// An epoch id names the epoch's window, and its form depends on how long an epoch is
// (config.epoch.lengthSeconds):
// - one day, the default: the UTC calendar date the window starts on, e.g. "2026-11-12". The window
//   starts at the program's start hour on that date.
// - shorter: the UTC date and hour the window starts at, e.g. "2026-11-17T03". Only the hours a whole
//   number of epochs away from the program's start hour are epochs.
// Ids of one length sort as strings in the order of their windows, and every id is a safe file name.
// The two forms are never mixed: a chain of trees keeps the length it was started with.
import type { Config } from "../types.ts";

export const DAY = 86_400;
const HOUR = 3600;

// A date, and a date with an hour. Anchored: an id becomes part of a path.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_HOUR = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

// A whole number of hours that divides the day, so that every day has the same epochs and an id
// needs no more than the hour.
function checkLength(lengthSeconds: number, what = "an epoch's length"): void {
  if (
    !Number.isInteger(lengthSeconds) ||
    lengthSeconds <= 0 ||
    lengthSeconds % HOUR !== 0 ||
    DAY % lengthSeconds !== 0
  ) {
    throw new Error(
      `${what} must be a whole number of hours that divides a day, like 86400 or 14400 seconds, got ${lengthSeconds}`,
    );
  }
}

// The epoch length in seconds: config.epoch.lengthSeconds, or one day when it is left out. No command
// loads its config through one place, so each of them asks here, and a length or a snapshot count that
// cannot work is refused before anything is read with it.
export function epochLength(config: Pick<Config, "epoch">): number {
  const lengthSeconds = config.epoch.lengthSeconds ?? DAY;
  checkLength(lengthSeconds, "config epoch.lengthSeconds");
  const perEpoch = config.epoch.snapshotsPerEpoch;
  if (!Number.isInteger(perEpoch) || perEpoch <= 0 || lengthSeconds % perEpoch !== 0) {
    throw new Error(
      `config epoch.snapshotsPerEpoch must split the epoch's ${lengthSeconds} seconds into whole seconds, got ${perEpoch}`,
    );
  }
  return lengthSeconds;
}

// Seconds from one snapshot of an epoch to the next.
export const snapshotInterval = (config: Pick<Config, "epoch">): number =>
  epochLength(config) / config.epoch.snapshotsPerEpoch;

// Which form a name has: "day" for a date, "hour" for a date and hour, null for anything else. The
// shape only (2026-11-31 has one): it tells stored files of the two forms apart, it does not check an id.
export const epochIdShape = (name: string): "day" | "hour" | null =>
  DATE.test(name) ? "day" : DATE_HOUR.test(name) ? "hour" : null;

// The shape of the ids of epochs of this length.
export const epochIdShapeFor = (lengthSeconds: number): "day" | "hour" => (lengthSeconds === DAY ? "day" : "hour");

// Milliseconds at the instant an id names: 00:00 UTC of its date for a one-day epoch (epochStart adds
// the start hour), the hour itself for a shorter one. Refuses anything that is not a real date, or
// date and hour, in the form of this length: Date would quietly read 2026-11-31 as 1 December, or
// hour 24 as the next day, and give one window two names. A date given for a shorter epoch is refused
// like any other id of the wrong form, and so is a date and hour given for a one-day epoch.
// Only the id is checked here. Whether a date and hour is one of the program's epochs depends on its
// start hour, which epochStart knows.
export function parseEpochId(epoch: string, lengthSeconds = DAY): number {
  checkLength(lengthSeconds);
  if (lengthSeconds === DAY) {
    const m = DATE.exec(String(epoch));
    const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
    if (!m || new Date(ms).toISOString().slice(0, 10) !== epoch) {
      throw new Error(`an epoch must be a date like 2026-11-12, got ${epoch}`);
    }
    return ms;
  }
  const m = DATE_HOUR.exec(String(epoch));
  const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])) : NaN;
  if (!m || new Date(ms).toISOString().slice(0, 13) !== epoch) {
    throw new Error(
      `an epoch of ${lengthSeconds} seconds must be the UTC date and hour it starts at, like 2026-11-17T03, got ${epoch}` +
        (DATE.test(String(epoch)) ? " (a date alone names a one-day epoch)" : ""),
    );
  }
  return ms;
}

// The id that names the instant `ms`, in the form of this length: parseEpochId the other way round.
export const formatEpochId = (ms: number, lengthSeconds = DAY): string =>
  new Date(ms).toISOString().slice(0, lengthSeconds === DAY ? 10 : 13);

// The id `epochs` epochs later, or earlier when negative. It needs no start hour: a whole number of
// epochs away from an epoch is an epoch.
export const addEpochs = (epoch: string, epochs: number, lengthSeconds = DAY): string =>
  formatEpochId(parseEpochId(epoch, lengthSeconds) + epochs * lengthSeconds * 1000, lengthSeconds);

// Unix seconds at which the epoch's window starts. A one-day epoch starts at the start hour on its
// date. A shorter one starts at the hour its id names, which must be a whole number of epochs away
// from the start hour: 2026-11-17T04 is no epoch of a program whose four-hour epochs start at 23.
export function epochStart(epoch: string, startHourUtc: number | null | undefined, lengthSeconds = DAY): number {
  const ms = parseEpochId(epoch, lengthSeconds);
  if (typeof startHourUtc !== "number" || !Number.isInteger(startHourUtc) || startHourUtc < 0 || startHourUtc > 23) {
    throw new Error("the epoch start hour (UTC, 0-23) is required and has no default");
  }
  if (lengthSeconds === DAY) return ms / 1000 + startHourUtc * HOUR;
  const start = ms / 1000;
  if ((start - startHourUtc * HOUR) % lengthSeconds !== 0) {
    const hours = Array.from(
      { length: DAY / lengthSeconds },
      (_, k) => (startHourUtc + (k * lengthSeconds) / HOUR) % 24,
    )
      .sort((a, b) => a - b)
      .map((hour) => String(hour).padStart(2, "0"));
    throw new Error(
      `${epoch} is not an epoch: with epochs of ${lengthSeconds} seconds and epoch_start_hour_utc ${startHourUtc}, ` +
        `an epoch starts at hour ${hours.join(", ")} UTC`,
    );
  }
  return start;
}
