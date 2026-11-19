// The runner's tick against a data directory, with snapshots supplied by the test instead of a chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingProgramFrom, programOnDisk, tick } from "../src/bot.ts";
import type { TickStatus } from "../src/bot.ts";
import { closeEpochToDisk, epochWindow } from "../src/close-epoch.ts";
import { loadDenylist } from "../src/lib/denylist.ts";
import { sha256, toJson } from "../src/lib/io.ts";
import { parseProgram } from "../src/program.ts";
import { ACCOUNTS, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";
import type { DenylistFile } from "../src/lib/denylist.ts";
import type { Tree } from "../src/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8"));
const FIRST = "2026-11-12";
const { start } = epochWindow(FIRST, 14);
const HOUR = 3600;

const programText = ({ husdt = 1, from = FIRST, endsAt = "" } = {}) => `name: bot test
applies_from_epoch: ${from}
budget_per_day:
  HUSDC: 1
  HUSDT: ${husdt}
epoch_start_hour_utc: 14
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
${endsAt && `ends_at: ${endsAt}\n`}`;
const PROGRAM = programText();
const program = parseProgram(PROGRAM, config, { requireDecisions: true });
const programOf = (options: Parameters<typeof programText>[0]) =>
  parseProgram(programText(options), config, { requireDecisions: true });
// The same settings with an end two epochs in: 2026-11-13 is the last epoch it pays.
const ENDING = programText({ endsAt: "2026-11-14T14:00:00Z" });
const ending = parseProgram(ENDING, config, { requireDecisions: true });
const END = start + 48 * HOUR;

// What a failed pass did, which it carries on the error it throws.
const statusOf = (error: unknown): TickStatus => (error as { status: TickStatus }).status;

// A runner over an empty data directory. Each hour's snapshot holds one account, a on even days of
// the month and b on odd ones, so the trees show which epochs were closed. An hour is due once it
// has ended, so at `start + k * HOUR` the hours before k have been asked for.
function runner({
  failAt = null,
  notFinalizedFrom = Infinity,
  noBlockAt = null,
  denylist = undefined,
}: {
  failAt?: number | null;
  notFinalizedFrom?: number;
  noBlockAt?: number | null;
  denylist?: DenylistFile;
} = {}) {
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [], ...(denylist ? { denylist } : {}) });
  const asked: number[] = [];
  const takeHour = async (target: number) => {
    asked.push(target);
    if (target >= notFinalizedFrom) throw Object.assign(new Error("no finalized block yet"), { code: "NOT_FINALIZED" });
    if (target === failAt) throw new Error("eth_call: execution reverted");
    if (target === noBlockAt) throw Object.assign(new Error("no block in this hour"), { code: "NO_BLOCK_IN_HOUR" });
    writeHour(target);
  };
  const writeHour = (target: number) => {
    const account = new Date((target - 14 * HOUR) * 1000).getUTCDate() % 2 === 0 ? ACCOUNTS.a : ACCOUNTS.b;
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: { [account]: { husdt: 10 } },
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  const run = (now: number, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
    tick({ now, dataDir, program, config, denylistPath, firstEpoch: FIRST, takeHour, ...extra });
  const tree = (epoch: string): Tree => JSON.parse(readFileSync(join(dataDir, "trees", `${epoch}.json`), "utf8"));
  return { dataDir, denylistPath, asked, run, tree, writeHour };
}

test("nothing happens before the first epoch starts", async () => {
  const { asked, run } = runner();
  const status = await run(start - 1);
  assert.deepEqual(asked, []);
  assert.equal(status.openEpoch, FIRST);
  assert.match(String(status.waiting), /first epoch starts at 2026-11-12T14:00:00/);
});

test("each hour is snapshotted once it has ended, and an epoch is closed when its last hour is in", async () => {
  const { dataDir, denylistPath, asked, run, tree } = runner();

  // An hour's block is picked by the first block after it, so the hour still running is not asked for.
  let status = await run(start + 3 * HOUR + 59);
  assert.deepEqual(asked, [start, start + HOUR, start + 2 * HOUR]);
  assert.deepEqual(status, {
    openEpoch: FIRST,
    snapshots: 3,
    taken: asked,
    closed: [],
    latestTree: null,
    denylist: { sha256: loadDenylist(denylistPath).sha256, provisional: false },
    waiting: null,
    blocked: [],
  });

  status = await run(start + 3 * HOUR + 119); // a minute later: nothing new is due
  assert.equal(asked.length, 3);
  assert.deepEqual(status.taken, []);

  status = await run(start + 24 * HOUR); // the 24th hour has ended
  assert.equal(asked.length, 24);
  assert.equal(status.closed.length, 1);
  assert.equal(status.closed[0].epoch, FIRST);
  assert.equal(status.closed[0].distributed, "1000000");
  assert.equal(status.closed[0].paidAccounts, 1);
  assert.equal(status.openEpoch, "2026-11-13");
  assert.equal(status.snapshots, 0);
  assert.deepEqual(status.latestTree, { epoch: FIRST, root: tree(FIRST).root, sha256: status.closed[0].treeSha256 });
  assert.equal(tree(FIRST).previousRoot, null); // the first epoch is the genesis tree
  assert.deepEqual([...parseCsv(readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8")).keys()], [ACCOUNTS.a]);
});

test("after downtime it catches up: missed hours first, then every finished epoch in order", async () => {
  const { asked, run, tree } = runner();
  await run(start + 5 * HOUR);
  // Down for two days, back at hour 50: hours 5 to 49 have ended since.
  const status = await run(start + 50 * HOUR + 10);
  assert.equal(asked.length, 50);
  assert.deepEqual(
    asked,
    [...asked].sort((x, y) => x - y),
  ); // oldest first
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-12", "2026-11-13"],
  );
  assert.equal(status.openEpoch, "2026-11-14");
  assert.equal(status.snapshots, 2);
  // Each tree builds on the day before, and carries its accounts forward.
  assert.equal(tree("2026-11-13").previousRoot, tree("2026-11-12").root);
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.a].claimable, "1000000");
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.b].claimable, "1000000");
});

test("a failed snapshot stops the snapshots and fails the tick; the next tick carries on from the same hour", async () => {
  const failing = runner({ failAt: start + 10 * HOUR });
  await assert.rejects(
    failing.run(start + 30 * HOUR),
    /snapshot of 2026-11-13T00:00:00.000Z: eth_call: execution reverted/,
  );
  assert.equal(failing.asked.at(-1), start + 10 * HOUR);
  assert.equal(existsSync(join(failing.dataDir, "trees")), false); // nothing closed with an hour missing

  const { asked, run } = runner();
  await run(start + 9 * HOUR);
  const status = await run(start + 30 * HOUR);
  assert.equal(asked.length, 30);
  assert.equal(status.closed.length, 1);
});

test("a failed snapshot in a later epoch does not hold up closing an epoch whose hours are all in", async () => {
  // Back after downtime at hour 30; hour 26, in the second epoch, cannot be read.
  const { dataDir, asked, run, tree } = runner({ failAt: start + 26 * HOUR });
  await assert.rejects(run(start + 30 * HOUR), (error) => {
    assert.match(
      String((error as Error).message),
      /snapshot of 2026-11-13T16:00:00.000Z: eth_call: execution reverted/,
    );
    // The failed pass still says what it did, for status.json.
    const status = statusOf(error);
    assert.deepEqual(
      status.closed.map((c) => c.epoch),
      [FIRST],
    );
    assert.equal(status.openEpoch, "2026-11-13");
    assert.equal(status.latestTree?.root, tree(FIRST).root);
    return true;
  });
  assert.equal(asked.at(-1), start + 26 * HOUR);
  assert.ok(existsSync(join(dataDir, "trees", `${FIRST}.json`)), "the complete first epoch was closed");
  assert.equal(tree(FIRST).claims[ACCOUNTS.a].claimable, "1000000");
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-13.json")), false);
});

