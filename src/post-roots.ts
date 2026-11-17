// Posting roots, for a runner that is given a key (PRIVKEY) and the distributor's address
// (URD_ADDRESS). Without both the runner posts nothing and only logs the call, as before.
//
// After each pass it looks at the distributor and takes at most one step:
//   - the newest tree's root is not on the distributor and nothing is pending: submitRoot(root, sha256)
//   - a root the newest tree builds on is pending and its timelock has passed: acceptRoot()
//   - anything else: it waits, or refuses and says why.
// It never posts over a pending root: a new submission replaces the pending one and restarts its
// clock. Roots are cumulative, so when several epochs closed in the meantime only the newest is
// posted, once the pending one is accepted.
//
// What it refuses, because a person has to look first:
//   - a root on the distributor, or pending there, that the newest tree does not build on: someone
//     else posted it, or this is the wrong distributor or data directory;
//   - a root it submitted that the owner has taken off again (revoked, or replaced by an older one):
//     nothing more is posted until a person removes posting.json from the data directory;
//   - an epoch since the accepted root that was closed while the denylist was provisional;
//   - a key whose address is not a root updater.
//
// The key can only propose: a posted root waits out the distributor's timelock, and its owner can
// revoke it in that time. Whoever holds the key can post any root, so it is a key of its own, with
// just enough WETH for gas, and never the owner's.
//
// Transactions are signed and sent with viem, the way the whm agents do: the call is simulated
// first, so a revert shows before a nonce is spent, and the fee fields are always explicit. The gas
// limit is twice the node's estimate. The distributor is read at the finalized block, and a sent
// transaction counts once its block is final: the newest blocks can still be replaced.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "./lib/accounts.ts";
import { readJson, toJson, writeText } from "./lib/io.ts";
import type { Log } from "./types.ts";

const ZERO_ROOT = `0x${"0".repeat(64)}`;

export const DISTRIBUTOR_ABI = parseAbi([
  "function root() view returns (bytes32)",
  "function pendingRoot() view returns (bytes32 root, bytes32 ipfsHash, uint256 validAt)",
  "function isUpdater(address) view returns (bool)",
  "function submitRoot(bytes32 newRoot, bytes32 ipfsHash)",
  "function acceptRoot()",
]);

// The newest tree of the data directory: its epoch, its root, and the sha256 of its file.
export interface NewestTree {
  epoch: string;
  root: string;
  sha256: string;
}

// What the distributor holds, read at one block.
export interface DistributorState {
  root: string;
  pendingRoot: string;
  // unix seconds from which the pending root can be accepted
  pendingValidAt: number;
  // the timestamp of the finalized block this was read at
  chainTime: number;
  isUpdater: boolean;
}

export type PostingStep =
  | { action: "none"; reason: string }
  | { action: "wait"; reason: string }
  | { action: "refuse"; reason: string }
  | { action: "accept"; root: string }
  | { action: "submit"; root: string; sha256: string };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// One epoch of the newest tree's lineage: its root, and whether it was closed while the denylist
// was provisional.
export interface LineageEntry {
  epoch: string;
  root: string;
  provisional: boolean;
}

// The newest tree's lineage, oldest first: the epoch it was closed for, the one that builds on, and
// so on back to the first, from the epochs' summaries (no tree has to be read). It stops when a
// summary is missing or does not hold the root the next one says it builds on.
export function lineageOf(dataDir: string, newestEpoch: string): LineageEntry[] {
  type Summary = {
    tree?: { root?: string; previousEpoch?: string | null; previousRoot?: string | null };
    denylist?: { provisional?: boolean };
  };
  const lineage: LineageEntry[] = [];
  let epoch: string | null = newestEpoch;
  let expectedRoot: string | null = null;
  while (epoch !== null) {
    const path = join(dataDir, "epochs", `${epoch}.summary.json`);
    if (!existsSync(path))
      throw new Error(`epoch ${epoch} has no summary, so the newest tree's lineage cannot be read`);
    const summary: Summary = readJson<Summary>(path);
    const root = summary.tree?.root;
    if (typeof root !== "string") throw new Error(`the summary of epoch ${epoch} records no root`);
    if (expectedRoot !== null && !same(root, expectedRoot)) {
      throw new Error(`epoch ${epoch} has the root ${root}, but the epoch after it builds on ${expectedRoot}`);
    }
    if (lineage.some((e) => e.epoch === epoch)) throw new Error(`the lineage of ${newestEpoch} loops at ${epoch}`);
    lineage.push({ epoch, root, provisional: summary.denylist?.provisional === true });
    expectedRoot = summary.tree?.previousRoot ?? null;
    epoch = summary.tree?.previousEpoch ?? null;
  }
  return lineage.reverse();
}

