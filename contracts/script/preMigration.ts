#!/usr/bin/env bun

import { Command } from "commander";
import {
  createReadStream,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  keccak256,
  publicActions,
  toHex,
  zeroAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { waitForSuccessfulTransactionReceipt } from "../test/utils/waitForSuccessfulTransactionReceipt.js";
import {
  blue,
  bold,
  cyan,
  dim,
  green,
  Logger,
  magenta,
  red,
  yellow,
} from "./logger.js";

import { loadArtifact, resolveChain } from "./scriptUtils.js";

// ABI fragments for v1 BaseRegistrar
const BASE_REGISTRAR_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "id", type: "uint256" }],
    name: "nameExpires",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Custom Errors
export class UnexpectedOwnerError extends Error {
  constructor(
    public readonly labelName: string,
    public readonly actualOwner: Address,
    public readonly expectedOwner: Address,
  ) {
    super(
      `Name ${labelName}.eth is already registered but owned by unexpected address: ${actualOwner} (expected: ${expectedOwner})`,
    );
    this.name = "UnexpectedOwnerError";
  }
}

export class InvalidLabelNameError extends Error {
  constructor(public readonly labelName: any) {
    super(`Invalid label name: ${labelName}`);
    this.name = "InvalidLabelNameError";
  }
}

export class CSVFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CSVFormatError";
  }
}

const ENCODED_LABELHASH_RE = /^\[[0-9a-fA-F]{64}\]$/;

export function isValidLabel(label: any): label is string {
  return (
    !!label &&
    typeof label === "string" &&
    label.trim() !== "" &&
    Buffer.from(label).length <= 255 &&
    !ENCODED_LABELHASH_RE.test(label)
  );
}

// Types
export interface ENSRegistration {
  labelName: string;
  lineNumber: number;
}

export interface PreMigrationConfig {
  rpcUrl: string;
  mainnetRpcUrl: string;
  registryAddress: Address;
  batchRegistrarAddress: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  csvFilePath: string;
  batchSize: number;
  startIndex: number;
  limit: number | null;
  dryRun: boolean;
  continue?: boolean;
  disableCheckpoint?: boolean;
  bonusPeriodDays: number;
  v1ResolverAddress: Address;
  v1BaseRegistrarAddress: Address;
}

export interface Checkpoint {
  lastProcessedLineNumber: number;
  totalProcessed: number;
  totalExpected: number;
  successCount: number;
  renewedCount: number;
  failureCount: number;
  /// Aggregate of the two skip sub-counters below (names not claimable on v1).
  skippedCount: number;
  /// Names skipped because they were never registered on v1.
  skippedNeverRegisteredCount: number;
  /// Names skipped because their v1 registration lapsed past the grace period.
  skippedPastGraceCount: number;
  /// Names skipped because they are already registered (owned) on v2. Tracked
  /// separately from genuine failures.
  alreadyRegisteredCount: number;
  invalidLabelCount: number;
  timestamp: string;
}

// Constants
export const CHECKPOINT_FILE = "preMigration-checkpoint.json";
const ERROR_LOG_FILE = "preMigration-errors.log";
const INFO_LOG_FILE = "preMigration.log";

const RPC_TIMEOUT_MS = 30000;

// ENS v1 BaseRegistrar on Ethereum mainnet
const BASE_REGISTRAR_ADDRESS =
  "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85" as Address;

/// Hard-coded ENSv1 grace period (in days). Defines the window after a name's
/// v1 expiry during which the original owner retains exclusive renewal rights
/// on v1. Sourced from `BaseRegistrarImplementation.GRACE_PERIOD = 90 days`.
/// Used as the v1-side eligibility gate for migration: a name is migratable
/// only while its v1 owner can still renew it.
export const V1_GRACE_PERIOD_DAYS = 90n;
export const V1_GRACE_PERIOD_SECONDS = V1_GRACE_PERIOD_DAYS * 86400n;

export function createFreshCheckpoint(): Checkpoint {
  return {
    lastProcessedLineNumber: -1,
    totalProcessed: 0,
    totalExpected: 0,
    successCount: 0,
    renewedCount: 0,
    failureCount: 0,
    skippedCount: 0,
    skippedNeverRegisteredCount: 0,
    skippedPastGraceCount: 0,
    alreadyRegisteredCount: 0,
    invalidLabelCount: 0,
    timestamp: new Date().toISOString(),
  };
}

// Pre-migration specific logger
class PreMigrationLogger extends Logger {
  constructor() {
    super({
      infoLogFile: INFO_LOG_FILE,
      errorLogFile: ERROR_LOG_FILE,
      enableFileLogging: true,
    });
  }

  processingName(name: string, index: number, total: number): void {
    this.raw(
      cyan(`[${index}/${total}] Processing: ${bold(name)}.eth`),
      `[${index}/${total}] Processing: ${name}.eth`,
    );
  }

