// Captures how names resolve, so the same questions can be asked again after the
// Universal Resolver cutover and the answers compared.
//
// The cutover repoints public resolution at v2. Verifying it by checking that a name
// resolves to a non-zero address proves almost nothing: a name that resolved to the
// wrong address, lost its text records, or stopped resolving a coin type it used to
// support would all pass. What matters is that every answer is the same one the v1
// resolver gave before the switch, so the check is a diff against a snapshot rather
// than a liveness probe.

import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  namehash,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export const RESOLVER_ABI = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
]);

// The records worth comparing. Coin types and text keys are the two places a
// resolver migration most easily drops data, because each is a separate lookup that
// a partial implementation can answer with an empty value instead of failing.
export const DEFAULT_COIN_TYPES = [60n, 0n, 2147483785n] as const;
export const DEFAULT_TEXT_KEYS = [
  "avatar",
  "url",
  "com.twitter",
  "description",
] as const;

export type RecordQuery = {
  /** Human-readable identity of the record, used when reporting a difference. */
  label: string;
  call: Hex;
};

export type NameSnapshot = {
  name: string;
  /** Resolver the name resolved through, or the zero address when it had none. */
  resolver: Address;
  /** Record label to the raw returned bytes, or null when the lookup reverted. */
  records: Record<string, Hex | null>;
};

export type ResolutionSnapshot = {
  capturedAt: string;
  chainId: number;
  resolverAddress: Address;
  names: NameSnapshot[];
};

// Builds the record lookups for one name. `addr(bytes32)` is kept alongside the
// coin-type form because they are distinct code paths on most resolvers.
export function recordQueries(
  name: string,
  {
    coinTypes = DEFAULT_COIN_TYPES,
    textKeys = DEFAULT_TEXT_KEYS,
  }: {
    coinTypes?: readonly bigint[];
    textKeys?: readonly string[];
  } = {},
): RecordQuery[] {
  const node = namehash(name);
  const queries: RecordQuery[] = [
    {
      label: "addr",
      call: encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: "addr",
        args: [node],
      }),
    },
    {
      label: "contenthash",
      call: encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: "contenthash",
        args: [node],
      }),
    },
  ];
  for (const coinType of coinTypes) {
    queries.push({
      label: `addr(${coinType})`,
      call: encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: "addr",
        args: [node, coinType],
      }),
    });
  }
  for (const key of textKeys) {
    queries.push({
      label: `text(${key})`,
      call: encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: "text",
        args: [node, key],
      }),
    });
  }
  return queries;
}

// Rebuilds the exact lookups a snapshot recorded, from the labels it stored.
//
// Verification has to ask the same questions the snapshot answered. Falling back to
// the defaults compares different records: anything captured under custom coin types
// or text keys is simply absent afterwards and reads as a revert, which looks like a
// cutover regression and is not one.
export function queriesFromSnapshot(
  name: string,
  records: string[],
): RecordQuery[] {
  const coinTypes: bigint[] = [];
  const textKeys: string[] = [];
  let wantsAddr = false;
  let wantsContenthash = false;

  for (const record of records) {
    if (record === "addr") wantsAddr = true;
    else if (record === "contenthash") wantsContenthash = true;
    else {
      const coin = record.match(/^addr\((\d+)\)$/);
      if (coin) {
        coinTypes.push(BigInt(coin[1]));
        continue;
      }
      const text = record.match(/^text\((.*)\)$/s);
      if (text) textKeys.push(text[1]);
    }
  }

  return recordQueries(name, { coinTypes, textKeys }).filter((query) => {
    if (query.label === "addr") return wantsAddr;
    if (query.label === "contenthash") return wantsContenthash;
    return true;
  });
}

export type SnapshotDifference = {
  name: string;
  record: string;
  before: string;
  after: string;
};

function render(value: Hex | null): string {
  return value === null ? "(reverted)" : value;
}

// Compares two snapshots record by record.
//
// A record that reverted before and still reverts is unchanged and not reported: the
// point is to catch answers that *changed*, not to require every name to have every
// record. A record that stops resolving, starts resolving, or returns different bytes
// is a difference in all three directions.
export function diffResolutionSnapshots(
  before: ResolutionSnapshot,
  after: ResolutionSnapshot,
): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];
  const afterByName = new Map(after.names.map((entry) => [entry.name, entry]));

  for (const beforeName of before.names) {
    const afterName = afterByName.get(beforeName.name);
    if (!afterName) {
      differences.push({
        name: beforeName.name,
        record: "(whole name)",
        before: "present",
        after: "absent from post-cutover snapshot",
      });
      continue;
    }
    for (const [record, beforeValue] of Object.entries(beforeName.records)) {
      const afterValue = afterName.records[record] ?? null;
      if (render(beforeValue) === render(afterValue)) continue;
      differences.push({
        name: beforeName.name,
        record,
        before: render(beforeValue),
        after: render(afterValue),
      });
    }
  }
  return differences;
}

export function describeDifference(difference: SnapshotDifference): string {
  return `${difference.name} ${difference.record}: ${difference.before} -> ${difference.after}`;
}

// Decodes a raw record answer for display. Falls back to the raw bytes when the
// value does not decode, so a report is never blank.
export function decodeRecord(record: string, value: Hex | null): string {
  if (value === null) return "(reverted)";
  try {
    if (record === "addr") {
      return String(
        decodeFunctionResult({
          abi: RESOLVER_ABI,
          functionName: "addr",
          data: value,
        }),
      );
    }
    if (record.startsWith("text(")) {
      return String(
        decodeFunctionResult({
          abi: RESOLVER_ABI,
          functionName: "text",
          data: value,
        }),
      );
    }
  } catch {
    // fall through to the raw value
  }
  return value;
}

// Whether an answer means the name carries no such record. A lookup that reverts and
// one that answers with the empty value are the same "no record", but raw bytes
// cannot be tested for emptiness directly: the encoding of an empty `bytes` or
// `string` still carries a non-zero offset word. Decode by the record's own type.
export function recordIsEmpty(record: string, value: Hex | null): boolean {
  if (value === null) return true;
  try {
    if (record === "addr") {
      const [address] = decodeAbiParameters([{ type: "address" }], value);
      return address === zeroAddress;
    }
    if (record.startsWith("text(")) {
      const [text] = decodeAbiParameters([{ type: "string" }], value);
      return text.length === 0;
    }
    const [bytes] = decodeAbiParameters([{ type: "bytes" }], value);
    return bytes === "0x";
  } catch {
    // An answer that will not decode carries no record either.
    return true;
  }
}

// Whether a snapshot holds anything a comparison can prove. A record that reads the
// same nothing on both sides of a cutover counts as unchanged, so a sample made only
// of empty answers reports success while having compared nothing.
export function snapshotCarriesRecords(snapshot: ResolutionSnapshot): boolean {
  return snapshot.names.some((entry) =>
    Object.entries(entry.records).some(
      ([record, value]) => !recordIsEmpty(record, value),
    ),
  );
}
