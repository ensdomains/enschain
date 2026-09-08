import { describe, expect, it } from "bun:test";
import { parseEther, zeroAddress, type Address } from "viem";

import { isRetryableRpcRequest } from "../../script/migration.js";
import {
  clearedRecord,
  planSetupSteps,
  recordValue,
  type PlanContext,
} from "../../script/migrationFixture/plan.js";
import {
  accounts,
  fundingTargets,
} from "../../script/migrationFixture/config.js";
import { assertSeedable, refContext } from "../../script/migrationFixture.js";
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

const OWNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const KEY_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const MNEMONIC = "test test test test test test test test test test test junk";

describe("the wallet that owns the seeded names", () => {
  it("derives every actor from the mnemonic when no owner is nominated", () => {
    const derived = accounts({ fixtureActorMnemonic: MNEMONIC } as never);
    expect(derived.map((a) => a.alias)).toEqual([
      "owner_a",
      "owner_b",
      "owner_c",
      "operator",
      "attacker",
    ]);
    // Five accounts, five addresses.
    expect(new Set(derived.map((a) => a.account.address)).size).toBe(5);
  });

  it("puts the three owner aliases on the nominated key", () => {
    const derived = accounts({
      fixtureActorMnemonic: MNEMONIC,
      fixtureOwnerKey: OWNER_KEY,
    } as never);
    const address = (alias: string) =>
      derived.find((a) => a.alias === alias)!.account.address;

    for (const alias of ["owner_a", "owner_b", "owner_c"]) {
      expect(address(alias)).toBe(KEY_ADDRESS);
    }
    // The counterparties stay separate: an operator or an attacker means
    // nothing if it is the owner.
    expect(address("operator")).not.toBe(KEY_ADDRESS);
    expect(address("attacker")).not.toBe(KEY_ADDRESS);
    expect(address("operator")).not.toBe(address("attacker"));
  });

  it("still needs the mnemonic, which the counterparties come from", () => {
    expect(() => accounts({ fixtureOwnerKey: OWNER_KEY } as never)).toThrow(
      /fixture-actor-mnemonic/,
    );
  });

  it("refuses a key that is not one", () => {
    expect(() =>
      accounts({
        fixtureActorMnemonic: MNEMONIC,
        fixtureOwnerKey: "0xnope",
      } as never),
    ).toThrow(/fixture-owner-key/);
  });
});

describe("the accounts a funding run tops up", () => {
  const FLOOR = "0.5";
  const floor = parseEther(FLOOR);

  it("charges one floor per account when every alias has its own", () => {
    const targets = fundingTargets(
      accounts({ fixtureActorMnemonic: MNEMONIC } as never),
      FLOOR,
    );
    expect(targets).toHaveLength(5);
    for (const target of targets) {
      expect(target.aliases).toHaveLength(1);
      expect(target.required).toBe(floor);
    }
  });

  it("charges the shared owner account every alias it carries", () => {
    const targets = fundingTargets(
      accounts({
        fixtureActorMnemonic: MNEMONIC,
        fixtureOwnerKey: OWNER_KEY,
      } as never),
      FLOOR,
    );
    // Five aliases, three accounts: the nominated wallet and two counterparties.
    expect(targets).toHaveLength(3);

    const owner = targets.find((t) => t.address === KEY_ADDRESS)!;
    // Actor order, so the receipt label a run prints is stable.
    expect(owner.aliases).toEqual(["owner_a", "owner_b", "owner_c"]);
    expect(owner.required).toBe(floor * 3n);

    for (const target of targets.filter((t) => t !== owner)) {
      expect(target.aliases).toHaveLength(1);
      expect(target.required).toBe(floor);
    }
  });

  it("covers every actor exactly once", () => {
    const derived = accounts({
      fixtureActorMnemonic: MNEMONIC,
      fixtureOwnerKey: OWNER_KEY,
    } as never);
    expect(fundingTargets(derived, FLOOR).flatMap((t) => t.aliases)).toEqual(
      derived.map((a) => a.alias),
    );
  });
});

