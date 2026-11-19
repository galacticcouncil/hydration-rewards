// A program with an end (ends_at) when epochs are shorter than a day (config.epoch.lengthSeconds):
// three-hour epochs of three hourly snapshots, counted from 23:00 UTC, which end at 02, 05, 08, 11, 14,
// 17, 20 and 23 UTC. The program of these tests pays two of them, 08:00 to 14:00 UTC on 17 November
// 2026, each an eighth of the day's budgets. The amounts here are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tick } from "../src/bot.ts";
import { closeEpochToDisk } from "../src/close-epoch.ts";
import { loadDenylist, makeDenylist } from "../src/lib/denylist.ts";
import { toJson } from "../src/lib/io.ts";
import { previewProgram } from "../src/preview.ts";
import { parseProgram } from "../src/program.ts";
import { latestPath } from "../src/publish.ts";
import type { Config, LatestFile, Program, Tree } from "../src/types.ts";
import { ACCOUNTS, makeDataDir, makeSnapshot } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const mainnet = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8")) as Config;
const HOUR = 3600;
const THREE_HOURS = 3 * HOUR;
// The mainnet config with three-hour epochs of three hourly snapshots.
const config: Config = { ...mainnet, epoch: { snapshotsPerEpoch: 3, lengthSeconds: THREE_HOURS } };
const START_HOUR = 23;
const FIRST = "2026-11-17T08";
const SECOND = "2026-11-17T11";
// The epoch that starts where the program ends. The program's file never pays it.
const AFTER = "2026-11-17T14";
// The first epoch starts at 08:00 UTC on 17 November 2026, and the program ends with the second, at 14:00.
const START = 1_794_902_400;
const END = START + 2 * THREE_HOURS;

