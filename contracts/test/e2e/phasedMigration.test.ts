import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Account,
  type Address,
  encodeAbiParameters,
  getContract,
  namehash,
  zeroAddress,
  zeroHash,
} from "viem";
import { Artifact_ETHRegistrarController } from "generated/artifacts/ETHRegistrarController.js";
import { FUSES, ROLES, STATUS } from "../../script/deploy-constants.js";
import { migrationDataComponents } from "../../script/migration.js";
import { main as preMigrationMain } from "../../script/preMigration.js";
import {
  buildMainArgs,
  createCSVFile,
  verifyV2State,
} from "../utils/mockPreMigration.js";
import { idFromLabel } from "../utils/utils.js";

const ONE_YEAR_SECONDS = 365n * 24n * 60n * 60n;
const MIN_V2_REGISTRATION_SECONDS = 28n * 24n * 60n * 60n;
const REGISTRAR_ROLES = ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW;

describe("Phased migration rehearsal", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;
  const csvFilePath = join(process.cwd(), "test-phased-migration.csv");
  const cleanupFiles = [
    csvFilePath,
    "preMigration-checkpoint.json",
    "preMigration-errors.log",
    "preMigration.log",
  ];

  setupEnv({
    resetOnEach: true,
    async initialize() {
      await enableV1Controller(ethRegistrarControllerAddress());
      await enableV1Controller(env.v1.NameWrapper.address);

      const v2RegistrarEnabled = await env.v2.ETHRegistry.read.hasRootRoles([
        REGISTRAR_ROLES,
        env.v2.ETHRegistrar.address,
      ]);
      if (v2RegistrarEnabled) {
        await env.v2.ETHRegistry.write.revokeRootRoles([
          REGISTRAR_ROLES,
          env.v2.ETHRegistrar.address,
        ]);
      }
    },
  });

  afterEach(() => {
    for (const file of cleanupFiles) {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {}
      }
    }
  });

  it("runs the migration phases on the local devnet snapshot", async () => {
    const { user } = env.namedAccounts;
    const initialLabel = "phaseoldok";
    const firstMigrationLabel = "phasemigrateone";
    const remainingMigrationLabel = "phasemigratetwo";
    const lockedMigrationLabel = "phasemigratelocked";

    await registerViaV1Controller(initialLabel, user);
    await registerViaV1Controller(firstMigrationLabel, user);
    await registerViaV1Controller(remainingMigrationLabel, user);
    await registerViaV1Controller(lockedMigrationLabel, user);
    // Wrap and lock before phase 3 freezes v1, so the locked route has a name
    // to carry through the phases.
    await wrapLockedV1Name(lockedMigrationLabel, user);

    const initialOwner = await env.v1.BaseRegistrar.read.ownerOf([
      idFromLabel(initialLabel),
    ]);
    expect(initialOwner.toLowerCase()).toBe(user.address.toLowerCase());

    createCSVFile(csvFilePath, [
      firstMigrationLabel,
      remainingMigrationLabel,
      lockedMigrationLabel,
    ]);
    await preMigrationMain(
      buildMainArgs(env, csvFilePath, {
        limit: 1,
        batchSize: 1,
      }),
    );

    let firstState = await verifyV2State(env, firstMigrationLabel);
    let remainingState = await verifyV2State(env, remainingMigrationLabel);
    expect(firstState.status).toBe(STATUS.RESERVED);
    expect(remainingState.status).toBe(STATUS.AVAILABLE);

    await disableV1Registrars();

    await expect(
      env.v1.BaseRegistrar.read.controllers([ethRegistrarControllerAddress()]),
    ).resolves.toBe(false);
    await expect(
      env.v1.BaseRegistrar.read.controllers([env.v1.NameWrapper.address]),
    ).resolves.toBe(false);
    // v1 BaseRegistrar rejects register() from a removed controller with a
    // bare require (no reason string), so only the reverted call is matchable.
    await expect(
      registerViaV1Controller("phaseoldblocked", user),
    ).rejects.toThrow('The contract function "register" reverted');

    await preMigrationMain(
      buildMainArgs(env, csvFilePath, {
        continue: true,
        batchSize: 1,
      }),
    );

    firstState = await verifyV2State(env, firstMigrationLabel);
    remainingState = await verifyV2State(env, remainingMigrationLabel);
    expect(firstState.status).toBe(STATUS.RESERVED);
    expect(remainingState.status).toBe(STATUS.RESERVED);

    await migrateUnwrappedV1Name(firstMigrationLabel, user);

    const migratedState = await verifyV2State(env, firstMigrationLabel);
    expect(migratedState.status).toBe(STATUS.REGISTERED);
    expect(migratedState.latestOwner.toLowerCase()).toBe(
      user.address.toLowerCase(),
    );

    // The locked route reaches v2 through a different controller and receiver
    // than the unwrapped one, so the phases have to wire both.
    await migrateLockedV1Name(lockedMigrationLabel, user);

    const lockedState = await verifyV2State(env, lockedMigrationLabel);
    expect(lockedState.status).toBe(STATUS.REGISTERED);
    expect(lockedState.latestOwner.toLowerCase()).toBe(
      user.address.toLowerCase(),
    );

    const registrarEnabledBefore = await env.v2.ETHRegistry.read.hasRootRoles([
      REGISTRAR_ROLES,
      env.v2.ETHRegistrar.address,
    ]);
    expect(registrarEnabledBefore).toBe(false);
    // ETHRegistrar lacks REGISTRAR/RENEW root roles on the registry, so the
    // registry rejects the registration with
    // EACUnauthorizedAccountRoles(uint256,uint256,address). The registrar's
    // deployment ABI cannot decode the registry's error, so viem surfaces the
    // raw selector (0x4b27a133); match either form.
    await expect(
      registerViaV2Registrar("phasev2blocked", user),
    ).rejects.toThrow(/EACUnauthorizedAccountRoles|0x4b27a133/);

    await env.v2.ETHRegistry.write.grantRootRoles([
      REGISTRAR_ROLES,
      env.v2.ETHRegistrar.address,
    ]);

    const registrarEnabledAfter = await env.v2.ETHRegistry.read.hasRootRoles([
      REGISTRAR_ROLES,
      env.v2.ETHRegistrar.address,
    ]);
    expect(registrarEnabledAfter).toBe(true);

    // The name is RESERVED from premigration, so the registrar refuses it.
    await expect(
      registerViaV2Registrar(remainingMigrationLabel, user),
    ).rejects.toThrow("NameNotAvailable");

    await registerViaV2Registrar("phasev2works", user);
    const v2RegisteredState = await verifyV2State(env, "phasev2works");
    expect(v2RegisteredState.status).toBe(STATUS.REGISTERED);
    expect(v2RegisteredState.latestOwner.toLowerCase()).toBe(
      user.address.toLowerCase(),
    );
  }, 30_000);

  function ethRegistrarControllerAddress(): Address {
    return env.rocketh.deployments["ETHRegistrarController"].address;
  }

  function ethRegistrarController(account: Account) {
    return env.patchContractWrite(
      getContract({
        abi: Artifact_ETHRegistrarController.abi,
        address: ethRegistrarControllerAddress(),
        client: env.createClient(account),
      }),
    ) as any;
  }

  async function enableV1Controller(address: Address) {
    const enabled = await env.v1.BaseRegistrar.read.controllers([address]);
    if (enabled) return;
    await env.v1.RegistrarSecurityController.write.addRegistrarController(
      [address],
      { account: env.namedAccounts.owner },
    );
  }

  async function disableV1Registrars() {
    const controllerAddresses = [
      ethRegistrarControllerAddress(),
      env.v1.NameWrapper.address,
    ];
    for (const address of controllerAddresses) {
      const enabled = await env.v1.BaseRegistrar.read.controllers([address]);
      if (!enabled) continue;
      await env.v1.RegistrarSecurityController.write.removeRegistrarController(
        [address],
        { account: env.namedAccounts.owner },
      );
    }
  }

  async function registerViaV1Controller(label: string, account: Account) {
    const controller = ethRegistrarController(account);
    const registration = {
      label,
      owner: account.address,
      duration: ONE_YEAR_SECONDS,
      secret: zeroHash,
      resolver: zeroAddress,
      data: [],
      reverseRecord: 0,
      referrer: zeroHash,
    };
    const commitment = await controller.read.makeCommitment([registration]);
    await controller.write.commit([commitment], { account });
    const minCommitmentAge = await controller.read.minCommitmentAge();
    await env.sync({ warpSec: Number(minCommitmentAge) + 1 });

    const price = await controller.read.rentPrice([label, ONE_YEAR_SECONDS]);
    await controller.write.register([registration], {
      account,
      value: price.base + price.premium,
    });
  }

  /// Wraps a v1 name and burns CANNOT_UNWRAP, giving the locked migration route
  /// a name in the form it requires.
  async function wrapLockedV1Name(label: string, account: Account) {
    await env.v1.BaseRegistrar.write.safeTransferFrom(
      [
        account.address,
        env.v1.NameWrapper.address,
        idFromLabel(label),
        encodeAbiParameters(
          [
            { name: "label", type: "string" },
            { name: "owner", type: "address" },
            { name: "fuses", type: "uint16" },
            { name: "resolver", type: "address" },
          ],
          [label, account.address, FUSES.CANNOT_UNWRAP, zeroAddress],
        ),
      ],
      { account },
    );
  }

  async function migrateLockedV1Name(label: string, account: Account) {
    const node = namehash(`${label}.eth`);
    const resolver = await env.v1.ENSRegistry.read.resolver([node]);
    const data = encodeAbiParameters(
      [{ type: "tuple", components: migrationDataComponents }],
      [
        {
          label,
          owner: account.address,
          subregistry: zeroAddress,
          resolver,
        },
      ],
    );
    await env.v1.NameWrapper.write.safeTransferFrom(
      [
        account.address,
        env.v2.LockedMigrationController.address,
        BigInt(node),
        1n,
        data,
      ],
      { account },
    );
  }

  async function migrateUnwrappedV1Name(label: string, account: Account) {
    const resolver = await env.v1.ENSRegistry.read.resolver([
      namehash(`${label}.eth`),
    ]);
    const data = encodeAbiParameters(
      [{ type: "tuple", components: migrationDataComponents }],
      [
        {
          label,
          owner: account.address,
          subregistry: zeroAddress,
          resolver,
        },
      ],
    );
    await env.v1.BaseRegistrar.write.safeTransferFrom(
      [
        account.address,
        env.v2.UnlockedMigrationController.address,
        idFromLabel(label),
        data,
      ],
      { account },
    );
  }

  async function registerViaV2Registrar(label: string, account: Account) {
    const duration = MIN_V2_REGISTRATION_SECONDS;
    const resolver = zeroAddress;
    const subregistry = zeroAddress;
    const referrer = zeroHash;
    const secret = zeroHash;
    const paymentToken = env.erc20.MockUSDC.address;

    const commitment = await env.v2.ETHRegistrar.read.makeCommitment([
      label,
      account.address,
      secret,
      subregistry,
      resolver,
      duration,
      referrer,
    ]);
    await env.v2.ETHRegistrar.write.commit([commitment], { account });
    await env.sync({ warpSec: 61 });

    const [base, premium] = await env.v2.ETHRegistrar.read.getRegisterPrice([
      label,
      duration,
      paymentToken,
    ]);
    await env.erc20.MockUSDC.write.mint([account.address, base + premium], {
      account,
    });
    await env.erc20.MockUSDC.write.approve(
      [env.v2.ETHRegistrar.address, base + premium],
      { account },
    );
    await env.v2.ETHRegistrar.write.register(
      [
        label,
        account.address,
        secret,
        subregistry,
        resolver,
        duration,
        paymentToken,
        referrer,
      ],
      { account },
    );
  }
});