test("an hour whose block is not finalized yet is waited for, not reported as a failure", async () => {
  const { asked, run } = runner({ notFinalizedFrom: start + 3 * HOUR });
  // Hours 3 and 4 have both ended; once 3 is not finalized, 4 cannot be either and is not tried.
  const status = await run(start + 5 * HOUR);
  assert.deepEqual(status.taken, [start, start + HOUR, start + 2 * HOUR]);
  assert.match(String(status.waiting), /the hour from 2026-11-12T17:00:00.000Z is not over and finalized yet/);
  assert.equal(asked.at(-1), start + 3 * HOUR);
});

test("a backlog larger than the limit is refused, so a wrong first epoch cannot start a year of snapshots", async () => {
  const { asked, run } = runner();
  await assert.rejects(run(start + 400 * HOUR), (error) => {
    assert.match(String((error as Error).message), /400 snapshots are overdue since 2026-11-12T14:00:00.000Z/);
    assert.equal(statusOf(error).openEpoch, FIRST, "status.json still says which epoch is open");
    return true;
  });
  assert.deepEqual(asked, []);
  await assert.rejects(run(start, { firstEpoch: "12 Nov" }), /must be a date like 2026-11-12/);
});

// The runner as its own process, with one --once pass.
function botProcess(data: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [join(root, "src", "bot.ts"), "--once", "--data", data, "--rpc", "http://127.0.0.1:1", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, FIRST_EPOCH: "", PROGRAM: "", PRIVKEY: "", URD_ADDRESS: "" },
    },
  );
}

test("the bot refuses to start without a first epoch or with a program whose decisions are blank", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const noEpoch = botProcess(data);
  assert.equal(noEpoch.status, 1);
  assert.match(noEpoch.stderr, /--first-epoch \(or FIRST_EPOCH\) is required/);

  // A program file whose decisions are not all made, as the shipped one is until launch. (Not the
  // shipped file itself: a pull request that fills it in must not turn this test red.)
  const undecided = join(data, "undecided.yaml");
  writeFileSync(undecided, PROGRAM.replace("HUSDT: 1", "HUSDT:"));
  const blank = botProcess(data, "--first-epoch", FIRST, "--program", undecided);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /budget_per_day for HUSDT is blank; fill it in before closing an epoch/);

  // With decisions made and an epoch that has not started, one tick writes the status file and exits.
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, PROGRAM);
  const idle = botProcess(data, "--first-epoch", "2999-01-01", "--program", programPath);
  assert.equal(idle.status, 0, idle.stderr);
  const status = JSON.parse(readFileSync(join(data, "status.json"), "utf8"));
  assert.equal(status.error, null);
  assert.equal(status.openEpoch, "2999-01-01");
  assert.equal(status.program.appliesFromEpoch, FIRST);
  assert.equal(status.programOnDisk, null);
  assert.match(status.denylist.sha256, /^0x[0-9a-f]{64}$/);
  assert.match(String(status.waiting), /first epoch starts at 2999-01-01T14:00:00/);

  // A denylist that does not load stops the start instead of the first close.
  const brokenDenylist = join(data, "denylist.json");
  writeFileSync(brokenDenylist, toJson({ addresses: [{ address: ACCOUNTS.a }] }));
  const broken = botProcess(
    data,
    "--first-epoch",
    "2999-01-01",
    "--program",
    programPath,
    "--denylist",
    brokenDenylist,
  );
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /every address needs a label/);
});

test("one runner per data directory; a lock left by a runner that is gone is taken over", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, PROGRAM);
  const once = () => botProcess(data, "--first-epoch", "2999-01-01", "--program", programPath);
  const lock = join(data, "bot.lock");

  // A runner that is running: this test's own process, which the spawned runner is not.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "running" }));
  const refused = once();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`in use by process ${process.pid} on`));
  assert.equal(existsSync(join(data, "status.json")), false);

  const gone = spawnSync(process.execPath, ["-e", ""]).pid; // has exited by now
  writeFileSync(lock, JSON.stringify({ pid: gone, host: hostname(), token: "crashed" }));
  const ran = once();
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(lock), false, "the lock is released on exit");
});

test("the runner releases its lock when it is stopped with SIGTERM, SIGINT or SIGHUP", async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
    const programPath = join(data, "program.yaml");
    writeFileSync(programPath, PROGRAM);
    const child = spawn(
      process.execPath,
      [join(root, "src", "bot.ts"), "--data", data, "--rpc", "http://127.0.0.1:1"].concat([
        "--first-epoch",
        "2999-01-01",
        "--program",
        programPath,
        "--interval",
        "3600",
      ]),
      { env: { ...process.env, FIRST_EPOCH: "", PROGRAM: "", PRIVKEY: "", URD_ADDRESS: "" }, stdio: "ignore" },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // Its first pass writes status.json; then it holds the lock and sleeps.
    for (let i = 0; i < 200 && !existsSync(join(data, "status.json")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(join(data, "bot.lock")), `${signal}: the lock is held while the runner runs`);
    child.kill(signal);
    await exited;
    assert.equal(existsSync(join(data, "bot.lock")), false, `${signal}: the lock is released`);
  }
});

test("a failed pass still writes what it knows to status.json", () => {
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const programPath = join(data, "program.yaml");
  writeFileSync(programPath, programText({ from: yesterday }));
  // The node cannot be reached, so the first hour that is due fails.
  const failed = botProcess(data, "--first-epoch", yesterday, "--program", programPath);
  assert.equal(failed.status, 1);
  const status = JSON.parse(readFileSync(join(data, "status.json"), "utf8"));
  assert.match(status.error, /snapshot of .*: 127\.0\.0\.1:1 unreachable after 4 attempts/);
  assert.equal(status.openEpoch, yesterday);
  assert.deepEqual(status.taken, []);
  assert.match(status.denylist.sha256, /^0x[0-9a-f]{64}$/);
});

test("an hour the chain produced no block in does not stop later hours, and leaves its epoch for a person to close", async () => {
  const { dataDir, asked, run } = runner({ noBlockAt: start + 5 * HOUR });
  // Before its other hours are all taken, closing it by hand would pay the whole budget on part of the day.
  const early = await run(start + 10 * HOUR);
  assert.match(
    String(early.waiting),
    /no block inside 2026-11-12T19:00:00.000Z, so epoch 2026-11-12 cannot close on its own; once its other hours are all taken, from 2026-11-13T15:00:00.000Z, close it by hand with --allow-partial/,
  );
  // Just after the epoch's end: the hours are in, but the closer only accepts --allow-partial an hour later.
  const justAfter = await run(start + 24 * HOUR + 30);
  assert.match(String(justAfter.waiting), /once its other hours are all taken, from 2026-11-13T15:00:00.000Z/);

  asked.length = 0;
  const status = await run(start + 30 * HOUR);
  assert.equal(asked.length, 7); // every hour that has ended was tried, the stalled one again each pass
  assert.equal(status.taken.length, 6);
  assert.deepEqual(status.blocked, ["2026-11-12T19:00:00.000Z"]);
  assert.equal(status.openEpoch, FIRST);
  assert.equal(status.closed.length, 0);
  assert.match(
    String(status.waiting),
    /epoch 2026-11-12 cannot close on its own: .* close it by hand with --allow-partial/,
  );
  assert.equal(existsSync(join(dataDir, "trees")), false);
});

test("after a day skipped by hand with --allow-gap, the runner carries on from the newest tree", async () => {
  const { dataDir, denylistPath, asked, run, tree, writeHour } = runner();
  await run(start + 24 * HOUR); // closes 2026-11-12
  // 2026-11-13 could never be closed; a person closed 2026-11-14 on 2026-11-12's tree.
  for (let k = 48; k < 72; k++) writeHour(start + k * HOUR);
  closeEpochToDisk({
    dataDir,
    epoch: "2026-11-14",
    program,
    config,
    denylist: loadDenylist(denylistPath),
    previousTreePath: join(dataDir, "trees", `${FIRST}.json`),
    allowGap: true,
  });
  asked.length = 0;
  const status = await run(start + 96 * HOUR);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-15"],
  );
  assert.equal(asked[0], start + 72 * HOUR, "the skipped day's hours are not asked for");
  assert.equal(tree("2026-11-15").previousRoot, tree("2026-11-14").root);
});