  finishedName(
    name: string,
    result: "reserved" | "renewed" | "skipped" | "failed",
  ): void {
    const icon =
      result === "reserved"
        ? "✓"
        : result === "renewed"
          ? "↻"
          : result === "skipped"
            ? "⊘"
            : "✗";
    const color =
      result === "reserved"
        ? green
        : result === "renewed"
          ? cyan
          : result === "skipped"
            ? yellow
            : red;
    this.raw(
      color(`${icon} Done: ${bold(name)}.eth`) + dim(` (${result})`),
      `${icon} Done: ${name}.eth (${result})`,
    );
  }

  reserving(name: string, expiry: string): void {
    this.raw(
      blue(`  → Reserving on v2`) + dim(` (expires: ${expiry})`),
      `  → Reserving on v2 (expires: ${expiry})`,
    );
  }

  reserved(tx: string): void {
    this.raw(
      green(`  → ✓ Reserved successfully`) + dim(` (tx: ${tx})`),
      `  → ✓ Reserved successfully (tx: ${tx})`,
    );
  }

  alreadyReserved(): void {
    this.raw(
      yellow(`  → ⊘ Already reserved by this migration`),
      `  → ⊘ Already reserved by this migration`,
    );
  }

  renewing(name: string, currentExpiry: string, newExpiry: string): void {
    this.raw(
      blue(`  → Renewing on v2`) +
        dim(` (current: ${currentExpiry}, new: ${newExpiry})`),
      `  → Renewing on v2 (current: ${currentExpiry}, new: ${newExpiry})`,
    );
  }

  renewed(tx: string): void {
    this.raw(
      green(`  → ✓ Renewed successfully`) + dim(` (tx: ${tx})`),
      `  → ✓ Renewed successfully (tx: ${tx})`,
    );
  }

  failed(name: string, error: string): void {
    this.rawError(
      red(`  → ✗ Failed:`) + dim(` ${error}`),
      `  → ✗ Failed: ${error}`,
    );
  }

  dryRun(): void {
    this.raw(
      dim(`  → [DRY RUN] Simulated registration (no transaction sent)`),
      `  → [DRY RUN] Simulated registration (no transaction sent)`,
    );
  }

  progress(
    current: number,
    total: number,
    stats: {
      reserved: number;
      renewed: number;
      skipped: number;
      failed: number;
    },
  ): void {
    const percent = Math.round((current / total) * 100);
    this.raw(
      magenta(
        `Progress: ${bold(`${current}/${total}`)} (${percent}%) - ` +
          `${green("Reserved: " + stats.reserved)}, ` +
          `${cyan("Renewed: " + stats.renewed)}, ` +
          `${yellow("Skipped: " + stats.skipped)}, ` +
          `${red("Failed: " + stats.failed)}`,
      ),
      `Progress: ${current}/${total} (${percent}%) - Reserved: ${stats.reserved}, Renewed: ${stats.renewed}, Skipped: ${stats.skipped}, Failed: ${stats.failed}`,
    );
  }

  verifyingV1(name: string): void {
    this.raw(
      dim(`  → Checking v1 status for ${name}.eth...`),
      `  → Checking v1 status for ${name}.eth...`,
    );
  }

  v1Verified(name: string, expiry: string): void {
    this.raw(
      green(`  → ✓ Verified on v1`) + dim(` (expires: ${expiry})`),
      `  → ✓ Verified on v1 (expires: ${expiry})`,
    );
  }

  v1NotRegistered(name: string, reason: string): void {
    this.raw(
      yellow(`  → ⊘ Not claimable on v1: ${reason}`),
      `  → ⊘ Not claimable on v1: ${reason}`,
    );
  }

  skippingInvalidName(domainName: string): void {
    this.raw(
      yellow(`  → ⊘ Skipping: ${bold(domainName)}`) +
        dim(` (invalid label name)`),
      `  → ⊘ Skipping: ${domainName} (invalid label name)`,
    );
  }
}

const logger = new PreMigrationLogger();

// Checkpoint management
export function loadCheckpoint(
  path: string = CHECKPOINT_FILE,
): Checkpoint | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const data = readFileSync(path, "utf-8");
    // Spread over a fresh checkpoint so counters added after an older run was
    // written default to 0 rather than undefined (which would break `count++`).
    return { ...createFreshCheckpoint(), ...JSON.parse(data) };
  } catch (error) {
    logger.error(`Failed to load checkpoint: ${error}`);
    return null;
  }
}

export function saveCheckpoint(checkpoint: Checkpoint): void {
  try {
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    logger.error(`Failed to save checkpoint: ${error}`);
  }
}

// Removes any checkpoint left in the work directory so a fresh run cannot
// inherit stale counts from a previous one. A run that processes zero batches
// writes no new checkpoint, so without this a lingering file would otherwise be
// mistaken for this run's result by anything that reads the checkpoint after.
export function clearCheckpoint(path: string = CHECKPOINT_FILE): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    logger.error(`Failed to clear checkpoint: ${error}`);
  }
}

