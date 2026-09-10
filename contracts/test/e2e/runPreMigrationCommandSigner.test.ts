import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHECKPOINT_FILE,
  createFreshCheckpoint,
  type Checkpoint,
} from "../../script/preMigration.js";

import { runPreMigrationCommand } from "../../script/migration.js";

// The BatchRegistrar owner that fork/clean-testnet runs impersonate. The env
// deployer key below does NOT control it.
const OWNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ownerAccount = privateKeyToAccount(OWNER_KEY);

const DEPLOYER_KEY =
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);

let capturedArgs: string[] | null = null;
// When set, the mocked pre-migration run writes this checkpoint to its workDir,
// standing in for the real run so the metadata-persistence path can be exercised.
let checkpointToWrite: Checkpoint | null = null;

async function captureArgs(args: string[]) {
  capturedArgs = args;
  if (checkpointToWrite) {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpointToWrite));
  }
}

function makeCheckpoint(overrides: Partial<Checkpoint>): Checkpoint {
  return { ...createFreshCheckpoint(), ...overrides };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const baseOpts = {
  rpcUrl: "http://127.0.0.1:8545",
  network: "mainnet" as const,
  registry: "0x0000000000000000000000000000000000000001" as const,
  batchRegistrar: "0x0000000000000000000000000000000000000002" as const,
  v1Resolver: "0x0000000000000000000000000000000000000003" as const,
  v1BaseRegistrar: "0x0000000000000000000000000000000000000004" as const,
  csvFile: "names.csv",
};

describe("runPreMigrationCommand signer resolution", () => {
  const savedEnv = {
    PREMIGRATION_PRIVATE_KEY: process.env.PREMIGRATION_PRIVATE_KEY,
    BATCH_REGISTRAR_OWNER_KEY: process.env.BATCH_REGISTRAR_OWNER_KEY,
    DEPLOYER_KEY: process.env.DEPLOYER_KEY,
  };

  beforeEach(() => {
    capturedArgs = null;
    delete process.env.PREMIGRATION_PRIVATE_KEY;
    delete process.env.BATCH_REGISTRAR_OWNER_KEY;
    process.env.DEPLOYER_KEY = DEPLOYER_KEY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("drops the non-matching env fallback when an impersonated account is supplied", async () => {
    await runPreMigrationCommand(
      { ...baseOpts, account: ownerAccount.address },
      false,
      captureArgs,
    );
    expect(capturedArgs).not.toBeNull();
    expect(flagValue(capturedArgs!, "--account")).toBe(ownerAccount.address);
    expect(capturedArgs).not.toContain("--private-key");
  });

  it("keeps the env fallback when it controls the supplied account", async () => {
    await runPreMigrationCommand(
      { ...baseOpts, account: deployerAccount.address },
      false,
      captureArgs,
    );
    expect(flagValue(capturedArgs!, "--private-key")).toBe(DEPLOYER_KEY);
    expect(flagValue(capturedArgs!, "--account")).toBe(deployerAccount.address);
  });

  it("uses the env fallback when no account is supplied", async () => {
    await runPreMigrationCommand({ ...baseOpts }, false, captureArgs);
    expect(flagValue(capturedArgs!, "--private-key")).toBe(DEPLOYER_KEY);
    expect(capturedArgs).not.toContain("--account");
  });

  it("an explicit private key always wins over the impersonated account", async () => {
    await runPreMigrationCommand(
      { ...baseOpts, privateKey: OWNER_KEY, account: ownerAccount.address },
      false,
      captureArgs,
    );
    expect(flagValue(capturedArgs!, "--private-key")).toBe(OWNER_KEY);
    expect(flagValue(capturedArgs!, "--account")).toBe(ownerAccount.address);
  });
});

describe("runPreMigrationCommand metadata persistence", () => {
  let deploymentsDir: string;
  let workDir: string;
  const deploymentNetwork = "mainnet";

  beforeEach(() => {
    process.env.DEPLOYER_KEY = DEPLOYER_KEY;
    deploymentsDir = mkdtempSync(join(tmpdir(), "premigration-meta-deploy-"));
    workDir = mkdtempSync(join(tmpdir(), "premigration-meta-work-"));
    // The namespace dir must exist for the sidecar to be written.
    mkdirSync(join(deploymentsDir, deploymentNetwork), { recursive: true });
  });

  afterEach(() => {
    checkpointToWrite = null;
    delete process.env.DEPLOYER_KEY;
    rmSync(deploymentsDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  const metadataPath = () =>
    join(deploymentsDir, deploymentNetwork, ".premigration.json");

  const readMetadata = () => JSON.parse(readFileSync(metadataPath(), "utf-8"));

  it("writes a run summary and resolved roll-up, upserting by label", async () => {
    checkpointToWrite = makeCheckpoint({
      totalExpected: 9,
      totalProcessed: 9,
      successCount: 5,
      renewedCount: 0,
      skippedCount: 3,
      skippedNeverRegisteredCount: 2,
      skippedPastGraceCount: 1,
      alreadyRegisteredCount: 0,
      invalidLabelCount: 1,
      failureCount: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await runPreMigrationCommand(
      {
        ...baseOpts,
        deploymentsDir,
        deploymentNetwork,
        workDir,
        metadataLabel: "initial",
      },
      false,
      captureArgs,
    );

    let metadata = readMetadata();
    expect(metadata.chainId).toBe(1);
    expect(metadata.runs).toHaveLength(1);
    expect(metadata.runs[0]).toMatchObject({
      label: "initial",
      reserved: 5,
      renewed: 0,
      skippedNeverRegistered: 2,
      skippedExpiredPastGrace: 1,
      invalidLabels: 1,
      alreadyOnV2: 0,
      failed: 0,
    });

    // Resume re-writes the same label's accumulated checkpoint: upsert, not append.
    checkpointToWrite = makeCheckpoint({
      totalExpected: 9,
      totalProcessed: 9,
      successCount: 6,
      skippedCount: 3,
      skippedNeverRegisteredCount: 2,
      skippedPastGraceCount: 1,
      invalidLabelCount: 0,
      timestamp: "2026-01-01T01:00:00.000Z",
    });
    await runPreMigrationCommand(
      {
        ...baseOpts,
        deploymentsDir,
        deploymentNetwork,
        workDir,
        metadataLabel: "initial",
      },
      true,
      captureArgs,
    );
    metadata = readMetadata();
    expect(metadata.runs).toHaveLength(1);
    expect(metadata.runs[0].reserved).toBe(6);

    // A second logical run (final-sync) appends and drives the resolved section,
    // being the most recently finished run.
    checkpointToWrite = makeCheckpoint({
      totalExpected: 10,
      totalProcessed: 10,
      successCount: 1,
      renewedCount: 5,
      skippedCount: 3,
      skippedNeverRegisteredCount: 2,
      skippedPastGraceCount: 1,
      alreadyRegisteredCount: 1,
      invalidLabelCount: 1,
      failureCount: 0,
      timestamp: "2026-01-02T00:00:00.000Z",
    });
    await runPreMigrationCommand(
      {
        ...baseOpts,
        deploymentsDir,
        deploymentNetwork,
        workDir,
        metadataLabel: "final-sync",
      },
      false,
      captureArgs,
    );
    metadata = readMetadata();
    expect(metadata.runs).toHaveLength(2);
    expect(metadata.resolved).toMatchObject({
      finishedAt: "2026-01-02T00:00:00.000Z",
      totalNames: 10,
      namesPreMigrated: 6,
      newReservations: 1,
      expiryResyncs: 5,
      skippedNeverRegistered: 2,
      skippedExpiredPastGrace: 1,
      invalidLabels: 1,
      alreadyOnV2: 1,
      failed: 0,
    });
  });

  it("skips the write on dry run and when persistMetadata is false", async () => {
    checkpointToWrite = makeCheckpoint({
      successCount: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    await runPreMigrationCommand(
      {
        ...baseOpts,
        deploymentsDir,
        deploymentNetwork,
        workDir,
        metadataLabel: "run",
        dryRun: true,
      },
      false,
      captureArgs,
    );
    expect(existsSync(metadataPath())).toBe(false);

    await runPreMigrationCommand(
      {
        ...baseOpts,
        deploymentsDir,
        deploymentNetwork,
        workDir,
        metadataLabel: "run",
        persistMetadata: false,
      },
      false,
      captureArgs,
    );
    expect(existsSync(metadataPath())).toBe(false);
  });

  it("does not write when the namespace directory is absent", async () => {
    checkpointToWrite = makeCheckpoint({
      successCount: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await runPreMigrationCommand(
      {
        ...baseOpts,
        deploymentsDir,
        deploymentNetwork: "does-not-exist",
        workDir,
        metadataLabel: "run",
      },
      false,
      captureArgs,
    );
    expect(
      existsSync(join(deploymentsDir, "does-not-exist", ".premigration.json")),
    ).toBe(false);
  });
});