test("a first epoch later than trees that already exist is refused instead of starting over from genesis", async () => {
  const { run } = runner();
  await run(start + 24 * HOUR); // closes 2026-11-12
  // Restarted with the date read as "resume from here".
  await assert.rejects(
    run(start + 49 * HOUR, { firstEpoch: "2026-11-13" }),
    /already holds 2026-11-12\.json; check the first epoch/,
  );
  // With the right date the same restart simply carries on.
  const status = await run(start + 49 * HOUR);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-13"],
  );
});

test("a program file closes nothing before its applies_from_epoch, and the runner says so on its first pass", async () => {
  const { dataDir, asked, run } = runner();
  const later = programOf({ from: "2026-11-13" });
  // Three hours in, a day before the close would be refused, the pass already fails.
  await assert.rejects(run(start + 3 * HOUR, { program: later }), (error) => {
    assert.match(
      String((error as Error).message),
      /program: epoch 2026-11-12 would be the first epoch, but this program file applies from 2026-11-13: start with --first-epoch 2026-11-13, or set applies_from_epoch to 2026-11-12/,
    );
    assert.equal(statusOf(error).taken.length, 3, "the hours are still taken");
    return true;
  });
  await assert.rejects(run(start + 24 * HOUR, { program: later }), /applies from 2026-11-13/);
  assert.equal(asked.length, 24);
  assert.equal(existsSync(join(dataDir, "trees")), false);
});

test("a new program file takes over at its applies_from_epoch, and a changed file needs a new one", async () => {
  const { run, tree } = runner();
  await run(start + 24 * HOUR); // 2026-11-12 with the first file

  // Reviewed to pay twice the HUSDT budget from 2026-11-13; the runner was restarted with it in time.
  const doubled = programOf({ husdt: 2, from: "2026-11-13" });
  const second = await run(start + 48 * HOUR, { program: doubled });
  assert.deepEqual(
    second.closed.map((c) => [c.epoch, c.distributed]),
    [["2026-11-13", "2000000"]],
  );
  assert.equal(tree("2026-11-13").claims[ACCOUNTS.b].claimable, "2000000");

  // The file edited again without moving applies_from_epoch: 2026-11-13 was closed with the earlier
  // version, so this one would apply to a day that has already been paid differently. The first pass
  // after the restart says so, an hour into 2026-11-14 rather than when it closes.
  const edited = programOf({ husdt: 3, from: "2026-11-13" });
  await assert.rejects(
    run(start + 49 * HOUR, { program: edited }),
    /program: epoch 2026-11-13 was closed with another program file .* set applies_from_epoch to 2026-11-14/,
  );
  const fromNextDay = programOf({ husdt: 3, from: "2026-11-14" });
  const third = await run(start + 72 * HOUR, { program: fromNextDay });
  assert.deepEqual(
    third.closed.map((c) => [c.epoch, c.distributed]),
    [["2026-11-14", "3000000"]],
  );
});

test("the denylist is read on every pass: a change applies from the next close, and one that does not load stops the closes", async () => {
  const { dataDir, denylistPath, asked, run } = runner();
  await run(start + 24 * HOUR); // 2026-11-12 pays a
  const before = loadDenylist(denylistPath).sha256;

  // b, who holds everything on 2026-11-13, is listed while the runner keeps running.
  writeFileSync(
    denylistPath,
    toJson({ rules: { palletAccounts: true }, addresses: [{ address: ACCOUNTS.b, label: "test entry" }] }),
  );
  const lines: string[] = [];
  const listed = await run(start + 48 * HOUR, { knownDenylist: before, log: (line) => lines.push(line) });
  assert.equal(listed.denylist?.sha256, loadDenylist(denylistPath).sha256);
  // The change is logged before the close that uses it.
  const changed = lines.findIndex((line) => line.startsWith(`denylist changed to ${listed.denylist?.sha256}`));
  const closedLine = lines.findIndex((line) => line.startsWith("epoch 2026-11-13 closed"));
  assert.ok(changed >= 0 && changed < closedLine, lines.join("\n"));
  assert.deepEqual(
    listed.closed.map((c) => [c.epoch, c.paidAccounts]),
    [["2026-11-13", 0]],
  );
  const summary = JSON.parse(readFileSync(join(dataDir, "epochs", "2026-11-13.summary.json"), "utf8"));
  assert.deepEqual(
    summary.denylist.excluded.map((e: { account: string }) => e.account),
    [ACCOUNTS.b],
  );

  // A denylist that cannot be read: no close and no latest.json on a stale list, but the hours go on.
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  const shown = latest().asOf.hour;
  const listedDenylist = readFileSync(denylistPath, "utf8");
  writeFileSync(denylistPath, "{ not json");
  await assert.rejects(run(start + 49 * HOUR), (error) => {
    assert.match(String((error as Error).message), /^denylist: /);
    assert.equal(statusOf(error).denylist, null);
    return true;
  });
  assert.equal(asked.at(-1), start + 48 * HOUR);
  assert.equal(latest().asOf.hour, shown, "latest.json stays as it was while the denylist is broken");

  // Once it loads again the file catches up with the hour taken meanwhile, on a pass with nothing due.
  writeFileSync(denylistPath, listedDenylist);
  const back = await run(start + 49 * HOUR + 60);
  assert.deepEqual(back.taken, []);
  assert.equal(latest().asOf.hour, start + 48 * HOUR);
  assert.equal(latest().openEpoch.snapshots, 1);
});

test("a denylist change reaches latest.json on the pass that reads it, without waiting for a snapshot", async () => {
  const { dataDir, denylistPath, run } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  await run(start + 3 * HOUR);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "125000" });
  const before = loadDenylist(denylistPath).sha256;

  // a, who holds everything, is listed. No hour is due and nothing closes.
  writeFileSync(
    denylistPath,
    toJson({ rules: { palletAccounts: true }, addresses: [{ address: ACCOUNTS.a, label: "test entry" }] }),
  );
  const status = await run(start + 3 * HOUR + 60, { knownDenylist: before });
  assert.deepEqual(status.taken, []);
  assert.deepEqual(latest().accounts, { [ACCOUNTS.a]: { earning: false, reason: "excluded" } });
  assert.deepEqual(latest().openEpoch.accruing, {});
});

test("while a newer program file waits on disk, the running one closes nothing from its applies_from_epoch on", async () => {
  const { dataDir, run } = runner();
  await assert.rejects(run(start + 48 * HOUR, { pendingProgramFrom: "2026-11-13" }), (error) => {
    assert.match(
      String((error as Error).message),
      /program: the program file on disk applies from 2026-11-13; restart the runner with it to close 2026-11-13/,
    );
    assert.deepEqual(
      statusOf(error).closed.map((c) => c.epoch),
      [FIRST],
    );
    return true;
  });
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-13.json")), false);
});

test("latest.json is rebuilt when the runner restarts with another program file", async () => {
  const { dataDir, run } = runner();
  await run(start + 3 * HOUR);
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  assert.equal(latest().program.sha256, program.sha256);
  const other = programOf({ husdt: 2 });
  await run(start + 3 * HOUR + 30, { program: other }); // nothing new is due
  assert.equal(latest().program.sha256, other.sha256);
  assert.equal(latest().assets.HUSDT.budgetPerDay, "2000000");
});

