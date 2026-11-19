// The open epoch's estimate with epochs shorter than a day (config.epoch.lengthSeconds), through the
// runner's tick: three-hour epochs of three hourly snapshots, counted from 23:00 UTC. An epoch pays an
// eighth of the day's budgets, rounded down, and the estimate is that eighth scaled to the snapshots
// there are, rounded down again. The amounts here are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tick } from "../src/bot.ts";
import type { TickStatus } from "../src/bot.ts";
import { epochWindow } from "../src/close-epoch.ts";
import { toJson } from "../src/lib/io.ts";
import { parseProgram } from "../src/program.ts";
import { latestPath } from "../src/publish.ts";
import type { Config, LatestFile, Program, Tree } from "../src/types.ts";
import { ACCOUNTS, makeDataDir, makeSnapshot, parseCsv } from "./helpers.ts";
import type { Holdings } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const mainnet = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8")) as Config;
const HOUR = 3600;
const THREE_HOURS = 3 * HOUR;
// The mainnet config with three-hour epochs of three hourly snapshots.
const config: Config = { ...mainnet, epoch: { snapshotsPerEpoch: 3, lengthSeconds: THREE_HOURS } };
// Three-hour epochs counted from 23:00 start at 23, 02, 05, 08, 11, 14, 17 and 20 UTC.
const START_HOUR = 23;
const FIRST = "2026-11-17T08";
const SECOND = "2026-11-17T11";
const THIRD = "2026-11-17T14";
// The first epoch's window, written out: 08:00 to 11:00 UTC on 17 November 2026.
const START = 1_794_902_400;
const END = 1_794_913_200;
const BORROWER = "0x00000000000000000000000000000000000000e5";

