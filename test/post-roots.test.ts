import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFunctionData } from "viem";
import {
  DISTRIBUTOR_ABI,
  nextStep,
  parsePrivateKey,
  postingError,
  postingSettings,
  postRoots,
  storedRoots,
  type Distributor,
  type DistributorState,
} from "../src/post-roots.ts";

const ZERO = `0x${"0".repeat(64)}`;
const R1 = `0x${"11".repeat(32)}`;
const R2 = `0x${"22".repeat(32)}`;
const R3 = `0x${"33".repeat(32)}`;
const OTHER = `0x${"ee".repeat(32)}`;
const SHA = `0x${"ab".repeat(32)}`;
const NOW = 1_794_880_000;

const state = (over: Partial<DistributorState> = {}): DistributorState => ({
  root: ZERO,
  pendingRoot: ZERO,
  pendingValidAt: 0,
  chainTime: NOW,
  isUpdater: true,
  ...over,
});
const newest = { epoch: "2026-11-17", root: R2, sha256: SHA };
const step = (s: Partial<DistributorState>, over: object = {}) =>
  nextStep({ state: state(s), newest, knownRoots: [R1, R2], provisional: false, ...over });

test("the newest root is submitted when the distributor holds nothing newer and nothing is pending", () => {
  assert.deepEqual(step({}), { action: "submit", root: R2, sha256: SHA });
  // the distributor holds the root before it
  assert.deepEqual(step({ root: R1 }), { action: "submit", root: R2, sha256: SHA });
  // roots compare whatever their letter case
  assert.deepEqual(step({ root: R1.toUpperCase().replace("0X", "0x") }), { action: "submit", root: R2, sha256: SHA });
});

test("nothing is done without a closed epoch, or once the distributor holds the newest root", () => {
  assert.equal(nextStep({ state: state(), newest: null, knownRoots: [], provisional: false }).action, "none");
  assert.equal(step({ root: R2 }).action, "none");
});

test("a pending root of this runner is waited for, then accepted, and never posted over", () => {
  const pending = { root: R1, pendingRoot: R2, pendingValidAt: NOW + 600 };
  assert.deepEqual(step(pending), {
    action: "wait",
    reason: `the root ${R2} can be accepted from ${new Date((NOW + 600) * 1000).toISOString()}`,
  });
  assert.deepEqual(step({ ...pending, chainTime: NOW + 600 }), { action: "accept", root: R2 });

  // an older root is pending and a newer epoch has closed: it is accepted first, not replaced
  const older = { pendingRoot: R1, pendingValidAt: NOW + 600 };
  assert.equal(step(older).action, "wait");
  assert.deepEqual(step({ ...older, chainTime: NOW + 601 }), { action: "accept", root: R1 });
  // accepting needs no updater role
  assert.deepEqual(step({ ...older, chainTime: NOW + 601, isUpdater: false }), { action: "accept", root: R1 });
});

test("a root this runner did not build stops the posting, pending or accepted", () => {
  assert.match(
    (step({ pendingRoot: OTHER, pendingValidAt: NOW - 1 }) as { reason: string }).reason,
    /is pending on the distributor and is not of a tree/,
  );
  assert.equal(step({ pendingRoot: OTHER, pendingValidAt: NOW - 1 }).action, "refuse");
  assert.equal(step({ root: OTHER }).action, "refuse");
  assert.match((step({ root: OTHER }) as { reason: string }).reason, /holds the root .* which is not of a tree/);
  // a newest tree that has no summary is not posted either
  assert.equal(step({}, { knownRoots: [R1] }).action, "refuse");
});

test("a tree closed on a provisional denylist, and a key that is no updater, are refused", () => {
  assert.match((step({}, { provisional: true }) as { reason: string }).reason, /denylist was provisional/);
  assert.equal(step({}, { provisional: true }).action, "refuse");
  assert.equal(step({ isUpdater: false }).action, "refuse");
  assert.match((step({ isUpdater: false }) as { reason: string }).reason, /not a root updater/);
});

function dataDirWith(summaries: Record<string, { root: string; provisional?: boolean }>): string {
  const dir = mkdtempSync(join(tmpdir(), "post-roots-"));
  mkdirSync(join(dir, "epochs"));
  for (const [epoch, s] of Object.entries(summaries)) {
    writeFileSync(
      join(dir, "epochs", `${epoch}.summary.json`),
      JSON.stringify({ epoch, tree: { root: s.root }, denylist: { provisional: s.provisional ?? false } }),
    );
  }
  writeFileSync(join(dir, "epochs", "2026-11-16.csv"), "account,amount\n");
  return dir;
}

test("the stored roots come from the epochs' summaries", () => {
  const dir = dataDirWith({ "2026-11-16": { root: R1 }, "2026-11-17": { root: R2, provisional: true } });
  assert.deepEqual(storedRoots(dir, "2026-11-17"), { roots: [R1, R2], provisional: true });
  assert.deepEqual(storedRoots(dir, "2026-11-16"), { roots: [R1, R2], provisional: false });
  assert.deepEqual(storedRoots(join(dir, "nothing-here"), null), { roots: [], provisional: false });
});