test("a failed close still publishes latest.json, two failures are both reported, and a latest.json failure fails the pass", async () => {
  // Hour 5's file is unreadable as a snapshot of hour 5, so 2026-11-12 cannot close.
  const { dataDir, run, writeHour } = runner({ failAt: start + 26 * HOUR });
  await run(start + 23 * HOUR);
  writeFileSync(join(dataDir, "snapshots", `${start + 5 * HOUR}.json`), toJson({ format: "something-else" }));
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));

  await assert.rejects(run(start + 24 * HOUR), /close of 2026-11-12: .* not a hydration-rewards-snapshot\/2 snapshot/);
  assert.equal(latest().asOf.hour, start + 23 * HOUR, "latest.json moved on to the hour taken in the failed pass");

  // A snapshot failure and a close failure in one pass are both reported, and so is the open epoch's
  // estimate, which the same unreadable hour stops.
  await assert.rejects(run(start + 30 * HOUR), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.match(
      error.message,
      /snapshot of 2026-11-13T16:00:00.000Z: .*; also close of 2026-11-12: .*; also estimate of the open epoch 2026-11-12: /,
    );
    return true;
  });

  // latest.json that cannot be written fails the pass too.
  writeHour(start + 5 * HOUR); // the epoch can close again
  rmSync(join(dataDir, "public", "latest.json"));
  mkdirSync(join(dataDir, "public", "latest.json", "in-the-way"), { recursive: true });
  await assert.rejects(run(start + 26 * HOUR), /public\/latest\.json: /);
});

test("every stored tree's claims file is written again if it is missing", async () => {
  // The URD holds an older root for at least 12 hours after each close, so the app needs older files too.
  const { dataDir, run, tree } = runner();
  await run(start + 48 * HOUR);
  const claims = (epoch: string) => join(dataDir, "public", "trees", `${tree(epoch).root}.json`);
  const original = readFileSync(claims(FIRST), "utf8");
  rmSync(claims(FIRST));
  rmSync(claims("2026-11-13"));
  const lines: string[] = [];
  await run(start + 48 * HOUR + 60, { log: (line) => lines.push(line) });
  assert.equal(readFileSync(claims(FIRST), "utf8"), original);
  assert.ok(existsSync(claims("2026-11-13")));
  assert.match(lines.join("\n"), /wrote the missing claims file of 2026-11-12's root/);
});

test("a provisional denylist is called out next to the root to post", async () => {
  const lines: string[] = [];
  const provisional = { rules: { palletAccounts: true }, addresses: [], unresolved: ["ICE pot"] };
  const status = await runner({ denylist: provisional }).run(start + 24 * HOUR, { log: (line) => lines.push(line) });
  assert.equal(status.closed[0].denylistProvisional, true);
  assert.match(
    lines.join("\n"),
    /to post: submitRoot\(0x[0-9a-f]{64}, 0x[0-9a-f]{64}\)\n\s+WARNING: the denylist is provisional/,
  );

  const clean: string[] = [];
  await runner().run(start + 24 * HOUR, { log: (line) => clean.push(line) });
  assert.doesNotMatch(clean.join("\n"), /WARNING/);
});

test("only a program file that takes over later than the running one stops the running one's closes", () => {
  const loaded = parseProgram(PROGRAM, config, { requireDecisions: true }); // applies from 2026-11-12
  const onDisk = (appliesFromEpoch: string | null) => ({ sha256: "0xother", appliesFromEpoch });
  assert.equal(pendingProgramFrom(onDisk("2026-11-20"), loaded), "2026-11-20");
  // An edit that kept the date, or an older file put back: reported, but the runner keeps closing.
  assert.equal(pendingProgramFrom(onDisk(FIRST), loaded), null);
  assert.equal(pendingProgramFrom(onDisk("2026-11-01"), loaded), null);
  assert.equal(pendingProgramFrom(onDisk(null), loaded), null);
  assert.equal(pendingProgramFrom({ error: "ENOENT" }, loaded), null);
  assert.equal(pendingProgramFrom(null, loaded), null);
});

test("a program file on disk that is not the one running is reported with the epoch it applies from", () => {
  const dir = mkdtempSync(join(tmpdir(), "hydration-program-"));
  const path = join(dir, "program.yaml");
  writeFileSync(path, PROGRAM);
  const loaded = parseProgram(PROGRAM, config, { requireDecisions: true });
  assert.equal(programOnDisk(path, config, loaded), null);

  const merged = programText({ husdt: 2, from: "2026-11-20" });
  writeFileSync(path, merged);
  assert.deepEqual(programOnDisk(path, config, loaded), { sha256: sha256(merged), appliesFromEpoch: "2026-11-20" });

  writeFileSync(path, "name: broken\nbudget_per_day: 1\n");
  assert.match(String(programOnDisk(path, config, loaded)?.error), /"earn_on_supply_of" is missing/);
  rmSync(path);
  assert.match(String(programOnDisk(path, config, loaded)?.error), /ENOENT/);
});

test("the runner publishes who is earning as of the newest snapshot, and the tree of each closed epoch", async () => {
  const { dataDir, run, tree } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));

  await run(start + 3 * HOUR + 30); // hours 0 to 2 have ended
  assert.equal(latest().asOf.hour, start + 2 * HOUR);
  assert.deepEqual(latest().accounts, { [ACCOUNTS.a]: { earning: true, hollarDebtUsd: "0.00" } });
  assert.equal(latest().latestTree, null);
  assert.equal(existsSync(join(dataDir, "public", "trees")), false);

  // A pass with nothing new leaves the file alone; if the file is lost, the next pass restores it.
  const before = readFileSync(join(dataDir, "public", "latest.json"), "utf8");
  await run(start + 3 * HOUR + 90);
  assert.equal(readFileSync(join(dataDir, "public", "latest.json"), "utf8"), before);
  rmSync(join(dataDir, "public", "latest.json"));
  await run(start + 3 * HOUR + 150);
  assert.equal(readFileSync(join(dataDir, "public", "latest.json"), "utf8"), before);

  // Closing the epoch publishes its tree under the root, and the status file points at it.
  await run(start + 25 * HOUR); // hour 24, the first of the next epoch, has ended too
  const closedRoot = tree(FIRST).root;
  assert.deepEqual(latest().latestTree, { epoch: FIRST, root: closedRoot });
  assert.equal(latest().asOf.hour, start + 24 * HOUR);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(join(dataDir, "public", "trees", `${closedRoot}.json`), "utf8")).claims),
    [ACCOUNTS.a],
  );
  // The runner's own status, which can carry RPC error text, is not in the public folder.
  assert.deepEqual(readdirSync(join(dataDir, "public")).sort(), ["latest.json", "trees"]);
});

test("latest.json says what each account has earned so far in the open epoch, and starts again after a close", async () => {
  const { dataDir, run, tree } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));

  await run(start + 3 * HOUR + 30); // hours 0 to 2 have ended
  // a holds all the HUSDT there is, so it has 3/24 of HUSDT's budget of 1 PRIME; nobody holds HUSDC.
  assert.deepEqual(latest().openEpoch, {
    id: FIRST,
    start,
    end: start + 24 * HOUR,
    snapshots: 3,
    expectedSnapshots: 24,
    accruing: { [ACCOUNTS.a]: "125000" },
  });
  // It is an addition: the format name and the fields before it are as they were.
  assert.equal(latest().format, "hydration-rewards-latest/1");
  assert.deepEqual(Object.keys(latest()), [
    "format",
    "asOf",
    "reward",
    "program",
    "assets",
    "accounts",
    "latestTree",
    "openEpoch",
  ]);

  // It moves with every snapshot, each budget rounded down: 4/24, then 23/24.
  await run(start + 4 * HOUR);
  assert.equal(latest().openEpoch.snapshots, 4);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "166666" });
  await run(start + 23 * HOUR);
  assert.equal(latest().openEpoch.snapshots, 23);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "958333" });

  // The last hour closes the epoch, which pays the whole budget. The next epoch is open and has no
  // snapshot yet: nothing has been earned in it, and a is still earning as of the newest snapshot.
  const status = await run(start + 24 * HOUR);
  assert.equal(status.closed[0].distributed, "1000000");
  assert.equal(tree(FIRST).claims[ACCOUNTS.a].claimable, "1000000");
  assert.deepEqual(latest().openEpoch, {
    id: "2026-11-13",
    start: start + 24 * HOUR,
    end: start + 48 * HOUR,
    snapshots: 0,
    expectedSnapshots: 24,
    accruing: {},
  });
  assert.equal(latest().asOf.hour, start + 23 * HOUR);
  assert.deepEqual(latest().accounts, { [ACCOUNTS.a]: { earning: true, hollarDebtUsd: "0.00" } });

  // Its first hour, in which b holds the HUSDT: a has earned nothing in this epoch and is left out.
  await run(start + 25 * HOUR);
  assert.equal(latest().openEpoch.snapshots, 1);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.b]: "41666" });
});