describe("the actors a run is checked against", () => {
  it("resolves aliases from the addresses the run recorded", () => {
    const recorded = { owner_a: KEY_ADDRESS, operator: OWNER };
    // No mnemonic and no owner key: reading the state back must not depend on
    // either, since nothing after seeding nominates one.
    const ctx = refContext({} as never, {}, recorded);
    expect(ctx.actors.get("owner_a")).toBe(KEY_ADDRESS);
    expect(ctx.actors.get("operator")).toBe(OWNER);
  });

  it("derives them when nothing was recorded", () => {
    const ctx = refContext({ fixtureActorMnemonic: MNEMONIC } as never, {});
    const derived = accounts({ fixtureActorMnemonic: MNEMONIC } as never);
    for (const actor of derived) {
      expect(ctx.actors.get(actor.alias)).toBe(actor.account.address);
    }
  });
});

const PLAN_BATCHER = "0x00000000000000000000000000000000000000b3" as Address;
const PLAN_WRAPPER = "0x00000000000000000000000000000000000000b2" as Address;
const PARENT_OWNER = "0x00000000000000000000000000000000000000a2" as Address;

const planCtx = {
  actors: new Map([
    ["owner_a", OWNER],
    ["owner_b", PARENT_OWNER],
  ]),
  fixtureContracts: {},
  v1Address: (name: string) => {
    if (name === "PublicResolver")
      return "0x00000000000000000000000000000000000000b6";
    throw new Error(`unexpected v1 lookup: ${name}`);
  },
  v2Address: (name: string) => {
    throw new Error(`unexpected v2 lookup: ${name}`);
  },
  batcher: PLAN_BATCHER,
  addresses: {
    baseRegistrar: "0x00000000000000000000000000000000000000b1",
    registry: "0x00000000000000000000000000000000000000b4",
    wrapper: PLAN_WRAPPER,
    controller: "0x00000000000000000000000000000000000000b5",
    publicResolver: "0x00000000000000000000000000000000000000b6",
    reverseRegistrar: "0x00000000000000000000000000000000000000b7",
    defaultReverseRegistrar: "0x00000000000000000000000000000000000000b8",
  },
} as unknown as PlanContext;

const childRow = (parentOwner?: string): FixtureEnvelope =>
  ({
    fixture_id: "FX-C01",
    source_scenario_id: "FX-C",
    label: "fxc",
    name: "sub.fxc.eth",
    scenario: {
      scenario_id: "FX-C01",
      name: "sub.fxc.eth",
      top_level_label: "fxc",
      child_label: "sub",
      tags: ["locked_child"],
      execution: { scenario: "live_now", expected_result: "success" },
      actors: { pre_migration_owner: "owner_a" },
      v1: {
        registration: { label: "fxc", owner_actor: "owner_a" },
        parent_fixture: parentOwner ? { owner_actor: parentOwner } : null,
        setup_steps: [
          {
            action: "ensure_wrapped_parent_and_child",
            wrapped_owner_actor: "owner_a",
          },
        ],
        expected_pre_migration: {},
      },
    },
  }) as unknown as FixtureEnvelope;

describe("a subname's parent", () => {
  const parentTransfer = (row: FixtureEnvelope) =>
    planSetupSteps(row, planCtx).filter((c) =>
      c.label.includes("parent owner transfer"),
    );

  it("goes to the owner the corpus declares for it", () => {
    // Creating the child needs the batcher to hold the parent, so seeding wraps
    // it there. Left there, the holder of the subname could never migrate it.
    const calls = parentTransfer(childRow("owner_b"));
    expect(calls).toHaveLength(1);
    expect(calls[0].signer).toEqual({ kind: "batcher" });
    expect(calls[0].target).toBe(PLAN_WRAPPER);
  });

  it("falls back to the child's owner when none is declared", () => {
    expect(parentTransfer(childRow())).toHaveLength(1);
  });

  it("is not emitted for a name that has no parent", () => {
    const flat = {
      ...childRow(),
      name: "fxc.eth",
      scenario: {
        ...childRow().scenario,
        name: "fxc.eth",
        child_label: null,
        tags: ["unwrapped"],
        v1: { ...childRow().scenario.v1, setup_steps: [] },
      },
    } as unknown as FixtureEnvelope;
    expect(parentTransfer(flat)).toEqual([]);
  });
});