const sepoliaRpcUrl = loadEnvValue("SEPOLIA_RPC_URL");
const runSepoliaFork =
  process.env.RUN_SEPOLIA_FORK_MIGRATION_TEST === "1" && Boolean(sepoliaRpcUrl);
const describeSepoliaFork = runSepoliaFork ? describe : describe.skip;

describeSepoliaFork("Sepolia Anvil fork migration rehearsal", () => {
  it("runs the migration phases against a direct Sepolia fork", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "enschain-sepolia-fork-"));
    const csvFile = join(workDir, "registrations.csv");
    writeFileSync(
      csvFile,
      "node,name,labelHash,owner,parentName,parentLabelHash,labelName,registrationDate,expiryDate\n",
    );
    const port = await getFreePort();

    try {
      const proc = Bun.spawn(
        [
          "bun",
          "script/migration.ts",
          "fork",
          "full",
          "--network",
          "sepolia",
          "--rpc-url",
          sepoliaRpcUrl!,
          "--chain-id",
          "11155111",
          "--port",
          String(port),
          "--csv-file",
          csvFile,
          "--work-dir",
          workDir,
          "--initial-limit",
          "1",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...stringEnv(process.env),
            SEPOLIA_RPC_URL: sepoliaRpcUrl!,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const output = `${stdout}\n${stderr}`;
      if (exitCode !== 0) {
        throw new Error(
          `Sepolia fork rehearsal failed:\n${output.slice(-12_000)}`,
        );
      }

      expect(output).toContain(
        "phase 1: deploy v2 contracts against official Sepolia v1 references",
      );
      expect(output).toContain(
        "v1 registration succeeded before registrar disablement",
      );
      expect(output).toContain(
        "v1 registration rejected after registrar disablement",
      );
      expect(output).toContain("smoke migration registered");
      expect(output).toContain(
        "v2 registrar rejected registration before enablement",
      );
      expect(output).toContain(
        "v2 registrar rejected pre-migrated reserved name after enablement",
      );
      expect(output).toContain("v2 registrar registered");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 300_000);
});

function loadEnvValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envFile = join(process.cwd(), ".env");
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || match[1] !== name) continue;
    return match[2].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a free local port");
  }
  return address.port;
}