test("with every snapshot of an epoch in, the estimate is what its close then pays", async () => {
  // The close cannot write its claims file, because public/trees is a file where a folder should be,
  // so the epoch that is complete stays open.
  const { dataDir, run } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  mkdirSync(join(dataDir, "public"));
  writeFileSync(join(dataDir, "public", "trees"), "in the way");
  await assert.rejects(run(start + 24 * HOUR), /^Error: close of 2026-11-12: /);
  assert.deepEqual(latest().openEpoch, {
    id: FIRST,
    start,
    end: start + 24 * HOUR,
    snapshots: 24,
    expectedSnapshots: 24,
    accruing: { [ACCOUNTS.a]: "1000000" },
  });
  rmSync(join(dataDir, "public", "trees"));
  const status = await run(start + 24 * HOUR + 60);
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed]),
    [[FIRST, "1000000"]],
  );
  assert.deepEqual(
    parseCsv(readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8")),
    new Map([[ACCOUNTS.a, 1_000_000n]]),
  );
});

test("a latest.json written before the open epoch's estimate existed is rebuilt on the next pass", async () => {
  const { dataDir, run } = runner();
  await run(start + 3 * HOUR);
  const path = join(dataDir, "public", "latest.json");
  const current = readFileSync(path, "utf8");
  // What an older version left behind, and a redeploy finds: the same file without openEpoch.
  const { openEpoch, ...older } = JSON.parse(current);
  assert.equal(openEpoch.snapshots, 3);
  writeFileSync(path, toJson(older));

  const status = await run(start + 3 * HOUR + 60); // no snapshot is due and nothing closes
  assert.deepEqual(status.taken, []);
  assert.equal(readFileSync(path, "utf8"), current);

  // So is a file whose openEpoch is not an object: the pass does not trip over it.
  for (const odd of [null, FIRST]) {
    writeFileSync(path, toJson({ ...older, openEpoch: odd }));
    await run(start + 3 * HOUR + 120);
    assert.equal(readFileSync(path, "utf8"), current);
  }
});

test("an epoch closed by hand is not published as the open one after the next pass", async () => {
  // Hour 5 never has a block, so 2026-11-12 waits for a person while the runner takes the later hours.
  const { dataDir, denylistPath, run, tree } = runner({ noBlockAt: start + 5 * HOUR });
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  await run(start + 30 * HOUR);
  assert.equal(latest().openEpoch.id, FIRST);
  assert.equal(latest().openEpoch.snapshots, 23);
  assert.equal(latest().latestTree, null);

  const byHand = (changes: object = {}) =>
    closeEpochToDisk({
      dataDir,
      epoch: FIRST,
      program,
      config,
      denylist: loadDenylist(denylistPath),
      now: start + 30 * HOUR + 10,
      genesis: true,
      allowPartial: true,
      ...changes,
    });
  byHand();

  // No hour is due and the runner closes nothing itself. The file still says what is on disk now: the
  // tree of 2026-11-12, and 2026-11-13 open with the six hours taken in it, all of them b's.
  const status = await run(start + 30 * HOUR + 60);
  assert.deepEqual(status.taken, []);
  assert.deepEqual(status.closed, []);
  assert.equal(status.openEpoch, "2026-11-13");
  assert.deepEqual(latest().latestTree, { epoch: FIRST, root: tree(FIRST).root });
  const open = {
    id: "2026-11-13",
    start: start + 24 * HOUR,
    end: start + 48 * HOUR,
    snapshots: 6,
    expectedSnapshots: 24,
    accruing: { [ACCOUNTS.b]: "250000" },
  };
  assert.deepEqual(latest().openEpoch, open);
  assert.equal(latest().asOf.hour, start + 29 * HOUR);

  // The same epoch closed again by hand with another result, after one of its hours was taken again:
  // the open epoch and the newest snapshot are as they were, and the file names the new root.
  const hour = start + 6 * HOUR;
  const retaken = makeSnapshot({
    number: hour / 6,
    timestamp: hour + 2,
    target: hour,
    accounts: { [ACCOUNTS.a]: { husdt: 10 }, [ACCOUNTS.c]: { husdt: 10 } },
  });
  writeFileSync(join(dataDir, "snapshots", `${hour}.json`), toJson(retaken));
  const first = tree(FIRST).root;
  const again = byHand({ overwrite: true });
  assert.notEqual(again.tree.root, first);
  assert.deepEqual((await run(start + 30 * HOUR + 120)).taken, []);
  assert.deepEqual(latest().latestTree, { epoch: FIRST, root: again.tree.root });
  assert.deepEqual(latest().openEpoch, open);
});

test("an epoch closed by hand that paid nobody still gives way to the next one in latest.json", async () => {
  // b, who holds everything on 2026-11-13, is listed, and that day's hour 5 never has a block.
  const { dataDir, denylistPath, run, tree } = runner({
    noBlockAt: start + 29 * HOUR,
    denylist: { rules: { palletAccounts: true }, addresses: [{ address: ACCOUNTS.b, label: "test entry" }] },
  });
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  await run(start + 24 * HOUR); // closes 2026-11-12, which pays a
  await run(start + 71 * HOUR); // 2026-11-13 waits with 23 of its hours; 23 of 2026-11-14's are in as well
  const before = latest();
  assert.deepEqual(before.latestTree, { epoch: FIRST, root: tree(FIRST).root });
  assert.deepEqual(
    [before.openEpoch.id, before.openEpoch.snapshots, before.openEpoch.accruing],
    ["2026-11-13", 23, {}],
  );

  closeEpochToDisk({
    dataDir,
    epoch: "2026-11-13",
    program,
    config,
    denylist: loadDenylist(denylistPath),
    now: start + 71 * HOUR + 10,
    previousTreePath: join(dataDir, "trees", `${FIRST}.json`),
    allowPartial: true,
  });
  assert.equal(tree("2026-11-13").root, tree(FIRST).root, "a day that pays nobody ends on the root before it");

  // The root, the newest snapshot and the number of snapshots are what the file had. The open epoch is not.
  const status = await run(start + 71 * HOUR + 60);
  assert.deepEqual(status.taken, []);
  assert.deepEqual(latest(), {
    ...before,
    latestTree: { epoch: "2026-11-13", root: tree(FIRST).root },
    openEpoch: {
      id: "2026-11-14",
      start: start + 48 * HOUR,
      end: start + 72 * HOUR,
      snapshots: 23,
      expectedSnapshots: 24,
      accruing: { [ACCOUNTS.a]: "958333" },
    },
  });
});

test("snapshots that appear without the runner taking them reach latest.json on the next pass", async () => {
  // Hour 5 never has a block, so 2026-11-12 stays open with 23 of its hours.
  const { dataDir, run, writeHour } = runner({ noBlockAt: start + 5 * HOUR });
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  const shown = () => [latest().asOf.hour, latest().openEpoch.snapshots];
  await run(start + 30 * HOUR);
  assert.deepEqual(shown(), [start + 29 * HOUR, 23]);

  // A later hour taken by hand: the open epoch has what it had, and who is earning is as of that hour.
  writeHour(start + 30 * HOUR);
  assert.deepEqual((await run(start + 31 * HOUR)).taken, []);
  assert.deepEqual(shown(), [start + 30 * HOUR, 23]);

  // The open epoch's missing hour put in place by hand, while its close cannot write its claims file
  // (public/trees is a file where a folder should be): the newest snapshot is the same one, and the
  // estimate counts all 24.
  writeHour(start + 5 * HOUR);
  writeFileSync(join(dataDir, "public", "trees"), "in the way");
  await assert.rejects(run(start + 31 * HOUR + 60), /^Error: close of 2026-11-12: /);
  assert.deepEqual(shown(), [start + 30 * HOUR, 24]);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "1000000" });
});

