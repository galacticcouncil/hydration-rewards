// The calls of the cutover referendum, as the EVM calls Hydration's
// Aave manager account makes: the end of the old PRIME stream on each aToken, and the move of PRIME
// from the old rewards pot to the distributor. This file only builds and checks them. A referendum
// wraps each one in dispatcher.dispatchAsAaveManager(evm.call(...)) inside one utility.batchAll, with
// the gas limit and the fee below.

import { normalizeAddress } from "../src/lib/accounts.ts";

// Hydration's Aave manager account: the PRIME emission admin, and the pot's rewards admin.
export const AAVE_MANAGER = "0xaa7e0000000000000000000000000000000aa7e0";
// The money market's EmissionManager, which sets a stream's end.
export const EMISSION_MANAGER = "0x08e8533cd99f96bd234d8734196285960c613e09";
// The transfer strategy that holds the old stream's PRIME and pays its claims.
export const OLD_POT = "0x112c208b900bcfc9ff8131d0f45769cb6c7c7d8d";

// The fee and gas fields of each evm.call. On Lark (Hydration's testnet) the node estimated 114,020 gas for
// setDistributionEnd and 26,289 for emergencyWithdrawal (2026-11-16). An EVM call that runs out of
// gas inside batchAll still lets the referendum pass, so the limits are well above the estimates.
export const MAX_FEE_PER_GAS = 600_000_000n;
export const GAS_LIMIT = { setDistributionEnd: 250_000, emergencyWithdrawal: 200_000 } as const;

const SELECTOR = {
  setDistributionEnd: "c5a7b538", // setDistributionEnd(address,address,uint32)
  emergencyWithdrawal: "8d8e5da7", // emergencyWithdrawal(address,address,uint256)
} as const;

export interface CutoverCall {
  name: string;
  to: string;
  data: string;
  gasLimit: number;
}

const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (address: string): string => normalizeAddress(address).slice(2).padStart(64, "0");

// The old stream's end has to be an epoch's start: on the hour, and a uint32 of unix seconds.
export function checkEnd(end: number): void {
  if (!Number.isInteger(end) || end <= 0 || end > 0xffff_ffff) throw new Error(`bad end ${end}: unix seconds`);
  if (end % 3600 !== 0) {
    throw new Error(`the end ${end} (${new Date(end * 1000).toISOString()}) is not on the hour`);
  }
}

// A stream's end can only be moved to a moment that has not come yet: enacted after it, the old
// stream has already paid past it.
export function checkEndIsAhead(end: number, now: number): void {
  checkEnd(end);
  if (end <= now) {
    throw new Error(
      `the end ${new Date(end * 1000).toISOString()} is not after the chain's time ${new Date(now * 1000).toISOString()}`,
    );
  }
}

// `end`: the new end of the PRIME stream on each of `aTokens`, in the order given.
// `amount`: raw units of the reward token moved from the old pot to `urd`. Either, or both.
export function cutoverCalls(o: {
  reward: string;
  aTokens: [name: string, address: string][];
  end?: number;
  urd?: string;
  amount?: bigint;
}): CutoverCall[] {
  const calls: CutoverCall[] = [];
  if (o.end !== undefined) {
    checkEnd(o.end);
    if (o.aTokens.length === 0) throw new Error("no aToken to set the end on");
    for (const [name, aToken] of o.aTokens) {
      calls.push({
        name: `setDistributionEnd a${name}`,
        to: EMISSION_MANAGER,
        data: `0x${SELECTOR.setDistributionEnd}${addressWord(aToken)}${addressWord(o.reward)}${word(BigInt(o.end))}`,
        gasLimit: GAS_LIMIT.setDistributionEnd,
      });
    }
  }
  if (o.amount !== undefined) {
    if (o.amount <= 0n) throw new Error(`bad amount ${o.amount}: raw units of the reward token, above zero`);
    if (o.urd === undefined) throw new Error("an amount needs the distributor it goes to");
    calls.push({
      name: "emergencyWithdrawal to the distributor",
      to: OLD_POT,
      data: `0x${SELECTOR.emergencyWithdrawal}${addressWord(o.reward)}${addressWord(o.urd)}${word(o.amount)}`,
      gasLimit: GAS_LIMIT.emergencyWithdrawal,
    });
  }
  if (calls.length === 0) throw new Error("nothing to do: give an end, an amount, or both");
  return calls;
}