// v1 verification
interface V1VerificationResult {
  isRegistered: boolean;
  expiry: bigint;
}

export async function verifyNameOnV1(
  labelName: string,
  client: any,
  baseRegistrarAddress: Address = BASE_REGISTRAR_ADDRESS,
): Promise<V1VerificationResult> {
  if (!isValidLabel(labelName)) {
    throw new InvalidLabelNameError(labelName);
  }

  const tokenId = keccak256(toHex(labelName));

  const expiry = await client.readContract({
    address: baseRegistrarAddress,
    abi: BASE_REGISTRAR_ABI,
    functionName: "nameExpires",
    args: [tokenId],
  });

  const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
  const isRegistered = expiry > 0n && expiry > currentTimestamp;

  return { isRegistered, expiry };
}

async function validateBatchRegistrar(
  client: any,
  address: Address,
): Promise<void> {
  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    throw new Error(
      `No contract deployed at BatchRegistrar address: ${address}`,
    );
  }
  logger.success(`Using BatchRegistrar at ${address}`);
}

const CSV_ROW_PREVIEW_LIMIT = 200;
const UTF8_BOM = "﻿";

function previewCSVLine(line: string): string {
  return line.length <= CSV_ROW_PREVIEW_LIMIT
    ? line
    : `${line.slice(0, CSV_ROW_PREVIEW_LIMIT)}...`;
}

async function* readCSVInBatches(
  csvFilePath: string,
  batchSize: number,
  startLineNumber: number = -1,
  limit: number | null = null,
): AsyncGenerator<ENSRegistration[]> {
  const readline = await import("node:readline");

  const fileStream = createReadStream(csvFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let dataLineNumber = 0;
  let processedCount = 0;
  let batch: ENSRegistration[] = [];

  let rawLineNumber = 0;
  let headerParsed = false;
  let labelColumnIndex = -1;
  let expectedColumnCount = 0;
  let pendingBlankLineNumber: number | null = null;

  for await (const rawLine of rl) {
    rawLineNumber++;

    let line = rawLine;
    if (rawLineNumber === 1 && line.startsWith(UTF8_BOM)) {
      line = line.slice(UTF8_BOM.length);
    }

    if (!headerParsed) {
      let headerFields: string[];
      try {
        headerFields = parseCSVLine(line);
      } catch {
        throw new CSVFormatError(
          `CSV header at ${csvFilePath}:1 has unbalanced quotes. Row: ${previewCSVLine(line)}`,
        );
      }

      const normalized = headerFields.map((f) => f.trim().toLowerCase());
      const labelNameIdx = normalized.indexOf("labelname");
      const labelIdx = normalized.indexOf("label");
      const resolvedIdx = labelNameIdx !== -1 ? labelNameIdx : labelIdx;
      if (resolvedIdx === -1) {
        const found = headerFields.map((f) => f.trim()).join(", ");
        throw new CSVFormatError(
          `CSV header at ${csvFilePath}:1 has no "labelName" or "label" column. ` +
            `Found columns: [${found}]. ` +
            `Expected one of "labelName" or "label" (case-insensitive).`,
        );
      }
      labelColumnIndex = resolvedIdx;
      expectedColumnCount = headerFields.length;
      headerParsed = true;
      continue;
    }

    if (dataLineNumber <= startLineNumber) {
      if (line !== "") {
        dataLineNumber++;
      }
      continue;
    }

    if (limit !== null && processedCount >= limit) {
      break;
    }

    if (line === "") {
      if (pendingBlankLineNumber === null) {
        pendingBlankLineNumber = rawLineNumber;
      } else {
        throw new CSVFormatError(
          `CSV row at ${csvFilePath}:${pendingBlankLineNumber} is blank. ` +
            `Blank lines are only tolerated at end of file.`,
        );
      }
      continue;
    }

    if (pendingBlankLineNumber !== null) {
      throw new CSVFormatError(
        `CSV row at ${csvFilePath}:${pendingBlankLineNumber} is blank. ` +
          `Blank lines are only tolerated at end of file.`,
      );
    }

    let parts: string[];
    try {
      parts = parseCSVLine(line);
    } catch {
      throw new CSVFormatError(
        `CSV row at ${csvFilePath}:${rawLineNumber} has unbalanced quotes. ` +
          `Row: ${previewCSVLine(line)}`,
      );
    }

    if (parts.length !== expectedColumnCount) {
      throw new CSVFormatError(
        `CSV row at ${csvFilePath}:${rawLineNumber} has ${parts.length} columns ` +
          `but header declared ${expectedColumnCount}. ` +
          `Row: ${previewCSVLine(line)}`,
      );
    }

    const labelName = parts[labelColumnIndex].trim();
    if (labelName === "") {
      throw new CSVFormatError(
        `CSV row at ${csvFilePath}:${rawLineNumber} has empty "labelName". ` +
          `Row: ${previewCSVLine(line)}`,
      );
    }

    batch.push({ labelName, lineNumber: dataLineNumber });
    processedCount++;

    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }

    dataLineNumber++;
  }

  if (!headerParsed) {
    throw new CSVFormatError(
      `CSV file at ${csvFilePath} is empty (no header row).`,
    );
  }

  if (batch.length > 0) {
    yield batch;
  }
}

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (inQuotes) {
    throw new Error("unbalanced quotes");
  }

  result.push(current);
  return result;
}

