import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { epochWindow } from "../src/close-epoch.ts";
import { loadProgram, parseProgram, toRawUnits } from "../src/program.ts";
import { previewProgram } from "../src/preview.ts";
import { makeDenylist } from "../src/lib/denylist.ts";
import { $, ACCOUNTS, hourly } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config", "mainnet.json"), "utf8"));
const { start } = epochWindow("2026-11-12", 14);

const SETTINGS = {
  name: "name: test",
  applies_from_epoch: "applies_from_epoch: 2026-11-12",
  budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT: 1",
  epoch_start_hour_utc: "epoch_start_hour_utc: 14",
  earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDT]",
  max_hollar_debt_usd: "max_hollar_debt_usd: 5",
};
// A complete program with some settings replaced (or removed, with null).
const program = (changes = {}) =>
  Object.values({ ...SETTINGS, ...changes })
    .filter((line) => line !== null)
    .join("\n");

// Checks how each shipped file behaves, never what it holds: a program pull request changes the values.
test("every shipped program file loads, and closes an epoch only once every decision is filled in", () => {
  const files = readdirSync(join(root, "programs")).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const path = join(root, "programs", file);
    const p = loadProgram(path, config); // the preview reads it whatever is still blank
    const undecided =
      [...p.budgetPerDay.values()].some((budget) => budget === null) ||
      p.startHourUtc === null ||
      p.appliesFromEpoch === null;
    if (undecided) {
      assert.throws(() => loadProgram(path, config, { requireDecisions: true }), /is blank/, file);
    } else {
      assert.doesNotThrow(() => loadProgram(path, config, { requireDecisions: true }), file);
    }
  }
});

test("the first epoch a program file pays is a decision: a real date, and required to close an epoch", () => {
  assert.equal(parseProgram(program(), config, { requireDecisions: true }).appliesFromEpoch, "2026-11-12");
  for (const line of ["applies_from_epoch:", null]) {
    // Left blank or left out, it previews, and stops a close.
    assert.equal(parseProgram(program({ applies_from_epoch: line }), config).appliesFromEpoch, null);
    assert.throws(
      () => parseProgram(program({ applies_from_epoch: line }), config, { requireDecisions: true }),
      /applies_from_epoch is blank; write the first epoch this file pays/,
    );
  }
  for (const value of ["2026-11-31", "12 Nov 2026", "2026-11-1", "tomorrow"]) {
    assert.throws(
      () => parseProgram(program({ applies_from_epoch: `applies_from_epoch: ${value}` }), config),
      /applies_from_epoch must be a date like 2027-01-15/,
    );
  }
});

test("the end of a program is optional: a UTC time on the hour that an epoch ends at, after the first epoch's start", () => {
  const withEnd = (value: string, changes = {}) =>
    parseProgram(program({ ends_at: `ends_at: ${value}`, ...changes }), config);
  // Left out or left blank the program has no end, and closing an epoch asks for none.
  for (const line of [null, "ends_at:"]) {
    assert.equal(parseProgram(program({ ends_at: line }), config, { requireDecisions: true }).endsAt, null);
  }
  // 15 January 2027, 14:00 UTC, as unix seconds.
  assert.equal(withEnd("2027-01-15T14:00:00Z").endsAt, 1_800_021_600);
  assert.equal(withEnd("2027-01-15T14:00:00Z   # the stream's own end").endsAt, 1_800_021_600);

  // One form only: no other zone and none left out, no date alone, no unix seconds, nothing off the
  // hour, and no date or hour that does not exist.
  for (const value of [
    "2027-01-15T15:00:00+01:00",
    "2027-01-15T14:00:00",
    "2027-01-15 14:00:00Z",
    "2027-01-15T14:00Z",
    "2027-01-15",
    "1800021600",
    "2027-01-15T14:30:00Z",
    "2027-01-15T14:00:01Z",
    "2027-02-30T14:00:00Z",
    "2027-01-15T24:00:00Z",
  ]) {
    assert.throws(() => withEnd(value), {
      message: `program: ends_at must be a UTC time on the hour, written like 2027-01-15T14:00:00Z, got ${value}`,
    });
  }

  // It is a moment an epoch ends at: the start hour's own hour, once that is decided.
  assert.throws(
    () => withEnd("2027-01-15T13:00:00Z"),
    /ends_at must be a time an epoch ends at, and with epoch_start_hour_utc 14 epochs end at 14:00 UTC; got 2027-01-15T13:00:00Z/,
  );
  assert.throws(
    () => withEnd("2027-01-15T14:00:00Z", { epoch_start_hour_utc: "epoch_start_hour_utc: 0" }),
    /with epoch_start_hour_utc 0 epochs end at 00:00 UTC/,
  );
  assert.equal(
    withEnd("2027-01-15T13:00:00Z", { epoch_start_hour_utc: "epoch_start_hour_utc:" }).endsAt,
    1_800_018_000,
  );

  // The file pays at least one epoch: the end is after the start of applies_from_epoch, 2026-11-12 14:00.
  assert.equal(withEnd("2026-11-13T14:00:00Z").endsAt, start + 86_400);
  for (const value of ["2026-11-12T14:00:00Z", "2026-11-11T14:00:00Z"]) {
    assert.throws(
      () => withEnd(value),
      new RegExp(
        `ends_at ${value} is not after the start of applies_from_epoch 2026-11-12, so this file would pay no epoch`,
      ),
    );
  }
  // While the start hour is undecided the first epoch starts at midnight at the earliest.
  const noHour = { epoch_start_hour_utc: null };
  assert.throws(
    () => withEnd("2026-11-12T00:00:00Z", noHour),
    /is not after the start of applies_from_epoch 2026-11-12/,
  );
  assert.equal(withEnd("2026-11-12T01:00:00Z", noHour).endsAt, start - 13 * 3600);
  // And without a first epoch there is nothing to compare it with yet.
  assert.equal(withEnd("2026-11-11T14:00:00Z", { applies_from_epoch: "applies_from_epoch:" }).endsAt, start - 86_400);

  assert.throws(
    () => parseProgram(program({ ends_at: "ends_on: 2027-01-15T14:00:00Z" }), config),
    /"ends_on" is not known\. Did you mean ends_at\?/,
  );
});

