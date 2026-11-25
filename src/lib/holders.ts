// Every address that ever received an earning asset's aToken, built from Transfer logs and kept in
// data/state/holders.json so each snapshot only scans the blocks since the last one.
//
// Hydration's node serves Substrate-originated EVM activity as synthetic transactions (sender
// 0x73796e74…7468, "synth"), so transfers made from Substrate wallets appear in eth_getLogs too.
// Completeness is still checked at every snapshot: holder balances must add up to total supply.
// The public RPC gives each log query 10 seconds, which ranges of 10k blocks often exceed, so the
// scan uses fixed windows (config logs.maxBlockSpan), a few in parallel, and splits a window that
// times out. A window already at the minimum size is retried a few times before the scan gives up.
// Progress is saved after every batch, so an interrupted scan resumes where it stopped.
//
// An index carries the tokens it was built for. A config that adds an earning asset adds its aToken:
// the index then scans that token alone, from its own first block (its deployBlock) up to where the
// index stands, and only then takes it into its tokens and goes on with all of them. A config that
// drops or replaces a token is refused, since the index could not say which addresses were whose.

import { existsSync } from "node:fs";
import { compareAddresses } from "./accounts.ts";
import { acquireLock, readJson, toJson, writeText } from "./io.ts";
import { TRANSFER_TOPIC, ZERO_ADDRESS } from "./abi.ts";
import { toBlockTag } from "./rpc.ts";
import type { Log, Rpc } from "../types.ts";

// data/state/holders.json
export interface HolderIndex {
  format: string;
  tokens: string[];
  fromBlock: number;
  scannedTo: number;
  addresses: string[];
}

interface TransferLog {
  address: string;
  topics: string[];
}

const HOLDERS_FORMAT = "hydration-rewards-holders/1";

const isQueryLimit = (error: unknown): boolean =>
  /timeout|too many|limit/i.test(String((error as { message?: unknown } | null)?.message));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One scan at a time: two processes extending the same index (the runner, and a --rescan run by hand)
// would each save their own address set, and the last save would drop what the other one found.
export async function updateHolderIndex(options: Parameters<typeof scanHolders>[0]): Promise<HolderIndex> {
  const release = acquireLock(`${options.path}.lock`, "the holder index");
  try {
    return await scanHolders(options);
  } finally {
    release();
  }
}

