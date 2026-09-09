import { describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, namehash, toHex, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { STATUS } from "../../script/deploy-constants.js";
import {
  migrateUnwrappedV1Name,
  migrateWrappedV1Name,
} from "../../script/migrate.js";
import { main as preMigrationMain } from "../../script/preMigration.js";
import {
  buildMainArgs,
  createCSVFile,
  registerV1Name,
  setupBaseRegistrarController,
} from "../utils/mockPreMigration.js";
import { idFromLabel } from "../utils/utils.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

function testPrivateKeyFor(address: Address): `0x${string}` {
  for (let index = 0; index < 10; index++) {
    const account = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index });
    if (getAddress(account.address) === getAddress(address)) {
      return toHex(account.getHdKey().privateKey!);
    }
  }
  throw new Error(`no test key for ${address}`);
}

describe("wrapped name migration", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  const v1DeploymentsDir = mkdtempSync(join(tmpdir(), "migrate-wrapped-v1-"));

  setupEnv({
    resetOnEach: true,
    async initialize() {
      await setupBaseRegistrarController(env);
      // The migration helpers resolve v1 contracts from deployment artifacts, so
      // the devnet's own v1 set has to be written where they will look for it.
      const dir = join(v1DeploymentsDir, "mainnet");
      mkdirSync(dir, { recursive: true });
      for (const [name, contract] of [
        ["ENSRegistry", env.v1.ENSRegistry],
        ["BaseRegistrarImplementation", env.v1.BaseRegistrar],
        ["NameWrapper", env.v1.NameWrapper],
      ] as const) {
        writeFileSync(
          join(dir, `${name}.json`),
          JSON.stringify({ address: contract.address, abi: contract.abi }),
        );
      }
    },
  });

  // Registers on v1 and reserves on v2, the state a name must be in before its owner
  // can claim it on v2.
  async function reserved(label: string, owner: Address) {
    const workDir = mkdtempSync(join(tmpdir(), "migrate-wrapped-"));
    const csvFile = join(workDir, "registrations.csv");
    await registerV1Name(env, label, owner, ONE_YEAR_SECONDS);
    createCSVFile(csvFile, [label]);
    await preMigrationMain(buildMainArgs(env, csvFile));
  }

  function migrationOptions(label: string, owner: Address) {
    return {
      network: "mainnet" as const,
      rpcUrl: `http://${env.hostPort}`,
      chain: env.client.chain,
      label,
      owner,
      privateKey: testPrivateKeyFor(owner),
      v1DeploymentsDir,
      v1DeploymentNetwork: "mainnet",
      migrationController: env.rocketh.get("UnlockedMigrationController"),
    };
  }

  async function v2State(label: string) {
    return env.v2.ETHRegistry.read.getState([idFromLabel(label)]);
  }

  it("migrates a wrapped name, which travels a different path than an unwrapped one", async () => {
    const label = "wrappedmig";
    const owner = env.namedAccounts.user.address;
    await reserved(label, owner);

    const before = await v2State(label);
    expect(Number(before.status)).toBe(STATUS.RESERVED);

    await migrateWrappedV1Name(migrationOptions(label, owner));

    const after = await v2State(label);
    expect(Number(after.status)).toBe(STATUS.REGISTERED);
    expect(getAddress(after.latestOwner)).toBe(getAddress(owner));

    // The wrapper no longer holds it: the migration controller does.
    const [wrapperOwner] = await env.v1.NameWrapper.read.getData([
      BigInt(namehash(`${label}.eth`)),
    ]);
    expect(getAddress(wrapperOwner)).not.toBe(getAddress(owner));
  }, 120_000);

  it("migrates an unwrapped name too, so both paths reach the same end state", async () => {
    const label = "unwrappedmig";
    const owner = env.namedAccounts.user.address;
    await reserved(label, owner);

    await migrateUnwrappedV1Name(migrationOptions(label, owner));

    const after = await v2State(label);
    expect(Number(after.status)).toBe(STATUS.REGISTERED);
    expect(getAddress(after.latestOwner)).toBe(getAddress(owner));
  }, 120_000);

  it("refuses to migrate a name that pre-migration never reserved", async () => {
    const label = "notreserved";
    const owner = env.namedAccounts.user.address;
    await registerV1Name(env, label, owner, ONE_YEAR_SECONDS);

    // The controllers only hold REGISTER_RESERVED, so a name with no reservation
    // has nothing for them to claim.
    await expect(
      migrateWrappedV1Name(migrationOptions(label, owner)),
    ).rejects.toThrow();
  }, 120_000);
});
