// The open epoch's estimate: what each account has earned so far, worked out by the code a close pays with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateAccruing, openEpochStatus } from "../src/accruing.ts";
import { closeEpochToDisk, epochWindow } from "../src/close-epoch.ts";
import { loadDenylist, makeDenylist } from "../src/lib/denylist.ts";
import { parseProgram } from "../src/program.ts";
import type { Config, Program, Snapshot } from "../src/types.ts";
import { ACCOUNTS, hourly, makeDataDir, parseCsv } from "./helpers.ts";
import type { Holdings } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8")) as Config;
const EPOCH = "2026-11-12";
const { start } = epochWindow(EPOCH, 14);
const BORROWER = "0x00000000000000000000000000000000000000e5";

const programText = (budgets: string) => `name: accruing test
applies_from_epoch: ${EPOCH}
budget_per_day:
${budgets}
epoch_start_hour_utc: 14
earn_on_supply_of: [HUSDC, HUSDT]
max_hollar_debt_usd: 5
`;
const programOf = (budgets: string) => parseProgram(programText(budgets), config, { requireDecisions: true });
// One PRIME a day on each asset, for amounts that can be checked by hand.
const simple = programOf("  HUSDC: 1\n  HUSDT: 1");
// Budgets that 24 does not divide, so every rounding shows.
const ragged = programOf("  HUSDC: 275.616001\n  HUSDT: 275.615999");

const DENYLIST = { rules: { palletAccounts: true }, addresses: [{ address: ACCOUNTS.listed, label: "test entry" }] };
const denylist = makeDenylist(DENYLIST);

// What the runner passes: the program's budgets for one epoch and the eligibility settings of a close.
const estimate = (snapshots: Snapshot[], program: Program = simple, expectedSnapshots = 24) =>
  estimateAccruing({
    snapshots,
    expectedSnapshots,
    budgets: program.budgetPerDay,
    eligibility: { maxHollarDebt: program.maxHollarDebt, earn: program.earn, denylist },
  });
const sum = (amounts: Map<string, bigint>): bigint => [...amounts.values()].reduce((x, y) => x + y, 0n);

// A day in which every rule applies: balances that move, an account that leaves after six hours, one
// that borrows HOLLAR for the first eight, one that borrows all day, and two denylisted accounts.
const busyDay = (h: number): Holdings => ({
  [ACCOUNTS.a]: { husdc: 1_234 + 7 * h, husdt: 777 },
  [ACCOUNTS.b]: { husdc: 3, husdt: 5_000, hollar: h < 8 ? 300 : 0 },
  ...(h < 6 ? { [ACCOUNTS.c]: { husdc: 2_500, husdt: 31 } } : {}),
  [BORROWER]: { husdc: 40_000, hollarGigahdx: 12_345 },
  [ACCOUNTS.treasury]: { husdc: 400_000, husdt: 400_000 },
  [ACCOUNTS.listed]: { husdt: 50_000 },
});

test("with every snapshot of the epoch in, the estimate is exactly what the close pays", () => {
  const snapshots = hourly(start, busyDay);
  const { dataDir, denylistPath } = makeDataDir({ snapshots, denylist: DENYLIST });
  const { tree } = closeEpochToDisk({
    dataDir,
    epoch: EPOCH,
    program: ragged,
    config,
    denylist: loadDenylist(denylistPath),
    genesis: true,
  });
  const paid = parseCsv(readFileSync(join(dataDir, "epochs", `${EPOCH}.csv`), "utf8"));
  // The close paid the three accounts that earn, in amounts that did not divide evenly.
  assert.deepEqual([...paid.keys()], [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.c]);
  assert.ok(sum(paid) < 275_616_001n + 275_615_999n, "the close left dust");

  const accruing = estimate(snapshots, ragged);
  assert.ok(accruing !== null);
  assert.deepEqual([...accruing], [...paid]);
  // The first tree's claims are the epoch's amounts, so the published estimate ends on what can be claimed.
  const { accruing: published } = openEpochStatus({
    id: EPOCH,
    window: tree.window,
    snapshots: 24,
    expectedSnapshots: 24,
    accruing,
  });
  assert.deepEqual(
    published,
    Object.fromEntries(Object.entries(tree.claims).map(([account, claim]) => [account, claim.claimable])),
  );

  // One snapshot short it is another result, so the comparison above can fail.
  assert.notDeepEqual([...(estimate(snapshots.slice(0, 23), ragged) ?? [])], [...paid]);
});