test("while latest.json is behind the snapshots on disk, every pass tries again and fails until it is written", async () => {
  const { dataDir, run, writeHour } = runner();
  const path = join(dataDir, "public", "latest.json");
  const latest = () => JSON.parse(readFileSync(path, "utf8"));
  await run(start + HOUR);
  const before = readFileSync(path, "utf8");

  // Hour 1 is taken, but what is on disk cannot be read: neither the estimate nor the file can be made.
  const cutShort = async (target: number) => writeFileSync(join(dataDir, "snapshots", `${target}.json`), "{ cut short");
  const both = /^estimate of the open epoch 2026-11-12: .*; also public\/latest\.json: /;
  await assert.rejects(run(start + 2 * HOUR, { takeHour: cutShort }), (error) => {
    assert.match(String((error as Error).message), both);
    assert.deepEqual(statusOf(error).taken, [start + HOUR]);
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), before);

  // Nothing is due on the next pass. The file is still one snapshot behind, so it does not look recovered.
  await assert.rejects(run(start + 2 * HOUR + 60), (error) => {
    assert.match(String((error as Error).message), both);
    assert.deepEqual(statusOf(error).taken, []);
    return true;
  });
  assert.equal(readFileSync(path, "utf8"), before);

  // Once the hour can be read, the file moves on to it without waiting for the next snapshot.
  writeHour(start + HOUR);
  const status = await run(start + 2 * HOUR + 120);
  assert.deepEqual(status.taken, []);
  assert.equal(latest().asOf.hour, start + HOUR);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "83333" });
});

test("a pass with nothing new does not work the estimate out again", async () => {
  const { dataDir, run } = runner();
  const path = join(dataDir, "public", "latest.json");
  await run(start + 3 * HOUR);
  const current = readFileSync(path, "utf8");
  // Hour 0 can no longer be read as a snapshot, which fails any estimate made from here on.
  writeFileSync(join(dataDir, "snapshots", `${start}.json`), toJson({ format: "something-else" }));
  const status = await run(start + 3 * HOUR + 60);
  assert.deepEqual(status.taken, []);
  assert.equal(readFileSync(path, "utf8"), current);

  // Nor while a budget is blank: an estimate left out for that is no failure, and nothing to try again.
  const blank = runner();
  const undecided = parseProgram(PROGRAM.replace("HUSDT: 1", "HUSDT:"), config);
  await blank.run(start + 3 * HOUR, { program: undecided });
  writeFileSync(join(blank.dataDir, "snapshots", `${start}.json`), toJson({ format: "something-else" }));
  const idle = await blank.run(start + 3 * HOUR + 60, { program: undecided });
  assert.deepEqual(idle.taken, []);
});

test("the estimate is made with the program's earning assets, its HOLLAR allowance and the denylist", async () => {
  // HUSDT alone earns, though every snapshot records HUSDC too. Next to a, three accounts hold far
  // more HUSDT and earn nothing: a HOLLAR borrower, a pallet account and a listed one.
  const husdtOnly = parseProgram(PROGRAM.replace("  HUSDC: 1\n", "").replace("[HUSDC, HUSDT]", "[HUSDT]"), config, {
    requireDecisions: true,
  });
  assert.deepEqual(husdtOnly.earn, ["HUSDT"]);
  const borrower = "0x00000000000000000000000000000000000000e5";
  const { dataDir, run } = runner({
    denylist: { rules: { palletAccounts: true }, addresses: [{ address: ACCOUNTS.listed, label: "test entry" }] },
  });
  const takeHour = async (target: number) => {
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: {
        [ACCOUNTS.a]: { husdc: 700, husdt: 100 },
        [borrower]: { husdt: 90_000, hollar: 300 },
        [ACCOUNTS.treasury]: { husdt: 400_000 },
        [ACCOUNTS.listed]: { husdt: 50_000 },
      },
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  await run(start + 3 * HOUR, { program: husdtOnly, takeHour });
  const latest = JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  // a has all of HUSDT's 3/24 and nothing for its HUSDC, as in the close of this epoch.
  assert.deepEqual(latest.openEpoch.accruing, { [ACCOUNTS.a]: "125000" });
});

test("an estimate that fails is left out of latest.json, which is still written, and is reported until it works", async () => {
  const { dataDir, run, writeHour } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  await run(start + 2 * HOUR);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "83333" });

  // Hour 0's file can no longer be read as a snapshot. The newest one, which says who is earning, is fine.
  writeFileSync(join(dataDir, "snapshots", `${start}.json`), toJson({ format: "something-else" }));
  await assert.rejects(run(start + 3 * HOUR), (error) => {
    assert.match(
      String((error as Error).message),
      /^estimate of the open epoch 2026-11-12: .* not a hydration-rewards-snapshot\/2 snapshot/,
    );
    assert.deepEqual(statusOf(error).taken, [start + 2 * HOUR]);
    return true;
  });
  // The file moved on to the new hour and names the open epoch; only the amounts are missing.
  assert.equal(latest().asOf.hour, start + 2 * HOUR);
  assert.deepEqual(latest().accounts, { [ACCOUNTS.a]: { earning: true, hollarDebtUsd: "0.00" } });
  assert.deepEqual(latest().openEpoch, {
    id: FIRST,
    start,
    end: start + 24 * HOUR,
    snapshots: 3,
    expectedSnapshots: 24,
    accruing: null,
  });

  // A pass with nothing else to do tries again and says so again: it does not look recovered.
  await assert.rejects(run(start + 3 * HOUR + 60), /^Error: estimate of the open epoch 2026-11-12: /);
  assert.equal(latest().openEpoch.accruing, null);

  // Once the hour is put right the estimate is back, without waiting for the next snapshot.
  writeHour(start);
  const status = await run(start + 3 * HOUR + 120);
  assert.deepEqual(status.taken, []);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "125000" });
});

test("a failing estimate does not hold up the snapshots, the close, or the tree the runner posts", async () => {
  const { dataDir, run, tree } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  await run(start + 23 * HOUR);
  // The first hour of the next epoch is on disk already, and cannot be read as a snapshot.
  writeFileSync(join(dataDir, "snapshots", `${start + 24 * HOUR}.json`), toJson({ format: "something-else" }));

  await assert.rejects(run(start + 26 * HOUR), (error) => {
    assert.match(String((error as Error).message), /^estimate of the open epoch 2026-11-13: /);
    const status = statusOf(error);
    assert.deepEqual(status.taken, [start + 23 * HOUR, start + 25 * HOUR]);
    assert.deepEqual(
      status.closed.map((c) => c.epoch),
      [FIRST],
    );
    // The failed pass still carries the newest tree, which is what the runner posts from.
    assert.equal(status.latestTree?.root, tree(FIRST).root);
    return true;
  });
  assert.deepEqual(latest().latestTree, { epoch: FIRST, root: tree(FIRST).root });
  assert.equal(latest().asOf.hour, start + 25 * HOUR);
  assert.deepEqual(latest().openEpoch, {
    id: "2026-11-13",
    start: start + 24 * HOUR,
    end: start + 48 * HOUR,
    snapshots: 2,
    expectedSnapshots: 24,
    accruing: null,
  });
});

test("a blank budget leaves the estimate out without failing the pass", async () => {
  const { dataDir, run } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  // The runner does not start with such a file; a pass given one publishes who is earning and no amounts.
  const undecided = parseProgram(PROGRAM.replace("HUSDT: 1", "HUSDT:"), config);
  const status = await run(start + 3 * HOUR, { program: undecided });
  assert.equal(status.snapshots, 3);
  assert.equal(latest().assets.HUSDT.budgetPerDay, null);
  assert.equal(latest().openEpoch.snapshots, 3);
  assert.equal(latest().openEpoch.accruing, null);
});

