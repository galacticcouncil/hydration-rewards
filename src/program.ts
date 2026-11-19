// Reads a rewards program file (programs/*.yaml) and checks every setting before anything runs.
// A misspelt key, an unknown asset or a missing setting stops the run: a setting that is silently
// ignored would pay accounts it should not. See programs/README.md for the file format.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { DAY, epochLength, epochStart, parseEpochId } from "./lib/epoch.ts";
import { messageOf, sha256 } from "./lib/io.ts";
import type { Config, Program } from "./types.ts";

const PROGRAM_KEYS = [
  "name",
  "applies_from_epoch",
  "ends_at",
  "budget_per_day",
  "epoch_start_hour_utc",
  "earn_on_supply_of",
  "max_hollar_debt_usd",
];
// Undecided settings may be left out as well as left blank; closing an epoch needs them all.
const DECISIONS = ["applies_from_epoch", "epoch_start_hour_utc"];
// May be left out or left blank for good: a program without ends_at has no end.
const OPTIONAL = ["ends_at"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function notKnown(what: string, value: unknown, known: string[]): Error {
  const close = known.filter((k) => distance(String(value).toLowerCase(), k.toLowerCase()) <= 2);
  const hint = close.length ? ` Did you mean ${close.join(" or ")}?` : ` Use one of: ${known.join(", ")}.`;
  return new Error(`${what} "${value}" is not known.${hint}`);
}

const blank = (v: unknown): boolean => v === null || v === undefined || v === "";

// "275.616" -> 275616000n for 6 decimals; refuses more decimal places than `decimals`.
export function toRawUnits(text: unknown, decimals: number, where: string): bigint {
  const s = String(text).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${where}: "${s}" is not a plain number like 275.616`);
  const fraction = m[2] ?? "";
  if (fraction.length > decimals) throw new Error(`${where}: ${s} has more than ${decimals} decimal places`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

// text: the file's contents. config: config/mainnet.json, or the config of the run. Returns a checked program.
// With requireDecisions, a blank budget, start hour or first epoch is an error (closing an epoch);
// without it they come back as null (previewing).
export function parseProgram(
  text: string,
  config: Config,
  { source = "program", requireDecisions = false }: { source?: string; requireDecisions?: boolean } = {},
): Program {
  // The failsafe schema keeps every value as text, so 275.616 never passes through a float.
  const doc = parse(text, { schema: "failsafe" });
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error(`${source}: expected settings like "name: ..."`);

  for (const key of Object.keys(doc))
    if (!PROGRAM_KEYS.includes(key)) throw notKnown(`${source}: setting`, key, PROGRAM_KEYS);
  for (const key of PROGRAM_KEYS) {
    if (!(key in doc) && !DECISIONS.includes(key) && !OPTIONAL.includes(key))
      throw new Error(`${source}: "${key}" is missing`);
  }

  const supplyAssets = Object.keys(config.supplyAssets);
  const listed = Array.isArray(doc.earn_on_supply_of) ? doc.earn_on_supply_of : [doc.earn_on_supply_of];
  if (listed.length === 0 || listed.some(blank))
    throw new Error(`${source}: earn_on_supply_of needs at least one asset`);
  const earn: string[] = listed.map(String);
  for (const [i, asset] of earn.entries()) {
    if (!supplyAssets.includes(asset)) {
      throw new Error(
        `${notKnown(`${source}: earn_on_supply_of asset`, asset, supplyAssets).message} ` +
          "The snapshot only records supply of these; ask a developer to add others to config/mainnet.json.",
      );
    }
    if (earn.indexOf(asset) !== i) throw new Error(`${source}: earn_on_supply_of lists ${asset} twice`);
  }

  const budgets = doc.budget_per_day;
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new Error(`${source}: budget_per_day needs one line per earning asset`);
  }
  for (const key of Object.keys(budgets))
    if (!earn.includes(key)) throw notKnown(`${source}: budget_per_day asset`, key, earn);
  const budgetPerDay = new Map<string, bigint | null>();
  for (const asset of earn) {
    if (!(asset in budgets)) throw new Error(`${source}: budget_per_day has no line for ${asset}`);
    if (blank(budgets[asset])) {
      if (requireDecisions)
        throw new Error(`${source}: budget_per_day for ${asset} is blank; fill it in before closing an epoch`);
      budgetPerDay.set(asset, null);
    } else {
      budgetPerDay.set(asset, toRawUnits(budgets[asset], config.reward.decimals, `${source}: budget_per_day ${asset}`));
    }
  }

  let startHourUtc: number | null = null;
  if (!blank(doc.epoch_start_hour_utc)) {
    const h = String(doc.epoch_start_hour_utc);
    if (!/^\d{1,2}$/.test(h) || Number(h) > 23)
      throw new Error(`${source}: epoch_start_hour_utc must be a whole hour from 0 to 23`);
    startHourUtc = Number(h);
  } else if (requireDecisions) {
    throw new Error(`${source}: epoch_start_hour_utc is blank; fill it in before closing an epoch`);
  }

  // The first epoch this file pays. A close of an earlier epoch with it is refused, and so is a close
  // after it that does not follow one made with this same file (src/close-epoch.ts).
  // It is an id of an epoch of the configured length (src/lib/epoch.ts): a date for one-day epochs,
  // and for shorter ones a date and hour, which must be an hour an epoch starts at once the start
  // hour is decided.
  let appliesFromEpoch: string | null = null;
  if (!blank(doc.applies_from_epoch)) {
    appliesFromEpoch = String(doc.applies_from_epoch);
    const lengthSeconds = epochLength(config);
    try {
      if (startHourUtc === null) parseEpochId(appliesFromEpoch, lengthSeconds);
      else epochStart(appliesFromEpoch, startHourUtc, lengthSeconds);
    } catch (error) {
      throw new Error(
        lengthSeconds === DAY
          ? `${source}: applies_from_epoch must be a date like 2027-01-15, got ${appliesFromEpoch}`
          : `${source}: applies_from_epoch: ${messageOf(error)}`,
      );
    }
  } else if (requireDecisions) {
    throw new Error(
      `${source}: applies_from_epoch is blank; write the first epoch this file pays before closing an epoch`,
    );
  }

  // The moment the program ends, if it has an end: the last epoch this file pays is the one that ends
  // then, and no later epoch is closed with it (src/close-epoch.ts). Text in one form only, a UTC time
  // on the hour, so that no time zone or half hour is read into it.
  let endsAt: number | null = null;
  if (!blank(doc.ends_at)) {
    const text = String(doc.ends_at);
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00:00Z$/.exec(text);
    const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])) : NaN;
    if (!m || new Date(ms).toISOString() !== `${text.slice(0, -1)}.000Z`) {
      throw new Error(
        `${source}: ends_at must be a UTC time on the hour, written like 2027-01-15T14:00:00Z, got ${text}`,
      );
    }
    endsAt = ms / 1000;
    const lengthSeconds = epochLength(config);
    // It is a moment an epoch ends at: a whole number of epochs away from the start hour. One-day
    // epochs all end at the start hour, and shorter ones at each hour one of them starts at.
    if (startHourUtc !== null && (endsAt - startHourUtc * 3600) % lengthSeconds !== 0) {
      const hour = startHourUtc;
      const hours = Array.from({ length: DAY / lengthSeconds }, (_, k) => (hour + (k * lengthSeconds) / 3600) % 24)
        .sort((a, b) => a - b)
        .map((h) => `${String(h).padStart(2, "0")}:00`);
      throw new Error(
        `${source}: ends_at must be a time an epoch ends at, and with epoch_start_hour_utc ${startHourUtc} ` +
          `${lengthSeconds === DAY ? "epochs" : `epochs of ${lengthSeconds} seconds`} end at ${hours.join(", ")} UTC; ` +
          `got ${text}`,
      );
    }
    // The file pays at least one epoch. The id of an epoch shorter than a day is the hour it starts at.
    // A one-day epoch starts at the start hour of its date, and while that hour is undecided at
    // midnight at the earliest, so an end that is not after that is wrong whatever the hour will be.
    if (appliesFromEpoch !== null) {
      const firstStart =
        startHourUtc === null
          ? parseEpochId(appliesFromEpoch, lengthSeconds) / 1000
          : epochStart(appliesFromEpoch, startHourUtc, lengthSeconds);
      if (endsAt <= firstStart) {
        throw new Error(
          `${source}: ends_at ${text} is not after the start of applies_from_epoch ${appliesFromEpoch}, ` +
            "so this file would pay no epoch",
        );
      }
    }
  }

  // Never optional: a blank here must not turn into "HOLLAR borrowers earn too".
  if (blank(doc.max_hollar_debt_usd)) {
    throw new Error(
      `${source}: max_hollar_debt_usd is blank; write a dollar amount (0 means any HOLLAR debt disqualifies)`,
    );
  }
  const maxHollarDebt = toRawUnits(doc.max_hollar_debt_usd, 2, `${source}: max_hollar_debt_usd`) * 10n ** 24n;

  if (blank(doc.name)) throw new Error(`${source}: name is blank`);
  return {
    name: String(doc.name),
    earn,
    budgetPerDay,
    startHourUtc,
    appliesFromEpoch,
    endsAt,
    maxHollarDebt,
    sha256: sha256(text),
  };
}

export function loadProgram(path: string, config: Config, options: { requireDecisions?: boolean } = {}): Program {
  return parseProgram(readFileSync(path, "utf8"), config, { source: path, ...options });
}