// The one step to take now. `lineage` is the newest tree's (lineageOf); `lastSubmitted` is the last
// root this runner submitted, or saw pending, if any.
export function nextStep(o: {
  state: DistributorState;
  newest: NewestTree | null;
  lineage: LineageEntry[];
  lastSubmitted: string | null;
}): PostingStep {
  const { state, newest, lineage } = o;
  if (newest === null) return { action: "none", reason: "no epoch is closed yet" };
  // where a root stands in the lineage; -1 for the zero root and for a root that is not in it
  const index = (root: string | null): number => (root === null ? -1 : lineage.findIndex((e) => same(e.root, root)));
  const last = lineage.length - 1;
  if (last < 0 || !same(lineage[last]!.root, newest.root)) {
    return {
      action: "refuse",
      reason: `the newest tree's root ${newest.root} is not the one its epoch's summary records`,
    };
  }

  const live = index(state.root);
  if (!same(state.root, ZERO_ROOT) && live < 0) {
    return {
      action: "refuse",
      reason: `the distributor holds the root ${state.root}, which the newest tree does not build on`,
    };
  }

  // Something is pending when its validAt is set: that is the contract's own test, and a pending
  // entry can carry the zero root.
  if (state.pendingValidAt !== 0) {
    const pending = index(state.pendingRoot);
    if (pending < 0 || pending <= live) {
      return {
        action: "refuse",
        reason:
          `the root ${state.pendingRoot} is pending on the distributor and is not a root the newest tree builds on, ` +
          "newer than the accepted one",
      };
    }
    if (state.chainTime < state.pendingValidAt) {
      return {
        action: "wait",
        reason: `the root ${state.pendingRoot} can be accepted from ${iso(state.pendingValidAt)}`,
      };
    }
    return { action: "accept", root: state.pendingRoot };
  }

  if (live === last) return { action: "none", reason: `the distributor holds the newest root ${newest.root}` };

  // A root of this runner that is newer than the accepted one and no longer pending was taken off
  // by the owner (revokePendingRoot, or setRoot to an older root). Posting it again, or a newer tree
  // that holds its amounts, would undo that, so a person has to look first.
  if (index(o.lastSubmitted) > live) {
    return {
      action: "refuse",
      reason:
        `the root ${o.lastSubmitted} was submitted and is neither pending nor accepted any more: the owner revoked ` +
        `or replaced it. Nothing is posted until a person has looked; removing ${POSTING_RECORD} from the data ` +
        "directory posts the newest root again",
    };
  }
  // Trees are cumulative: the newest holds the amounts of every epoch since the accepted root.
  const provisional = lineage.slice(live + 1).find((e) => e.provisional);
  if (provisional) {
    return {
      action: "refuse",
      reason:
        `epoch ${provisional.epoch} was closed while the denylist was provisional, and the newest tree holds its ` +
        "amounts: such a root is posted by hand, if at all",
    };
  }
  if (!state.isUpdater)
    return { action: "refuse", reason: "the key's address is not a root updater of the distributor" };
  return { action: "submit", root: newest.root, sha256: newest.sha256 };
}

// The last root this runner submitted, kept in the data directory (not in the public folder), so
// that a root the owner takes off is not posted again after a restart either.
export const POSTING_RECORD = "posting.json";

