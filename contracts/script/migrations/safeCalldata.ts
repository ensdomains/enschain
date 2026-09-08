// Re-derives the calldata a migration phase produced, so what a Safe is about to
// sign can be checked against it.
//
// On mainnet the owner-gated phases run with `--calldata-only` and the resulting
// bytes travel by hand into a Safe. Between here and there they are copied, pasted,
// and read by people. A wrong target or a transposed argument is not visible by
// inspection — `0x...` looks like every other `0x...` — and once the Safe threshold
// signs, it executes. This turns "someone eyeballed it" into a comparison.

import { decodeFunctionData, getAddress, type Abi, type Hex } from "viem";

export type PreparedCall = {
  to: string;
  data: string;
  value?: string;
};

export type CalldataVerdict =
  | { kind: "match"; functionName: string; args: readonly unknown[] }
  | { kind: "target-mismatch"; expected: string; actual: string }
  | { kind: "value-mismatch"; expected: string; actual: string }
  | { kind: "data-mismatch"; expected: string; actual: string }
  | { kind: "undecodable"; reason: string };

function normalizeHex(value: string): string {
  return (value.startsWith("0x") ? value : `0x${value}`).toLowerCase();
}

// Compares a transaction someone is about to sign against the one the tool produced.
//
// Target, value, and calldata are all compared: a correct payload sent to the wrong
// contract is just as wrong as the reverse, and a stray `value` on a call that should
// carry none moves funds.
export function compareCalldata(
  expected: PreparedCall,
  actual: PreparedCall,
): CalldataVerdict {
  if (getAddress(expected.to as Hex) !== getAddress(actual.to as Hex)) {
    return {
      kind: "target-mismatch",
      expected: getAddress(expected.to as Hex),
      actual: getAddress(actual.to as Hex),
    };
  }

  const expectedValue = BigInt(expected.value ?? "0");
  const actualValue = BigInt(actual.value ?? "0");
  if (expectedValue !== actualValue) {
    return {
      kind: "value-mismatch",
      expected: expectedValue.toString(),
      actual: actualValue.toString(),
    };
  }

  const expectedData = normalizeHex(expected.data);
  const actualData = normalizeHex(actual.data);
  if (expectedData !== actualData) {
    return {
      kind: "data-mismatch",
      expected: expectedData,
      actual: actualData,
    };
  }

  return { kind: "match", functionName: "", args: [] };
}

// Decodes calldata so a reviewer sees a function call rather than a hex blob. A
// payload that cannot be decoded against the expected ABI is reported as such: it
// means the bytes are not the call anyone thinks they are.
export function decodeCalldata(
  abi: Abi,
  data: string,
): { functionName: string; args: readonly unknown[] } | { error: string } {
  try {
    const decoded = decodeFunctionData({
      abi,
      data: normalizeHex(data) as Hex,
    });
    return {
      functionName: decoded.functionName,
      args: (decoded.args ?? []) as readonly unknown[],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function describeVerdict(verdict: CalldataVerdict): string {
  switch (verdict.kind) {
    case "match":
      return "calldata matches the prepared transaction";
    case "target-mismatch":
      return `target mismatch: prepared for ${verdict.expected}, about to send to ${verdict.actual}`;
    case "value-mismatch":
      return `value mismatch: prepared ${verdict.expected} wei, about to send ${verdict.actual} wei`;
    case "data-mismatch":
      return `calldata mismatch:\n  prepared: ${verdict.expected}\n  actual:   ${verdict.actual}`;
    case "undecodable":
      return `calldata could not be decoded: ${verdict.reason}`;
  }
}