test("an open epoch that a newer program file on disk will pay has no estimate from the running one", async () => {
  const { dataDir, run } = runner();
  const path = join(dataDir, "public", "latest.json");
  const latest = () => JSON.parse(readFileSync(path, "utf8"));
  // The file on disk applies from 2026-11-13. The epoch before it is the running file's, estimate and all.
  const waiting = { pendingProgramFrom: "2026-11-13" };
  await run(start + 3 * HOUR, waiting);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.a]: "125000" });

  // 2026-11-12 closes with the running file. 2026-11-13 is open with one hour in, and the file on disk
  // will pay it, with budgets this runner has not loaded: no amount is shown, and that is no failure.
  const status = await run(start + 25 * HOUR, waiting);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    [FIRST],
  );
  assert.deepEqual(latest().openEpoch, {
    id: "2026-11-13",
    start: start + 24 * HOUR,
    end: start + 48 * HOUR,
    snapshots: 1,
    expectedSnapshots: 24,
    accruing: null,
  });

  // It is nothing to try again either: a pass with nothing new does not read the newest snapshot,
  // which could not be read as one any more.
  const current = readFileSync(path, "utf8");
  const hour = join(dataDir, "snapshots", `${start + 24 * HOUR}.json`);
  const taken = readFileSync(hour, "utf8");
  writeFileSync(hour, "{ cut short");
  assert.deepEqual((await run(start + 25 * HOUR + 60, waiting)).taken, []);
  assert.equal(readFileSync(path, "utf8"), current);
  writeFileSync(hour, taken);

  // The file on disk is taken back: the estimate is there after the next pass, with no hour due. And
  // it goes again on the pass that finds a file waiting for this epoch.
  assert.deepEqual((await run(start + 25 * HOUR + 120)).taken, []);
  assert.deepEqual(latest().openEpoch.accruing, { [ACCOUNTS.b]: "41666" });
  assert.deepEqual((await run(start + 25 * HOUR + 180, waiting)).taken, []);
  assert.equal(latest().openEpoch.accruing, null);
});

// What a runner wrote under its data directory, by the hash of each file's bytes.
function written(dataDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const dir of ["epochs", "trees", "public", "public/trees"]) {
    for (const entry of readdirSync(join(dataDir, dir), { withFileTypes: true })) {
      if (entry.isFile()) files[`${dir}/${entry.name}`] = sha256(readFileSync(join(dataDir, dir, entry.name), "utf8"));
    }
  }
  return files;
}

// Two closed epochs and the first hour of the third, with the program file of these tests (PROGRAM): the
// files the version before ends_at wrote for those hours, each by its hash. They were taken from a run
// of that version; a change that means to alter what the runner writes, or the snapshots these tests
// make, changes them with it.
const BEFORE_ENDS_AT = {
  "epochs/2026-11-12.csv": "0xc3189280ad4690696e8c56891ea21e2a4c825ee9bdea3e412148b881e251f396",
  "epochs/2026-11-12.summary.json": "0x961fc207d808344b774d39db82bb89e260832179cdfab75359cb86af345a8706",
  "epochs/2026-11-13.csv": "0x3d889d95cdfe3f1cc11986c2ceba510d521b660fbbbdf9db02ee7f736e23eb8a",
  "epochs/2026-11-13.summary.json": "0x3e9d801388b2cb701da203c03e007b412e8d067e0a67ecb7d6bf2527107114fe",
  "trees/2026-11-12.json": "0xb223a3f917e6d0d4226c4277aab3408ed498165b2728261f112a9f4b85e98488",
  "trees/2026-11-13.json": "0xb626c2c2227593a15e49d56b708b8a815c0e7b054d611e23777291442112721c",
  "public/latest.json": "0x4dbbb6fc09167bdd1392528add5df42b4c4dfd746479b29a7ea34c53fe38e5f2",
  "public/trees/0x0b7d2e1ca651084f58124af649f0214a0c11a07e87dca58e29548f96d01980b8.json":
    "0x09fbc673c5e898f10c3a9d8dea4b2b8291b420fd32d2cde919a817ff199cda96",
  "public/trees/0xf9717720462ed655949825ae89f56560825a9c19ddde76990abceda8e8b5dd99.json":
    "0x682301e6c682d7f82d8ed816854a54658e713221ea8567e78485348559e7b7f2",
};

test("a program file without ends_at writes what it wrote before there was such a setting", async () => {
  const { dataDir, run } = runner();
  await run(start + 49 * HOUR);
  assert.deepEqual(written(dataDir), BEFORE_ENDS_AT);
});

test("the epoch that ends at ends_at is the last one closed, and it pays in full what it pays without an end", async () => {
  const withEnd = runner();
  const status = await withEnd.run(END, { program: ending });
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed]),
    [
      [FIRST, "1000000"],
      ["2026-11-13", "1000000"],
    ],
  );
  assert.equal(withEnd.tree("2026-11-13").claims[ACCOUNTS.b].claimable, "1000000");

  // The same hours under the same settings without an end: every CSV, tree and claims file is the same,
  // byte for byte, and the summaries differ in nothing but the program file they record.
  const without = runner();
  await without.run(END);
  const files = Object.keys(written(without.dataDir)).filter((file) => file !== "public/latest.json");
  assert.equal(files.length, 8);
  for (const file of files) {
    const [a, b] = [withEnd, without].map((r) => readFileSync(join(r.dataDir, file), "utf8"));
    if (!file.endsWith(".summary.json")) assert.equal(a, b, file);
    else assert.deepEqual({ ...JSON.parse(a), program: null }, { ...JSON.parse(b), program: null }, file);
  }
});

test("once the last epoch has its tree a pass takes nothing, closes nothing and succeeds, and says the program ended", async () => {
  const { denylistPath, asked, run, tree } = runner();
  const lines: string[] = [];
  const ended =
    /^the program ended at 2026-11-14T14:00:00\.000Z: this program file takes no hour and closes no epoch from then on; to go on, restart the runner with a program file that applies from 2026-11-14$/;

  // An hour before the end the last epoch is open like any other.
  const before = await run(END - HOUR, { program: ending });
  assert.equal(before.waiting, null);
  assert.equal(before.openEpoch, "2026-11-13");

  // The pass that closes the last epoch says so already, in its status and once in the log.
  const last = await run(END, { program: ending, log: (line) => lines.push(line) });
  assert.deepEqual(
    last.closed.map((c) => c.epoch),
    ["2026-11-13"],
  );
  assert.match(String(last.waiting), ended);
  assert.match(String(lines.at(-2)), /^epoch 2026-11-13 closed: /);
  assert.equal(lines.at(-1), last.waiting);

  // Half a day later nothing was asked of the chain, and the pass is no failure: it returns its status,
  // which still carries the last tree for the root to be posted and accepted.
  asked.length = 0;
  lines.length = 0;
  const idle = await run(END + 12 * HOUR, { program: ending, log: (line) => lines.push(line) });
  assert.deepEqual(asked, []);
  assert.deepEqual(lines, []);
  assert.deepEqual(idle, {
    openEpoch: "2026-11-14",
    snapshots: 0,
    taken: [],
    closed: [],
    latestTree: { epoch: "2026-11-13", root: tree("2026-11-13").root, sha256: last.closed[0].treeSha256 },
    denylist: { sha256: loadDenylist(denylistPath).sha256, provisional: false },
    waiting: last.waiting,
    blocked: [],
  });
});