export function readSubmitted(dataDir: string): string | null {
  const path = join(dataDir, POSTING_RECORD);
  if (!existsSync(path)) return null;
  const root = readJson<{ submitted?: { root?: unknown } }>(path).submitted?.root;
  if (typeof root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error(`${path} records no root`);
  return root;
}

function writeSubmitted(dataDir: string, root: string, epoch: string): void {
  writeText(join(dataDir, POSTING_RECORD), toJson({ submitted: { root, epoch, at: new Date().toISOString() } }));
}

// What a poster reads from and sends to. The runner's is `viemDistributor`; tests give their own.
export interface Distributor {
  // the address that signs
  account: string;
  read(): Promise<DistributorState>;
  submitRoot(root: string, sha256: string): Promise<string>;
  acceptRoot(): Promise<string>;
}

// One pass: reads the distributor, takes the step and returns it. A sent transaction is waited for,
// so the next pass reads its effect.
export async function postRoots(o: {
  distributor: Distributor;
  dataDir: string;
  newest: NewestTree | null;
  log?: Log;
}): Promise<PostingStep> {
  const { distributor, dataDir, newest, log = () => {} } = o;
  const lineage = newest === null ? [] : lineageOf(dataDir, newest.epoch);
  const state = await distributor.read();
  let lastSubmitted = readSubmitted(dataDir);

  // A root of the lineage that is pending was submitted, also when this runner did not live to
  // write that down (or a person posted it by hand).
  const index = (root: string | null): number => (root === null ? -1 : lineage.findIndex((e) => same(e.root, root)));
  const pending = state.pendingValidAt !== 0 ? index(state.pendingRoot) : -1;
  if (pending >= 0 && pending > index(lastSubmitted)) {
    writeSubmitted(dataDir, lineage[pending]!.root, lineage[pending]!.epoch);
    lastSubmitted = lineage[pending]!.root;
  }

  const step = nextStep({ state, newest, lineage, lastSubmitted });
  if (step.action === "submit" && newest !== null) {
    const tx = await distributor.submitRoot(step.root, step.sha256);
    writeSubmitted(dataDir, step.root, newest.epoch);
    log(`posted the root ${step.root} of epoch ${newest.epoch} (submitRoot, ${tx})`);
  } else if (step.action === "accept") {
    const tx = await distributor.acceptRoot();
    log(`accepted the root ${step.root} (acceptRoot, ${tx}): claims are made against it now`);
  }
  return step;
}

// PRIVKEY: 32 bytes of hex, with or without 0x.
export function parsePrivateKey(raw: string): Hex {
  const hex = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVKEY is not a 32-byte hex private key");
  return `0x${hex.toLowerCase()}`;
}

// The distributor on the chain behind `rpcUrl`, signing with `key`. It stops when the node serves
// another chain id, or when there is no contract at the address.
export async function viemDistributor(o: {
  rpcUrl: string;
  chainId: number;
  address: string;
  key: Hex;
  // The genesis hash the chain must have. Lark, the testnet forked from Hydration, keeps its chain
  // id, so the id alone cannot tell them apart, and a transaction signed for one is valid on the other.
  genesis?: string;
  receiptTimeoutMs?: number;
  finalityTimeoutMs?: number;
}): Promise<Distributor> {
  const address = normalizeAddress(o.address) as Address;
  // No default RPC in the chain, so a missing URL is an error and never a public endpoint.
  const chain = defineChain({
    id: o.chainId,
    name: "Hydration",
    nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
  const account = privateKeyToAccount(o.key);
  const publicClient = createPublicClient({ chain, transport: http(o.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(o.rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== o.chainId) throw new Error(`the node serves chain ${chainId}, the config says ${o.chainId}`);
  if (o.genesis !== undefined) {
    const genesis: unknown = await publicClient.request({
      method: "chain_getBlockHash" as never,
      params: [0] as never,
    });
    if (typeof genesis !== "string" || genesis.toLowerCase() !== o.genesis.toLowerCase()) {
      throw new Error(`the node's chain starts at ${String(genesis)}, the settings say ${o.genesis} (URD_GENESIS)`);
    }
  }
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`there is no contract at the distributor's address ${address}`);

  // Legacy gas price where blocks carry no base fee; otherwise twice the base fee, and the priority
  // fee the node asks for, or none where it has no such call. Two shapes, never a mix: viem's write
  // parameters are either legacy or EIP-1559.
  type Fees =
    { kind: "legacy"; gasPrice: bigint } | { kind: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  const fees = async (): Promise<Fees> => {
    const block = await publicClient.getBlock();
    if (!block.baseFeePerGas) return { kind: "legacy", gasPrice: await publicClient.getGasPrice() };
    let maxPriorityFeePerGas = 0n;
    try {
      maxPriorityFeePerGas = BigInt(await publicClient.request({ method: "eth_maxPriorityFeePerGas" }));
    } catch {
      // the node has no such call: no priority fee
    }
    return { kind: "eip1559", maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
  };

  const abi: Abi = DISTRIBUTOR_ABI;
  const send = async (functionName: "submitRoot" | "acceptRoot", args: readonly unknown[]): Promise<Hash> => {
    // simulated first: a revert shows here, by name, before a nonce is spent
    await publicClient.simulateContract({ address, abi, functionName, args, account });
    const fee = await fees();
    // Twice the node's estimate, as in the deploy scripts. Hydration meters new storage against the gas
    // limit, and a transaction needs a little more of it than the estimate says: sent with exactly the
    // estimate, submitRoot stopped at its first storage write (Lark, 2026-11-17). Unused gas costs nothing.
    const gas = (await publicClient.estimateContractGas({ address, abi, functionName, args, account })) * 2n;
    // the fee fields are always explicit, so viem never falls back to a guess of the transaction type
    const tx = { address, abi, functionName, args, account, gas } as const;
    const hash =
      fee.kind === "legacy"
        ? await wallet.writeContract({ ...tx, gasPrice: fee.gasPrice })
        : await wallet.writeContract({
            ...tx,
            maxFeePerGas: fee.maxFeePerGas,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
          });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: o.receiptTimeoutMs ?? 180_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} was included and reverted (${hash})`);
    // A block can still be replaced until it is finalized, and the transaction then lands in a later
    // one, or not at all. The step counts as taken once its block is final; until then the next pass,
    // which reads the finalized state, must not see it as taken and gone again.
    const deadline = Date.now() + (o.finalityTimeoutMs ?? 180_000);
    for (;;) {
      const finalized = await publicClient.getBlock({ blockTag: "finalized" });
      if (finalized.number >= receipt.blockNumber) break;
      if (Date.now() > deadline) {
        throw new Error(`${functionName} is in block ${receipt.blockNumber}, which is not finalized yet (${hash})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    const final = await publicClient.getTransactionReceipt({ hash });
    if (final.blockHash !== receipt.blockHash || final.status !== "success") {
      throw new Error(`${functionName} did not stay in the block it was first included in (${hash})`);
    }
    return hash;
  };

  return {
    account: account.address.toLowerCase(),
    // At the finalized block: the newest blocks can still be replaced, and a root that is there in one
    // read and not in the next would look like one the owner took off.
    async read() {
      const block = await publicClient.getBlock({ blockTag: "finalized" });
      const at = { blockNumber: block.number } as const;
      const [root, pending, isUpdater] = await Promise.all([
        publicClient.readContract({ address, abi: DISTRIBUTOR_ABI, functionName: "root", ...at }),
        publicClient.readContract({ address, abi: DISTRIBUTOR_ABI, functionName: "pendingRoot", ...at }),
        publicClient.readContract({
          address,
          abi: DISTRIBUTOR_ABI,
          functionName: "isUpdater",
          args: [account.address],
          ...at,
        }),
      ]);
      return {
        root,
        pendingRoot: pending[0],
        pendingValidAt: Number(pending[2]),
        chainTime: Number(block.timestamp),
        isUpdater,
      };
    },
    submitRoot: (root, sha256) => send("submitRoot", [root, sha256]),
    acceptRoot: () => send("acceptRoot", []),
  };
}

// The runner's posting settings, from its environment: PRIVKEY (the root-posting key) and URD_ADDRESS
// (the distributor). With neither it is null and nothing is posted; with only one the runner stops,
// because half a setting is a mistake. The key is taken out of the environment once it is read.
export function postingSettings(env: Record<string, string | undefined>): {
  key: Hex;
  address: string;
  // the address the key signs as
  account: string;
  // URD_GENESIS: the genesis hash the node's chain must have, when given
  genesis?: string;
} | null {
  const key = env.PRIVKEY?.trim();
  const address = env.URD_ADDRESS?.trim();
  const genesis = env.URD_GENESIS?.trim() || undefined;
  if (genesis !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(genesis)) {
    throw new Error(`URD_GENESIS is not a block hash: ${genesis}`);
  }
  if (!key && !address) return null;
  if (!key || !address) {
    throw new Error("posting roots needs both PRIVKEY and URD_ADDRESS: set both, or neither to post nothing");
  }
  const parsed = parsePrivateKey(key);
  delete env.PRIVKEY;
  return {
    key: parsed,
    address: normalizeAddress(address),
    account: privateKeyToAccount(parsed).address.toLowerCase(),
    ...(genesis === undefined ? {} : { genesis }),
  };
}

// What went wrong, without the node's URL: viem puts the request, URL included, into its messages,
// and a URL can carry a key.
export function postingError(error: unknown): string {
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  // viem's short message is the cause without the request, over a few lines (a revert's reason is
  // on the second); of any other message only the first line is kept.
  const text =
    typeof short === "string"
      ? short.split("\n").filter(Boolean).join(" ")
      : (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
  return text.replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
}
