import { describe, expect, it } from "bun:test";
import {
  decodeFunctionData,
  getAddress,
  zeroAddress,
  type Address,
} from "viem";

import { isRetryableRpcRequest } from "../../script/migration.js";
import {
  clearedRecord,
  planHandover,
  recordValue,
  tokenIdOf,
  type HandoverState,
  type PlanContext,
} from "../../script/migrationFixture/plan.js";
import { assertSeedable } from "../../script/migrationFixture.js";
import type { RefContext } from "../../script/migrationFixture/scenario.js";
import {
  FUSES,
  type FixtureEnvelope,
  type RecordSpec,
} from "../../script/migrationFixture/types.js";

const OWNER = "0x00000000000000000000000000000000000000a1" as Address;

const ctx: RefContext = {
  actors: new Map([["owner_a", OWNER]]),
  fixtureContracts: {},
  addresses: {},
  v1Address: (name: string) => {
    throw new Error(`unexpected v1 lookup: ${name}`);
  },
  v2Address: (name: string) => {
    throw new Error(`unexpected v2 lookup: ${name}`);
  },
} as unknown as RefContext;

describe("record values", () => {
  it("encodes a multicoin address from its declared bytes", () => {
    const record: RecordSpec = {
      kind: "addr",
      coin_type: 0,
      value_hex: "0x00112233445566778899aabbccddeeff00112233",
    };
    expect(recordValue(record, ctx)).toBe(record.value_hex as string);
  });

  it("falls back to empty bytes when a multicoin slot declares nothing", () => {
    expect(recordValue({ kind: "addr", coin_type: 2147483785 }, ctx)).toBe(
      "0x",
    );
  });

  it("resolves an ether address through its actor", () => {
    expect(
      recordValue({ kind: "addr", value_actor: "actor.owner_a" }, ctx),
    ).toBe(OWNER);
  });

  it("prefers the hex bytes of a contenthash", () => {
    expect(
      recordValue(
        { kind: "contenthash", value_hex: "0xe301", value: "x" },
        ctx,
      ),
    ).toBe("0xe301");
  });
});

describe("cleared records", () => {
  it("drops the bytes of a contenthash rather than rewriting them", () => {
    const cleared = clearedRecord({ kind: "contenthash", value_hex: "0xe301" });
    expect(cleared.value_hex).toBe("0x");
    expect(recordValue(cleared, ctx)).toBe("0x");
  });

  it("empties a multicoin slot rather than zero-filling it", () => {
    const cleared = clearedRecord({
      kind: "addr",
      coin_type: 0,
      value_hex: "0xdead",
    });
    expect(recordValue(cleared, ctx)).toBe("0x");
  });

  it("zeroes an ether address and empties a text slot", () => {
    expect(
      recordValue(
        clearedRecord({ kind: "addr", value_actor: "actor.owner_a" }),
        ctx,
      ),
    ).toBe(zeroAddress);
    expect(
      recordValue(clearedRecord({ kind: "text", key: "url", value: "u" }), ctx),
    ).toBe("");
  });
});

const envelope = (scenario: Record<string, any>): FixtureEnvelope =>
  ({
    fixture_id: "FX-001",
    source_scenario_id: "FX",
    label: "fx",
    name: "fx.eth",
    scenario: {
      scenario_id: "FX-001",
      execution: { scenario: "live_now", clock: "none" },
      v1: {
        registration: { duration_seconds: 31536000 },
        setup_steps: [],
        expected_pre_migration: { expiry_cohort: "long" },
      },
      v2_premigration: { profile: "present" },
      ...scenario,
    },
  }) as unknown as FixtureEnvelope;

