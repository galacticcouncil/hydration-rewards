// What each account has earned so far in the epoch still open: an estimate for the app, published as
// "openEpoch" in public/latest.json (src/publish.ts). No network, no clock, no files.
//
// Each asset's budget for the epoch is scaled to the share of the epoch's snapshots that exist, rounded
// down, and split over those snapshots by the code a close uses (src/eligibility.ts, src/allocate.ts):
//   estimate_a = floor( Σ_r floor(budget_r × snapshots / expected) × e_{a,r} / E_r )
// So an account that left earlier in the epoch keeps what it earned in the hours it held, HOLLAR
// borrowers and denylisted accounts get nothing, and once every snapshot is in the result is exactly
// what the close pays. Until then it is an estimate: an account's share of an asset is its share of the
// hours so far, and the hours still to come change it, up or down.
//
// Nothing here knows how long an epoch is or how it is named. The caller passes the budgets of one
// whole epoch, the epoch's window and its id.

import { allocate } from "./allocate.ts";
import { epochEligibility } from "./eligibility.ts";
import type { EligibilityOptions } from "./eligibility.ts";
import { compareAddresses } from "./lib/accounts.ts";
import type { EpochWindow, OpenEpoch, Snapshot } from "./types.ts";

// account -> raw reward units. Accounts with nothing are left out, so the map is empty while the epoch
// has no snapshot. null while a budget is undecided: no estimate can be made without it.
export function estimateAccruing({
  snapshots,
  expectedSnapshots,
  budgets,
  eligibility,
}: {
  // the epoch's snapshots that exist, as a close would load them
  snapshots: Snapshot[];
  // how many a full epoch has
  expectedSnapshots: number;
  // per earning asset, the budget of one whole epoch; null while undecided
  budgets: Map<string, bigint | null>;
  // what a close of this epoch passes to the eligibility code
  eligibility: EligibilityOptions;
}): Map<string, bigint> | null {
  if (!Number.isInteger(expectedSnapshots) || expectedSnapshots < 1) {
    throw new Error(`an epoch has a whole number of snapshots, at least one; got ${expectedSnapshots}`);
  }
  if (snapshots.length > expectedSnapshots) {
    throw new Error(`${snapshots.length} snapshots were given for an epoch that has ${expectedSnapshots}`);
  }
  const scaled = new Map<string, bigint>();
  for (const [asset, budget] of budgets) {
    if (budget === null) return null;
    scaled.set(asset, (budget * BigInt(snapshots.length)) / BigInt(expectedSnapshots));
  }
  if (snapshots.length === 0) return new Map();

  const { eligible, totals } = epochEligibility(snapshots, eligibility);
  const { amounts } = allocate({ eligible, totals, budgets: scaled });
  // The check a close makes before it pays: no amount is shown for an account it would refuse.
  for (const account of amounts.keys()) {
    if (eligibility.denylist.reasonFor(account))
      throw new Error(`denylisted account ${account} would be shown earning`);
  }
  return amounts;
}

// The "openEpoch" object of public/latest.json. `snapshots` is how many of the epoch's snapshots exist,
// and `accruing` what estimateAccruing made of them, or null when it could not.
export function openEpochStatus({
  id,
  window,
  snapshots,
  expectedSnapshots,
  accruing,
}: {
  id: string;
  window: EpochWindow;
  snapshots: number;
  expectedSnapshots: number;
  accruing: Map<string, bigint> | null;
}): OpenEpoch {
  return {
    id,
    start: window.start,
    end: window.end,
    snapshots,
    expectedSnapshots,
    accruing:
      accruing &&
      Object.fromEntries(
        [...accruing]
          .filter(([, amount]) => amount > 0n)
          .sort(([a], [b]) => compareAddresses(a, b))
          .map(([account, amount]): [string, string] => [account, amount.toString()]),
      ),
  };
}
