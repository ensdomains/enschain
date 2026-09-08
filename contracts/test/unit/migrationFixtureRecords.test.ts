import { describe, expect, it } from "bun:test";
import { zeroAddress, type Address } from "viem";

import { isRetryableRpcRequest } from "../../script/migration.js";
import {
  clearedRecord,
  recordValue,
} from "../../script/migrationFixture/plan.js";
import { assertSeedable } from "../../script/migrationFixture.js";
import type { RefContext } from "../../script/migrationFixture/scenario.js";
import type {
  FixtureEnvelope,
  RecordSpec,
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
