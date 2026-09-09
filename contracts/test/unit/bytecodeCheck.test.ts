import { describe, expect, it } from "bun:test";

import {
  compareDeployedBytecode,
  describeComparison,
  extractImmutableValues,
  immutableAsAddress,
  maskImmutables,
} from "../../script/migrations/bytecodeCheck.js";

// A 32-byte word holding a left-padded address, as the compiler writes one.
function addressWord(address: string): string {
  return `${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

describe("maskImmutables", () => {
  it("leaves bytecode untouched when nothing is immutable", () => {
    expect(maskImmutables("0xdeadbeef", undefined)).toBe("deadbeef");
  });

  it("blanks the byte ranges an immutable occupies", () => {
    // Bytes: de ad be ef — blanking byte 1 (length 1) clears "ad".
    expect(
      maskImmutables("0xdeadbeef", { "1": [{ start: 1, length: 1 }] }),
    ).toBe("de00beef");
  });

  it("blanks every range of every immutable", () => {
    expect(
      maskImmutables("0xdeadbeefcafe", {
        "1": [{ start: 0, length: 1 }],
        "2": [{ start: 2, length: 1 }],
      }),
    ).toBe("00ad00efcafe");
  });

  it("ignores a range past the end rather than throwing", () => {
    expect(() =>
      maskImmutables("0xdead", { "1": [{ start: 8, length: 4 }] }),
    ).not.toThrow();
  });
});

describe("compareDeployedBytecode", () => {
  it("matches identical bytecode", () => {
    expect(
      compareDeployedBytecode({
        onChain: "0xdeadbeef",
        artifact: "0xdeadbeef",
      }),
    ).toEqual({ kind: "match" });
  });

  it("matches regardless of hex case", () => {
    expect(
      compareDeployedBytecode({
        onChain: "0xDEADBEEF",
        artifact: "0xdeadbeef",
      }),
    ).toEqual({ kind: "match" });
  });

  it("reports an address with no code", () => {
    expect(
      compareDeployedBytecode({ onChain: "0x", artifact: "0xdeadbeef" }),
    ).toEqual({ kind: "no-code" });
    expect(
      compareDeployedBytecode({ onChain: null, artifact: "0xdeadbeef" }),
    ).toEqual({ kind: "no-code" });
  });

  it("reports a different contract at the address", () => {
    const comparison = compareDeployedBytecode({
      onChain: "0xdeadbe11",
      artifact: "0xdeadbeef",
    });
    expect(comparison).toEqual({ kind: "differs", firstDifferenceOffset: 3 });
  });

  it("reports a length mismatch separately from a content difference", () => {
    expect(
      compareDeployedBytecode({ onChain: "0xdead", artifact: "0xdeadbeef" }),
    ).toEqual({ kind: "length-mismatch", expected: 4, actual: 2 });
  });

  it("matches when only the immutable values differ, as they must", () => {
    // Constructor-set immutables are baked into runtime code, so the compiler's copy
    // and the deployed copy legitimately differ exactly there.
    const comparison = compareDeployedBytecode({
      onChain: "0xdeadCAFEbeef",
      artifact: "0xdead0000beef",
      immutableReferences: { "1": [{ start: 2, length: 2 }] },
    });
    expect(comparison).toEqual({ kind: "match" });
  });

  it("still catches a difference outside the immutable range", () => {
    const comparison = compareDeployedBytecode({
      onChain: "0xdeadCAFEbe11",
      artifact: "0xdead0000beef",
      immutableReferences: { "1": [{ start: 2, length: 2 }] },
    });
    expect(comparison.kind).toBe("differs");
  });
});

describe("describeComparison", () => {
  it("names the contract and address in every outcome", () => {
    const address = "0x00000000000000000000000000000000000000ff";
    for (const comparison of [
      { kind: "match" } as const,
      { kind: "no-code" } as const,
      { kind: "length-mismatch", expected: 4, actual: 2 } as const,
      { kind: "differs", firstDifferenceOffset: 3 } as const,
    ]) {
      const described = describeComparison("ETHRegistry", address, comparison);
      expect(described).toContain("ETHRegistry");
      expect(described).toContain(address);
    }
  });
});

describe("extractImmutableValues", () => {
  const registry = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
  const resolver = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63";

  // Two immutables in one runtime image: the first written at two offsets, as the
  // compiler does when a value is read in more than one place.
  const code = `0x${addressWord(registry)}${addressWord(resolver)}${addressWord(registry)}`;
  const references = {
    "10": [
      { start: 0, length: 32 },
      { start: 64, length: 32 },
    ],
    "11": [{ start: 32, length: 32 }],
  };

  it("reads back what construction wrote, which the comparison blanks", () => {
    const values = extractImmutableValues(code, references);
    expect(values.map((value) => immutableAsAddress(value))).toEqual([
      registry.toLowerCase(),
      resolver.toLowerCase(),
    ]);
    // The bytes are identical once masked, so the comparison alone sees nothing.
    expect(maskImmutables(code, references)).toBe("0".repeat(192));
  });

  it("reports an immutable whose copies disagree", () => {
    const tampered = `0x${addressWord(registry)}${addressWord(resolver)}${addressWord(resolver)}`;
    const values = extractImmutableValues(tampered, references);
    expect(values.find((value) => value.astId === "10")?.inconsistent).toBe(
      true,
    );
    expect(values.find((value) => value.astId === "11")?.inconsistent).toBe(
      false,
    );
  });

  it("returns nothing when the artifact declares no immutables", () => {
    expect(extractImmutableValues(code, undefined)).toEqual([]);
  });

  it("keeps a vanity address with a long zero prefix", () => {
    // The ENS registry is one. Any rule that discarded low-magnitude words to
    // filter out scalars would discard the reference that matters most.
    const [value] = extractImmutableValues(`0x${addressWord(registry)}`, {
      "1": [{ start: 0, length: 32 }],
    });
    expect(immutableAsAddress(value)).toBe(registry.toLowerCase());
  });

  it("ignores a zero address, which wires nothing", () => {
    const [value] = extractImmutableValues(`0x${"0".repeat(64)}`, {
      "1": [{ start: 0, length: 32 }],
    });
    expect(immutableAsAddress(value)).toBeNull();
  });
});