interface MigrationClients {
  client: any;
  mainnetClient: any;
  registry: any;
  batchRegistrar: any;
  registryAbi: any[];
}

async function createMigrationClients(
  config: PreMigrationConfig,
): Promise<MigrationClients> {
  const v2Chain = await resolveChain(config.rpcUrl, RPC_TIMEOUT_MS);

  const account = config.privateKey
    ? privateKeyToAccount(config.privateKey)
    : config.account;
  if (!account) {
    throw new Error(
      "Missing signer: provide --private-key, PREMIGRATION_PRIVATE_KEY, or --account",
    );
  }

  const client = createWalletClient({
    account,
    chain: v2Chain,
    transport: http(config.rpcUrl, { retryCount: 0, timeout: RPC_TIMEOUT_MS }),
  }).extend(publicActions);

  const mainnetClient = createPublicClient({
    chain: mainnet,
    transport: http(config.mainnetRpcUrl, {
      retryCount: 0,
      timeout: RPC_TIMEOUT_MS,
    }),
  });

  const registryArtifact = loadArtifact("PermissionedRegistry");
  const registry = getContract({
    address: config.registryAddress,
    abi: registryArtifact.abi,
    client,
  });

  await validateBatchRegistrar(client, config.batchRegistrarAddress);

  const batchRegistrarArtifact = loadArtifact("BatchRegistrar");
  const batchRegistrar = getContract({
    address: config.batchRegistrarAddress,
    abi: batchRegistrarArtifact.abi,
    client,
  });

  return {
    client,
    mainnetClient,
    registry,
    batchRegistrar,
    registryAbi: registryArtifact.abi,
  };
}

const MAX_UINT64 = (1n << 64n) - 1n;

// The reservation expiry stored on v2, widened by the bonus period and held inside
// the uint64 the registry stores it in. A v1 name renewed to the ceiling would
// otherwise wrap around and reserve a name that reads as long expired.
export function bonusAdjustedExpiry(
  v1Expiry: bigint,
  bonusPeriodSeconds: bigint,
): bigint {
  const raw = v1Expiry + bonusPeriodSeconds;
  return raw > MAX_UINT64 ? MAX_UINT64 : raw;
}

// Renders an expiry as a date for logging. Expiries near the uint64 ceiling are far
// outside the range `Date` can represent, and letting one of those throw would abort
// the whole run over a log line, so they are described rather than formatted.
export function formatExpiry(expiry: bigint): string {
  const milliseconds = Number(expiry) * 1000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) {
    return `${expiry} (beyond representable dates)`;
  }
  return new Date(milliseconds).toISOString().split("T")[0];
}

async function fetchAndReserveInBatches(
  config: PreMigrationConfig,
  checkpoint: Checkpoint,
): Promise<void> {
  const { client, mainnetClient, registry, batchRegistrar, registryAbi } =
    await createMigrationClients(config);

  const block = await client.getBlock();
  const maxGas = BigInt(
    Math.floor(Number(block.gasLimit) * GAS_LIMIT_SAFETY_FACTOR),
  );
  logger.config("Block Gas Limit", block.gasLimit.toString());
  logger.config("Max Gas Per Batch", maxGas.toString());

  logger.info(
    `\nReading CSV file and reserving in batches of ${config.batchSize}...`,
  );
  logger.info(`CSV file: ${config.csvFilePath}`);

  const batchGenerator = readCSVInBatches(
    config.csvFilePath,
    config.batchSize,
    config.startIndex,
    config.limit,
  );

  for await (const batch of batchGenerator) {
    try {
      checkpoint.totalExpected += batch.length;

      let invalidLabelsInBatch = 0;
      let lastInvalidLineNumber = checkpoint.lastProcessedLineNumber;
      const validBatch = batch.filter((reg) => {
        if (!isValidLabel(reg.labelName)) {
          logger.skippingInvalidName(reg.labelName || "unknown");
          invalidLabelsInBatch++;
          checkpoint!.invalidLabelCount++;
          checkpoint!.totalProcessed++;
          lastInvalidLineNumber = reg.lineNumber;
          return false;
        }
        return true;
      });

      if (invalidLabelsInBatch > 0) {
        checkpoint.lastProcessedLineNumber = lastInvalidLineNumber;
        if (!config.disableCheckpoint) {
          saveCheckpoint(checkpoint);
        }
      }

      logger.info(
        `\nRead ${batch.length} names from CSV (${invalidLabelsInBatch} invalid labels filtered). ` +
          `Starting reservation of ${validBatch.length} valid names...`,
      );

      if (validBatch.length > 0) {
        checkpoint = await processBatch(
          config,
          validBatch,
          client,
          mainnetClient,
          registry,
          batchRegistrar,
          checkpoint,
          registryAbi,
          maxGas,
        );
      }

      logger.info(
        `Batch complete. Total: ${checkpoint.totalProcessed} processed ` +
          `(${checkpoint.successCount} reserved, ${checkpoint.renewedCount} renewed, ` +
          `${checkpoint.skippedCount} skipped, ${checkpoint.invalidLabelCount} invalid, ` +
          `${checkpoint.failureCount} failed)`,
      );

      if (config.limit && checkpoint.totalProcessed >= config.limit) {
        logger.info(`\nReached limit of ${config.limit} names. Stopping.`);
        break;
      }
    } catch (error) {
      logger.error(`Failed to process batch: ${error}`);
      throw error;
    }
  }

  printFinalSummary(checkpoint);
}

