import { describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(60_000);

import { toHex, type Address } from "viem";
import { ROLES } from "../../script/deploy-constants.js";
import { main } from "../../script/prepareMigration.js";
import { revertPrePrepareMigrationRoles } from "../utils/mockPrepareMigration.js";

const ROLE_REGISTRAR = ROLES.REGISTRY.REGISTRAR;
const ROLE_REGISTRAR_ADMIN = ROLES.ADMIN.REGISTRY.REGISTRAR;
const ROLE_REGISTER_RESERVED = ROLES.REGISTRY.REGISTER_RESERVED;
const ROLE_REGISTER_RESERVED_ADMIN = ROLES.ADMIN.REGISTRY.REGISTER_RESERVED;
const ROLE_RENEW = ROLES.REGISTRY.RENEW;
const ROLE_RENEW_ADMIN = ROLES.ADMIN.REGISTRY.RENEW;

describe("PrepareMigration", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  setupEnv({
    resetOnEach: true,
    async initialize() {
      await revertPrePrepareMigrationRoles(env);
    },
  });

  function getAddresses() {
    return {
      rpcUrl: `http://${env.hostPort}`,
      registry: env.v2.ETHRegistry.address,
      batchRegistrar: env.rocketh.get("BatchRegistrar").address as Address,
      ethRegistrar: env.v2.ETHRegistrar.address,
      unlocked: env.v2.UnlockedMigrationController.address,
      locked: env.v2.LockedMigrationController.address,
    };
  }

  function buildArgs(
    addrs: ReturnType<typeof getAddresses>,
    overrides: { privateKey?: string; execute?: boolean } = {},
  ): string[] {
    const args = [
      "node",
      "prepareMigration",
      "--rpc-url",
      addrs.rpcUrl,
      "--registry",
      addrs.registry,
      "--batch-registrar",
      addrs.batchRegistrar,
      "--eth-registrar",
      addrs.ethRegistrar,
      "--unlocked-migration-controller",
      addrs.unlocked,
      "--locked-migration-controller",
      addrs.locked,
    ];
    const pk =
      overrides.privateKey ??
      toHex(env.namedAccounts.deployer.getHdKey().privateKey!);
    if (pk) args.push("--private-key", pk);
    if (overrides.execute) args.push("--execute");
    return args;
  }

  async function readRoles(account: Address): Promise<bigint> {
    return (await env.v2.ETHRegistry.read.roles([0n, account])) as bigint;
  }

  it("devnet starts in pre-prepareMigration state", async () => {
    const addrs = getAddresses();

    expect((await readRoles(addrs.batchRegistrar)) & ROLE_REGISTRAR).toBe(
      ROLE_REGISTRAR,
    );
    expect((await readRoles(addrs.ethRegistrar)) & ROLE_REGISTRAR).toBe(0n);
    expect((await readRoles(addrs.unlocked)) & ROLE_REGISTER_RESERVED).toBe(0n);
    expect((await readRoles(addrs.locked)) & ROLE_REGISTER_RESERVED).toBe(0n);
  });

  it("dry run does not mutate on-chain role state", async () => {
    const addrs = getAddresses();

    const before = {
      batch: await readRoles(addrs.batchRegistrar),
      eth: await readRoles(addrs.ethRegistrar),
      unlocked: await readRoles(addrs.unlocked),
      locked: await readRoles(addrs.locked),
    };

    await main(buildArgs(addrs));

    expect(await readRoles(addrs.batchRegistrar)).toBe(before.batch);
    expect(await readRoles(addrs.ethRegistrar)).toBe(before.eth);
    expect(await readRoles(addrs.unlocked)).toBe(before.unlocked);
    expect(await readRoles(addrs.locked)).toBe(before.locked);
  });

  it("execute strips all migration-relevant roles from BatchRegistrar and hands them to the live targets", async () => {
    const addrs = getAddresses();

    const batchBefore = await readRoles(addrs.batchRegistrar);
    expect(batchBefore & ROLE_REGISTRAR).toBe(ROLE_REGISTRAR);
    expect(batchBefore & ROLE_RENEW).toBe(ROLE_RENEW);

    await main(buildArgs(addrs, { execute: true }));

    const batchAfter = await readRoles(addrs.batchRegistrar);
    expect(batchAfter & ROLE_REGISTRAR).toBe(0n);
    expect(batchAfter & ROLE_REGISTRAR_ADMIN).toBe(0n);
    expect(batchAfter & ROLE_REGISTER_RESERVED).toBe(0n);
    expect(batchAfter & ROLE_REGISTER_RESERVED_ADMIN).toBe(0n);
    expect(batchAfter & ROLE_RENEW).toBe(0n);
    expect(batchAfter & ROLE_RENEW_ADMIN).toBe(0n);

    const ethAfter = await readRoles(addrs.ethRegistrar);
    expect(ethAfter & ROLE_REGISTRAR).toBe(ROLE_REGISTRAR);
    expect(ethAfter & ROLE_RENEW).toBe(ROLE_RENEW);
    expect((await readRoles(addrs.unlocked)) & ROLE_REGISTER_RESERVED).toBe(
      ROLE_REGISTER_RESERVED,
    );
    expect((await readRoles(addrs.locked)) & ROLE_REGISTER_RESERVED).toBe(
      ROLE_REGISTER_RESERVED,
    );
  });

  it("execute fully decommissions BatchRegistrar (no roles remain)", async () => {
    const addrs = getAddresses();
    const batchBefore = await readRoles(addrs.batchRegistrar);
    expect(batchBefore & ROLE_RENEW).toBe(ROLE_RENEW);

    await main(buildArgs(addrs, { execute: true }));

    expect(await readRoles(addrs.batchRegistrar)).toBe(0n);
  });

  it("is idempotent on repeated execute", async () => {
    const addrs = getAddresses();

    await main(buildArgs(addrs, { execute: true }));
    const snapshot = {
      batch: await readRoles(addrs.batchRegistrar),
      eth: await readRoles(addrs.ethRegistrar),
      unlocked: await readRoles(addrs.unlocked),
      locked: await readRoles(addrs.locked),
    };

    await main(buildArgs(addrs, { execute: true }));

    expect(await readRoles(addrs.batchRegistrar)).toBe(snapshot.batch);
    expect(await readRoles(addrs.ethRegistrar)).toBe(snapshot.eth);
    expect(await readRoles(addrs.unlocked)).toBe(snapshot.unlocked);
    expect(await readRoles(addrs.locked)).toBe(snapshot.locked);
  });

  it("aborts when signer lacks required admin roles", async () => {
    const addrs = getAddresses();
    // "owner" account is funded but has CAN_NAME for root on ETHRegistry
    const { owner } = env.namedAccounts;
    const privateKey = toHex(owner.getHdKey().privateKey!);
    expect(await readRoles(owner.address)).toBe(ROLES.REGISTRY.CAN_NAME);

    await expect(
      main(buildArgs(addrs, { privateKey, execute: true })),
    ).rejects.toThrow(/admin roles/);

    // state untouched
    expect((await readRoles(addrs.batchRegistrar)) & ROLE_REGISTRAR).toBe(
      ROLE_REGISTRAR,
    );
  });

  it("rejects --execute without --private-key", async () => {
    const addrs = getAddresses();
    await expect(
      main(buildArgs(addrs, { privateKey: "", execute: true })),
    ).rejects.toThrow(/--execute requires --private-key/);
  });
});