const programText = ({
  husdc = "1",
  husdt = "1",
  from = FIRST,
  startHour = String(START_HOUR),
  endsAt = "2026-11-17T14:00:00Z",
} = {}) => `name: three-hour end test
applies_from_epoch: ${from}
${endsAt && `ends_at: ${endsAt}\n`}budget_per_day:
  HUSDC: ${husdc}
  HUSDT: ${husdt}
epoch_start_hour_utc: ${startHour}
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const programOf = (options: Parameters<typeof programText>[0] = {}) =>
  parseProgram(programText(options), config, { requireDecisions: true });
const ending = programOf();
// The file that continues: it applies from the epoch that starts at the end, and has no end itself.
const following = programOf({ from: AFTER, husdt: "2", endsAt: "" });

const ENDED =
  "the program ended at 2026-11-17T14:00:00.000Z: this program file takes no hour and closes no epoch from then on; ";

// A runner with the three-hour config over an empty data directory. One account holds all the HUSDT of
// an epoch, and nobody holds HUSDC: a in the first epoch, b in the second, c from the end on.
function runner(program: Program = ending) {
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [] });
  const writeHour = (target: number) => {
    const account = [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c][Math.min(Math.floor((target - START) / THREE_HOURS), 2)];
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: { [account]: { husdt: 10 } },
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  // Every hour the runner asks the chain for.
  const asked: number[] = [];
  const takeHour = async (target: number) => {
    asked.push(target);
    writeHour(target);
  };
  const run = (now: number, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
    tick({ now, dataDir, program, config, denylistPath, firstEpoch: FIRST, takeHour, ...extra });
  const latest = (): LatestFile => JSON.parse(readFileSync(latestPath(dataDir), "utf8"));
  const treePath = (epoch: string) => join(dataDir, "trees", `${epoch}.json`);
  const tree = (epoch: string): Tree => JSON.parse(readFileSync(treePath(epoch), "utf8"));
  return { dataDir, denylistPath, asked, run, latest, treePath, tree, writeHour };
}

test("with three-hour epochs ends_at is a moment one of them ends at, after the hour applies_from_epoch names", () => {
  const withEnd = (endsAt: string, options: Parameters<typeof programText>[0] = {}, withConfig = config) =>
    parseProgram(programText({ ...options, endsAt }), withConfig);

  // 15 January 2027 at 14:00 UTC is one of the eight hours a three-hour epoch counted from 23:00 ends at.
  assert.equal(withEnd("2027-01-15T14:00:00Z").endsAt, 1_800_021_600);
  for (const hour of ["02", "05", "08", "11", "14", "17", "20", "23"]) {
    assert.equal(withEnd(`2027-01-15T${hour}:00:00Z`).endsAt, Date.UTC(2027, 0, 15, Number(hour)) / 1000, hour);
  }
  // Any other hour is refused, and the refusal lists them.
  for (const hour of ["00", "13", "15", "22"]) {
    assert.throws(() => withEnd(`2027-01-15T${hour}:00:00Z`), {
      message:
        "program: ends_at must be a time an epoch ends at, and with epoch_start_hour_utc 23 epochs of 10800 seconds " +
        `end at 02:00, 05:00, 08:00, 11:00, 14:00, 17:00, 20:00, 23:00 UTC; got 2027-01-15T${hour}:00:00Z`,
    });
  }
  // The length decides: with one-day epochs and the same start hour only 23:00 is such a moment.
  const oneDay = { from: "2026-11-17" };
  assert.equal(withEnd("2027-01-15T23:00:00Z", oneDay, mainnet).endsAt, Date.UTC(2027, 0, 15, 23) / 1000);
  assert.throws(
    () => withEnd("2027-01-15T14:00:00Z", oneDay, mainnet),
    /with epoch_start_hour_utc 23 epochs end at 23:00 UTC; got 2027-01-15T14:00:00Z/,
  );

  // The file pays at least one epoch. applies_from_epoch names the hour its epoch starts at, 08:00 on
  // 17 November: an end at that hour or before it pays none, and the end of that epoch, 11:00, pays one.
  for (const endsAt of ["2026-11-17T08:00:00Z", "2026-11-17T05:00:00Z", "2026-11-16T11:00:00Z"]) {
    assert.throws(() => withEnd(endsAt), {
      message:
        `program: ends_at ${endsAt} is not after the start of applies_from_epoch 2026-11-17T08, ` +
        "so this file would pay no epoch",
    });
  }
  assert.equal(withEnd("2026-11-17T11:00:00Z").endsAt, START + THREE_HOURS);
  // While the start hour is undecided there are no hours to hold the end to yet, and the first epoch
  // still starts at the hour its id names.
  const noHour = { startHour: "" };
  assert.throws(
    () => withEnd("2026-11-17T08:00:00Z", noHour),
    /ends_at 2026-11-17T08:00:00Z is not after the start of applies_from_epoch 2026-11-17T08/,
  );
  assert.equal(withEnd("2026-11-17T09:00:00Z", noHour).endsAt, START + HOUR);
  // Blank, the program has no end.
  assert.equal(withEnd("").endsAt, null);
});

test("the three-hour epoch that ends at ends_at is the last one closed, and it pays its eighth of the day in full", async () => {
  const withEnd = runner();
  const status = await withEnd.run(END);
  // 1 PRIME a day is 125000 per three-hour epoch. Nobody holds HUSDC, so its eighth is not distributed.
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed]),
    [
      [FIRST, "125000"],
      [SECOND, "125000"],
    ],
  );
  assert.equal(withEnd.tree(SECOND).claims[ACCOUNTS.a].claimable, "125000");
  assert.equal(withEnd.tree(SECOND).claims[ACCOUNTS.b].claimable, "125000");
  const summary = JSON.parse(readFileSync(join(withEnd.dataDir, "epochs", `${SECOND}.summary.json`), "utf8"));
  assert.deepEqual(summary.budgets, { HUSDC: "125000", HUSDT: "125000" });
  assert.deepEqual(summary.window, { start: END - THREE_HOURS, end: END });
  assert.equal(new Date(summary.window.end * 1000).toISOString(), "2026-11-17T14:00:00.000Z");

  // The same hours under the same settings without an end: every tree and CSV is the same, byte for byte.
  const without = runner(programOf({ endsAt: "" }));
  await without.run(END);
  for (const file of [`trees/${FIRST}.json`, `trees/${SECOND}.json`, `epochs/${FIRST}.csv`, `epochs/${SECOND}.csv`]) {
    assert.equal(
      readFileSync(join(withEnd.dataDir, file), "utf8"),
      readFileSync(join(without.dataDir, file), "utf8"),
      file,
    );
  }
});

test("once the last three-hour epoch has its tree a pass is idle and succeeds, until a file that applies from the end takes over", async () => {
  const { denylistPath, asked, run, latest, tree } = runner();

  // An hour before the end the last epoch is open like any other.
  const before = await run(END - HOUR);
  assert.equal(before.waiting, null);
  assert.equal(before.openEpoch, SECOND);

  // The pass that closes it says that the program ended, and names the epoch a following file applies
  // from by the date and hour it starts at.
  const lines: string[] = [];
  const last = await run(END, { log: (line) => lines.push(line) });
  assert.deepEqual(
    last.closed.map((c) => c.epoch),
    [SECOND],
  );
  assert.equal(
    last.waiting,
    `${ENDED}to go on, restart the runner with a program file that applies from 2026-11-17T14`,
  );
  assert.equal(lines.at(-1), last.waiting);

  // Two hours later nothing was asked of the chain, and the pass is no failure: it returns its status,
  // which still carries the last tree for the root to be posted and accepted.
  asked.length = 0;
  lines.length = 0;
  const idle = await run(END + 2 * HOUR, { log: (line) => lines.push(line) });
  assert.deepEqual(asked, []);
  assert.deepEqual(lines, []);
  assert.deepEqual(idle, {
    openEpoch: AFTER,
    snapshots: 0,
    taken: [],
    closed: [],
    latestTree: { epoch: SECOND, root: tree(SECOND).root, sha256: last.closed[0].treeSha256 },
    denylist: { sha256: loadDenylist(denylistPath).sha256, provisional: false },
    waiting: last.waiting,
    blocked: [],
  });

  // The following file on disk: the ended runner says to restart with it, and still takes nothing. A
  // file on disk that applies from a later epoch is not the one that continues, and is not named.
  const told = await run(END + 2 * HOUR + 60, { pendingProgramFrom: AFTER });
  assert.equal(
    told.waiting,
    `${ENDED}restart the runner with the program file on disk, which applies from 2026-11-17T14`,
  );
  const later = await run(END + 2 * HOUR + 120, { pendingProgramFrom: "2026-11-17T17" });
  assert.equal(later.waiting, last.waiting);
  assert.deepEqual(asked, []);

  // Restarted with it: the hours from the end on are taken, and its first epoch closes on top of the
  // last tree of the program before. 2 PRIME a day is 250000 per three-hour epoch.
  const status = await run(END + THREE_HOURS, { program: following });
  assert.deepEqual(asked, [END, END + HOUR, END + 2 * HOUR]);
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed]),
    [[AFTER, "250000"]],
  );
  assert.equal(status.waiting, null);
  assert.equal(tree(AFTER).previousRoot, tree(SECOND).root);
  assert.equal(tree(AFTER).claims[ACCOUNTS.c].claimable, "250000");
  // An epoch is open again, and the file that has no end names none.
  assert.equal(latest().openEpoch?.id, "2026-11-17T17");
  assert.deepEqual(latest().program, {
    name: "three-hour end test",
    sha256: following.sha256,
    maxHollarDebtUsd: "5.00",
  });
});

test("latest.json of a three-hour program names its end, and after the end says that no epoch is open", async () => {
  const { dataDir, run, latest, tree } = runner();
  const path = latestPath(dataDir);

  // Before the end the file already names it, in unix seconds, next to the open epoch and its estimate:
  // two of the last epoch's three snapshots are in, and b holds all the HUSDT there is.
  await run(END - HOUR);
  assert.deepEqual(latest().program, {
    name: "three-hour end test",
    sha256: ending.sha256,
    maxHollarDebtUsd: "5.00",
    endsAt: 1_794_924_000,
  });
  assert.deepEqual(latest().openEpoch, {
    id: SECOND,
    start: END - THREE_HOURS,
    end: END,
    snapshots: 2,
    expectedSnapshots: 3,
    accruing: { [ACCOUNTS.b]: "83333" },
  });

  // The pass that closes the last epoch: no epoch is open, and the file stays at the last snapshot,
  // the hour before the end.
  await run(END);
  const after = readFileSync(path, "utf8");
  assert.match(after, /^  "openEpoch": null\n}\n$/m);
  assert.equal(latest().openEpoch, null);
  assert.equal(latest().program.endsAt, END);
  assert.equal(latest().asOf.hour, END - HOUR);
  assert.deepEqual(latest().latestTree, { epoch: SECOND, root: tree(SECOND).root });
  assert.deepEqual(latest().accounts, { [ACCOUNTS.b]: { earning: true, hollarDebtUsd: "0.00" } });
  assert.equal(latest().assets.HUSDT.budgetPerDay, "1000000");

  // A later pass does not take that null for a file to rebuild. It reads no snapshot: the last one
  // could not be read as one any more, and the pass succeeds all the same and writes nothing.
  const writtenAt = statSync(path).mtimeMs;
  writeFileSync(join(dataDir, "snapshots", `${END - HOUR}.json`), "{ cut short");
  const idle = await run(END + 4 * HOUR);
  assert.deepEqual(idle.taken, []);
  assert.equal(readFileSync(path, "utf8"), after);
  assert.equal(statSync(path).mtimeMs, writtenAt);
});

test("no hour at or after ends_at is taken with three-hour epochs, also after downtime across the end", async () => {
  const { dataDir, asked, run, latest, writeHour } = runner();
  await run(START + 4 * HOUR);
  assert.deepEqual(asked, [START, START + HOUR, START + 2 * HOUR, START + 3 * HOUR]);

  // Down for a day, across the end. Twenty-six hours have ended since, but only the two before the end
  // are due: with a limit of one that is refused, with two it is not.
  const dayLater = END + 24 * HOUR;
  asked.length = 0;
  await assert.rejects(
    run(dayLater, { maxBacklog: 1 }),
    /^Error: 2 snapshots are overdue since 2026-11-17T12:00:00\.000Z, more than the 1 /,
  );
  assert.deepEqual(asked, []);
  const status = await run(dayLater, { maxBacklog: 2 });
  assert.deepEqual(asked, [END - 2 * HOUR, END - HOUR]);
  assert.deepEqual(status.taken, asked);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    [SECOND],
  );
  assert.equal(status.waiting, `${ENDED}to go on, restart the runner with a program file that applies from ${AFTER}`);
  assert.equal(latest().asOf.hour, END - HOUR);

  // Every hour of the epoch after the end put on disk by hand: this file closes no epoch with them, and
  // latest.json stays at the last hour before the end.
  for (let k = 0; k < 3; k++) writeHour(END + k * HOUR);
  asked.length = 0;
  const later = await run(dayLater + 60);
  assert.deepEqual(asked, []);
  assert.deepEqual(later.closed, []);
  assert.equal(later.openEpoch, AFTER);
  assert.equal(existsSync(join(dataDir, "trees", `${AFTER}.json`)), false);
  assert.equal(latest().asOf.hour, END - HOUR);
  assert.equal(latest().openEpoch, null);
});

// A command as a separate process.
function cli(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, "src", script), ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("a three-hour epoch past ends_at is not closed by hand either, by closeEpochToDisk or by the command", () => {
  // The hours of the program's two epochs and of the one after its end, and no tree yet.
  const { dataDir, denylistPath, treePath, writeHour } = runner();
  for (let k = 0; k < 9; k++) writeHour(START + k * HOUR);
  const denylist = loadDenylist(denylistPath);
  const toDisk = (epoch: string, extra: Partial<Parameters<typeof closeEpochToDisk>[0]> = {}) =>
    closeEpochToDisk({ dataDir, epoch, program: ending, config, denylist, ...extra });

  // The epoch that ends at the end is the last one the file closes, and it pays in full.
  toDisk(FIRST, { genesis: true });
  assert.equal(toDisk(SECOND, { previousTreePath: treePath(FIRST) }).summary.distributed, "125000");

  // The epoch after it is refused however it is asked for.
  const previousTreePath = treePath(SECOND);
  for (const extra of [
    { previousTreePath },
    { previousTreePath, overwrite: true },
    { previousTreePath, allowPartial: true, now: END + 30 * 24 * HOUR },
    { previousTreePath: treePath(FIRST), allowGap: true },
  ]) {
    assert.throws(
      () => toDisk(AFTER, extra),
      /^Error: epoch 2026-11-17T14 ends at 2026-11-17T17:00:00\.000Z, after this program file's ends_at \(2026-11-17T14:00:00\.000Z\), and the file pays no epoch past its end; a later epoch is closed with a new program file, whose applies_from_epoch is the epoch that starts at ends_at$/,
    );
  }

  // The command reads the epoch length from --config, and refuses the same epoch.
  const folder = mkdtempSync(join(tmpdir(), "hydration-three-hours-"));
  const configPath = join(folder, "config.json");
  const programPath = join(folder, "program.yaml");
  writeFileSync(configPath, toJson(config));
  writeFileSync(programPath, programText());
  const close = (program: string) =>
    cli(
      "close-epoch.ts",
      ...["--epoch", AFTER, "--program", program, "--config", configPath, "--data", dataDir],
      ...["--denylist", denylistPath, "--prev", previousTreePath],
    );
  const refused = close(programPath);
  assert.equal(refused.status, 1);
  assert.match(
    refused.err,
    /^close-epoch: epoch 2026-11-17T14 ends at 2026-11-17T17:00:00\.000Z, after this program file's ends_at \(2026-11-17T14:00:00\.000Z\), and the file pays no epoch past its end/,
  );
  assert.equal(existsSync(treePath(AFTER)), false);
  assert.equal(existsSync(join(dataDir, "epochs", `${AFTER}.csv`)), false);

  // The file that continues, which applies from the epoch that starts at that end, closes it.
  const followingPath = join(folder, "following.yaml");
  writeFileSync(followingPath, programText({ from: AFTER, husdt: "2", endsAt: "" }));
  const closed = close(followingPath);
  assert.equal(closed.status, 0, closed.err);
  assert.match(closed.out, /^epoch 2026-11-17T14: 3 snapshots, 1 accounts paid, distributed 250000, dust 0, root /);
});

test("the preview counts the three-hour epochs up to ends_at, each paying an eighth of the day rounded down", () => {
  const snapshots = [0, 1, 2].map((h) =>
    makeSnapshot({ number: 1_000 + h, timestamp: START + h * HOUR, accounts: { [ACCOUNTS.a]: { husdt: 100 } } }),
  );
  const denylist = makeDenylist({ rules: { palletAccounts: true }, addresses: [] });
  const text = (options: Parameters<typeof programText>[0] = {}) =>
    previewProgram(parseProgram(programText(options), config), snapshots, {
      denylist,
      reward: config.reward,
      lengthSeconds: THREE_HOURS,
    }).text;

  // The program of these tests pays two epochs, an eighth of 1 PRIME each per asset.
  assert.match(
    text(),
    /^Until ends_at it pays 2 epochs, from 2026-11-17T08: HUSDC 0\.25, HUSDT 0\.25, 0\.5 PRIME in all$/m,
  );
  assert.match(
    text({ endsAt: "2026-11-17T11:00:00Z" }),
    /^Until ends_at it pays 1 epoch, from 2026-11-17T08: HUSDC 0\.125, HUSDT 0\.125, 0\.25 PRIME in all$/m,
  );
  // One day is eight epochs, and each rounds its eighth down as its close does: 100.000004 a day is
  // 12.5 an epoch and 80.000005 is 10, so the eight pay a little less than the day's budgets.
  assert.match(
    text({ husdc: "100.000004", husdt: "80.000005", endsAt: "2026-11-18T08:00:00Z" }),
    /^Until ends_at it pays 8 epochs, from 2026-11-17T08: HUSDC 100, HUSDT 80, 180 PRIME in all$/m,
  );
  // To 15 January 2027 at 14:00 UTC it is 474 epochs, at 34.452 PRIME each per asset.
  assert.match(
    text({ husdc: "275.616", husdt: "275.616", endsAt: "2027-01-15T14:00:00Z" }),
    /^Until ends_at it pays 474 epochs, from 2026-11-17T08: HUSDC 16330\.248, HUSDT 16330\.248, 32660\.496 PRIME in all$/m,
  );
  // The figures above it stay per day, and a program without an end has no such line.
  assert.match(text(), /^Budget per day: HUSDC 1, HUSDT 1 PRIME$/m);
  assert.doesNotMatch(text({ endsAt: "" }), /Until ends_at/);

  // The command takes the epoch length from --config.
  const { dataDir, denylistPath } = makeDataDir({ snapshots });
  const folder = mkdtempSync(join(tmpdir(), "hydration-three-hours-"));
  const configPath = join(folder, "config.json");
  const programPath = join(folder, "program.yaml");
  writeFileSync(configPath, toJson(config));
  writeFileSync(programPath, programText({ husdc: "100.000004", husdt: "80.000005", endsAt: "2026-11-18T08:00:00Z" }));
  const preview = cli(
    "preview.ts",
    ...["--program", programPath, "--config", configPath, "--data", dataDir, "--denylist", denylistPath],
  );
  assert.equal(preview.status, 0, preview.err);
  assert.match(preview.out, /^Snapshots 3 /m);
  assert.match(
    preview.out,
    /^Until ends_at it pays 8 epochs, from 2026-11-17T08: HUSDC 100, HUSDT 80, 180 PRIME in all$/m,
  );
});