test("after the end latest.json says that no epoch is open, and a pass with nothing new leaves it unread and unwritten", async () => {
  const { dataDir, run, tree } = runner();
  const path = join(dataDir, "public", "latest.json");
  const latest = () => JSON.parse(readFileSync(path, "utf8"));

  // Before the end the file already names it, next to the open epoch.
  await run(END - HOUR, { program: ending });
  assert.deepEqual(latest().program, {
    name: "bot test",
    sha256: ending.sha256,
    maxHollarDebtUsd: "5.00",
    endsAt: END,
  });
  assert.equal(latest().openEpoch.id, "2026-11-13");
  assert.equal(latest().openEpoch.snapshots, 23);

  // The pass that closes the last epoch: no epoch is open, and the file stays at the last snapshot.
  await run(END, { program: ending });
  const after = readFileSync(path, "utf8");
  assert.equal(latest().openEpoch, null);
  assert.deepEqual(Object.keys(latest()).slice(-2), ["latestTree", "openEpoch"]);
  assert.equal(latest().program.endsAt, END);
  assert.equal(latest().asOf.hour, END - HOUR);
  assert.deepEqual(latest().latestTree, { epoch: "2026-11-13", root: tree("2026-11-13").root });
  assert.deepEqual(latest().accounts, { [ACCOUNTS.b]: { earning: true, hollarDebtUsd: "0.00" } });

  // A later pass does not take that null for a file to rebuild. It reads no snapshot: the last one
  // could not be read as one any more, and the pass succeeds all the same and writes nothing.
  const hour = join(dataDir, "snapshots", `${END - HOUR}.json`);
  const taken = readFileSync(hour, "utf8");
  const writtenAt = statSync(path).mtimeMs;
  writeFileSync(hour, "{ cut short");
  const idle = await run(END + 3 * HOUR, { program: ending });
  assert.deepEqual(idle.taken, []);
  assert.equal(readFileSync(path, "utf8"), after);
  assert.equal(statSync(path).mtimeMs, writtenAt);
  writeFileSync(hour, taken);

  // A file that is lost, or that an older version left without the key, is written again as it was.
  rmSync(path);
  await run(END + 3 * HOUR + 60, { program: ending });
  assert.equal(readFileSync(path, "utf8"), after);
  const { openEpoch: _, ...older } = JSON.parse(after);
  writeFileSync(path, toJson(older));
  await run(END + 3 * HOUR + 120, { program: ending });
  assert.equal(readFileSync(path, "utf8"), after);
});

test("no hour at or after ends_at is taken or closed, also after a long downtime across the end", async () => {
  const { dataDir, asked, run, writeHour } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  await run(start + 40 * HOUR, { program: ending });
  assert.equal(asked.length, 40);

  // Down for a month, across the end. The 720 hours since are far more than the runner catches up on,
  // but only the eight before the end are due: with a limit of seven that is refused, with eight it is not.
  const monthLater = END + 30 * 24 * HOUR;
  asked.length = 0;
  await assert.rejects(
    run(monthLater, { program: ending, maxBacklog: 7 }),
    /^Error: 8 snapshots are overdue since 2026-11-14T06:00:00\.000Z, more than the 7 /,
  );
  assert.deepEqual(asked, []);
  const status = await run(monthLater, { program: ending, maxBacklog: 8 });
  assert.deepEqual(
    asked,
    Array.from({ length: 8 }, (_, k) => start + (40 + k) * HOUR),
  );
  assert.deepEqual(status.taken, asked);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    ["2026-11-13"],
  );
  assert.match(String(status.waiting), /^the program ended at 2026-11-14T14:00:00\.000Z/);
  assert.equal(latest().asOf.hour, END - HOUR);

  // Every hour of the day after the end put on disk by hand: this file closes no epoch with them, and
  // latest.json stays at the last hour before the end.
  for (let k = 48; k < 72; k++) writeHour(start + k * HOUR);
  asked.length = 0;
  const later = await run(monthLater + 60, { program: ending });
  assert.deepEqual(asked, []);
  assert.deepEqual(later.closed, []);
  assert.equal(later.openEpoch, "2026-11-14");
  assert.equal(existsSync(join(dataDir, "trees", "2026-11-14.json")), false);
  assert.equal(latest().asOf.hour, END - HOUR);
  assert.equal(latest().openEpoch, null);
});

test("a program that has ended is continued by a program file that applies from the epoch starting at its end", async () => {
  const { dataDir, asked, run, tree } = runner();
  const latest = () => JSON.parse(readFileSync(join(dataDir, "public", "latest.json"), "utf8"));
  const next = programOf({ husdt: 2, from: "2026-11-14" });

  // Restarted with the following file before the last epoch is closed: refused, as for any file that comes too early.
  await run(start + 40 * HOUR, { program: ending });
  await assert.rejects(
    run(start + 40 * HOUR + 60, { program: next }),
    /program: epoch 2026-11-13 is before 2026-11-14, the first epoch this program file applies to; close it with the program file that applied then, or restart the runner with that file until it has/,
  );

  // The following file on disk once the program has ended: the running one says to restart with it,
  // and still fails nothing and takes nothing.
  await run(END + 2 * HOUR, { program: ending });
  const told = await run(END + 2 * HOUR + 60, { program: ending, pendingProgramFrom: "2026-11-14" });
  assert.equal(
    told.waiting,
    "the program ended at 2026-11-14T14:00:00.000Z: this program file takes no hour and closes no epoch from then on; " +
      "restart the runner with the program file on disk, which applies from 2026-11-14",
  );
  assert.equal(asked.length, 48);
  assert.equal(latest().openEpoch, null);

  // Restarted with it: the hours from the end on, which the ended file left alone, are taken, and its
  // first epoch closes on top of the last tree of the program before.
  const status = await run(END + 24 * HOUR, { program: next });
  assert.deepEqual(
    asked.slice(48),
    Array.from({ length: 24 }, (_, k) => END + k * HOUR),
  );
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed]),
    [["2026-11-14", "2000000"]],
  );
  assert.equal(status.waiting, null);
  assert.equal(tree("2026-11-14").previousRoot, tree("2026-11-13").root);
  assert.equal(tree("2026-11-14").claims[ACCOUNTS.a].claimable, "3000000");
  // An epoch is open again, and the file that has no end names none.
  assert.equal(latest().openEpoch.id, "2026-11-15");
  assert.deepEqual(latest().program, { name: "bot test", sha256: next.sha256, maxHollarDebtUsd: "5.00" });

  // The ended file put back after that is the older file, and is told so.
  await assert.rejects(
    run(END + 24 * HOUR + 60, { program: ending }),
    /program: epoch 2026-11-14 was closed with a newer program file \(0x[0-9a-f]{64}, which applies from 2026-11-14\) than this one \(applies from 2026-11-12\); restart the runner with that file/,
  );
});

test("a runner whose program has ended does not fail: its log has no FAILED, and --once exits 0", async () => {
  // A data directory whose program ended on 2026-11-14, days before this test runs.
  const { dataDir, denylistPath, run, tree } = runner();
  await run(END, { program: ending });
  const programPath = join(dataDir, "program.yaml");
  writeFileSync(programPath, ENDING);
  // The node cannot be reached, so the pass would fail if it asked for a single hour.
  const once = botProcess(dataDir, "--first-epoch", FIRST, "--program", programPath, "--denylist", denylistPath);
  assert.equal(once.status, 0, once.stderr);
  assert.match(once.stdout, / applies from 2026-11-12 and ends at 2026-11-14T14:00:00\.000Z; denylist /);
  assert.doesNotMatch(once.stdout, /FAILED/);
  const status = JSON.parse(readFileSync(join(dataDir, "status.json"), "utf8"));
  assert.equal(status.error, null);
  assert.match(status.waiting, /^the program ended at 2026-11-14T14:00:00\.000Z: /);
  assert.equal(status.openEpoch, "2026-11-14");
  assert.deepEqual(status.taken, []);
  assert.deepEqual(status.closed, []);
  assert.equal(status.latestTree.root, tree("2026-11-13").root);

  // A program without an end is announced as before.
  const data = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  writeFileSync(join(data, "program.yaml"), PROGRAM);
  const plain = botProcess(data, "--first-epoch", "2999-01-01", "--program", join(data, "program.yaml"));
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, / applies from 2026-11-12; denylist /);
});