async function scanHolders({
  rpc,
  path,
  tokens,
  fromBlock,
  fromBlocks = {},
  toBlock,
  maxSpan = 10_000,
  concurrency = 4,
  minSpan = 500,
  retries = 3,
  retryDelayMs = 2_000,
  rewind = 0,
  log = () => {},
}: {
  rpc: Pick<Rpc, "call">;
  path: string;
  tokens: string[];
  // where a new index starts: the first block of the earliest token
  fromBlock: number;
  // the first block of each token, by lowercase address, for a token the index does not hold yet;
  // fromBlock for a token not listed here
  fromBlocks?: Record<string, number>;
  toBlock: number;
  maxSpan?: number;
  concurrency?: number;
  minSpan?: number;
  retries?: number;
  retryDelayMs?: number;
  rewind?: number;
  log?: Log;
}): Promise<HolderIndex> {
  const tokenList = tokens.map((t) => t.toLowerCase()).sort();
  const state: HolderIndex = existsSync(path)
    ? readJson<HolderIndex>(path)
    : { format: HOLDERS_FORMAT, tokens: tokenList, fromBlock, scannedTo: fromBlock - 1, addresses: [] };
  if (state.format !== HOLDERS_FORMAT) throw new Error(`${path}: not a ${HOLDERS_FORMAT} file`);
  const added = tokenList.filter((t) => !state.tokens.includes(t));
  const dropped = state.tokens.filter((t) => !tokenList.includes(t));
  if (dropped.length > 0) {
    throw new Error(
      `${path}: built for other tokens: the config no longer has ${dropped.join(", ")}; ` +
        "an index can take on new tokens but not lose one",
    );
  }

  // Scanning a stretch again only ever adds addresses, so it is safe whenever the index is in doubt.
  if (rewind > 0) state.scannedTo = Math.max(state.fromBlock - 1, state.scannedTo - rewind);

  const addresses = new Set(state.addresses);
  const save = () => {
    state.addresses = [...addresses].sort(compareAddresses);
    writeText(path, toJson(state));
  };

  // One window of blocks for some of the tokens. A window the node cannot answer in time is split in
  // two; one that is already at the minimum size is retried, then fails the scan.
  async function fetchWindow(list: string[], from: number, to: number, attempt = 0): Promise<TransferLog[]> {
    try {
      return (await rpc.call("eth_getLogs", [
        { address: list, topics: [TRANSFER_TOPIC], fromBlock: toBlockTag(from), toBlock: toBlockTag(to) },
      ])) as TransferLog[];
    } catch (error) {
      if (!isQueryLimit(error)) throw error;
      if (to - from + 1 > minSpan) {
        const mid = from + Math.floor((to - from) / 2);
        return [...(await fetchWindow(list, from, mid)), ...(await fetchWindow(list, mid + 1, to))];
      }
      if (attempt >= retries) throw error;
      await sleep(retryDelayMs * 2 ** attempt);
      return fetchWindow(list, from, to, attempt + 1);
    }
  }

  // Blocks from..to for the tokens in list, a batch of windows at a time. done(to) runs after each
  // batch with the last block the batch covered.
  async function scan(list: string[], from: number, to: number, done: (scanned: number) => void): Promise<void> {
    let next = from;
    while (next <= to) {
      const windows: [number, number][] = [];
      for (let i = 0; i < concurrency && next <= to; i++) {
        const end = Math.min(next + maxSpan - 1, to);
        windows.push([next, end]);
        next = end + 1;
      }
      // All windows of a batch must succeed before the scan advances past them.
      const results = await Promise.all(windows.map(([f, t]) => fetchWindow(list, f, t)));
      for (const logs of results) {
        for (const entry of logs) {
          if (!list.includes(entry.address.toLowerCase()))
            throw new Error(`log from unexpected contract ${entry.address}`);
          if (entry.topics[0] !== TRANSFER_TOPIC || entry.topics.length < 3) continue;
          const recipient = `0x${entry.topics[2].slice(26)}`.toLowerCase();
          if (recipient !== ZERO_ADDRESS) addresses.add(recipient);
        }
      }
      done(windows[windows.length - 1][1]);
    }
  }

  // Tokens the config added since the index was built: each from its own first block up to where the
  // index stands. The addresses found are saved as they come, since they only ever add candidates, but
  // the tokens join the index only once the whole stretch is scanned, so a scan that stops here starts
  // this stretch again from the beginning next time.
  if (added.length > 0) {
    const start = Math.min(...added.map((t) => fromBlocks[t] ?? fromBlock));
    log(
      `holders: taking on ${added.join(", ")} from block ${start}` +
        (start <= state.scannedTo ? `, first up to ${state.scannedTo} where the index stands` : ""),
    );
    let batches = 0;
    if (start <= state.scannedTo) {
      await scan(added, start, state.scannedTo, (scanned) => {
        save();
        if (++batches % 10 === 0) log(`holders: new tokens scanned to ${scanned}, ${addresses.size} addresses`);
      });
    }
    state.tokens = tokenList;
    state.fromBlock = Math.min(state.fromBlock, start);
    save();
  }

  let batches = 0;
  await scan(tokenList, state.scannedTo + 1, toBlock, (scanned) => {
    state.scannedTo = scanned;
    save();
    if (++batches % 10 === 0) log(`holders: scanned to ${state.scannedTo}, ${addresses.size} addresses`);
  });
  save();
  return state;
}