export interface VerificationResult {
  registration: ENSRegistration;
  v2Status: number;
  v2LatestOwner: string;
  /// Whether the original v1 owner still has renewal rights — i.e., the name
  /// is currently registered or within the v1 90-day grace period. Names that
  /// pass this gate are candidates for migration; the v2 expiry is computed
  /// separately by adding the configurable `--bonus-period-days`.
  v1IsClaimable: boolean;
  v1Expiry: bigint;
  error?: string;
}

export async function batchVerifyRegistrations(
  registrations: ENSRegistration[],
  client: any,
  mainnetClient: any,
  registryAddress: Address,
  registryAbi: any[],
  v1BaseRegistrarAddress: Address,
): Promise<VerificationResult[]> {
  const v2Contracts = registrations.map((r) => ({
    address: registryAddress,
    abi: registryAbi,
    functionName: "getState" as const,
    args: [BigInt(keccak256(toHex(r.labelName)))],
  }));

  const v1Contracts = registrations.map((r) => ({
    address: v1BaseRegistrarAddress,
    abi: BASE_REGISTRAR_ABI,
    functionName: "nameExpires" as const,
    args: [keccak256(toHex(r.labelName))],
  }));

  const [v2Settled, v1Settled] = await Promise.allSettled([
    client.multicall({ contracts: v2Contracts }),
    mainnetClient.multicall({ contracts: v1Contracts }),
  ]);

  const buildFallback = (reason: unknown) =>
    registrations.map(() => ({ status: "failure" as const, error: reason }));

  if (v2Settled.status === "rejected") {
    logger.warning(
      `v2 multicall failed for batch of ${registrations.length}: ${v2Settled.reason}`,
    );
  }
  if (v1Settled.status === "rejected") {
    logger.warning(
      `v1 multicall failed for batch of ${registrations.length}: ${v1Settled.reason}`,
    );
  }

  const v2Results =
    v2Settled.status === "fulfilled"
      ? v2Settled.value
      : buildFallback(v2Settled.reason);
  const v1Results =
    v1Settled.status === "fulfilled"
      ? v1Settled.value
      : buildFallback(v1Settled.reason);

  const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));

  return registrations.map((reg, i) => {
    const v2 = (v2Results as any[])[i];
    const v1 = (v1Results as any[])[i];

    if (v2.status === "failure" || v1.status === "failure") {
      return {
        registration: reg,
        v2Status: -1,
        v2LatestOwner: zeroAddress,
        v1IsClaimable: false,
        v1Expiry: 0n,
        error: v2.status === "failure" ? String(v2.error) : String(v1.error),
      };
    }

    const expiry = v1.result as bigint;
    return {
      registration: reg,
      v2Status: (v2.result as any).status,
      v2LatestOwner: (v2.result as any).latestOwner,
      v1IsClaimable:
        expiry > 0n && expiry + V1_GRACE_PERIOD_SECONDS > currentTimestamp,
      v1Expiry: expiry,
    };
  });
}

interface BatchSubmitResult {
  succeeded: { label: string; txHash: string }[];
  failed: { label: string; error: string }[];
}

