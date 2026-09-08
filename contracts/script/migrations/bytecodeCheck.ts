// Compares the code actually running at an address against the artifact the
// deployment claims is there.
//
// Nothing else does this. Source verification on Etherscan/Sourcify is a one-way
// submission, not a check you can re-run, and every `getCode` call in this repo is a
// liveness probe rather than a comparison. So a deployment record can name a contract
// that is not the contract at that address — from a stale artifact, a partial deploy,
// or a record copied between namespaces — and every downstream check would happily
// call the wrong code.

export type ImmutableReferences = Record<
  string,
  Array<{ start: number; length: number }>
>;

export type BytecodeComparison =
  | { kind: "match" }
  | { kind: "no-code" }
  | { kind: "length-mismatch"; expected: number; actual: number }
  | { kind: "differs"; firstDifferenceOffset: number };

function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

// Immutable values are written into the runtime code at construction, so they differ
// between the compiler's output and the deployed copy by design. Their byte ranges
// are blanked in both before comparing, leaving only the parts that must be identical.
export function maskImmutables(
  bytecode: string,
  immutableReferences: ImmutableReferences | undefined,
): string {
  const hex = strip0x(bytecode);
  if (!immutableReferences) return hex;

  const bytes = hex.split("");
  for (const ranges of Object.values(immutableReferences)) {
    for (const { start, length } of ranges) {
      // Offsets and lengths are in bytes; the string holds two characters per byte.
      for (let index = start * 2; index < (start + length) * 2; index++) {
        if (index < bytes.length) bytes[index] = "0";
      }
    }
  }
  return bytes.join("");
}

export type ImmutableValue = {
  /** AST id of the immutable, as the compiler records it. */
  astId: string;
  /** Byte offsets in the runtime code the value was written to. */
  offsets: number[];
  length: number;
  /** The bytes found there, hex without a 0x prefix. */
  value: string;
  /** True when the copies disagree, which no correctly constructed code produces. */
  inconsistent: boolean;
};

// Reads back what construction wrote into the runtime code.
//
// `compareDeployedBytecode` blanks these ranges, because the compiler's output cannot
// carry them — which means the constructor-set addresses that wire a deployment
// together are exactly the bytes the comparison does not look at. Reading them out is
// what lets those references be audited separately.
export function extractImmutableValues(
  bytecode: string,
  immutableReferences: ImmutableReferences | undefined,
): ImmutableValue[] {
  const hex = strip0x(bytecode).toLowerCase();
  if (!immutableReferences) return [];

  const values: ImmutableValue[] = [];
  for (const [astId, ranges] of Object.entries(immutableReferences)) {
    if (ranges.length === 0) continue;
    const copies: string[] = [];
    const offsets: number[] = [];
    for (const { start, length } of ranges) {
      // Offsets and lengths are in bytes; the string holds two characters per byte.
      const slice = hex.slice(start * 2, (start + length) * 2);
      if (slice.length !== length * 2) continue;
      copies.push(slice);
      offsets.push(start);
    }
    if (copies.length === 0) continue;
    values.push({
      astId,
      offsets,
      length: ranges[0].length,
      value: copies[0],
      inconsistent: copies.some((copy) => copy !== copies[0]),
    });
  }
  return values;
}

// The low 20 bytes of an immutable, read as an address.
//
// Shape cannot separate an address from a scalar — both are left-padded 32-byte
// words, and ENS's own registry is a vanity address with eleven leading zeros — so
// this only reports what the bytes could be. Whether they are an address is settled
// by looking the value up among the addresses actually deployed, not by guessing
// from its magnitude.
export function immutableAsAddress(value: ImmutableValue): string | null {
  if (value.length !== 32) return null;
  if (!/^0{24}[0-9a-f]{40}$/.test(value.value)) return null;
  const address = value.value.slice(24);
  return /^0+$/.test(address) ? null : `0x${address}`;
}

export function compareDeployedBytecode(opts: {
  onChain: string | null | undefined;
  artifact: string | undefined;
  immutableReferences?: ImmutableReferences;
}): BytecodeComparison {
  const onChain = strip0x(opts.onChain ?? "");
  if (onChain === "") return { kind: "no-code" };

  const expected = maskImmutables(
    opts.artifact ?? "",
    opts.immutableReferences,
  ).toLowerCase();
  const actual = maskImmutables(
    onChain,
    opts.immutableReferences,
  ).toLowerCase();

  if (expected.length !== actual.length) {
    return {
      kind: "length-mismatch",
      expected: expected.length / 2,
      actual: actual.length / 2,
    };
  }
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] !== actual[index]) {
      return { kind: "differs", firstDifferenceOffset: Math.floor(index / 2) };
    }
  }
  return { kind: "match" };
}

export function describeComparison(
  name: string,
  address: string,
  comparison: BytecodeComparison,
): string {
  switch (comparison.kind) {
    case "match":
      return `${name} ${address}: bytecode matches`;
    case "no-code":
      return `${name} ${address}: no code at address`;
    case "length-mismatch":
      return `${name} ${address}: bytecode length ${comparison.actual} on chain, artifact says ${comparison.expected}`;
    case "differs":
      return `${name} ${address}: bytecode differs from byte ${comparison.firstDifferenceOffset}`;
  }
}
