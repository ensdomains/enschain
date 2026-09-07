import { describe, expect, it } from "bun:test";
import { encodeAbiParameters, zeroAddress, type Hex } from "viem";

import {
  diffResolutionSnapshots,
  queriesFromSnapshot,
  recordIsEmpty,
  recordQueries,
  snapshotCarriesRecords,
  type ResolutionSnapshot,
} from "../../script/resolutionSnapshot.js";

function snapshot(
  names: Array<{ name: string; records: Record<string, Hex | null> }>,
): ResolutionSnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    chainId: 1,
    resolverAddress: "0x00000000000000000000000000000000000000ff",
    names: names.map((entry) => ({
      name: entry.name,
      resolver: "0x00000000000000000000000000000000000000aa",
      records: entry.records,
    })),
  };
}

const ADDR_A =
  "0x000000000000000000000000000000000000000000000000000000000000000a" as Hex;
const ADDR_B =
  "0x000000000000000000000000000000000000000000000000000000000000000b" as Hex;

describe("recordQueries", () => {
  it("asks for the address, contenthash, each coin type, and each text key", () => {
    const queries = recordQueries("vitalik.eth", {
      coinTypes: [60n, 0n],
      textKeys: ["avatar"],
    });

    expect(queries.map((query) => query.label)).toEqual([
      "addr",
      "contenthash",
      "addr(60)",
      "addr(0)",
      "text(avatar)",
    ]);
    for (const query of queries) {
      expect(query.call.startsWith("0x")).toBe(true);
    }
  });

  it("distinguishes the two addr overloads, which are separate code paths", () => {
    const [plain, , withCoinType] = recordQueries("vitalik.eth", {
      coinTypes: [60n],
      textKeys: [],
    });
    expect(plain.call).not.toBe(withCoinType.call);
  });
});

describe("queriesFromSnapshot", () => {
  it("rebuilds exactly the records a snapshot captured", () => {
    const queries = queriesFromSnapshot("vitalik.eth", [
      "addr",
      "addr(9999)",
      "text(custom.key)",
    ]);

    expect(queries.map((query) => query.label)).toEqual([
      "addr",
      "addr(9999)",
      "text(custom.key)",
    ]);
  });

  it("omits records the snapshot did not capture", () => {
    // Asking the defaults instead would add contenthash here, and its absence from
    // the snapshot would then read as a revert — a cutover regression that is not one.
    const queries = queriesFromSnapshot("vitalik.eth", ["addr"]);
    expect(queries.map((query) => query.label)).toEqual(["addr"]);
  });

  it("round-trips the labels recordQueries produces", () => {
    const original = recordQueries("vitalik.eth", {
      coinTypes: [60n, 501n],
      textKeys: ["avatar", "com.github"],
    });
    const rebuilt = queriesFromSnapshot(
      "vitalik.eth",
      original.map((query) => query.label),
    );

    expect(rebuilt.map((q) => q.label)).toEqual(original.map((q) => q.label));
    expect(rebuilt.map((q) => q.call)).toEqual(original.map((q) => q.call));
  });

  it("handles a text key containing parentheses", () => {
    const queries = queriesFromSnapshot("vitalik.eth", ["text(a(b)c)"]);
    expect(queries.map((query) => query.label)).toEqual(["text(a(b)c)"]);
  });
});