test("part of the way in, each asset's budget is scaled to the snapshots there are and rounded down", () => {
  // One account holds all of both assets, so it gets both scaled budgets whole.
  const alone = hourly(start, () => ({ [ACCOUNTS.a]: { husdc: 10, husdt: 10 } }));
  // 275616001 × 7 / 24 = 80388000.29…, and 275615999 × 7 / 24 = 80387999.70…: each is rounded down on
  // its own, which is one unit less than rounding their sum.
  assert.deepEqual(estimate(alone.slice(0, 7), ragged), new Map([[ACCOUNTS.a, 80_388_000n + 80_387_999n]]));
  assert.deepEqual(estimate(alone.slice(0, 1), simple), new Map([[ACCOUNTS.a, 41_666n + 41_666n]]));

  // With several accounts the estimates never add up to more than the scaled budgets, and fall short
  // of them by less than one unit per account, however many snapshots are in.
  const snapshots = hourly(start, busyDay);
  for (let n = 1; n <= 24; n++) {
    const accruing = estimate(snapshots.slice(0, n), ragged);
    assert.ok(accruing !== null);
    const scaled = (275_616_001n * BigInt(n)) / 24n + (275_615_999n * BigInt(n)) / 24n;
    assert.ok(sum(accruing) <= scaled, `${n} snapshots: ${sum(accruing)} is more than ${scaled}`);
    assert.ok(scaled - sum(accruing) < 3n, `${n} snapshots: ${scaled - sum(accruing)} units of dust for 3 accounts`);
  }
});

test("an epoch without a snapshot has an empty estimate, and one with an undecided budget has none", () => {
  assert.deepEqual(estimate([]), new Map());
  const window = { start, end: start + 86_400 };
  const none = openEpochStatus({ id: EPOCH, window, snapshots: 0, expectedSnapshots: 24, accruing: estimate([]) });
  assert.deepEqual(none.accruing, {});

  // A budget still blank in the program file: no amount can be worked out, with snapshots or without.
  const undecided = parseProgram(programText("  HUSDC: 1\n  HUSDT:"), config);
  const snapshots = hourly(start, () => ({ [ACCOUNTS.a]: { husdc: 10 } })).slice(0, 5);
  assert.equal(estimate(snapshots, undecided), null);
  assert.equal(estimate([], undecided), null);
  const blank = openEpochStatus({ id: EPOCH, window, snapshots: 5, expectedSnapshots: 24, accruing: null });
  assert.equal(blank.accruing, null);

  // Empty with snapshots in as well, when nobody has earned: here only a HOLLAR borrower and a listed
  // account hold. So it is `snapshots`, not an empty estimate, that says whether an hour is in.
  const nobody = hourly(start, () => ({
    [BORROWER]: { husdt: 90_000, hollar: 300 },
    [ACCOUNTS.listed]: { husdt: 50_000 },
  })).slice(0, 2);
  assert.deepEqual(estimate(nobody), new Map());
  const idle = openEpochStatus({ id: EPOCH, window, snapshots: 2, expectedSnapshots: 24, accruing: estimate(nobody) });
  assert.deepEqual([idle.snapshots, idle.accruing], [2, {}]);
});

test("an account that supplied early in the epoch and left still has an estimate", () => {
  // c holds $100 for the first two of four hours and is gone from the snapshots after; a holds $100 in all four.
  const snapshots = hourly(start, (h) => ({
    [ACCOUNTS.a]: { husdt: 100 },
    ...(h < 2 ? { [ACCOUNTS.c]: { husdt: 100 } } : {}),
  })).slice(0, 4);
  assert.equal(ACCOUNTS.c in snapshots[3].accounts, false);
  // HUSDT's budget for four hours is 1000000 × 4 / 24 = 166666; a has two thirds of the eligible value.
  // Nobody holds HUSDC, so its budget goes to nobody.
  assert.deepEqual(
    estimate(snapshots),
    new Map([
      [ACCOUNTS.a, 111_110n],
      [ACCOUNTS.c, 55_555n],
    ]),
  );
});

