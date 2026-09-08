import {
  getAddress,
  namehash,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {
  isChild,
  isWrapped,
  isLocked,
  resolveFuses,
  resolveOptionalRef,
  resolveRef,
  v1Form,
  type RefContext,
} from "./scenario.js";
import { labelhashOf, recordValue, tokenIdOf } from "./plan.js";
import {
  FUSES,
  OWNER_CONTROLLED_MASK,
  type FixtureEnvelope,
  type RecordSpec,
} from "./types.js";

const REGISTRY_READ_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "resolver",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ttl",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

const BASE_REGISTRAR_READ_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "nameExpires",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const WRAPPER_READ_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getData",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
  },
] as const;

const RESOLVER_READ_ABI = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "contenthash",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

const RESOLVER_MULTICOIN_READ_ABI = [
  {
    type: "function",
    name: "addr",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "coinType", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

export type V1Addresses = {
  registry: Address;
  baseRegistrar: Address;
  nameWrapper: Address;
};

export type V1Issue = {
  fixtureId: string;
  name: string;
  form: string;
  field: string;
  expected: string;
  actual: string;
};

type Call = { address: Address; abi: any; functionName: string; args: any[] };

/// One on-chain read plus the assertion made about its result. Checks are built
/// for the whole cohort first and read in multicall batches, so verifying
/// thousands of names costs a few round trips rather than one per name.
type Check = {
  fixtureId: string;
  name: string;
  form: string;
  field: string;
  call: Call;
  /// Returns an `{expected, actual}` pair when the read disagrees, else null.
  assert: (
    ok: boolean,
    result: any,
  ) => { expected: string; actual: string } | null;
};

const addrEq = (a: unknown, b: Address) =>
  typeof a === "string" && getAddress(a as Address) === getAddress(b);

/// Byte strings are compared by value. Accepting anything non-empty would pass a
/// slot seeded with the wrong bytes, and would fail a slot a scenario cleared on
/// purpose — both of which are states the corpus is meant to distinguish.
const bytesEq = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/// The fuse bits that end up burned on-chain without the corpus restating them.
///
/// Wrapping a `.eth` 2LD emancipates it and flags it as a `.eth` name, so both
/// bits are always present. A subname carries the parent-control bit whenever
/// any owner-controlled fuse is burned, because NameWrapper refuses to burn one
/// without it.
function implicitFuses(
  wrapped: boolean,
  child: boolean,
  declared: number,
): number {
  if (!wrapped) return 0;
  if (!child) return FUSES.PARENT_CANNOT_CONTROL | FUSES.IS_DOT_ETH;
  return declared & OWNER_CONTROLLED_MASK ? FUSES.PARENT_CANNOT_CONTROL : 0;
}

function fuseNames(bitmap: number): string {
  const names = Object.entries(FUSES)
    .filter(([, bit]) => (bitmap & bit) !== 0)
    .map(([name]) => name);
  return names.length ? `${bitmap} [${names.join("|")}]` : `${bitmap} []`;
}

function recordChecks(
  row: FixtureEnvelope,
  ctx: RefContext,
  resolver: Address,
  node: Hex,
  records: RecordSpec[],
  meta: { form: string },
): Check[] {
  if (resolver === zeroAddress) return [];
  const checks: Check[] = [];
  for (const record of records) {
    const base = {
      fixtureId: row.fixture_id,
      name: row.scenario.name,
      form: meta.form,
    };
    if (record.kind === "addr" && (record.coin_type ?? 60) === 60) {
      const expected = recordValue(record, ctx) as Address;
      checks.push({
        ...base,
        field: "record addr(60)",
        call: {
          address: resolver,
          abi: RESOLVER_READ_ABI,
          functionName: "addr",
          args: [node],
        },
        assert: (ok, result) =>
          ok && addrEq(result, expected)
            ? null
            : { expected, actual: ok ? String(result) : "read reverted" },
      });
    } else if (record.kind === "addr") {
      const expected = recordValue(record, ctx);
      checks.push({
        ...base,
        field: `record addr(${record.coin_type})`,
        call: {
          address: resolver,
          abi: RESOLVER_MULTICOIN_READ_ABI,
          functionName: "addr",
          args: [node, BigInt(record.coin_type as number)],
        },
        assert: (ok, result) =>
          ok && bytesEq(result, expected)
            ? null
            : { expected, actual: ok ? String(result) : "read reverted" },
      });
    } else if (record.kind === "text") {
      const expected = recordValue(record, ctx);
      checks.push({
        ...base,
        field: `record text(${record.key})`,
        call: {
          address: resolver,
          abi: RESOLVER_READ_ABI,
          functionName: "text",
          args: [node, record.key ?? ""],
        },
        assert: (ok, result) =>
          ok && result === expected
            ? null
            : { expected, actual: ok ? String(result) : "read reverted" },
      });
    } else if (record.kind === "contenthash") {
      const expected = recordValue(record, ctx);
      checks.push({
        ...base,
        field: "record contenthash",
        call: {
          address: resolver,
          abi: RESOLVER_READ_ABI,
          functionName: "contenthash",
          args: [node],
        },
        assert: (ok, result) =>
          ok && bytesEq(result, expected)
            ? null
            : { expected, actual: ok ? String(result) : "read reverted" },
      });
    }
  }
  return checks;
}

/// Builds every assertion the scenario's declared pre-migration state supports.
export function buildV1Checks(
  row: FixtureEnvelope,
  ctx: RefContext,
  addresses: V1Addresses,
): Check[] {
  const scenario = row.scenario;
  const pre = scenario.v1.expected_pre_migration;
  if (!pre) return [];

  const form = v1Form(scenario);
  const wrapped = isWrapped(form);
  const child = isChild(form);
  const locked = isLocked(form);
  const node = namehash(scenario.name) as Hex;
  const topTokenId = tokenIdOf(scenario.top_level_label);
  const base = { fixtureId: row.fixture_id, name: scenario.name, form };
  const checks: Check[] = [];

  const registryOwner = resolveRef(pre.registry_owner_ref, ctx);
  checks.push({
    ...base,
    field: "registry.owner",
    call: {
      address: addresses.registry,
      abi: REGISTRY_READ_ABI,
      functionName: "owner",
      args: [node],
    },
    assert: (ok, result) =>
      ok && addrEq(result, registryOwner)
        ? null
        : {
            expected: registryOwner,
            actual: ok ? String(result) : "read reverted",
          },
  });

  const resolver = resolveOptionalRef(pre.resolver_ref, ctx);
  checks.push({
    ...base,
    field: "registry.resolver",
    call: {
      address: addresses.registry,
      abi: REGISTRY_READ_ABI,
      functionName: "resolver",
      args: [node],
    },
    assert: (ok, result) =>
      ok && addrEq(result, resolver)
        ? null
        : { expected: resolver, actual: ok ? String(result) : "read reverted" },
  });

  const ttl = BigInt(pre.ttl ?? 0);
  checks.push({
    ...base,
    field: "registry.ttl",
    call: {
      address: addresses.registry,
      abi: REGISTRY_READ_ABI,
      functionName: "ttl",
      args: [node],
    },
    assert: (ok, result) =>
      ok && BigInt(result as bigint) === ttl
        ? null
        : {
            expected: String(ttl),
            actual: ok ? String(result) : "read reverted",
          },
  });

  // The registrar token tracks the 2LD, which for a child scenario is its parent.
  const registrarOwner = resolveRef(pre.base_registrar_owner_ref, ctx);
  checks.push({
    ...base,
    field: child ? "baseRegistrar.ownerOf(parent)" : "baseRegistrar.ownerOf",
    call: {
      address: addresses.baseRegistrar,
      abi: BASE_REGISTRAR_READ_ABI,
      functionName: "ownerOf",
      args: [topTokenId],
    },
    assert: (ok, result) =>
      ok && addrEq(result, registrarOwner)
        ? null
        : {
            expected: registrarOwner,
            actual: ok ? String(result) : "read reverted (name expired?)",
          },
  });

  const wrapperOwner = pre.wrapper_owner_ref
    ? resolveRef(pre.wrapper_owner_ref, ctx)
    : zeroAddress;
  checks.push({
    ...base,
    field: "nameWrapper.ownerOf",
    call: {
      address: addresses.nameWrapper,
      abi: WRAPPER_READ_ABI,
      functionName: "ownerOf",
      args: [BigInt(node)],
    },
    assert: (ok, result) => {
      const actual = ok ? String(result) : "read reverted";
      if (!wrapped) {
        return ok && addrEq(result, zeroAddress)
          ? null
          : { expected: "unwrapped (0x0)", actual };
      }
      return ok && addrEq(result, wrapperOwner)
        ? null
        : { expected: wrapperOwner, actual };
    },
  });

  const declaredFuses = resolveFuses(pre as any);
  const expectedFuses =
    declaredFuses | implicitFuses(wrapped, child, declaredFuses);
  checks.push({
    ...base,
    field: "nameWrapper.fuses",
    call: {
      address: addresses.nameWrapper,
      abi: WRAPPER_READ_ABI,
      functionName: "getData",
      args: [BigInt(node)],
    },
    assert: (ok, result) => {
      if (!ok)
        return { expected: fuseNames(expectedFuses), actual: "read reverted" };
      const actual = Number((result as any[])[1]);
      if (!wrapped) {
        // `ERC1155Fuse._burn` keeps fuses and expiry and clears only the owner,
        // so a name that was wrapped earlier in its history still reads back
        // the parent-controlled bits after being unwrapped. Only an
        // owner-controlled fuse proves the name is still wrapped.
        return (actual & OWNER_CONTROLLED_MASK) === 0
          ? null
          : {
              expected: "unwrapped (no owner-controlled fuses)",
              actual: fuseNames(actual),
            };
      }
      // Locked and emancipated forms are the point of the corpus, so the bits
      // that define them are asserted exactly rather than as a subset.
      if (locked && (actual & FUSES.CANNOT_UNWRAP) === 0) {
        return {
          expected: `${fuseNames(expectedFuses)} (locked form requires CANNOT_UNWRAP)`,
          actual: fuseNames(actual),
        };
      }
      if (!locked && (actual & FUSES.CANNOT_UNWRAP) !== 0) {
        return {
          expected: `${fuseNames(expectedFuses)} (unlocked form must not burn CANNOT_UNWRAP)`,
          actual: fuseNames(actual),
        };
      }
      if (actual !== expectedFuses) {
        return {
          expected: fuseNames(expectedFuses),
          actual: fuseNames(actual),
        };
      }
      return null;
    },
  });

  checks.push(
    ...recordChecks(row, ctx, resolver, node, pre.records ?? [], { form }),
  );

  return checks;
}

export type V1VerifyResult = {
  names: number;
  checks: number;
  issues: V1Issue[];
  byField: Record<string, number>;
};

/// Reads the shaped v1 state back and compares it with what each scenario says
/// its pre-migration state should be.
export async function verifySeededV1State(
  client: any,
  rows: FixtureEnvelope[],
  ctx: RefContext,
  addresses: V1Addresses,
  batchSize = 400,
): Promise<V1VerifyResult> {
  const checks = rows.flatMap((row) => buildV1Checks(row, ctx, addresses));
  const issues: V1Issue[] = [];

  for (let i = 0; i < checks.length; i += batchSize) {
    const slice = checks.slice(i, i + batchSize);
    const results = await client.multicall({
      contracts: slice.map((c) => c.call),
      allowFailure: true,
    });
    for (const [index, check] of slice.entries()) {
      const outcome = results[index];
      const ok = outcome.status === "success";
      const failure = check.assert(ok, outcome.result);
      if (failure) {
        issues.push({
          fixtureId: check.fixtureId,
          name: check.name,
          form: check.form,
          field: check.field,
          ...failure,
        });
      }
    }
  }

  const byField: Record<string, number> = {};
  for (const issue of issues) {
    byField[issue.field] = (byField[issue.field] ?? 0) + 1;
  }
  return { names: rows.length, checks: checks.length, issues, byField };
}