describe("diffResolutionSnapshots", () => {
  it("passes when every answer is identical", () => {
    const before = snapshot([{ name: "a.eth", records: { addr: ADDR_A } }]);
    expect(diffResolutionSnapshots(before, before)).toEqual([]);
  });

  it("catches an answer that changed", () => {
    const differences = diffResolutionSnapshots(
      snapshot([{ name: "a.eth", records: { addr: ADDR_A } }]),
      snapshot([{ name: "a.eth", records: { addr: ADDR_B } }]),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({
      name: "a.eth",
      record: "addr",
      before: ADDR_A,
      after: ADDR_B,
    });
  });

  it("catches a record that stopped resolving", () => {
    const differences = diffResolutionSnapshots(
      snapshot([{ name: "a.eth", records: { "text(url)": ADDR_A } }]),
      snapshot([{ name: "a.eth", records: { "text(url)": null } }]),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0].after).toBe("(reverted)");
  });

  it("catches a record that started resolving", () => {
    const differences = diffResolutionSnapshots(
      snapshot([{ name: "a.eth", records: { contenthash: null } }]),
      snapshot([{ name: "a.eth", records: { contenthash: ADDR_A } }]),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0].before).toBe("(reverted)");
  });

  it("ignores a record that never resolved either side", () => {
    // A name legitimately without a contenthash must not be reported as a change.
    const before = snapshot([
      { name: "a.eth", records: { contenthash: null } },
    ]);
    expect(diffResolutionSnapshots(before, before)).toEqual([]);
  });

  it("catches a name missing from the post-cutover snapshot entirely", () => {
    const differences = diffResolutionSnapshots(
      snapshot([{ name: "a.eth", records: { addr: ADDR_A } }]),
      snapshot([]),
    );

    expect(differences).toHaveLength(1);
    expect(differences[0].record).toBe("(whole name)");
  });

  it("reports every changed record, not just the first", () => {
    const differences = diffResolutionSnapshots(
      snapshot([
        {
          name: "a.eth",
          records: { addr: ADDR_A, "text(url)": ADDR_A, contenthash: ADDR_A },
        },
      ]),
      snapshot([
        {
          name: "a.eth",
          records: { addr: ADDR_B, "text(url)": null, contenthash: ADDR_A },
        },
      ]),
    );

    expect(differences.map((difference) => difference.record).sort()).toEqual([
      "addr",
      "text(url)",
    ]);
  });
});

// An empty `bytes` or `string` answer is not all zeroes: it carries an offset word.
// Testing the raw bytes for emptiness therefore reads every empty dynamic answer as
// a record, which is what makes a vacuous cutover comparison look verified.
const EMPTY_ADDR = encodeAbiParameters([{ type: "address" }], [zeroAddress]);
const EMPTY_BYTES = encodeAbiParameters([{ type: "bytes" }], ["0x"]);
const EMPTY_TEXT = encodeAbiParameters([{ type: "string" }], [""]);
const REAL_ADDR = encodeAbiParameters(
  [{ type: "address" }],
  ["0x7f1266aa4e48567f42e02e9da040eeec33edd5cb"],
);
const REAL_TEXT = encodeAbiParameters([{ type: "string" }], ["hello"]);

describe("recordIsEmpty", () => {
  it("treats a reverted lookup as no record", () => {
    expect(recordIsEmpty("addr", null)).toBe(true);
  });

  it("treats the zero address as no record", () => {
    expect(recordIsEmpty("addr", EMPTY_ADDR)).toBe(true);
    expect(recordIsEmpty("addr", REAL_ADDR)).toBe(false);
  });

  it("sees through the offset word of an empty bytes answer", () => {
    expect(recordIsEmpty("contenthash", EMPTY_BYTES)).toBe(true);
    expect(recordIsEmpty("addr(60)", EMPTY_BYTES)).toBe(true);
  });

  it("sees through the offset word of an empty string answer", () => {
    expect(recordIsEmpty("text(url)", EMPTY_TEXT)).toBe(true);
    expect(recordIsEmpty("text(url)", REAL_TEXT)).toBe(false);
  });

  it("treats an answer that will not decode as no record", () => {
    expect(recordIsEmpty("text(url)", "0xdeadbeef")).toBe(true);
  });
});

describe("snapshotCarriesRecords", () => {
  it("rejects a sample whose every answer is empty or reverted", () => {
    expect(
      snapshotCarriesRecords(
        snapshot([
          { name: "a.eth", records: { addr: EMPTY_ADDR, "text(url)": null } },
          { name: "b.eth", records: { contenthash: EMPTY_BYTES } },
        ]),
      ),
    ).toBe(false);
  });

  it("accepts a sample where one name answers one record", () => {
    expect(
      snapshotCarriesRecords(
        snapshot([
          { name: "a.eth", records: { addr: EMPTY_ADDR } },
          { name: "b.eth", records: { addr: REAL_ADDR } },
        ]),
      ),
    ).toBe(true);
  });
});
