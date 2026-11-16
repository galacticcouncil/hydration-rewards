import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkEnd,
  checkEndIsAhead,
  cutoverCalls,
  EMISSION_MANAGER,
  GAS_LIMIT,
  OLD_POT,
} from "../tools/cutover-calls.ts";

const PRIME = "0x000000000000000000000000000000010000002b";
const A_TOKENS: [string, string][] = [
  ["HUSDC", "0x35774c305aaf441a102d47988d35f0f5428471b3"],
  ["HUSDT", "0x1806860d27ee903c1ec7586d4f7d598d7591f124"],
];
const URD = "0xbd1108369553bfFBAaa1BA5C8D07a8131EB92F10";

// The calldata of referendum 461 on Lark 0 (2026-11-16), made there with `cast calldata`.
const END_461 = 1794924000; // 2026-11-17T14:00:00Z
const CALLDATA_461 = [
  "0xc5a7b53800000000000000000000000035774c305aaf441a102d47988d35f0f5428471b3000000000000000000000000000000000000000000000000000000010000002b000000000000000000000000000000000000000000000000000000006afc5de0",
  "0xc5a7b5380000000000000000000000001806860d27ee903c1ec7586d4f7d598d7591f124000000000000000000000000000000000000000000000000000000010000002b000000000000000000000000000000000000000000000000000000006afc5de0",
  "0x8d8e5da7000000000000000000000000000000000000000000000000000000010000002b000000000000000000000000bd1108369553bffbaaa1ba5c8d07a8131eb92f10000000000000000000000000000000000000000000000000000000012a05f200",
];

test("the cutover's calls are the calldata of the referendum that ran on Lark 0", () => {
  const calls = cutoverCalls({ reward: PRIME, aTokens: A_TOKENS, end: END_461, urd: URD, amount: 5_000_000_000n });
  assert.deepEqual(
    calls.map((c) => c.data),
    CALLDATA_461,
  );
  assert.deepEqual(
    calls.map((c) => c.to),
    [EMISSION_MANAGER, EMISSION_MANAGER, OLD_POT],
  );
  assert.deepEqual(
    calls.map((c) => c.gasLimit),
    [GAS_LIMIT.setDistributionEnd, GAS_LIMIT.setDistributionEnd, GAS_LIMIT.emergencyWithdrawal],
  );
});

test("an end alone sets the end on each aToken, an amount alone only moves the reward", () => {
  const ends = cutoverCalls({ reward: PRIME, aTokens: A_TOKENS, end: 1794870000 });
  assert.equal(ends.length, 2);
  assert.ok(ends.every((c) => c.to === EMISSION_MANAGER && c.data.endsWith("6afb8af0")));
  const move = cutoverCalls({ reward: PRIME, aTokens: A_TOKENS, urd: URD, amount: 1n });
  assert.equal(move.length, 1);
  assert.equal(move[0]?.to, OLD_POT);
  assert.ok(move[0]?.data.endsWith("1".padStart(64, "0")));
});

test("calls that cannot be meant are refused", () => {
  assert.throws(() => cutoverCalls({ reward: PRIME, aTokens: A_TOKENS }), /nothing to do/);
  assert.throws(() => cutoverCalls({ reward: PRIME, aTokens: A_TOKENS, amount: 1n }), /needs the distributor/);
  assert.throws(() => cutoverCalls({ reward: PRIME, aTokens: A_TOKENS, urd: URD, amount: 0n }), /bad amount/);
  assert.throws(() => cutoverCalls({ reward: PRIME, aTokens: [], end: END_461 }), /no aToken/);
  assert.throws(() => cutoverCalls({ reward: PRIME, aTokens: A_TOKENS, end: END_461 + 60 }), /not on the hour/);
  assert.throws(() => cutoverCalls({ reward: "0x1234", aTokens: A_TOKENS, end: END_461 }), /20-byte/);
});

test("the end is unix seconds on the hour, and ahead of the chain's time when it is set", () => {
  assert.doesNotThrow(() => checkEnd(END_461));
  assert.throws(() => checkEnd(END_461 * 1000), /bad end/);
  assert.throws(() => checkEnd(1.5), /bad end/);
  assert.doesNotThrow(() => checkEndIsAhead(END_461, END_461 - 1));
  assert.throws(() => checkEndIsAhead(END_461, END_461), /not after the chain's time/);
});