test("a program file loads from any folder", () => {
  // The skill previews a saved copy of the old program from a temporary folder.
  const path = join(mkdtempSync(join(tmpdir(), "hydration-program-")), "before.yaml");
  writeFileSync(path, program());
  assert.equal(loadProgram(path, config, { requireDecisions: true }).name, "test");
});

test("budgets and the HOLLAR allowance are read as exact decimals", () => {
  assert.equal(toRawUnits("275.616", 6, "x"), 275_616_000n);
  assert.equal(toRawUnits("0.000001", 6, "x"), 1n);
  assert.throws(() => toRawUnits("1.0000001", 6, "x"), /more than 6 decimal places/);
  assert.throws(() => toRawUnits("1e3", 6, "x"), /plain number/);
  const p = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 275.616\n  HUSDT: 1" }), config);
  assert.equal(p.budgetPerDay.get("HUSDC"), 275_616_000n);

  assert.equal(parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: 0" }), config).maxHollarDebt, 0n);
  assert.equal(
    parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: 2.50" }), config).maxHollarDebt,
    (5n * $(1)) / 2n,
  );
  assert.throws(
    () => parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: 2.505" }), config),
    /more than 2 decimal places/,
  );
});

test("the HOLLAR allowance can never be left out or blank", () => {
  assert.throws(() => parseProgram(program({ max_hollar_debt_usd: null }), config), /"max_hollar_debt_usd" is missing/);
  assert.throws(
    () => parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd:" }), config),
    /max_hollar_debt_usd is blank/,
  );
  assert.throws(
    () => parseProgram(program({ max_hollar_debt_usd: "max_hollar_debt_usd: none" }), config),
    /not a plain number/,
  );
});

test("mistakes stop the run with a message a non-developer can act on", () => {
  const withLine = (line: string) => `${program()}\n${line}`;
  assert.throws(
    () => parseProgram(withLine("max_holar_debt_usd: 5"), config),
    /"max_holar_debt_usd" is not known\. Did you mean max_hollar_debt_usd\?/,
  );
  assert.throws(() => parseProgram(program({ name: null }), config), /"name" is missing/);
  assert.throws(
    () => parseProgram(program({ earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDZ]" }), config),
    /"HUSDZ" is not known\. Did you mean HUSDC or HUSDT\?.*ask a developer/,
  );
  assert.throws(
    () => parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDZ: 1" }), config),
    /budget_per_day asset "HUSDZ"/,
  );
  assert.throws(
    () => parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1" }), config),
    /no line for HUSDT/,
  );
  assert.throws(
    () => parseProgram(program({ epoch_start_hour_utc: "epoch_start_hour_utc: 24" }), config),
    /whole hour from 0 to 23/,
  );
  assert.throws(
    () => parseProgram(program({ earn_on_supply_of: "earn_on_supply_of: [HUSDT, HUSDT]" }), config),
    /lists HUSDT twice/,
  );
});

test("each earning asset has a budget of its own", () => {
  const p = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT: 2.5" }), config, {
    requireDecisions: true,
  });
  assert.deepEqual(p.earn, ["HUSDC", "HUSDT"]);
  assert.equal(p.budgetPerDay.get("HUSDC"), 1_000_000n);
  assert.equal(p.budgetPerDay.get("HUSDT"), 2_500_000n);
  // Earning without a budget line of its own is refused.
  assert.throws(
    () => parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1" }), config),
    /no line for HUSDT/,
  );
});

test("HEURC is not a supply asset in the mainnet config, so a program cannot earn on it", () => {
  assert.equal(config.supplyAssets.HEURC, undefined);
  assert.throws(
    () =>
      parseProgram(
        program({
          earn_on_supply_of: "earn_on_supply_of: [HUSDC, HUSDT, HEURC]",
          budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT: 1\n  HEURC: 1",
        }),
        config,
      ),
    /asset "HEURC" is not known/,
  );
});

test("settings from other strategies are refused, not ignored", () => {
  for (const line of [
    "rules:\n  - subtract_debt: [HOLLAR]",
    "exclude_accounts: config/denylist.json",
    "reward: PRIME",
  ]) {
    assert.throws(() => parseProgram(`${program()}\n${line}`, config), /is not known/);
  }
});

test("the preview reports eligible value and what the HOLLAR rule removed", () => {
  const snapshots = hourly(start, () => ({
    [ACCOUNTS.a]: { husdt: 100_000, hollar: 67_000 },
    [ACCOUNTS.b]: { husdc: 10_000 },
    [ACCOUNTS.treasury]: { husdt: 5_000 },
  }));
  const denylist = makeDenylist({ rules: { palletAccounts: true }, addresses: [] });
  const { text, perAccount } = previewProgram(parseProgram(program(), config), snapshots, {
    denylist,
    reward: config.reward,
    rewardPriceUsd: 1,
  });
  assert.match(text, /Supplied HUSDC \+ HUSDT\s+\$115,000/);
  assert.match(text, /excluded accounts \(1\)\s+-\$5,000/);
  assert.match(text, /HOLLAR debt above \$5\.00 \(1 accounts\)\s+-\$100,000/);
  assert.match(text, /Eligible\s+\$10,000/);
  assert.match(text, /Accounts earning: 1/);
  assert.equal(perAccount.find((r) => r.account === ACCOUNTS.a)?.eligibleUsd, 0);
  assert.equal(perAccount.find((r) => r.account === ACCOUNTS.b)?.rewardPerDay, 1);

  const blank = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC:\n  HUSDT:" }), config);
  assert.match(
    previewProgram(blank, snapshots, { denylist, reward: config.reward }).text,
    /budget_per_day is blank for HUSDC and HUSDT, so no amounts are shown/,
  );
  // One budget filled in is still not enough to show amounts, and the message names the one left.
  const half = parseProgram(program({ budget_per_day: "budget_per_day:\n  HUSDC: 1\n  HUSDT:" }), config);
  assert.match(
    previewProgram(half, snapshots, { denylist, reward: config.reward }).text,
    /budget_per_day is blank for HUSDT, so no amounts are shown/,
  );
});

test("for a program with an end, the preview adds up what it pays from its first epoch to the end", () => {
  const snapshots = hourly(start, () => ({ [ACCOUNTS.a]: { husdt: 100 } }));
  const denylist = makeDenylist({ rules: { palletAccounts: true }, addresses: [] });
  const text = (changes = {}) =>
    previewProgram(parseProgram(program(changes), config), snapshots, { denylist, reward: config.reward }).text;

  // 64 epochs from 12 November 2026 to 15 January 2027, at 275.616 and 0.5 PRIME a day: what a funding
  // referendum has to move, to the last unit.
  const ends = {
    ends_at: "ends_at: 2027-01-15T14:00:00Z",
    budget_per_day: "budget_per_day:\n  HUSDC: 275.616\n  HUSDT: 0.5",
  };
  assert.match(
    text(ends),
    /^Until ends_at it pays 64 epochs, from 2026-11-12: HUSDC 17639\.424, HUSDT 32, 17671\.424 PRIME in all$/m,
  );
  assert.match(
    text({
      ends_at: "ends_at: 2026-11-13T14:00:00Z",
      budget_per_day: "budget_per_day:\n  HUSDC: 0.000001\n  HUSDT: 1",
    }),
    /^Until ends_at it pays 1 epoch, from 2026-11-12: HUSDC 0\.000001, HUSDT 1, 1\.000001 PRIME in all$/m,
  );

  // Only with an end, a first epoch, a start hour and every budget.
  for (const changes of [
    {},
    { ...ends, applies_from_epoch: "applies_from_epoch:" },
    { ...ends, epoch_start_hour_utc: "epoch_start_hour_utc:" },
    { ...ends, budget_per_day: "budget_per_day:\n  HUSDC: 275.616\n  HUSDT:" },
  ]) {
    assert.doesNotMatch(text(changes), /Until ends_at/);
  }
});
