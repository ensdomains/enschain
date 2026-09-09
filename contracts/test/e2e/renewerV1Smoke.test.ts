import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  namehash,
  toHex,
  zeroAddress,
  type Address,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  activateV1HandoffControllers,
  activateV1RenewerAndTransferOwnership,
  authorizeV1Renewer,
  renewViaEthRenewerV1,
  verifyV1Renewer,
} from "../../script/migrate.js";
import { main as preMigrationMain } from "../../script/preMigration.js";
import { writeDeploymentNamespace } from "../utils/deploymentArtifacts.js";
import {
  buildMainArgs,
  createCSVFile,
  registerV1Name,
  setupBaseRegistrarController,
} from "../utils/mockPreMigration.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const NETWORK = "mainnet";
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

describe("ETHRenewerV1 renewal smoke", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;
  const workDir = mkdtempSync(join(tmpdir(), "renewer-phase4-"));
  const v1DeploymentsDir = join(workDir, "v1");
  const deploymentsDir = join(workDir, "v2");

  setupEnv({
    resetOnEach: true,
    async initialize() {
      await setupBaseRegistrarController(env);
    },
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // The phase commands read addresses from deployment artifacts rather than from a
  // live environment, so the devnet's contracts are written out in the layout they
  // expect. These tests drive the shipped commands rather than the writes they
  // make, so that what phase 4 grants is checked against what it promises.
  // The phase commands read addresses from deployment artifacts rather than from a
  // live environment, so the devnet's contracts are written out in the layout they
  // expect. These tests drive the shipped commands rather than the writes they
  // make, so that what phase 4 grants is checked against what it promises.
  function writeDeploymentArtifacts() {
    writeDeploymentNamespace(v1DeploymentsDir, NETWORK, [
      ["BaseRegistrarImplementation", env.v1.BaseRegistrar],
      ["RegistrarSecurityController", env.v1.RegistrarSecurityController],
    ]);
    writeDeploymentNamespace(deploymentsDir, NETWORK, [
      ["ETHRenewerV1", env.v2.ETHRenewerV1],
      ["Graveyard", env.v2.Graveyard],
    ]);
  }

  function phaseOptions() {
    return {
      network: NETWORK,
      rpcUrl: `http://${env.hostPort}`,
      chainId: "1",
      deploymentsDir,
      deploymentNetwork: NETWORK,
      v1DeploymentsDir,
      v1DeploymentNetwork: NETWORK,
      impersonateOwner: true,
    } as const;
  }

  // Registers a name on v1 and reserves it on v2 through the real pre-migration
  // path, which is the state an unmigrated name is in during the migration window.
  async function reservedName(label: string) {
    const { user } = env.namedAccounts;
    const csvDir = mkdtempSync(join(tmpdir(), "renewer-"));
    const csvFile = join(csvDir, "registrations.csv");
    await registerV1Name(env, label, user.address, ONE_YEAR_SECONDS);
    createCSVFile(csvFile, [label]);
    await preMigrationMain(buildMainArgs(env, csvFile));
  }

  function renew(label: string) {
    const payer = env.namedAccounts.deployer;
    return renewViaEthRenewerV1({
      rpcUrl: `http://${env.hostPort}`,
      chain: env.client.chain,
      label,
      privateKey: testPrivateKeyFor(payer.address),
      ethRenewerV1: env.rocketh.get("ETHRenewerV1"),
      ethRegistry: env.rocketh.get("ETHRegistry"),
      v1BaseRegistrar: {
        address: env.v1.BaseRegistrar.address,
        abi: env.v1.BaseRegistrar.abi,
      },
      nameWrapper: {
        address: env.v1.NameWrapper.address,
        abi: env.v1.NameWrapper.abi,
      },
      mockUsdc: env.rocketh.get("MockUSDC"),
      duration: BigInt(ONE_YEAR_SECONDS),
    });
  }

  // Runs phase 4 as the runbook does: authorize the renewer, grant the remaining
  // handoff controllers while the v1 owner still holds the registrar, then hand the
  // registrar over.
  async function runPhase4() {
    writeDeploymentArtifacts();
    await authorizeV1Renewer(phaseOptions());
    await activateV1HandoffControllers(phaseOptions());
    await activateV1RenewerAndTransferOwnership(phaseOptions());
  }

  it("leaves unmigrated names renewable once phase 4 completes", async () => {
    const label = "renewme";
    await reservedName(label);
    await runPhase4();

    // The phase's own verification, run the way an operator would: a renewal needs
    // the controller grant and registrar ownership, and it passes only with both.
    await verifyV1Renewer(phaseOptions());

    // Asserts the whole invariant internally: reaching here means the v1
    // registration and the v2 reservation both advanced by the same duration and
    // the entry stayed RESERVED.
    await renew(label);
  }, 120_000);

  it("cannot renew on the controller grant alone, which is why phase 4 also hands over the registrar", async () => {
    const label = "renewlater";
    await reservedName(label);
    writeDeploymentArtifacts();
    await authorizeV1Renewer(phaseOptions());

    // `renew()` calls `syncWrapper()`, which calls the owner-gated `addController`
    // on the v1 BaseRegistrar. Authorizing the renewer as a controller and deferring
    // the ownership transfer to a later phase leaves every renewal reverting for as
    // long as the gap lasts.
    await expect(verifyV1Renewer(phaseOptions())).rejects.toThrow(
      /not ETHRenewerV1/,
    );
    await expect(renew(label)).rejects.toThrow();
  }, 120_000);

  it("syncs the NameWrapper expiry when the name is wrapped", async () => {
    const label = "wrappedrenew";
    const { user } = env.namedAccounts;
    const csvDir = mkdtempSync(join(tmpdir(), "renewer-wrapped-"));
    const csvFile = join(csvDir, "registrations.csv");
    // The registrar keys tokens by labelhash; NameWrapper keys them by namehash.
    const registrarTokenId = BigInt(keccak256(toHex(label)));
    const wrapperTokenId = BigInt(namehash(`${label}.eth`));

    await registerV1Name(env, label, user.address, ONE_YEAR_SECONDS);

    // Wrap it, so the NameWrapper holds its own copy of the expiry — the third
    // place a renewal has to keep in step, and the branch an unwrapped name
    // never reaches.
    await env.v1.BaseRegistrar.write.safeTransferFrom(
      [
        user.address,
        env.v1.NameWrapper.address,
        registrarTokenId,
        encodeAbiParameters(
          [
            { name: "label", type: "string" },
            { name: "owner", type: "address" },
            { name: "fuses", type: "uint16" },
            { name: "resolver", type: "address" },
          ],
          [label, user.address, 0, zeroAddress],
        ),
      ],
      { account: user },
    );

    createCSVFile(csvFile, [label]);
    await preMigrationMain(buildMainArgs(env, csvFile));
    await runPhase4();

    const wrapperExpiryBefore = (
      await env.v1.NameWrapper.read.getData([wrapperTokenId])
    )[2];
    expect(wrapperExpiryBefore).toBeGreaterThan(0n);

    await renew(label);

    const wrapperExpiryAfter = (
      await env.v1.NameWrapper.read.getData([wrapperTokenId])
    )[2];
    expect(wrapperExpiryAfter).toBeGreaterThan(wrapperExpiryBefore);
  }, 120_000);
});