const programText = ({ husdc = "1", husdt = "1" } = {}) => `name: three-hour accruing test
applies_from_epoch: ${FIRST}
budget_per_day:
  HUSDC: ${husdc}
  HUSDT: ${husdt}
epoch_start_hour_utc: ${START_HOUR}
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const programOf = (budgets: Parameters<typeof programText>[0] = {}) =>
  parseProgram(programText(budgets), config, { requireDecisions: true });

// What a failed pass did, which it carries on the error it throws.
const statusOf = (error: unknown): TickStatus => (error as { status: TickStatus }).status;

// A runner with the three-hour config over an empty data directory. `holdingsAt(h)` says who holds
// what in the hour that starts h hours after the first epoch does.
function runner(holdingsAt: (hour: number) => Holdings, program: Program = programOf()) {
  const { dataDir, denylistPath } = makeDataDir({ snapshots: [] });
  const writeHour = (target: number) => {
    const snapshot = makeSnapshot({
      number: target / 6,
      timestamp: target + 2,
      target,
      accounts: holdingsAt((target - START) / HOUR),
    });
    writeFileSync(join(dataDir, "snapshots", `${target}.json`), toJson(snapshot));
  };
  const takeHour = async (target: number) => writeHour(target);
  const run = (now: number, extra: Partial<Parameters<typeof tick>[0]> = {}) =>
    tick({ now, dataDir, program, config, denylistPath, firstEpoch: FIRST, takeHour, ...extra });
  const latest = (): LatestFile => JSON.parse(readFileSync(latestPath(dataDir), "utf8"));
  const tree = (epoch: string): Tree => JSON.parse(readFileSync(join(dataDir, "trees", `${epoch}.json`), "utf8"));
  return { dataDir, run, latest, tree, writeHour };
}

// One account holds all the HUSDT of an epoch: a in the first, b in the second, c in the third.
const oneHolderPerEpoch = (h: number): Holdings => ({
  [[ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c][Math.floor(h / 3) % 3]]: { husdt: 10 },
});

test("the open epoch of a three-hour program is named by the hour it starts at, and its window is three hours", async () => {
  assert.deepEqual(epochWindow(FIRST, START_HOUR, THREE_HOURS), { start: START, end: END });
  assert.equal(new Date(START * 1000).toISOString(), "2026-11-17T08:00:00.000Z");
  assert.equal(END - START, THREE_HOURS);

  const { run, latest } = runner(oneHolderPerEpoch);
  const status = await run(START + HOUR + 30); // hour 0 has ended
  assert.equal(status.openEpoch, FIRST);
  // 1 PRIME a day is 125000 per three-hour epoch, and a third of that, rounded down, with one snapshot
  // of three. a holds all the HUSDT there is and nobody holds HUSDC. The day's budget would give 333333.
  assert.deepEqual(latest().openEpoch, {
    id: "2026-11-17T08",
    start: 1_794_902_400,
    end: 1_794_913_200,
    snapshots: 1,
    expectedSnapshots: 3,
    accruing: { [ACCOUNTS.a]: "41666" },
  });
  // It is an addition: the format name and the fields before it are as they were, and the budget the
  // file shows is still the program's figure per day.
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
  assert.equal(latest().assets.HUSDT.budgetPerDay, "1000000");
});

test("the estimate moves with each of a three-hour epoch's snapshots, and starts again after the close", async () => {
  const { run, latest, tree } = runner(oneHolderPerEpoch);

  await run(START + HOUR);
  assert.equal(latest().openEpoch?.snapshots, 1);
  assert.deepEqual(latest().openEpoch?.accruing, { [ACCOUNTS.a]: "41666" });
  await run(START + 2 * HOUR);
  assert.equal(latest().openEpoch?.snapshots, 2);
  assert.deepEqual(latest().openEpoch?.accruing, { [ACCOUNTS.a]: "83333" });

  // The third hour closes the epoch, which pays the epoch's whole budget. The next epoch is open, its
  // window starts where the first one's ended, and it has no snapshot yet: nothing has been earned in
  // it, and a is still earning as of the newest snapshot.
  let status = await run(START + 3 * HOUR);
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed]),
    [[FIRST, "125000"]],
  );
  assert.equal(tree(FIRST).claims[ACCOUNTS.a].claimable, "125000");
  assert.deepEqual(latest().openEpoch, {
    id: "2026-11-17T11",
    start: 1_794_913_200,
    end: 1_794_924_000,
    snapshots: 0,
    expectedSnapshots: 3,
    accruing: {},
  });
  assert.deepEqual(latest().latestTree, { epoch: FIRST, root: tree(FIRST).root });
  assert.equal(latest().asOf.hour, START + 2 * HOUR);
  assert.deepEqual(latest().accounts, { [ACCOUNTS.a]: { earning: true, hollarDebtUsd: "0.00" } });

  // Its first hour, in which b holds the HUSDT: a has earned nothing in this epoch and is left out,
  // and what a can claim is in the tree, not here.
  await run(START + 4 * HOUR);
  assert.equal(latest().openEpoch?.id, SECOND);
  assert.equal(latest().openEpoch?.snapshots, 1);
  assert.deepEqual(latest().openEpoch?.accruing, { [ACCOUNTS.b]: "41666" });

  // Down for a while, back in the third epoch's second hour: the second epoch is closed, and the
  // estimate is of the third epoch's one snapshot alone.
  status = await run(START + 7 * HOUR + 10);
  assert.deepEqual(
    status.closed.map((c) => c.epoch),
    [SECOND],
  );
  assert.deepEqual(latest().openEpoch, {
    id: THIRD,
    start: START + 6 * HOUR,
    end: START + 9 * HOUR,
    snapshots: 1,
    expectedSnapshots: 3,
    accruing: { [ACCOUNTS.c]: "41666" },
  });
});

test("with all three snapshots in, the estimate is what the close of the three-hour epoch then pays", async () => {
  // Budgets that neither step divides. An epoch's share of the day is rounded down first:
  //   HUSDC 100000004 / 8 = 12500000.5 -> 12500000      HUSDT 80000005 / 8 = 10000000.625 -> 10000000
  // and the snapshots' share of that is rounded down on its own (HUSDT with two of three: 6666666,
  // where one division of the day's budget by 12 would give 6666667).
  const program = programOf({ husdc: "100.000004", husdt: "80.000005" });
  // HUSDC: a holds $100 in every hour; b $50, then $150, and has left by the third; c $200 in the third.
  // HUSDT: c holds $10 in every hour, alone until a brings $40 in the third.
  // The borrower supplies more than all of them and owes $300 of HOLLAR, so it earns nothing.
  const busy = (h: number): Holdings => ({
    [ACCOUNTS.a]: { husdc: 100, ...(h === 2 ? { husdt: 40 } : {}) },
    ...(h < 2 ? { [ACCOUNTS.b]: { husdc: h === 0 ? 50 : 150 } } : {}),
    [ACCOUNTS.c]: { husdt: 10, ...(h === 2 ? { husdc: 200 } : {}) },
    [BORROWER]: { husdc: 40_000, hollar: 300 },
  });
  const { dataDir, run, latest, tree } = runner(busy, program);

  // One snapshot. HUSDC 4166666: a has 100 of 150 and b 50. HUSDT 3333333: all c's.
  await run(START + HOUR);
  assert.deepEqual(latest().openEpoch?.accruing, {
    [ACCOUNTS.a]: "2777777",
    [ACCOUNTS.b]: "1388888",
    [ACCOUNTS.c]: "3333333",
  });
  // Two. HUSDC 8333333: a and b have 200 of 400 each. HUSDT 6666666: all c's.
  await run(START + 2 * HOUR);
  assert.deepEqual(latest().openEpoch?.accruing, {
    [ACCOUNTS.a]: "4166666",
    [ACCOUNTS.b]: "4166666",
    [ACCOUNTS.c]: "6666666",
  });

  // All three, while the close cannot write its claims file (public/trees is a file where a folder
  // should be), so the epoch that is complete stays open.
  // HUSDC 12500000: a has 300 of 700, b 200 and c 200. HUSDT 10000000: c has 30 of 70 and a 40.
  //   a = 5357142.857… + 5714285.714… = 11071428   b = 3571428.571… = 3571428
  //   c = 3571428.571… + 4285714.285… = 7857142
  // b left before the third hour: its amount went down, and it is in the estimate though no longer
  // among the accounts of the newest snapshot. The borrower is among those and has no amount.
  writeFileSync(join(dataDir, "public", "trees"), "in the way");
  await assert.rejects(run(START + 3 * HOUR), /^Error: close of 2026-11-17T08: /);
  const held = latest().openEpoch;
  assert.deepEqual(held, {
    id: FIRST,
    start: START,
    end: END,
    snapshots: 3,
    expectedSnapshots: 3,
    accruing: { [ACCOUNTS.a]: "11071428", [ACCOUNTS.b]: "3571428", [ACCOUNTS.c]: "7857142" },
  });
  assert.deepEqual(Object.keys(latest().accounts), [ACCOUNTS.a, ACCOUNTS.c, BORROWER]);
  assert.equal(latest().accounts[BORROWER].earning, false);

  // The close pays exactly those amounts, from the epoch's eighth of the day's budgets.
  rmSync(join(dataDir, "public", "trees"));
  const status = await run(START + 3 * HOUR + 60);
  assert.deepEqual(status.taken, []);
  assert.deepEqual(
    status.closed.map((c) => [c.epoch, c.distributed, c.paidAccounts]),
    [[FIRST, "22499998", 3]],
  );
  const paid = parseCsv(readFileSync(join(dataDir, "epochs", `${FIRST}.csv`), "utf8"));
  assert.deepEqual(
    [...paid].map(([account, amount]) => [account, amount.toString()]),
    Object.entries(held?.accruing ?? {}),
  );
  assert.deepEqual(
    Object.entries(tree(FIRST).claims).map(([account, claim]) => [account, claim.claimable]),
    Object.entries(held?.accruing ?? {}),
  );
  const summary = JSON.parse(readFileSync(join(dataDir, "epochs", `${FIRST}.summary.json`), "utf8"));
  assert.deepEqual(summary.budgets, { HUSDC: "12500000", HUSDT: "10000000" });
  assert.deepEqual(summary.window, { start: START, end: END });

  // And the estimate starts again in the epoch after it.
  assert.deepEqual(latest().openEpoch, {
    id: SECOND,
    start: END,
    end: END + THREE_HOURS,
    snapshots: 0,
    expectedSnapshots: 3,
    accruing: {},
  });
  assert.equal(latest().assets.HUSDT.budgetPerDay, "80000005");
});

test("a blank budget or a failed estimate leaves the amounts out of a three-hour epoch, not the epoch", async () => {
  // A budget still blank in the program file: the pass succeeds, and there is no estimate to make.
  const undecided = parseProgram(programText({ husdt: "" }), config);
  const blank = runner(oneHolderPerEpoch, undecided);
  const status = await blank.run(START + 2 * HOUR);
  assert.equal(status.snapshots, 2);
  assert.equal(blank.latest().assets.HUSDT.budgetPerDay, null);
  assert.deepEqual(blank.latest().openEpoch, {
    id: FIRST,
    start: START,
    end: END,
    snapshots: 2,
    expectedSnapshots: 3,
    accruing: null,
  });
  // Restarted with the budget filled in, the same two snapshots give the estimate.
  await blank.run(START + 2 * HOUR + 60, { program: programOf() });
  assert.deepEqual(blank.latest().openEpoch?.accruing, { [ACCOUNTS.a]: "83333" });

  // An hour of the open epoch that can no longer be read as a snapshot: the estimate is reported under
  // the epoch's id, and the file is written with the open epoch and no amounts.
  const { dataDir, run, latest, writeHour } = runner(oneHolderPerEpoch);
  await run(START + HOUR);
  assert.deepEqual(latest().openEpoch?.accruing, { [ACCOUNTS.a]: "41666" });
  writeFileSync(join(dataDir, "snapshots", `${START}.json`), toJson({ format: "something-else" }));
  await assert.rejects(run(START + 2 * HOUR), (error) => {
    assert.match(
      String((error as Error).message),
      /^estimate of the open epoch 2026-11-17T08: .* not a hydration-rewards-snapshot\/2 snapshot/,
    );
    assert.deepEqual(statusOf(error).taken, [START + HOUR]);
    return true;
  });
  assert.equal(latest().asOf.hour, START + HOUR);
  assert.deepEqual(latest().openEpoch, {
    id: FIRST,
    start: START,
    end: END,
    snapshots: 2,
    expectedSnapshots: 3,
    accruing: null,
  });
  // Once the hour is put right the estimate is back, without waiting for the next snapshot.
  writeHour(START);
  const recovered = await run(START + 2 * HOUR + 60);
  assert.deepEqual(recovered.taken, []);
  assert.deepEqual(latest().openEpoch?.accruing, { [ACCOUNTS.a]: "83333" });
});