describe("seedable selections", () => {
  it("accepts a scenario seeding can establish", () => {
    expect(() => assertSeedable([envelope({})])).not.toThrow();
  });

  it("refuses an expiry that needs a controlled clock", () => {
    expect(() =>
      assertSeedable([
        envelope({
          execution: { scenario: "fork_only", clock: "time_control" },
        }),
      ]),
    ).toThrow(/controlled clock/);
  });

  it("refuses an expiry cohort seeding cannot reach", () => {
    expect(() =>
      assertSeedable([
        envelope({
          v1: {
            registration: { duration_seconds: 31536000 },
            setup_steps: [],
            expected_pre_migration: { expiry_cohort: "near_expiry" },
          },
        }),
      ]),
    ).toThrow(/near_expiry/);
  });

  it("refuses a v2 state seeding does not create", () => {
    expect(() =>
      assertSeedable([
        envelope({ v2_premigration: { profile: "already_registered" } }),
      ]),
    ).toThrow(/already_registered/);
  });

  it("refuses a lease below the registration minimum", () => {
    expect(() =>
      assertSeedable([
        envelope({
          v1: {
            registration: { duration_seconds: 60 },
            setup_steps: [],
            expected_pre_migration: { expiry_cohort: "long" },
          },
        }),
      ]),
    ).toThrow(/below the v1 controller minimum/);
  });
});

describe("retryable rpc requests", () => {
  it("retries reads", () => {
    for (const method of [
      "eth_call",
      "eth_chainId",
      "eth_getBalance",
      "eth_getTransactionReceipt",
      "eth_feeHistory",
    ]) {
      expect(isRetryableRpcRequest({ method })).toBe(true);
    }
  });

  it("refuses transaction submission", () => {
    for (const method of [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "wallet_sendTransaction",
    ]) {
      expect(isRetryableRpcRequest({ method })).toBe(false);
    }
  });

  it("refuses state controls, whose effects accumulate", () => {
    for (const method of [
      "evm_increaseTime",
      "evm_mine",
      "anvil_setBalance",
      "tenderly_setBalance",
    ]) {
      expect(isRetryableRpcRequest({ method })).toBe(false);
    }
  });

  it("refuses batches and unparseable bodies, whose contents are unknown", () => {
    expect(isRetryableRpcRequest([{ method: "eth_call" }])).toBe(false);
    expect(isRetryableRpcRequest(null)).toBe(false);
    expect(isRetryableRpcRequest({})).toBe(false);
  });
});

const REGISTRAR = "0x00000000000000000000000000000000000000b1" as Address;
const WRAPPER = "0x00000000000000000000000000000000000000b2" as Address;
const BATCHER = "0x00000000000000000000000000000000000000b3" as Address;
const TESTER = "0x00000000000000000000000000000000000000c1" as Address;

const planCtx = {
  ...ctx,
  batcher: BATCHER,
  addresses: {
    baseRegistrar: REGISTRAR,
    registry: "0x00000000000000000000000000000000000000b4",
    wrapper: WRAPPER,
    controller: "0x00000000000000000000000000000000000000b5",
    publicResolver: "0x00000000000000000000000000000000000000b6",
    reverseRegistrar: "0x00000000000000000000000000000000000000b7",
    defaultReverseRegistrar: "0x00000000000000000000000000000000000000b8",
  },
} as unknown as PlanContext;

const NOW = 2_000_000_000n;
const YEAR_AHEAD = NOW + 31_536_000n;

const handoverEnvelope = (
  tags: string[],
  overrides: Record<string, any> = {},
): FixtureEnvelope =>
  ({
    fixture_id: "FX-H01",
    source_scenario_id: "FX-H",
    label: "fxh",
    name: "fxh.eth",
    scenario: {
      scenario_id: "FX-H01",
      name: "fxh.eth",
      top_level_label: "fxh",
      child_label: null,
      tags,
      execution: { scenario: "live_now", expected_result: "success" },
      actors: { pre_migration_owner: "owner_a" },
      v1: {
        registration: { label: "fxh", owner_actor: "owner_a" },
        setup_steps: [],
        expected_pre_migration: {},
      },
      ...overrides,
    },
  }) as unknown as FixtureEnvelope;

const liveState = (over: Partial<HandoverState> = {}): HandoverState => ({
  wrapperOwner: zeroAddress,
  wrapperFuses: 0,
  wrapperExpiry: 0n,
  registrant: zeroAddress,
  now: NOW,
  ...over,
});

const decoded = (call: { target: Address; data: `0x${string}` }) =>
  decodeFunctionData({
    abi: [...ERC721_HANDOVER_ABI, ...ERC1155_HANDOVER_ABI],
    data: call.data,
  });

const ERC721_HANDOVER_ABI = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reclaim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "owner", type: "address" },
    ],
    outputs: [],
  },
] as const;

