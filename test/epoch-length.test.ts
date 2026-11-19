// Epochs shorter than a day (config.epoch.lengthSeconds): a test network that closes an epoch, and so
// gets a new root, every four hours. The program's epochs start at 23:00 UTC and every four hours after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tick } from "../src/bot.ts";
import { buildTree } from "../src/build-tree.ts";
import { closeEpochToDisk, epochWindow, storedTreeEpochs } from "../src/close-epoch.ts";
import { loadDenylist } from "../src/lib/denylist.ts";
import {
  addEpochs,
  DAY,
  epochLength,
  epochStart,
  formatEpochId,
  parseEpochId,
  snapshotInterval,
} from "../src/lib/epoch.ts";
import { toJson } from "../src/lib/io.ts";
import { parseProgram } from "../src/program.ts";
import { latestPath } from "../src/publish.ts";
import { snapshotHour } from "../src/snapshot.ts";
import type { Config, LatestFile, Rpc, Tree } from "../src/types.ts";
import { ACCOUNTS, hourly, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";
import type { Holdings } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const mainnet = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8")) as Config;
const HOUR = 3600;
const FOUR_HOURS = 4 * HOUR;
// The mainnet config with four-hour epochs of four hourly snapshots.
const config: Config = { ...mainnet, epoch: { snapshotsPerEpoch: 4, lengthSeconds: FOUR_HOURS } };
const START_HOUR = 23;
const FIRST = "2026-11-16T23";
const SECOND = "2026-11-17T03";
const THIRD = "2026-11-17T07";
const { start } = epochWindow(FIRST, START_HOUR, FOUR_HOURS);

const programText = ({ husdc = "1", husdt = "1", from = FIRST, startHour = String(START_HOUR) } = {}) =>
  `name: four-hour test
applies_from_epoch: ${from}
budget_per_day:
  HUSDC: ${husdc}
  HUSDT: ${husdt}
epoch_start_hour_utc: ${startHour}
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const programOf = (options: Parameters<typeof programText>[0] = {}, withConfig = config) =>
  parseProgram(programText(options), withConfig, { requireDecisions: true });

// The four hourly snapshots of the epoch that starts at `from`.
const fourHours = (from: number, holdingsAt: (hour: number) => Holdings, firstBlock = 1_000) =>
  hourly(from, holdingsAt, firstBlock).slice(0, 4);

// A data directory with the snapshots of the first three epochs: a holds in the first, b in the second, c in the third.
function threeEpochs() {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c].flatMap((account, k) =>
      fourHours(start + k * FOUR_HOURS, () => ({ [account]: { husdc: 10, husdt: 10 } }), (k + 1) * 1_000),
    ),
  });
  const denylist = loadDenylist(denylistPath);
  const treePath = (epoch: string) => join(dataDir, "trees", `${epoch}.json`);
  type Options = Partial<Parameters<typeof closeEpochToDisk>[0]>;
  const close = (epoch: string, options: Options = {}) =>
    closeEpochToDisk({
      dataDir,
      epoch,
      program: programOf({ husdc: "275.616", husdt: "80" }),
      config,
      denylist,
      ...options,
    });
  // As the runner closes it: the first epoch as the genesis tree, any other on the tree of the epoch before.
  const toDisk = (epoch: string, extra: Options = {}) =>
    close(epoch, {
      genesis: epoch === FIRST,
      previousTreePath: epoch === FIRST ? null : treePath(addEpochs(epoch, -1, FOUR_HOURS)),
      ...extra,
    });
  return { dataDir, denylistPath, denylist, treePath, close, toDisk };
}

test("the id of an epoch shorter than a day is the UTC date and hour it starts at", () => {
  assert.equal(parseEpochId(SECOND, FOUR_HOURS), Date.UTC(2026, 10, 17, 3));
  assert.equal(formatEpochId(Date.UTC(2026, 10, 17, 3), FOUR_HOURS), SECOND);
  // A date alone is the id of a one-day epoch, and the refusal says so.
  assert.throws(
    () => parseEpochId("2026-11-17", FOUR_HOURS),
    /an epoch of 14400 seconds must be the UTC date and hour it starts at, like 2026-11-17T03, got 2026-11-17 \(a date alone names a one-day epoch\)/,
  );
  // Anything that is not a real date and hour in exactly that form: one window must not have two names,
  // and an id becomes a file name.
  for (const epoch of [
    "2026-11-17T24",
    "2026-11-31T03",
    "2026-13-01T03",
    "2026-11-17T3",
    "2026-11-17T03:00",
    "2026-11-17T03:00:00Z",
    "2026-11-17 03",
    "2026-11-17t03",
    "../2026-11-17T03",
    "",
  ]) {
    assert.throws(() => parseEpochId(epoch, FOUR_HOURS), /must be the UTC date and hour it starts at/, epoch);
  }

  // With one-day epochs nothing changed: an id is a date, and a date and hour is refused as before.
  assert.equal(parseEpochId("2026-11-12"), Date.UTC(2026, 10, 12));
  assert.equal(parseEpochId("2026-11-12", DAY), Date.UTC(2026, 10, 12));
  assert.equal(formatEpochId(Date.UTC(2026, 10, 12, 14)), "2026-11-12");
  assert.throws(() => parseEpochId(SECOND), /an epoch must be a date like 2026-11-12, got 2026-11-17T03/);
  assert.throws(() => parseEpochId(SECOND, DAY), /an epoch must be a date like 2026-11-12/);
  // A length that no config can have is refused here too.
  assert.throws(() => parseEpochId(SECOND, 5_000), /an epoch's length must be a whole number of hours/);
});

test("the window of a shorter epoch starts at the hour its id names, and only on the program's hours", () => {
  assert.equal(new Date(start * 1000).toISOString(), "2026-11-16T23:00:00.000Z");
  assert.deepEqual(epochWindow(FIRST, START_HOUR, FOUR_HOURS), { start, end: start + FOUR_HOURS });
  assert.equal(epochStart(SECOND, START_HOUR, FOUR_HOURS), start + FOUR_HOURS);
  // Four-hour epochs counted from 23:00 start at 03, 07, 11, 15, 19 and 23.
  for (const hour of ["03", "07", "11", "15", "19", "23"]) {
    assert.doesNotThrow(() => epochWindow(`2026-11-17T${hour}`, START_HOUR, FOUR_HOURS), hour);
  }
  for (const hour of ["00", "01", "02", "04", "12", "22"]) {
    assert.throws(
      () => epochWindow(`2026-11-17T${hour}`, START_HOUR, FOUR_HOURS),
      new RegExp(
        `2026-11-17T${hour} is not an epoch: with epochs of 14400 seconds and epoch_start_hour_utc 23, ` +
          "an epoch starts at hour 03, 07, 11, 15, 19, 23 UTC",
      ),
    );
  }
  // Another start hour moves the hours with it.
  assert.doesNotThrow(() => epochWindow("2026-11-17T04", 0, FOUR_HOURS));
  assert.throws(() => epochWindow(SECOND, 0, FOUR_HOURS), /an epoch starts at hour 00, 04, 08, 12, 16, 20 UTC/);

  // The id is checked first and the start hour is still required, as for a one-day epoch.
  assert.throws(() => epochWindow("2026-11-17", START_HOUR, FOUR_HOURS), /a date alone names a one-day epoch/);
  assert.throws(() => epochWindow(SECOND, undefined, FOUR_HOURS), /required and has no default/);
  assert.throws(() => epochWindow(SECOND, 24, FOUR_HOURS), /required and has no default/);

  // One-day epochs: the window is the date plus the start hour, with or without the length given.
  const day = { start: Date.UTC(2026, 10, 12, 14) / 1000, end: Date.UTC(2026, 10, 13, 14) / 1000 };
  assert.deepEqual(epochWindow("2026-11-12", 14), day);
  assert.deepEqual(epochWindow("2026-11-12", 14, DAY), day);
  assert.throws(() => epochWindow(SECOND, 14), /must be a date like 2026-11-12/);
});

test("the next epoch is one epoch length on, across midnight and the end of a month", () => {
  const ids = Array.from({ length: 8 }, (_, k) => addEpochs(FIRST, k, FOUR_HOURS));
  assert.deepEqual(ids, [
    "2026-11-16T23",
    "2026-11-17T03",
    "2026-11-17T07",
    "2026-11-17T11",
    "2026-11-17T15",
    "2026-11-17T19",
    "2026-11-17T23",
    "2026-11-18T03",
  ]);
  // Each window starts where the one before ended, and the ids sort as strings in that order.
  for (const [k, id] of ids.entries()) assert.equal(epochStart(id, START_HOUR, FOUR_HOURS), start + k * FOUR_HOURS);
  assert.deepEqual([...ids].reverse().sort(), ids);
  assert.equal(addEpochs(SECOND, -1, FOUR_HOURS), FIRST);
  assert.equal(addEpochs("2026-11-30T23", 1, FOUR_HOURS), "2026-12-01T03");
  assert.equal(addEpochs("2027-01-01T03", -1, FOUR_HOURS), "2026-12-31T23");

  // One-day epochs step by a calendar day, as they always did.
  assert.equal(addEpochs("2026-11-30", 1), "2026-12-01");
  assert.equal(addEpochs("2026-11-12", -1), "2026-11-11");
  assert.equal(addEpochs("2026-11-12", 1, DAY), "2026-11-13");
});

test("the epoch length is a whole number of hours that divides a day and is split evenly by the snapshots", () => {
  // Left out, an epoch is one day: the config every existing deployment has.
  assert.equal(epochLength({ epoch: { snapshotsPerEpoch: 24 } }), DAY);
  assert.equal(epochLength(mainnet), DAY);
  assert.equal(snapshotInterval(mainnet), HOUR);
  assert.equal(epochLength({ epoch: { snapshotsPerEpoch: 24, lengthSeconds: DAY } }), DAY);
  assert.equal(epochLength(config), FOUR_HOURS);
  assert.equal(snapshotInterval(config), HOUR);

  const withLength = (lengthSeconds: unknown, snapshotsPerEpoch: unknown = 4) =>
    ({ ...mainnet, epoch: { snapshotsPerEpoch, lengthSeconds } }) as Config;
  // Not a whole number of hours, not a divisor of the day, or not a positive number at all.
  for (const length of [0, -14_400, 5_400, 14_400.5, 18_000, 172_800, "14400"]) {
    assert.throws(
      () => epochLength(withLength(length)),
      /config epoch\.lengthSeconds must be a whole number of hours that divides a day/,
      String(length),
    );
  }
  // Snapshots that would fall on fractions of a second, or no snapshots.
  for (const perEpoch of [7, 0, -4, 2.5]) {
    assert.throws(
      () => epochLength(withLength(FOUR_HOURS, perEpoch)),
      /config epoch\.snapshotsPerEpoch must split the epoch's 14400 seconds into whole seconds/,
      String(perEpoch),
    );
  }
  assert.throws(() => epochLength({ epoch: { snapshotsPerEpoch: 7 } }), /must split the epoch's 86400 seconds/);
});

test("every command refuses a config whose epoch length cannot work", async () => {
  const bad = { ...mainnet, epoch: { snapshotsPerEpoch: 4, lengthSeconds: 18_000 } };
  const refused = /config epoch\.lengthSeconds must be a whole number of hours that divides a day/;
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [] });
  const noChain: Rpc = {
    call: async () => assert.fail("the config is refused before the chain is asked anything"),
    batch: async () => assert.fail("the config is refused before the chain is asked anything"),
  };
  assert.throws(() => programOf({}, bad), refused);
  assert.throws(
    () =>
      closeEpochToDisk({
        dataDir,
        epoch: FIRST,
        program: programOf(),
        config: bad,
        denylist: loadDenylist(denylistPath),
        genesis: true,
      }),
    refused,
  );
  await assert.rejects(snapshotHour({ rpc: noChain, config: bad, dataDir, target: start }), refused);
  await assert.rejects(
    tick({
      now: start,
      dataDir,
      program: programOf(),
      config: bad,
      denylistPath,
      firstEpoch: FIRST,
      takeHour: async () => assert.fail("nothing is taken with a config that is refused"),
    }),
    refused,
  );
  // The snapshots of a four-hour epoch are still on the hour.
  await assert.rejects(
    snapshotHour({ rpc: noChain, config, dataDir, target: start + 1_800 }),
    /must be a multiple of 3600 seconds \(on the hour\)/,
  );
});

test("a program's first epoch is written in the form of the epoch length, on one of its hours", () => {
  assert.equal(programOf().appliesFromEpoch, FIRST);
  // A date, as a one-day program has it, is refused with what to write instead.
  assert.throws(
    () => programOf({ from: "2026-11-16" }),
    /applies_from_epoch: an epoch of 14400 seconds must be the UTC date and hour it starts at, like 2026-11-17T03, got 2026-11-16 \(a date alone names a one-day epoch\)/,
  );
  // An hour that no epoch of this program starts at.
  assert.throws(
    () => programOf({ from: "2026-11-17T00" }),
    /applies_from_epoch: 2026-11-17T00 is not an epoch: .* an epoch starts at hour 03, 07, 11, 15, 19, 23 UTC/,
  );
  assert.throws(() => programOf({ from: "2026-11-17T24" }), /applies_from_epoch: an epoch of 14400 seconds must be/);
  // While the start hour is undecided only the form can be checked; a close needs the hour anyway.
  assert.equal(
    parseProgram(programText({ from: "2026-11-17T00", startHour: "" }), config).appliesFromEpoch,
    "2026-11-17T00",
  );
  assert.throws(
    () => parseProgram(programText({ from: "2026-11-17", startHour: "" }), config),
    /a date alone names a one-day epoch/,
  );

  // With one-day epochs a date and hour is refused, with the message a bad date always had.
  assert.throws(
    () => programOf({ from: FIRST }, mainnet),
    /applies_from_epoch must be a date like 2027-01-15, got 2026-11-16T23/,
  );
  assert.equal(programOf({ from: "2026-11-16" }, mainnet).appliesFromEpoch, "2026-11-16");
});

test("a four-hour epoch closes on its four snapshots and pays a sixth of the day's budget, rounded down", () => {
  const { dataDir, toDisk, treePath } = threeEpochs();
  const { tree, summary } = toDisk(FIRST);

  // 275.616 PRIME a day is 45.936 per epoch exactly; 80 a day is 13.333333, and the rest is never paid.
  assert.deepEqual(summary.budgets, { HUSDC: "45936000", HUSDT: "13333333" });
  assert.equal(summary.distributed, String(45_936_000 + 13_333_333));
  assert.equal(summary.dust, "0");
  assert.deepEqual(summary.undistributed, {});
  // The program still says what it pays per day.
  assert.equal(programOf({ husdc: "275.616", husdt: "80" }).budgetPerDay.get("HUSDC"), 275_616_000n);

  assert.equal(summary.epoch, FIRST);
  assert.deepEqual(summary.window, { start, end: start + FOUR_HOURS });
  assert.deepEqual(
    summary.snapshots.map((s) => s.file),
    [0, 1, 2, 3].map((h) => `${start + h * HOUR}.json`),
  );
  assert.equal(summary.partial, false);
  assert.equal(summary.program?.appliesFromEpoch, FIRST);

  // The files are named after the id, and the tree is the genesis tree of its chain.
  assert.deepEqual(readdirSync(join(dataDir, "epochs")).sort(), [`${FIRST}.csv`, `${FIRST}.summary.json`]);
  assert.deepEqual(readdirSync(join(dataDir, "trees")), [`${FIRST}.json`]);
  assert.equal(readFileSync(treePath(FIRST), "utf8"), toJson(tree));
  assert.equal(tree.epoch, FIRST);
  assert.deepEqual(tree.window, { start, end: start + FOUR_HOURS });
  assert.equal(tree.previousEpoch, null);
  assert.deepEqual(
    [...parseCsv(readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8"))],
    [[ACCOUNTS.a, 59_269_333n]],
  );
  // Neither file gained a key for the length: the window says how long the epoch was.
  assert.deepEqual(Object.keys(tree), [
    "format",
    "epoch",
    "window",
    "previousEpoch",
    "previousRoot",
    "reward",
    "leafEncoding",
    "root",
    "totals",
    "accounts",
    "claims",
  ]);
  assert.ok(existsSync(join(dataDir, "public", "trees", `${tree.root}.json`)));
  assert.deepEqual(storedTreeEpochs(dataDir, FOUR_HOURS), [FIRST]);

  // Closing it again changes nothing.
  assert.doesNotThrow(() => toDisk(FIRST));
  assert.equal(readFileSync(treePath(FIRST), "utf8"), toJson(tree));
});

test("the next four-hour epoch builds on the tree of the one before, and no other", () => {
  const { toDisk, treePath } = threeEpochs();
  const first = toDisk(FIRST);
  const second = toDisk(SECOND);
  assert.equal(second.tree.previousEpoch, FIRST);
  assert.equal(second.tree.previousRoot, first.tree.root);
  assert.equal(second.summary.tree.previousEpoch, FIRST);
  assert.deepEqual(second.tree.window, { start: start + FOUR_HOURS, end: start + 2 * FOUR_HOURS });
  assert.equal(second.tree.claims[ACCOUNTS.a].claimable, "59269333"); // carried over
  assert.equal(second.tree.claims[ACCOUNTS.b].claimable, "59269333");

  // The third epoch on the first one's tree would drop what b earned in the second.
  assert.throws(
    () => toDisk(THIRD, { previousTreePath: treePath(FIRST) }),
    /previous tree is for 2026-11-16T23, but the epoch before 2026-11-17T07 is 2026-11-17T03; building on an older tree drops the rewards of the epochs in between/,
  );
  assert.throws(
    () => toDisk(THIRD, { previousTreePath: treePath(FIRST), allowGap: true }),
    /2026-11-17T07 would build on 2026-11-16T23, but 2026-11-17T03 is closed after it, .* drops the closed epochs in between; --allow-gap is only for epochs that have no tree/,
  );
  assert.throws(
    () => toDisk(THIRD, { genesis: true, previousTreePath: null }),
    /2026-11-17T03 is already closed, so 2026-11-17T07 cannot start a new chain \(--genesis\)/,
  );
  const third = toDisk(THIRD);
  assert.equal(third.tree.previousRoot, second.tree.root);
  assert.equal(third.tree.totals.cumulative, String(3 * 59_269_333));

  // A file that took over too late is told the first epoch not closed yet, four hours on.
  assert.throws(
    () => toDisk(THIRD, { program: programOf({ husdt: "2", from: SECOND }), overwrite: true }),
    /otherwise set applies_from_epoch to 2026-11-17T11, the first epoch not closed yet/,
  );
});

test("an id of the other epoch length is refused wherever one is given", () => {
  const { dataDir, denylist, close, toDisk } = threeEpochs();
  // --epoch: a date under the four-hour config, an hour that is no epoch, a date and hour under the daily one.
  assert.throws(() => close("2026-11-16", { genesis: true }), /got 2026-11-16 \(a date alone names a one-day epoch\)/);
  assert.throws(() => close("2026-11-17T00", { genesis: true }), /2026-11-17T00 is not an epoch/);
  assert.throws(
    () =>
      closeEpochToDisk({
        dataDir,
        epoch: FIRST,
        program: programOf({ from: "2026-11-16" }, mainnet),
        config: mainnet,
        denylist,
        genesis: true,
      }),
    /an epoch must be a date like 2026-11-12, got 2026-11-16T23/,
  );
  assert.equal(existsSync(join(dataDir, "trees")), false);

  // A previous tree of one-day epochs, from another data directory.
  const daily = makeDataDir({
    snapshots: hourly(epochWindow("2026-11-15", START_HOUR).start, () => ({ [ACCOUNTS.a]: { husdt: 10 } })),
  });
  const closedDaily = closeEpochToDisk({
    dataDir: daily.dataDir,
    epoch: "2026-11-15",
    program: programOf({ from: "2026-11-15" }, mainnet),
    config: mainnet,
    denylist,
    genesis: true,
  });
  assert.deepEqual(closedDaily.tree.window, { start: start - DAY, end: start }); // it ends where FIRST starts
  assert.throws(
    () => toDisk(FIRST, { genesis: false, previousTreePath: closedDaily.treePath }),
    /got 2026-11-15 \(a date alone names a one-day epoch\)/,
  );
  // The tree builder refuses it on its own as well, whichever of the two ids has the wrong form.
  const amounts = new Map([[ACCOUNTS.a, 1n]]);
  const window = epochWindow(FIRST, START_HOUR, FOUR_HOURS);
  assert.throws(
    () =>
      buildTree({
        epoch: FIRST,
        window,
        reward: mainnet.reward.address,
        epochAmounts: amounts,
        previous: closedDaily.tree,
        lengthSeconds: FOUR_HOURS,
      }),
    /got 2026-11-15 \(a date alone names a one-day epoch\)/,
  );
  assert.throws(
    () => buildTree({ epoch: FIRST, window, reward: mainnet.reward.address, epochAmounts: amounts, genesis: true }),
    /an epoch must be a date like 2026-11-12, got 2026-11-16T23/,
  );
});

test("trees closed with another epoch length are refused, not passed over as if the folder were empty", async () => {
  // A data directory that already holds a chain of one-day epochs.
  const { dataDir, denylistPath, denylist, toDisk } = threeEpochs();
  makeDataDir({
    snapshots: hourly(epochWindow("2026-11-15", START_HOUR).start, () => ({ [ACCOUNTS.a]: { husdt: 10 } }), 9_000),
    into: dataDir,
  });
  const daily = () =>
    closeEpochToDisk({
      dataDir,
      epoch: "2026-11-15",
      program: programOf({ from: "2026-11-15" }, mainnet),
      config: mainnet,
      denylist,
      genesis: true,
    });
  daily();
  const refused =
    /trees\/2026-11-15\.json is the tree of a one-day epoch, but epochs are 14400 seconds long here \(epoch\.lengthSeconds in the config\)/;
  // Passed over, the folder would look empty: this close would start a second chain without its amounts.
  assert.throws(() => toDisk(FIRST), refused);
  assert.throws(() => storedTreeEpochs(dataDir, FOUR_HOURS), refused);
  await assert.rejects(
    tick({
      now: start + FOUR_HOURS,
      dataDir,
      program: programOf(),
      config,
      denylistPath,
      firstEpoch: FIRST,
      takeHour: async () => assert.fail("nothing is taken beside a chain of another epoch length"),
    }),
    refused,
  );
  assert.deepEqual(readdirSync(join(dataDir, "trees")), ["2026-11-15.json"]);

  // The other way round: a four-hour tree in the folder of a one-day chain.
  writeFileSync(join(dataDir, "trees", `${FIRST}.json`), "{}");
  assert.throws(
    daily,
    /trees\/2026-11-16T23\.json is the tree of an epoch shorter than a day, but epochs are 86400 seconds long here/,
  );
  // Other files in the folder, such as what a write that was cut off leaves behind or a copy a person
  // set aside, are not epochs of either length, as before.
  const { dataDir: other } = makeDataDir({ snapshots: [] });
  mkdirSync(join(other, "trees"));
  const strays = [
    "2026-11-16T23.json.123.tmp",
    "2026-11-16.json.123.tmp",
    "2026-11-16T23-old.json",
    "old-2026-11-16T23.json",
    "2026-11-16-old.json",
    "old-2026-11-16.json",
    "notes.txt",
  ];
  for (const file of [...strays, `${SECOND}.json`]) writeFileSync(join(other, "trees", file), "{}");
  assert.deepEqual(storedTreeEpochs(other, FOUR_HOURS), [SECOND]);
  assert.deepEqual(storedTreeEpochs(join(other, "nowhere"), FOUR_HOURS), []);
  const { dataDir: dailyOnly } = makeDataDir({ snapshots: [] });
  mkdirSync(join(dailyOnly, "trees"));
  for (const file of [...strays, "2026-11-16.json"]) writeFileSync(join(dailyOnly, "trees", file), "{}");
  assert.deepEqual(storedTreeEpochs(dailyOnly), ["2026-11-16"]);
});

test("--allow-partial is accepted an hour after a four-hour epoch ends, and still pays the epoch's budget", () => {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: fourHours(start, () => ({ [ACCOUNTS.a]: { husdt: 10 } })).filter((_, h) => h !== 2),
  });
  const partial = (now: number) =>
    closeEpochToDisk({
      dataDir,
      epoch: FIRST,
      program: programOf(),
      config,
      denylist: loadDenylist(denylistPath),
      genesis: true,
      allowPartial: true,
      now,
    });
  const end = start + FOUR_HOURS;
  assert.throws(
    () => partial(start + 3 * HOUR),
    /epoch 2026-11-16T23 ends at 2026-11-17T03:00:00.000Z and its last hour is taken just after; --allow-partial is accepted from 2026-11-17T04:00:00.000Z/,
  );
  assert.throws(() => partial(end + 3599), /is accepted from 2026-11-17T04:00:00.000Z/);
  const { summary } = partial(end + HOUR);
  assert.equal(summary.snapshots.length, 3);
  assert.equal(summary.partial, true);
  assert.equal(summary.distributed, "166666"); // a sixth of 1 PRIME, rounded down
  // Without it the missing hour stops the close, counted against the epoch's four.
  assert.throws(
    () =>
      closeEpochToDisk({
        dataDir,
        epoch: FIRST,
        program: programOf(),
        config,
        denylist: loadDenylist(denylistPath),
        genesis: true,
      }),
    /epoch 2026-11-16T23 has 3 of 4 snapshots \(missing \d+\.json\)/,
  );
});

// A runner with the four-hour config over an empty data directory. Each epoch's snapshots hold one
// account, a, b and c in turn, so the trees show which epochs were closed.
function runner({ noBlockAt = null }: { noBlockAt?: number | null } = {}) {
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [] });
  const asked: number[] = [];
  const holders = [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c];
  const takeHour = async (target: number) => {
    asked.push(target);
    if (target === noBlockAt) throw Object.assign(new Error("no block in this hour"), { code: "NO_BLOCK_IN_HOUR" });
    const account = holders[Math.floor((target - start) / FOUR_HOURS) % holders.length];
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: { [account]: { husdt: 10 } },
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  const run = (now: number, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
    tick({ now, dataDir, program: programOf(), config, denylistPath, firstEpoch: FIRST, takeHour, ...extra });
  const tree = (epoch: string): Tree => JSON.parse(readFileSync(join(dataDir, "trees", `${epoch}.json`), "utf8"));
  return { dataDir, denylistPath, asked, run, tree };
}

test("the runner takes each hour and closes an epoch every four hours", async () => {
  const { dataDir, denylistPath, asked, run, tree } = runner();

  let status = await run(start - 1);
  assert.deepEqual(asked, []);
  assert.equal(status.openEpoch, FIRST);
  assert.match(String(status.waiting), /first epoch starts at 2026-11-16T23:00:00/);

  // Three hours have ended; the fourth is still running.
  status = await run(start + 3 * HOUR + 59);
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

  // The fourth hour has ended: the epoch is closed, on the genesis tree, with a sixth of the day's budget.
  status = await run(start + 4 * HOUR);
  assert.equal(asked.length, 4);
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed, c.paidAccounts]),
    [[FIRST, "166666", 1]],
  );
  assert.equal(status.openEpoch, SECOND);
  assert.equal(status.snapshots, 0);
  assert.deepEqual(status.latestTree, { epoch: FIRST, root: tree(FIRST).root, sha256: status.closed[0].treeSha256 });
  assert.equal(tree(FIRST).previousRoot, null);

  // Down for a while, back in the fourth epoch's second hour: the missed hours first, oldest first,
  // then every finished epoch in order, each on the tree of the one before.
  status = await run(start + 13 * HOUR + 10);
  assert.deepEqual(
    asked,
    Array.from({ length: 13 }, (_, h) => start + h * HOUR),
  );
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    [SECOND, THIRD],
  );
  assert.equal(status.openEpoch, "2026-11-17T11");
  assert.equal(status.snapshots, 1);
  assert.equal(tree(SECOND).previousRoot, tree(FIRST).root);
  assert.equal(tree(THIRD).previousRoot, tree(SECOND).root);
  assert.deepEqual(tree(THIRD).window, { start: start + 8 * HOUR, end: start + 12 * HOUR });
  assert.deepEqual(
    Object.entries(tree(THIRD).claims).map(([account, claim]) => [account, claim.claimable]),
    [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c].map((account) => [account, "166666"]),
  );
  assert.deepEqual(readdirSync(join(dataDir, "trees")).sort(), [`${FIRST}.json`, `${SECOND}.json`, `${THIRD}.json`]);

  // What the app reads: the budget stays the program's figure per day, and the newest tree is named by its id.
  const latest = JSON.parse(readFileSync(latestPath(dataDir), "utf8")) as LatestFile;
  assert.deepEqual(latest.latestTree, { epoch: THIRD, root: tree(THIRD).root });
  assert.equal(latest.assets.HUSDT.budgetPerDay, "1000000");
  assert.equal(latest.asOf.hour, start + 12 * HOUR);

  // A minute later nothing is due.
  status = await run(start + 13 * HOUR + 70);
  assert.deepEqual(status.taken, []);
  assert.deepEqual(status.closed, []);
});

test("the runner's first epoch must be an epoch of the configured length", async () => {
  const { asked, run } = runner();
  await assert.rejects(
    run(start, { firstEpoch: "2026-11-16" }),
    /must be the UTC date and hour it starts at, like 2026-11-17T03, got 2026-11-16 \(a date alone names a one-day epoch\)/,
  );
  await assert.rejects(run(start, { firstEpoch: "2026-11-17T00" }), /2026-11-17T00 is not an epoch/);
  // A date and hour given to a runner with one-day epochs.
  await assert.rejects(
    run(start, { config: mainnet, program: programOf({ from: "2026-11-16" }, mainnet) }),
    /an epoch must be a date like 2026-11-12, got 2026-11-16T23/,
  );
  assert.deepEqual(asked, []);

  // A first epoch later than a tree that is already there is still refused instead of starting over.
  await run(start + 4 * HOUR);
  await assert.rejects(
    run(start + 9 * HOUR, { firstEpoch: SECOND }),
    /the first epoch is 2026-11-17T03, but .* already holds 2026-11-16T23\.json; check the first epoch/,
  );
});

test("an hour with no block leaves a four-hour epoch for a person to close, from an hour after it ends", async () => {
  const { run } = runner({ noBlockAt: start + HOUR });
  const early = await run(start + 3 * HOUR);
  assert.match(
    String(early.waiting),
    /no block inside 2026-11-17T00:00:00.000Z, so epoch 2026-11-16T23 cannot close on its own; once its other hours are all taken, from 2026-11-17T04:00:00.000Z, close it by hand with --allow-partial/,
  );
  const status = await run(start + 5 * HOUR);
  assert.equal(status.openEpoch, FIRST);
  assert.deepEqual(status.closed, []);
  assert.match(String(status.waiting), /epoch 2026-11-16T23 cannot close on its own: .* --allow-partial/);
});

test("one-day epochs come out the same whether the length is left out or written as 86400", () => {
  const dayStart = epochWindow("2026-11-12", 14).start;
  const close = (withConfig: Config) => {
    const { dataDir, denylistPath } = makeDataDir({
      snapshots: [0, 1].flatMap((d) =>
        hourly(
          dayStart + d * DAY,
          (h) => ({ [ACCOUNTS.a]: { husdc: 100 + h, husdt: 7 }, [ACCOUNTS.b]: { husdt: 50, hollar: h % 3 } }),
          (d + 1) * 1_000,
        ),
      ),
    });
    const program = parseProgram(
      programText({ husdc: "275.616", husdt: "80", from: "2026-11-12", startHour: "14" }),
      withConfig,
      { requireDecisions: true },
    );
    const denylist = loadDenylist(denylistPath);
    closeEpochToDisk({ dataDir, epoch: "2026-11-12", program, config: withConfig, denylist, genesis: true });
    closeEpochToDisk({
      dataDir,
      epoch: "2026-11-13",
      program,
      config: withConfig,
      denylist,
      previousTreePath: join(dataDir, "trees", "2026-11-12.json"),
    });
    const files = ["trees", "epochs", join("public", "trees")].flatMap((dir) =>
      readdirSync(join(dataDir, dir))
        .sort()
        .map((file) => join(dir, file)),
    );
    return files.map((file): [string, string] => [file, readFileSync(join(dataDir, file), "utf8")]);
  };
  const implicit = close(mainnet);
  const explicit = close({ ...mainnet, epoch: { snapshotsPerEpoch: 24, lengthSeconds: DAY } });
  assert.equal(implicit.length, 8); // two trees, two CSVs, two summaries, two claims files
  assert.deepEqual(explicit, implicit);
  // The whole of the day's budget, not a share of it.
  const summary = JSON.parse(implicit.find(([file]) => file.endsWith("2026-11-12.summary.json"))![1]);
  assert.deepEqual(summary.budgets, { HUSDC: "275616000", HUSDT: "80000000" });
  assert.deepEqual(summary.window, { start: dayStart, end: dayStart + DAY });
});

// The commands as separate processes, with a config file that has four-hour epochs.
function cli(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, "src", script), ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("the commands take the epoch length from --config, and the id form with it", () => {
  const { dataDir, denylistPath } = makeDataDir({
    snapshots: fourHours(start, () => ({ [ACCOUNTS.a]: { husdc: 10, husdt: 10 } })),
  });
  const folder = mkdtempSync(join(tmpdir(), "hydration-four-hours-"));
  const configPath = join(folder, "config.json");
  const programPath = join(folder, "program.yaml");
  writeFileSync(configPath, toJson(config));
  writeFileSync(programPath, programText({ husdc: "275.616", husdt: "80" }));
  const close = (epoch: string, ...extra: string[]) =>
    cli("close-epoch.ts", "--epoch", epoch, "--program", programPath, "--data", dataDir, ...extra);
  const here = ["--denylist", denylistPath, "--genesis"];

  // A date is the id of a one-day epoch, and a date and hour is not one with the default config, where
  // the program file's own first epoch is refused before anything else.
  const date = close("2026-11-16", "--config", configPath, ...here);
  assert.equal(date.status, 1);
  assert.match(date.err, /close-epoch: an epoch of 14400 seconds must be the UTC date and hour it starts at/);
  const defaultConfig = close(FIRST, ...here);
  assert.equal(defaultConfig.status, 1);
  assert.match(defaultConfig.err, /applies_from_epoch must be a date like 2027-01-15, got 2026-11-16T23/);
  assert.equal(existsSync(join(dataDir, "trees")), false);

  const closed = close(FIRST, "--config", configPath, ...here);
  assert.equal(closed.status, 0, closed.err);
  assert.match(
    closed.out,
    /^epoch 2026-11-16T23: 4 snapshots, 1 accounts paid, distributed 59269333, dust 0, root 0x[0-9a-f]{64}\n$/,
  );
  assert.equal(
    readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8"),
    `account,amount\n${ACCOUNTS.a},59269333\n`,
  );
  assert.ok(existsSync(join(dataDir, "trees", `${FIRST}.json`)));

  // The preview of one epoch reads its four snapshots, and its figures stay per day.
  const preview = cli(
    "preview.ts",
    "--program",
    programPath,
    "--data",
    dataDir,
    "--denylist",
    denylistPath,
    "--config",
    configPath,
    "--epoch",
    FIRST,
  );
  assert.equal(preview.status, 0, preview.err);
  assert.match(preview.out, /Snapshots 4 /);
  assert.match(preview.out, /Budget per day: HUSDC 275\.616, HUSDT 80 PRIME/);

  // The runner, one pass on a data directory of its own, with a first epoch that has not started: it
  // has nothing to take, so it asks the node nothing. The environment is blanked so that a developer's
  // shell or .env cannot give it another first epoch or program, or a key to post roots with.
  const runnerData = mkdtempSync(join(tmpdir(), "hydration-rewards-"));
  const runner = (firstEpoch: string) => {
    const r = spawnSync(
      process.execPath,
      [
        join(root, "src", "bot.ts"),
        "--once",
        ...["--data", runnerData, "--rpc", "http://127.0.0.1:1", "--config", configPath],
        ...["--program", programPath, "--denylist", denylistPath, "--first-epoch", firstEpoch],
      ],
      { encoding: "utf8", env: { ...process.env, FIRST_EPOCH: "", PROGRAM: "", PRIVKEY: "", URD_ADDRESS: "" } },
    );
    return { exit: r.status, err: r.stderr, status: JSON.parse(readFileSync(join(runnerData, "status.json"), "utf8")) };
  };
  const idle = runner("2999-01-01T03");
  assert.equal(idle.exit, 0, idle.err);
  assert.equal(idle.status.error, null);
  assert.equal(idle.status.firstEpoch, "2999-01-01T03");
  assert.equal(idle.status.openEpoch, "2999-01-01T03");
  assert.equal(idle.status.program.appliesFromEpoch, FIRST);
  assert.match(String(idle.status.waiting), /first epoch starts at 2999-01-01T03:00:00/);
  // A date is reported on the pass, as a date that is none is with one-day epochs.
  const dated = runner("2999-01-01");
  assert.equal(dated.exit, 1);
  assert.match(dated.status.error, /must be the UTC date and hour it starts at, like 2026-11-17T03, got 2999-01-01/);
});
