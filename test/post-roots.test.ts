import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeFunctionData } from "viem";
import {
  DISTRIBUTOR_ABI,
  lineageOf,
  nextStep,
  parsePrivateKey,
  postingError,
  postingSettings,
  postRoots,
  POSTING_RECORD,
  readSubmitted,
  type Distributor,
  type DistributorState,
  type LineageEntry,
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
const LINEAGE: LineageEntry[] = [
  { epoch: "2026-11-16", root: R1, provisional: false },
  { epoch: "2026-11-17", root: R2, provisional: false },
];
const newest = { epoch: "2026-11-17", root: R2, sha256: SHA };
const step = (s: Partial<DistributorState>, over: { lineage?: LineageEntry[]; lastSubmitted?: string | null } = {}) =>
  nextStep({ state: state(s), newest, lineage: LINEAGE, lastSubmitted: null, ...over });
const reason = (s: ReturnType<typeof step>): string => ("reason" in s ? s.reason : "");

test("the newest root is submitted when the distributor holds an older one, or none, and nothing is pending", () => {
  assert.deepEqual(step({}), { action: "submit", root: R2, sha256: SHA });
  assert.deepEqual(step({ root: R1 }), { action: "submit", root: R2, sha256: SHA });
  // roots compare whatever their letter case
  assert.deepEqual(step({ root: R1.toUpperCase().replace("0X", "0x") }), { action: "submit", root: R2, sha256: SHA });
});

test("nothing is done without a closed epoch, or once the distributor holds the newest root", () => {
  assert.equal(nextStep({ state: state(), newest: null, lineage: [], lastSubmitted: null }).action, "none");
  assert.equal(step({ root: R2 }).action, "none");
});

test("a pending root the newest tree builds on is waited for, then accepted, and never posted over", () => {
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

test("a root the newest tree does not build on stops the posting, pending or accepted", () => {
  assert.equal(step({ pendingRoot: OTHER, pendingValidAt: NOW - 1 }).action, "refuse");
  assert.match(
    reason(step({ pendingRoot: OTHER, pendingValidAt: NOW - 1 })),
    /is pending on the distributor and is not a root/,
  );
  assert.equal(step({ root: OTHER }).action, "refuse");
  assert.match(reason(step({ root: OTHER })), /which the newest tree does not build on/);
  // a pending root that is not newer than the accepted one
  assert.equal(step({ root: R2, pendingRoot: R1, pendingValidAt: NOW - 1 }).action, "refuse");
  // an accepted root that is newer than the newest tree: the lineage does not reach it
  assert.equal(step({ root: R3 }).action, "refuse");
  // a newest tree whose summary records another root
  assert.equal(step({}, { lineage: [LINEAGE[0]!] }).action, "refuse");
});

test("a pending entry counts as pending by its validAt, also when its root is zero", () => {
  // the owner's removal of the root, waiting out the timelock: not posted over
  const removal = step({ root: R1, pendingRoot: ZERO, pendingValidAt: NOW + 600 });
  assert.equal(removal.action, "refuse");
  assert.match(reason(removal), /is pending on the distributor/);
});

test("a root the owner took off again is not posted again, nor a newer one that holds its amounts", () => {
  // R2 was submitted and revoked: the distributor is back at R1 with nothing pending
  const revoked = step({ root: R1 }, { lastSubmitted: R2 });
  assert.equal(revoked.action, "refuse");
  assert.match(reason(revoked), /was submitted and is neither pending nor accepted any more/);
  assert.match(reason(revoked), new RegExp(POSTING_RECORD.replace(".", "\\.")));
  // the first root ever, revoked
  assert.equal(step({}, { lastSubmitted: R2 }).action, "refuse");
  // a later epoch builds on the revoked root: still refused
  const longer = [...LINEAGE, { epoch: "2026-11-18", root: R3, provisional: false }];
  const later = nextStep({
    state: state({ root: R1 }),
    newest: { epoch: "2026-11-18", root: R3, sha256: SHA },
    lineage: longer,
    lastSubmitted: R2,
  });
  assert.equal(later.action, "refuse");
  // a record that is not newer than the accepted root is no rejection
  assert.equal(step({ root: R1 }, { lastSubmitted: R1 }).action, "submit");
  // nor is a record of a root that is in no summary any more (the epoch was closed again)
  assert.equal(step({ root: R1 }, { lastSubmitted: OTHER }).action, "submit");
});

test("an epoch closed on a provisional denylist stops every root that holds its amounts", () => {
  const first = [{ ...LINEAGE[0]!, provisional: true }, LINEAGE[1]!];
  // the newest epoch is not provisional, but its tree holds the first one's amounts
  assert.equal(step({}, { lineage: first }).action, "refuse");
  assert.match(reason(step({}, { lineage: first })), /epoch 2026-11-16 was closed while the denylist was provisional/);
  // once a person has posted that root and it is accepted, the next one goes out
  assert.equal(step({ root: R1 }, { lineage: first }).action, "submit");
  const second = [LINEAGE[0]!, { ...LINEAGE[1]!, provisional: true }];
  assert.equal(step({ root: R1 }, { lineage: second }).action, "refuse");
});

test("a key that is no updater is refused", () => {
  assert.equal(step({ isUpdater: false }).action, "refuse");
  assert.match(reason(step({ isUpdater: false })), /not a root updater/);
});

// A data directory with the summaries of a chain of epochs, each building on the one before.
function dataDirWith(epochs: { epoch: string; root: string; provisional?: boolean }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "post-roots-"));
  mkdirSync(join(dir, "epochs"));
  epochs.forEach((e, i) => {
    const previous = i === 0 ? null : epochs[i - 1]!;
    writeFileSync(
      join(dir, "epochs", `${e.epoch}.summary.json`),
      JSON.stringify({
        epoch: e.epoch,
        tree: { root: e.root, previousEpoch: previous?.epoch ?? null, previousRoot: previous?.root ?? null },
        denylist: { provisional: e.provisional ?? false },
      }),
    );
  });
  return dir;
}
const THREE = [
  { epoch: "2026-11-16", root: R1 },
  { epoch: "2026-11-17", root: R2, provisional: true },
  { epoch: "2026-11-18", root: R3 },
];

test("the lineage is read from the summaries, back from the newest epoch", () => {
  const dir = dataDirWith(THREE);
  assert.deepEqual(lineageOf(dir, "2026-11-18"), [
    { epoch: "2026-11-16", root: R1, provisional: false },
    { epoch: "2026-11-17", root: R2, provisional: true },
    { epoch: "2026-11-18", root: R3, provisional: false },
  ]);
  assert.deepEqual(lineageOf(dir, "2026-11-16"), [{ epoch: "2026-11-16", root: R1, provisional: false }]);
  // a summary that is gone, or that holds another root than the next epoch builds on
  rmSync(join(dir, "epochs", "2026-11-16.summary.json"));
  assert.throws(() => lineageOf(dir, "2026-11-18"), /epoch 2026-11-16 has no summary/);
  const broken = dataDirWith([THREE[0]!, { epoch: "2026-11-17", root: R2 }]);
  writeFileSync(
    join(broken, "epochs", "2026-11-16.summary.json"),
    JSON.stringify({ tree: { root: OTHER, previousEpoch: null, previousRoot: null } }),
  );
  assert.throws(() => lineageOf(broken, "2026-11-17"), /but the epoch after it builds on/);
});

// A distributor with the URD's rules for the calls, and a clock.
function fakeDistributor(timelock: number) {
  const d = {
    account: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    now: NOW,
    sent: [] as string[],
    state: state(),
    async read(): Promise<DistributorState> {
      return { ...d.state, chainTime: d.now };
    },
    async submitRoot(root: string, sha256: string) {
      d.state = { ...d.state, pendingRoot: root, pendingValidAt: d.now + timelock };
      d.sent.push(`submitRoot(${root}, ${sha256})`);
      return "0xsubmit";
    },
    async acceptRoot() {
      assert.ok(d.state.pendingValidAt !== 0 && d.now >= d.state.pendingValidAt, "accepted before the timelock passed");
      d.state = { ...d.state, root: d.state.pendingRoot, pendingRoot: ZERO, pendingValidAt: 0 };
      d.sent.push("acceptRoot()");
      return "0xaccept";
    },
    // the owner's call
    revokePendingRoot() {
      d.state = { ...d.state, pendingRoot: ZERO, pendingValidAt: 0 };
    },
  };
  return d satisfies Distributor;
}

test("pass by pass: a root is posted, waited for, accepted, and the next one follows", async () => {
  const dir = dataDirWith([THREE[0]!, { epoch: "2026-11-17", root: R2 }, THREE[2]!]);
  const d = fakeDistributor(600);
  const lines: string[] = [];
  const pass = (tree: { epoch: string; root: string }) =>
    postRoots({ distributor: d, dataDir: dir, newest: { ...tree, sha256: SHA }, log: (line) => lines.push(line) });
  const first = { epoch: "2026-11-16", root: R1 };
  const third = { epoch: "2026-11-18", root: R3 };

  assert.equal((await pass(first)).action, "submit");
  assert.equal(readSubmitted(dir), R1);
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

test("pass by pass: a revoked root stays off until a person removes the record", async () => {
  const dir = dataDirWith([THREE[0]!, { epoch: "2026-11-17", root: R2 }]);
  const d = fakeDistributor(600);
  const pass = () =>
    postRoots({ distributor: d, dataDir: dir, newest: { epoch: "2026-11-17", root: R2, sha256: SHA } });

  assert.equal((await pass()).action, "submit");
  d.revokePendingRoot();
  assert.equal((await pass()).action, "refuse");
  d.now += 86_400;
  assert.equal((await pass()).action, "refuse");
  assert.deepEqual(d.sent, [`submitRoot(${R2}, ${SHA})`]);

  // a person looks, and removes the record: the newest root is posted again
  rmSync(join(dir, POSTING_RECORD));
  assert.equal((await pass()).action, "submit");
  assert.equal(JSON.parse(readFileSync(join(dir, POSTING_RECORD), "utf8")).submitted.root, R2);
});

test("pass by pass: a tree that holds a provisionally closed epoch's amounts is not posted", async () => {
  // THREE: the middle epoch was closed while the denylist was provisional
  const dir = dataDirWith(THREE);
  const d = fakeDistributor(600);
  const pass = () =>
    postRoots({ distributor: d, dataDir: dir, newest: { epoch: "2026-11-18", root: R3, sha256: SHA } });
  d.state = state({ root: R1 });
  const refused = await pass();
  assert.equal(refused.action, "refuse");
  assert.match(reason(refused), /epoch 2026-11-17 was closed while the denylist was provisional/);
  assert.deepEqual(d.sent, []);
  // a person posted the provisional root by hand and it was accepted: the next one goes out
  d.state = state({ root: R2 });
  assert.equal((await pass()).action, "submit");
});

test("a pending root this runner did not write down is written down when it is seen", async () => {
  // the runner died between its transaction and its record, or a person posted the root by hand
  const dir = dataDirWith([THREE[0]!, { epoch: "2026-11-17", root: R2 }]);
  const d = fakeDistributor(600);
  d.state = state({ pendingRoot: R2, pendingValidAt: NOW + 600 });
  assert.equal(existsSync(join(dir, POSTING_RECORD)), false);
  const pass = () =>
    postRoots({ distributor: d, dataDir: dir, newest: { epoch: "2026-11-17", root: R2, sha256: SHA } });
  assert.equal((await pass()).action, "wait");
  assert.equal(readSubmitted(dir), R2);
  // so that a revocation is still seen as one
  d.revokePendingRoot();
  assert.equal((await pass()).action, "refuse");
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

  // the chain can be named by its genesis hash
  const genesis = `0x${"af".repeat(32)}`;
  assert.equal(postingSettings({ PRIVKEY: key, URD_ADDRESS: address, URD_GENESIS: genesis })?.genesis, genesis);
  assert.throws(() => postingSettings({ PRIVKEY: key, URD_ADDRESS: address, URD_GENESIS: "0x12" }), /not a block hash/);
});

test("an error is reported without the node's URL", () => {
  const viemLike = Object.assign(new Error("HTTP request failed.\n\nURL: https://node.example/key-123\nDetails: ..."), {
    shortMessage: "HTTP request failed.",
  });
  assert.equal(postingError(viemLike), "HTTP request failed.");
  // a revert's reason is on the short message's second line
  const revert = Object.assign(new Error("long"), {
    shortMessage:
      'The contract function "submitRoot" reverted with the following reason:\ncaller has not the updater role',
  });
  assert.equal(
    postingError(revert),
    'The contract function "submitRoot" reverted with the following reason: caller has not the updater role',
  );
  assert.equal(postingError(new Error("fetch https://node.example/key-123 failed\nmore")), "fetch <url> failed");
  assert.equal(postingError("plain"), "plain");
});