async function submitBatchWithBinaryFallback(
  batchRegistrar: any,
  client: any,
  resolver: Address,
  labels: string[],
  expires: bigint[],
): Promise<BatchSubmitResult> {
  try {
    const hash = await batchRegistrar.write.batchRegister([
      zeroAddress,
      resolver,
      labels,
      expires,
    ]);
    await waitForSuccessfulTransactionReceipt(client, { hash });
    return {
      succeeded: labels.map((l) => ({ label: l, txHash: hash })),
      failed: [],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (labels.length <= 1) {
      return {
        succeeded: [],
        failed: [{ label: labels[0], error: errorMsg }],
      };
    }

    const mid = Math.ceil(labels.length / 2);
    logger.warning(
      `Batch of ${labels.length} failed: ${errorMsg}. Splitting into ${mid} + ${labels.length - mid}...`,
    );

    const leftResult = await submitBatchWithBinaryFallback(
      batchRegistrar,
      client,
      resolver,
      labels.slice(0, mid),
      expires.slice(0, mid),
    );
    const rightResult = await submitBatchWithBinaryFallback(
      batchRegistrar,
      client,
      resolver,
      labels.slice(mid),
      expires.slice(mid),
    );

    return {
      succeeded: [...leftResult.succeeded, ...rightResult.succeeded],
      failed: [...leftResult.failed, ...rightResult.failed],
    };
  }
}

const GAS_LIMIT_SAFETY_FACTOR = 0.8;

async function estimateAndSplitBatch(
  batchRegistrar: any,
  client: any,
  resolver: Address,
  labels: string[],
  expires: bigint[],
  maxGas: bigint,
): Promise<BatchSubmitResult> {
  try {
    const estimatedGas = await batchRegistrar.estimateGas.batchRegister([
      zeroAddress,
      resolver,
      labels,
      expires,
    ]);

    if (estimatedGas <= maxGas) {
      return await submitBatchWithBinaryFallback(
        batchRegistrar,
        client,
        resolver,
        labels,
        expires,
      );
    }

    if (labels.length <= 1) {
      const msg = `single registration exceeds gas limit (${estimatedGas} > ${maxGas})`;
      logger.warning(`Label ${labels[0]}: ${msg}`);
      return {
        succeeded: [],
        failed: [{ label: labels[0], error: msg }],
      };
    }

    logger.warning(
      `Batch of ${labels.length} estimated at ${estimatedGas} gas (limit: ${maxGas}). Splitting...`,
    );
    const mid = Math.ceil(labels.length / 2);
    const leftResult = await estimateAndSplitBatch(
      batchRegistrar,
      client,
      resolver,
      labels.slice(0, mid),
      expires.slice(0, mid),
      maxGas,
    );
    const rightResult = await estimateAndSplitBatch(
      batchRegistrar,
      client,
      resolver,
      labels.slice(mid),
      expires.slice(mid),
      maxGas,
    );
    return {
      succeeded: [...leftResult.succeeded, ...rightResult.succeeded],
      failed: [...leftResult.failed, ...rightResult.failed],
    };
  } catch (estimateError) {
    logger.warning(
      `Gas estimation failed for batch of ${labels.length}, using binary-search fallback`,
    );
    return await submitBatchWithBinaryFallback(
      batchRegistrar,
      client,
      resolver,
      labels,
      expires,
    );
  }
}

async function processBatch(
  config: PreMigrationConfig,
  registrations: ENSRegistration[],
  client: any,
  mainnetClient: any,
  registry: any,
  batchRegistrar: any,
  checkpoint: Checkpoint,
  registryAbi: any[],
  maxGas: bigint,
): Promise<Checkpoint> {
  const batchLabels: string[] = [];
  const batchExpires: bigint[] = [];
  const alreadyReservedNames = new Set<string>();
  let lastLineNumber = checkpoint.lastProcessedLineNumber;

  const bonusPeriodSeconds = BigInt(config.bonusPeriodDays) * 86400n;

  const verificationResults = await batchVerifyRegistrations(
    registrations,
    client,
    mainnetClient,
    config.registryAddress,
    registryAbi,
    config.v1BaseRegistrarAddress,
  );

  const baseProcessed = checkpoint.totalProcessed;
  for (let i = 0; i < verificationResults.length; i++) {
    const result = verificationResults[i];
    const registration = result.registration;
    const globalIndex = baseProcessed + i + 1;
    lastLineNumber = registration.lineNumber;

    logger.processingName(
      registration.labelName,
      globalIndex,
      checkpoint.totalExpected,
    );

    if (result.error) {
      logger.failed(registration.labelName, result.error);
      checkpoint.failureCount++;
      checkpoint.totalProcessed++;
      logger.finishedName(registration.labelName, "failed");
      continue;
    }

    if (result.v2Status === 2) {
      logger.error(
        `Name ${registration.labelName}.eth is already registered with owner: ${result.v2LatestOwner}`,
      );
      checkpoint.alreadyRegisteredCount++;
      checkpoint.totalProcessed++;
      logger.finishedName(registration.labelName, "failed");
      continue;
    }
    if (result.v2Status === 1) {
      alreadyReservedNames.add(registration.labelName);
    }

    if (!result.v1IsClaimable) {
      const neverRegistered = result.v1Expiry === 0n;
      const reason = neverRegistered
        ? "never registered on v1"
        : `past v1 ${V1_GRACE_PERIOD_DAYS}-day grace period`;
      logger.v1NotRegistered(registration.labelName, reason);
      checkpoint.skippedCount++;
      if (neverRegistered) {
        checkpoint.skippedNeverRegisteredCount++;
      } else {
        checkpoint.skippedPastGraceCount++;
      }
      checkpoint.totalProcessed++;
      logger.finishedName(registration.labelName, "skipped");
      continue;
    }

    const effectiveExpiry = bonusAdjustedExpiry(
      result.v1Expiry,
      bonusPeriodSeconds,
    );

    logger.v1Verified(registration.labelName, formatExpiry(effectiveExpiry));

    batchLabels.push(registration.labelName);
    batchExpires.push(effectiveExpiry);
  }

  if (batchLabels.length > 0 && !config.dryRun) {
    logger.info(`\n → Batch reserving ${batchLabels.length} names...\n`);

    const result = await estimateAndSplitBatch(
      batchRegistrar,
      client,
      config.v1ResolverAddress,
      batchLabels,
      batchExpires,
      maxGas,
    );

    for (const { label, txHash } of result.succeeded) {
      checkpoint.totalProcessed++;
      if (alreadyReservedNames.has(label)) {
        checkpoint.renewedCount++;
        logger.renewed(txHash);
        logger.finishedName(label, "renewed");
      } else {
        checkpoint.successCount++;
        logger.reserved(txHash);
        logger.finishedName(label, "reserved");
      }
    }

    for (const { label, error } of result.failed) {
      logger.failed(label, error);
      checkpoint.totalProcessed++;
      checkpoint.failureCount++;
      logger.finishedName(label, "failed");
    }
  } else if (batchLabels.length > 0 && config.dryRun) {
    logger.info(`\nDry run: Would batch reserve ${batchLabels.length} names`);

    for (const label of batchLabels) {
      logger.dryRun();
      checkpoint.totalProcessed++;
      if (alreadyReservedNames.has(label)) {
        checkpoint.renewedCount++;
        logger.finishedName(label, "renewed");
      } else {
        checkpoint.successCount++;
        logger.finishedName(label, "reserved");
      }
    }
  }

  checkpoint.lastProcessedLineNumber = lastLineNumber;
  checkpoint.timestamp = new Date().toISOString();

  if (!config.disableCheckpoint) {
    saveCheckpoint(checkpoint);
  }

  return checkpoint;
}

function calculateSuccessRate(
  successCount: number,
  totalAttempts: number,
): number {
  return totalAttempts > 0
    ? Math.round((successCount / totalAttempts) * 100)
    : 0;
}

function printFinalSummary(checkpoint: Checkpoint): void {
  const actualRegistrations =
    checkpoint.successCount + checkpoint.renewedCount + checkpoint.failureCount;

  logger.info("");
  logger.divider();
  logger.header("Pre-Migration Complete");
  logger.divider();

  logger.config("Total names processed", checkpoint.totalProcessed);
  logger.config(
    "Successfully reserved",
    green(checkpoint.successCount.toString()),
  );
  logger.config(
    "Successfully renewed",
    cyan(checkpoint.renewedCount.toString()),
  );
  logger.config(
    "Skipped (not claimable on v1)",
    yellow(checkpoint.skippedCount.toString()),
  );
  logger.config(
    "  → never registered on v1",
    yellow(checkpoint.skippedNeverRegisteredCount.toString()),
  );
  logger.config(
    "  → expired past v1 grace period",
    yellow(checkpoint.skippedPastGraceCount.toString()),
  );
  logger.config(
    "Already registered on v2",
    yellow(checkpoint.alreadyRegisteredCount.toString()),
  );
  logger.config(
    "Invalid labels",
    yellow(checkpoint.invalidLabelCount.toString()),
  );
  logger.config(
    "Failed (other errors)",
    checkpoint.failureCount > 0
      ? red(checkpoint.failureCount.toString())
      : checkpoint.failureCount,
  );
  logger.config("Actual reservations/renewals attempted", actualRegistrations);

  const rate = calculateSuccessRate(
    checkpoint.successCount + checkpoint.renewedCount,
    actualRegistrations,
  );
  if (actualRegistrations > 0) {
    logger.config("Success rate", `${rate}%`);
  }

  logger.divider();

  if (checkpoint.failureCount > 0) {
    logger.warning(
      `\nSome registrations failed. Check ${ERROR_LOG_FILE} for details.`,
    );
  }
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command()
    .name("premigrate")
    .description(
      "Pre-migrate ENS .eth 2LDs from v1 to v2 on Ethereum mainnet. By default starts fresh. Use --continue to resume from checkpoint.",
    )
    .requiredOption("--rpc-url <url>", "Ethereum mainnet RPC endpoint")
    .requiredOption("--registry <address>", "v2 ETH Registry contract address")
    .requiredOption(
      "--batch-registrar <address>",
      "Pre-deployed BatchRegistrar contract address",
    )
    .option(
      "--private-key <key>",
      "Deployer private key (default: PREMIGRATION_PRIVATE_KEY env var)",
    )
    .option(
      "--account <address>",
      "Impersonated or unlocked BatchRegistrar owner account",
    )
    .requiredOption(
      "--csv-file <path>",
      "Path to CSV file containing ENS registrations",
    )
    .option(
      "--mainnet-rpc-url <url>",
      "Mainnet RPC endpoint for v1 verification (default: public endpoint)",
      "https://eth.drpc.org",
    )
    .option(
      "--batch-size <number>",
      "Number of names to process per batch",
      "50",
    )
    .option(
      "--start-index <number>",
      "Starting index for resuming partial migrations",
      "-1",
    )
    .option(
      "--limit <number>",
      "Maximum total number of names to process and register",
    )
    .option("--dry-run", "Simulate without executing transactions", false)
    .option(
      "--continue",
      "Continue from previous checkpoint if it exists",
      false,
    )
    .option(
      "--bonus-period-days <days>",
      "Days added to each name's v1 expiry to compute its v2 expiry",
      "62",
    )
    .requiredOption(
      "--v1-resolver <address>",
      "ENSV1Resolver address deployed on v2 for fallback resolution",
    )
    .option(
      "--v1-base-registrar <address>",
      "V1 BaseRegistrar address for expiry lookups",
      BASE_REGISTRAR_ADDRESS,
    );

  program.parse(argv);
  const opts = program.opts();

  const privateKey = (opts.privateKey ??
    process.env.PREMIGRATION_PRIVATE_KEY) as `0x${string}` | undefined;
  const account = opts.account as Address | undefined;
  if (!privateKey && !account) {
    console.error(
      "Error: signer must be provided via --private-key, PREMIGRATION_PRIVATE_KEY, or --account",
    );
    process.exit(1);
  }

  const config: PreMigrationConfig = {
    rpcUrl: opts.rpcUrl,
    mainnetRpcUrl: opts.mainnetRpcUrl,
    registryAddress: opts.registry as Address,
    batchRegistrarAddress: opts.batchRegistrar as Address,
    privateKey,
    account,
    csvFilePath: opts.csvFile,
    batchSize: parseInt(opts.batchSize) || 100,
    startIndex: parseInt(opts.startIndex) || 0,
    limit: opts.limit ? parseInt(opts.limit) : null,
    dryRun: opts.dryRun,
    continue: opts.continue,
    bonusPeriodDays: Number.isNaN(parseInt(opts.bonusPeriodDays))
      ? 62
      : parseInt(opts.bonusPeriodDays),
    v1ResolverAddress: opts.v1Resolver as Address,
    v1BaseRegistrarAddress: opts.v1BaseRegistrar as Address,
  };

  try {
    logger.header("ENS Pre-Migration Script");
    logger.divider();

    logger.info(`Configuration:`);
    logger.config("RPC URL", config.rpcUrl);
    logger.config("Registry", config.registryAddress);
    logger.config("BatchRegistrar", config.batchRegistrarAddress);
    logger.config(
      "Signer Account",
      config.account ??
        (opts.privateKey ? "private key (CLI)" : "private key (env)"),
    );
    logger.config("Mainnet RPC (v1)", config.mainnetRpcUrl);
    logger.config("CSV File", config.csvFilePath);
    logger.config("Batch Size", config.batchSize);
    logger.config("Bonus Period Days", config.bonusPeriodDays);
    logger.config(
      "V1 Grace Period Days (hard-coded)",
      Number(V1_GRACE_PERIOD_DAYS),
    );
    logger.config("V1 Resolver", config.v1ResolverAddress);
    logger.config("Limit", config.limit ?? "none");
    logger.config("Dry Run", config.dryRun);
    logger.config("Continue Mode", config.continue ?? false);

    let checkpoint = createFreshCheckpoint();
    if (config.continue) {
      const cp = loadCheckpoint();
      if (cp) {
        checkpoint = cp;
        config.startIndex = cp.lastProcessedLineNumber;
        logger.config(
          "Checkpoint Found",
          `${cp.totalProcessed} processed (${cp.successCount} reserved, ${cp.renewedCount} renewed, ${cp.skippedCount} skipped, ${cp.invalidLabelCount} invalid, ${cp.failureCount} failed) (last line: ${cp.lastProcessedLineNumber})`,
        );
        logger.info(`Resuming from CSV line ${config.startIndex}`);
      }
    } else if (!config.disableCheckpoint) {
      clearCheckpoint();
    }
    logger.info("");

    await fetchAndReserveInBatches(config, checkpoint);

    logger.success("\nPre-migration script completed successfully!");
  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    console.error(error);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