// A distributor with the URD's rules for the two calls, and a clock.
function fakeDistributor(timelock: number): Distributor & { now: number; state: DistributorState; sent: string[] } {
  const d = {
    account: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    now: NOW,
    sent: [] as string[],
    state: state(),
    async read() {
      return { ...d.state, chainTime: d.now };
    },
    async submitRoot(root: string, sha256: string) {
      d.state = { ...d.state, pendingRoot: root, pendingValidAt: d.now + timelock };
      d.sent.push(`submitRoot(${root}, ${sha256})`);
      return "0xsubmit";
    },
    async acceptRoot() {
      assert.ok(d.now >= d.state.pendingValidAt, "accepted before the timelock passed");
      d.state = { ...d.state, root: d.state.pendingRoot, pendingRoot: ZERO, pendingValidAt: 0 };
      d.sent.push("acceptRoot()");
      return "0xaccept";
    },
  };
  return d;
}

test("pass by pass: a root is posted, waited for, accepted, and the next one follows", async () => {
  const dir = dataDirWith({ "2026-11-16": { root: R1 }, "2026-11-17": { root: R2 }, "2026-11-18": { root: R3 } });
  const d = fakeDistributor(600);
  const lines: string[] = [];
  const pass = (tree: { epoch: string; root: string }) =>
    postRoots({ distributor: d, dataDir: dir, newest: { ...tree, sha256: SHA }, log: (line) => lines.push(line) });
  const first = { epoch: "2026-11-16", root: R1 };
  const third = { epoch: "2026-11-18", root: R3 };

  assert.equal((await pass(first)).action, "submit");
  assert.equal((await pass(first)).action, "wait");
  d.now += 600;
  assert.equal((await pass(first)).action, "accept");
  assert.equal((await pass(first)).action, "none");

  // two more epochs close: only the newest root is posted
  assert.equal((await pass(third)).action, "submit");
  d.now += 300;
  assert.equal((await pass(third)).action, "wait");
  d.now += 300;
  assert.equal((await pass(third)).action, "accept");
  assert.equal(d.state.root, R3);
  assert.deepEqual(d.sent, [`submitRoot(${R1}, ${SHA})`, "acceptRoot()", `submitRoot(${R3}, ${SHA})`, "acceptRoot()"]);
  assert.match(lines[0]!, /posted the root 0x1111.* of epoch 2026-11-16 \(submitRoot, 0xsubmit\)/);
  assert.match(lines[1]!, /accepted the root 0x1111/);
});

test("the key is 32 bytes of hex, with or without 0x", () => {
  const key = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  assert.equal(parsePrivateKey(` 0X${key.toUpperCase()}\n`), `0x${key}`);
  assert.equal(parsePrivateKey(key), `0x${key}`);
  assert.throws(() => parsePrivateKey("0x1234"), /not a 32-byte hex private key/);
  // the message never repeats the value
  assert.throws(
    () => parsePrivateKey(`${key}zz`),
    (error: Error) => !error.message.includes(key),
  );
});

test("the calls are the distributor's own", () => {
  // cast sig "submitRoot(bytes32,bytes32)" and "acceptRoot()"
  assert.equal(
    encodeFunctionData({
      abi: DISTRIBUTOR_ABI,
      functionName: "submitRoot",
      args: [R1 as `0x${string}`, SHA as `0x${string}`],
    }),
    `0xd61825ef${R1.slice(2)}${SHA.slice(2)}`,
  );
  assert.equal(encodeFunctionData({ abi: DISTRIBUTOR_ABI, functionName: "acceptRoot" }), "0xed075ec5");
});

test("posting is switched on by both settings, off by neither, and half a setting is refused", () => {
  const key = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
  const address = "0xbd1108369553bfFBAaa1BA5C8D07a8131EB92F10";
  assert.equal(postingSettings({}), null);
  assert.equal(postingSettings({ PRIVKEY: " ", URD_ADDRESS: "" }), null);
  assert.throws(() => postingSettings({ PRIVKEY: key }), /needs both PRIVKEY and URD_ADDRESS/);
  assert.throws(() => postingSettings({ URD_ADDRESS: address }), /needs both PRIVKEY and URD_ADDRESS/);
  assert.throws(() => postingSettings({ PRIVKEY: key, URD_ADDRESS: "0x1234" }), /20-byte/);

  const env: Record<string, string | undefined> = { PRIVKEY: key, URD_ADDRESS: address, OTHER: "kept" };
  assert.deepEqual(postingSettings(env), {
    key: `0x${key}`,
    address: address.toLowerCase(),
    // anvil's third account, which this key is
    account: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  });
  // the key does not stay in the environment
  assert.deepEqual(env, { URD_ADDRESS: address, OTHER: "kept" });
});

test("an error is reported without the node's URL", () => {
  const viemLike = Object.assign(new Error("HTTP request failed.\n\nURL: https://node.example/key-123\nDetails: ..."), {
    shortMessage: "HTTP request failed.",
  });
  assert.equal(postingError(viemLike), "HTTP request failed.");
  assert.equal(postingError(new Error("fetch https://node.example/key-123 failed\nmore")), "fetch <url> failed");
  assert.equal(postingError("plain"), "plain");
});