test("a HOLLAR borrower and a denylisted account have no estimate", () => {
  const snapshots = hourly(start, (h) => ({
    // a borrows $300 of HOLLAR in the first two of four hours, and earns for the other two
    [ACCOUNTS.a]: { husdt: 100, hollar: h < 2 ? 300 : 0 },
    [ACCOUNTS.b]: { husdt: 100, hollar: 3 }, // within the allowance
    [BORROWER]: { husdt: 90_000, hollarBil: 5.01 },
    [ACCOUNTS.treasury]: { husdt: 400_000 },
    [ACCOUNTS.listed]: { husdt: 50_000 },
  })).slice(0, 4);
  assert.deepEqual(
    estimate(snapshots),
    new Map([
      [ACCOUNTS.a, 55_555n],
      [ACCOUNTS.b, 111_110n],
    ]),
  );
  // Without the listed entry that account earns, and takes most of the budget.
  const open = estimateAccruing({
    snapshots,
    expectedSnapshots: 24,
    budgets: simple.budgetPerDay,
    eligibility: {
      maxHollarDebt: simple.maxHollarDebt,
      earn: simple.earn,
      denylist: makeDenylist({ rules: { palletAccounts: true }, addresses: [] }),
    },
  });
  assert.deepEqual([...(open ?? new Map()).keys()], [ACCOUNTS.a, ACCOUNTS.b, ACCOUNTS.listed]);
});

test("an amount for an account the denylist names is refused, should the eligibility code ever let one through", () => {
  // The eligibility code leaves listed accounts out itself, so the check after it only fires when the
  // two disagree. This denylist names nobody the first time it is asked, by the eligibility code for
  // the one account of the one snapshot, and everybody after that, when the check asks.
  const snapshots = hourly(start, () => ({ [ACCOUNTS.a]: { husdt: 10 } })).slice(0, 1);
  let asked = 0;
  const changing = { reasonFor: () => (asked++ === 0 ? null : "listed since") };
  assert.throws(
    () =>
      estimateAccruing({
        snapshots,
        expectedSnapshots: 24,
        budgets: simple.budgetPerDay,
        eligibility: { maxHollarDebt: simple.maxHollarDebt, earn: simple.earn, denylist: changing },
      }),
    new RegExp(`denylisted account ${ACCOUNTS.a} would be shown earning`),
  );
  assert.equal(asked, 2);
});

test("nothing depends on the epoch's length or name: the caller gives the count, the window and the id", () => {
  // A three-hour epoch with hourly snapshots and an eighth of a day's budgets: 125000 per asset.
  const eighth = new Map([
    ["HUSDC", 125_000n],
    ["HUSDT", 125_000n],
  ]);
  const snapshots = hourly(start, () => ({ [ACCOUNTS.b]: { husdt: 10 } })).slice(0, 1);
  const accruing = estimateAccruing({
    snapshots,
    expectedSnapshots: 3,
    budgets: eighth,
    eligibility: { maxHollarDebt: simple.maxHollarDebt, earn: simple.earn, denylist },
  });
  assert.deepEqual(accruing, new Map([[ACCOUNTS.b, 41_666n]]));

  const status = openEpochStatus({
    id: "2026-11-17T08",
    window: { start: 1_794_902_400, end: 1_794_913_200 },
    snapshots: 1,
    expectedSnapshots: 3,
    // not in address order, with an amount past 2^53 and an account with nothing
    accruing: new Map([
      [ACCOUNTS.b, 41_666n],
      [ACCOUNTS.c, 0n],
      [ACCOUNTS.a, 12_345_678_901_234_567_890n],
    ]),
  });
  assert.deepEqual(status, {
    id: "2026-11-17T08",
    start: 1_794_902_400,
    end: 1_794_913_200,
    snapshots: 1,
    expectedSnapshots: 3,
    accruing: { [ACCOUNTS.a]: "12345678901234567890", [ACCOUNTS.b]: "41666" },
  });
  assert.deepEqual(Object.keys(status), ["id", "start", "end", "snapshots", "expectedSnapshots", "accruing"]);
  assert.deepEqual(Object.keys(status.accruing ?? {}), [ACCOUNTS.a, ACCOUNTS.b]);
});

test("more snapshots than the epoch has, or an epoch of no snapshots, is refused", () => {
  const snapshots = hourly(start, () => ({ [ACCOUNTS.a]: { husdt: 10 } }));
  assert.throws(() => estimate(snapshots, simple, 23), /24 snapshots were given for an epoch that has 23/);
  assert.throws(() => estimate([], simple, 0), /a whole number of snapshots, at least one; got 0/);
  assert.throws(() => estimate([], simple, 2.5), /a whole number of snapshots, at least one; got 2.5/);
  // What stops a close stops the estimate: here a snapshot that did not record an earning asset.
  const { HUSDC: _, ...withoutHusdc } = snapshots[1].reserves;
  const broken = [snapshots[0], { ...snapshots[1], reserves: withoutHusdc }];
  assert.throws(() => estimate(broken), /the snapshot did not record supply of HUSDC/);
});