const ERC1155_HANDOVER_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

describe("handing a seeded name to a wallet", () => {
  it("reclaims an unwrapped name before transferring it", () => {
    const plan = planHandover(
      handoverEnvelope(["unwrapped"]),
      planCtx,
      TESTER,
      liveState({ registrant: OWNER }),
    );

    expect(plan.skips).toEqual([]);
    expect(plan.holders).toEqual([OWNER]);
    expect(plan.calls.map((c) => c.signer.kind)).toEqual([
      "batcher",
      "batcher",
    ]);
    // Reclaim first: after the token moves the sender loses standing to make it.
    const [reclaim, transfer] = plan.calls.map(decoded);
    expect(reclaim.functionName).toBe("reclaim");
    expect(reclaim.args?.[1]).toBe(getAddress(TESTER));
    expect(transfer.functionName).toBe("transferFrom");
    expect(transfer.args?.[0]).toBe(getAddress(OWNER));
    expect(transfer.args?.[1]).toBe(getAddress(TESTER));
    const tokenId = tokenIdOf("fxh");
    expect(reclaim.args?.[0]).toBe(tokenId);
    expect(transfer.args?.[2]).toBe(tokenId);
  });

  it("moves a wrapped name with one wrapper transfer", () => {
    const plan = planHandover(
      handoverEnvelope(["wrapped_unlocked"]),
      planCtx,
      TESTER,
      liveState({ wrapperOwner: OWNER, wrapperExpiry: YEAR_AHEAD }),
    );

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0].target).toBe(WRAPPER);
    const transfer = decoded(plan.calls[0]);
    expect(transfer.functionName).toBe("safeTransferFrom");
    expect(transfer.args?.slice(0, 2)).toEqual([
      getAddress(OWNER),
      getAddress(TESTER),
    ]);
    expect(transfer.args?.[3]).toBe(1n);
  });

  it("leaves a name whose transfer fuse is burned", () => {
    const plan = planHandover(
      handoverEnvelope(["wrapped_locked"]),
      planCtx,
      TESTER,
      liveState({
        wrapperOwner: OWNER,
        wrapperFuses: FUSES.CANNOT_TRANSFER,
        wrapperExpiry: YEAR_AHEAD,
      }),
    );

    expect(plan.calls).toEqual([]);
    expect(plan.skips).toEqual([
      { subject: "fxh.eth", reason: "CANNOT_TRANSFER burned" },
    ]);
  });

  it("leaves an emancipated name that has reached its grace period", () => {
    const plan = planHandover(
      handoverEnvelope(["wrapped_locked"]),
      planCtx,
      TESTER,
      liveState({
        wrapperOwner: OWNER,
        // The wrapper treats a .eth 2LD as expiring when its grace period opens.
        wrapperFuses: FUSES.IS_DOT_ETH | FUSES.PARENT_CANNOT_CONTROL,
        wrapperExpiry: NOW + 1n,
      }),
    );

    expect(plan.calls).toEqual([]);
    expect(plan.skips).toEqual([{ subject: "fxh.eth", reason: "expired" }]);
  });

  it("plans nothing for a name the wallet already holds", () => {
    const plan = planHandover(
      handoverEnvelope(["unwrapped"]),
      planCtx,
      TESTER,
      liveState({ registrant: TESTER }),
    );

    expect(plan.calls).toEqual([]);
    expect(plan.skips).toEqual([]);
    expect(plan.holders).toEqual([]);
  });

  it("moves a child's parent as well, so the child can be migrated", () => {
    const child = handoverEnvelope(["locked_child"], {
      name: "sub.fxh.eth",
      child_label: "sub",
    });
    const plan = planHandover(
      child,
      planCtx,
      TESTER,
      liveState({
        wrapperOwner: OWNER,
        wrapperExpiry: YEAR_AHEAD,
        parentWrapperOwner: BATCHER,
        parentWrapperExpiry: YEAR_AHEAD,
      }),
    );

    expect(plan.calls).toHaveLength(2);
    expect(plan.holders).toEqual([OWNER, BATCHER]);
    for (const call of plan.calls) {
      expect(call.target).toBe(WRAPPER);
      expect(decoded(call).args?.[1]).toBe(getAddress(TESTER));
    }
  });
});
