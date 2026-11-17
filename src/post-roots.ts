// Posting roots, for a runner that is given a key (PRIVKEY) and the distributor's address
// (URD_ADDRESS). Without both the runner posts nothing and only logs the call, as before.
//
// After each pass it looks at the distributor and takes at most one step:
//   - the newest tree's root is not on the distributor and nothing is pending: submitRoot(root, sha256)
//   - a root of this runner is pending and its timelock has passed: acceptRoot()
//   - anything else: it waits, or refuses and says why.
// It never posts over a pending root: a new submission replaces the pending one and restarts its
// clock. Roots are cumulative, so when several epochs closed in the meantime only the newest is
// posted, once the pending one is accepted.
//
// What it refuses, because a person has to look first:
//   - a root on the distributor, or pending there, that is not the root of a tree in this data
//     directory: someone else posted it, or this is the wrong distributor or data directory;
//   - a tree closed while the denylist was provisional;
//   - a key whose address is not a root updater.
//
// The key can only propose: a posted root waits out the distributor's timelock, and its owner can
// revoke it in that time. Whoever holds the key can post any root, so it is a key of its own, with
// just enough WETH for gas, and never the owner's.
//
// Transactions are signed and sent with viem, the way the whm agents do: the call is simulated
// first, so a revert shows before a nonce is spent, and the fee fields are always explicit.

import { existsSync, readdirSync } from "node:fs";
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
import { readJson } from "./lib/io.ts";
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
  // the timestamp of the block this was read at
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

// The one step to take now. `knownRoots` are the roots of every tree in the data directory;
// `provisional` says the newest tree was closed while the denylist was provisional.
export function nextStep(o: {
  state: DistributorState;
  newest: NewestTree | null;
  knownRoots: string[];
  provisional: boolean;
}): PostingStep {
  const { state, newest } = o;
  const known = (root: string): boolean => o.knownRoots.some((r) => same(r, root));
  if (newest === null) return { action: "none", reason: "no epoch is closed yet" };
  if (!known(newest.root))
    return { action: "refuse", reason: `the newest tree's root ${newest.root} is not among the stored trees` };

  if (!same(state.pendingRoot, ZERO_ROOT)) {
    if (!known(state.pendingRoot)) {
      return {
        action: "refuse",
        reason: `the root ${state.pendingRoot} is pending on the distributor and is not of a tree in this data directory`,
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

  if (same(state.root, newest.root))
    return { action: "none", reason: `the distributor holds the newest root ${newest.root}` };
  if (!same(state.root, ZERO_ROOT) && !known(state.root)) {
    return {
      action: "refuse",
      reason: `the distributor holds the root ${state.root}, which is not of a tree in this data directory`,
    };
  }
  if (o.provisional) {
    return {
      action: "refuse",
      reason: `epoch ${newest.epoch} was closed while the denylist was provisional: its root is posted by hand, if at all`,
    };
  }
  if (!state.isUpdater)
    return { action: "refuse", reason: "the key's address is not a root updater of the distributor" };
  return { action: "submit", root: newest.root, sha256: newest.sha256 };
}

// The root of every stored tree, and whether `epoch`'s was closed on a provisional denylist. Both
// from the epochs' summaries, so no tree has to be read.
export function storedRoots(dataDir: string, epoch: string | null): { roots: string[]; provisional: boolean } {
  const dir = join(dataDir, "epochs");
  const roots: string[] = [];
  let provisional = false;
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!file.endsWith(".summary.json")) continue;
    const summary = readJson<{ tree?: { root?: string }; denylist?: { provisional?: boolean } }>(join(dir, file));
    if (typeof summary.tree?.root === "string") roots.push(summary.tree.root);
    if (file === `${epoch}.summary.json`) provisional = summary.denylist?.provisional === true;
  }
  return { roots, provisional };
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
  const { distributor, newest, log = () => {} } = o;
  const { roots, provisional } = storedRoots(o.dataDir, newest?.epoch ?? null);
  const step = nextStep({ state: await distributor.read(), newest, knownRoots: roots, provisional });
  if (step.action === "submit") {
    const tx = await distributor.submitRoot(step.root, step.sha256);
    log(`posted the root ${step.root} of epoch ${newest?.epoch} (submitRoot, ${tx})`);
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
  receiptTimeoutMs?: number;
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
    // the fee fields are always explicit, so viem never falls back to a guess of the transaction type
    const tx = { address, abi, functionName, args, account } as const;
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
    return hash;
  };

  return {
    account: account.address.toLowerCase(),
    async read() {
      const block = await publicClient.getBlock();
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
} | null {
  const key = env.PRIVKEY?.trim();
  const address = env.URD_ADDRESS?.trim();
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
  };
}

// What went wrong, without the node's URL: viem puts the request, URL included, into its messages,
// and a URL can carry a key.
export function postingError(error: unknown): string {
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  const text = typeof short === "string" ? short : error instanceof Error ? error.message : String(error);
  return text
    .replace(/https?:\/\/\S+/g, "<url>")
    .split("\n")[0]!
    .slice(0, 300);
}
