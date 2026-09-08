#!/usr/bin/env bun

import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContract,
  http,
  keccak256,
  namehash,
  parseAbiItem,
  parseEther,
  stringToHex,
  zeroAddress,
  zeroHash,
  type AbiEvent,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import {
  english as englishWordlist,
  generateMnemonic,
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import type { AccountDefinition, AccountType, UserConfig } from "rocketh/types";
import { Artifact_BaseRegistrarImplementation } from "generated/artifacts/BaseRegistrarImplementation.js";
import { Artifact_BatchRegistrar } from "generated/artifacts/BatchRegistrar.js";
import { Artifact_MockERC20 } from "generated/artifacts/test/mocks/MockERC20.sol/MockERC20.js";
import { Artifact_PermissionedRegistry } from "generated/artifacts/PermissionedRegistry.js";
import { Artifact_StandardRentPriceOracle } from "generated/artifacts/StandardRentPriceOracle.js";
import { Artifact_UniversalResolverV2 } from "generated/artifacts/UniversalResolverV2.js";
import { Artifact_UpgradableUniversalResolverProxy } from "generated/artifacts/UpgradableUniversalResolverProxy.js";
import { isHCAOnlyDeployment } from "../deploy/hca/_helpers.js";
import { config as rockethConfig } from "../rocketh/config.js";
import { loadAndExecuteDeploymentsFromFilesWithConfig } from "../rocketh/environment.js";
import { generateAddressMarkdown } from "./addressDocs.js";
import {
  DEPLOYED_UNIVERSAL_RESOLVER_PROXY,
  DEPLOYMENT_ROLES,
  FUSES,
  LOCAL_BATCH_GATEWAY_URL,
  MAINNET_DAI,
  MAINNET_USDC,
  ROLES,
  SEC_PER_DAY,
  STATUS,
} from "./deploy-constants.js";
import {
  main as exportRegistrationsMain,
  parseENSRegistrationNetwork,
} from "./exportTheGraphRegistrations.js";
import {
  addFixtureSubcommands,
  runFixtureSeedStage,
} from "./migrationFixture.js";
import { ACTOR_ALIASES, bufferedGas } from "./migrationFixture/config.js";
import { resolveRegistrarControlRoute } from "./registrarControl.js";
import {
  CHECKPOINT_FILE,
  type Checkpoint,
  createFreshCheckpoint,
  isValidLabel,
  loadCheckpoint,
  main as preMigrationMain,
  parseCSVLine,
  bonusAdjustedExpiry,
  V1_GRACE_PERIOD_SECONDS,
} from "./preMigration.js";
import {
  compareCalldata,
  describeVerdict,
  type CalldataVerdict,
} from "./safeCalldata.js";
import {
  checkPrecondition,
  clearVerification,
  describePreconditionFailure,
  readVerification,
  recordVerification,
} from "./phaseGate.js";
import {
  compareDeployedBytecode,
  describeComparison,
  extractImmutableValues,
  immutableAsAddress,
  type ImmutableReferences,
} from "./bytecodeCheck.js";
import {
  describeDifference,
  diffResolutionSnapshots,
  queriesFromSnapshot,
  recordQueries,
  snapshotCarriesRecords,
  type NameSnapshot,
  type ResolutionSnapshot,
} from "./resolutionSnapshot.js";
import {
  describeRoleBitmap,
  describeRoleFinding,
  diffRoleMatrix,
  type RoleExpectation,
  type RoleHolder,
} from "./roleAudit.js";
import {
  assertCompleteCsv,
  assertIndependentSource,
  assertIndexCoversChainTime,
  buildV1NameIndex,
  buildV1NameIndexFromRpc,
  createRpcIndexClient,
  loadV1NameIndex,
  readV1NameIndexMeta,
} from "./premigrationIndex.js";
import {
  PREMIGRATION_CSV_HEADER,
  premigrationCsvRow,
} from "./preMigrationUtils.js";

const DEFAULT_ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const DEFAULT_ANVIL_DEPLOYER =
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;
const DEFAULT_ANVIL_OWNER =
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const MAINNET_DAO = "0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7" as const;
// The Sepolia ENS v1 BaseRegistrar owner EOA; derived from the `v1Owner` named
// account in rocketh/config.ts so the two values cannot drift apart.
const SEPOLIA_V1_OWNER = getAddress(rockethConfig.accounts.v1Owner.sepolia);

const V1_REGISTRATION_DURATION = 365n * SEC_PER_DAY;
const V2_REGISTRATION_DURATION = 28n * SEC_PER_DAY;
const REGISTRAR_ROLES = ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW;
const RPC_RETRY_COUNT = 3;
/// Transport-level retries for a dropped connection, on top of viem's own
/// JSON-RPC retries, which never see a request that failed to reach the node.
const RPC_TRANSPORT_RETRIES = 5;
const RPC_TRANSPORT_BACKOFF_MS = 250;
const PREMIGRATION_VERIFY_BATCH_SIZE = 250;

const DEFAULT_DEPLOYMENTS_DIR = resolve(import.meta.dirname, "../deployments");
const BUNDLED_V1_DEPLOYMENTS_DIR = resolve(
  import.meta.dirname,
  "../lib/ens-contracts/deployments",
);
const LOCAL_V1_DEPLOYMENTS_DIR = resolve(
  import.meta.dirname,
  "../deployments/v1",
);

const MIGRATION_DEPLOY_TAGS = ["migration:phase1:deploy-v2"] as const;

export const migrationDataComponents = [
  { name: "label", type: "string" },
  { name: "owner", type: "address" },
  { name: "subregistry", type: "address" },
  { name: "resolver", type: "address" },
] as const;

export type MigrationNetwork = "sepolia" | "mainnet";

type RpcProvider = {
  request(args: {
    method: string;
    params?: readonly unknown[] | object;
  }): Promise<unknown>;
};

type JsonDeployment = {
  address: Address;
  abi: readonly any[];
};

type V1DeploymentOptions = {
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
};

type PrivateKeyOptions = {
  deployerPrivateKey?: `0x${string}`;
  ownerPrivateKey?: `0x${string}`;
  v1OwnerPrivateKey?: `0x${string}`;
  urManagerPrivateKey?: `0x${string}`;
};

type NetworkConfig = {
  chain: Chain;
  environment: MigrationNetwork;
  rpcEnv: string;
  defaultForkPort: number;
  defaultOwner: Address;
  defaultV1Owner: Address;
  chainTags: string[];
};

type PreparedOwnerTransaction = {
  account?: string;
  role?: string;
  from?: Address;
  to: Address;
  value?: string;
  data: `0x${string}`;
  phase?: string;
  label?: string;
  functionName?: string;
  deployment?: string;
};

const NETWORKS: Record<MigrationNetwork, NetworkConfig> = {
  sepolia: {
    chain: sepolia,
    environment: "sepolia",
    rpcEnv: "SEPOLIA_RPC_URL",
    defaultForkPort: 8547,
    defaultOwner: DEFAULT_ANVIL_OWNER,
    defaultV1Owner: SEPOLIA_V1_OWNER,
    chainTags: [],
  },
  mainnet: {
    chain: mainnet,
    environment: "mainnet",
    rpcEnv: "MAINNET_RPC_URL",
    defaultForkPort: 8548,
    defaultOwner: MAINNET_DAO,
    defaultV1Owner: MAINNET_DAO,
    chainTags: ["hasDao"],
  },
};

export function parseMigrationNetwork(
  value: string | undefined,
): MigrationNetwork {
  if (value === "mainnet" || value === "sepolia") return value;
  throw new Error(`Unsupported network: ${value ?? "<missing>"}`);
}

function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key] = match;
    if (process.env[key]) continue;
    let value = match[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends where an inline comment begins (whitespace
      // followed by '#'); surrounding whitespace is not part of the value.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[key] = value;
  }
}

function requireRpcUrl(
  opts: { rpcUrl?: string },
  network: MigrationNetwork,
): string {
  const config = NETWORKS[network];
  const rpcUrl = opts.rpcUrl ?? process.env[config.rpcEnv];
  if (!rpcUrl) {
    throw new Error(`Missing --rpc-url or ${config.rpcEnv}`);
  }
  return rpcUrl;
}

function forkChain(
  network: MigrationNetwork,
  chainId: number,
  rpcUrl: string,
): Chain {
  const base = NETWORKS[network].chain;
  return defineChain({
    ...base,
    id: chainId,
    name: chainId === base.id ? base.name : `${base.name} Fork ${chainId}`,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function migrationChain(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
}): Chain {
  return forkChain(
    opts.network,
    parseNumber(opts.chainId, NETWORKS[opts.network].chain.id),
    opts.rpcUrl,
  );
}

function publicClient(rpcUrl: string, chain: Chain, provider?: RpcProvider) {
  return createPublicClient({
    chain,
    transport: provider
      ? custom(provider as any)
      : http(rpcUrl, { retryCount: RPC_RETRY_COUNT }),
  });
}

async function getProviderChainId(provider: RpcProvider): Promise<number> {
  const value = await provider.request({ method: "eth_chainId" });
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(BigInt(value));
  throw new Error(`Unsupported eth_chainId response: ${String(value)}`);
}

type WalletAccount =
  | ReturnType<typeof privateKeyToAccount>
  | ReturnType<typeof mnemonicToAccount>;

// A gas estimate is made against the latest block, but the transaction runs in
// the next one. A call whose cost depends on state the estimate warmed — a price
// oracle read, a balance that changes from zero — can then need more gas than it
// was given and run out part-way. The receipt reports that as a plain failure, so
// a rehearsal aborts with a revert that names no reason. Unused gas is refunded,
// so padding every estimate costs nothing and removes the whole failure class.
const GAS_ESTIMATE_PERCENT = 130n;

function withGasBuffer<T extends (...args: never[]) => Promise<unknown>>(
  request: T,
): T {
  return (async (...args: Parameters<T>) => {
    const result = await request(...args);
    const { method } = args[0] as { method: string };
    if (method !== "eth_estimateGas" || typeof result !== "string") {
      return result;
    }
    return `0x${((BigInt(result) * GAS_ESTIMATE_PERCENT) / 100n).toString(16)}`;
  }) as T;
}

function walletClient({
  rpcUrl,
  chain,
  privateKey,
  account,
  provider,
}: {
  rpcUrl: string;
  chain: Chain;
  privateKey?: `0x${string}`;
  account?: Address | WalletAccount;
  provider?: RpcProvider;
}) {
  const walletAccount = privateKey ? privateKeyToAccount(privateKey) : account;
  if (!walletAccount) {
    throw new Error("A private key or impersonated account is required");
  }
  const base = provider
    ? custom(provider as any)
    : http(rpcUrl, { retryCount: RPC_RETRY_COUNT });
  return createWalletClient({
    account: walletAccount,
    chain,
    // The wrapped transport keeps its own retry policy, so the wrapper adds none
    // of its own — nesting them would multiply the attempts behind every call.
    transport: (config) =>
      custom(
        { request: withGasBuffer(base(config).request) },
        { retryCount: 0 },
      )(config),
  });
}

function loadDeploymentFromRoot(
  root: string,
  environment: string,
  name: string,
): JsonDeployment | null {
  const path = join(root, environment, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as JsonDeployment;
}

function loadV1Deployment(
  network: MigrationNetwork,
  name: string,
  opts: V1DeploymentOptions = {},
): JsonDeployment | null {
  const roots = opts.v1DeploymentsDir
    ? [resolve(opts.v1DeploymentsDir)]
    : [LOCAL_V1_DEPLOYMENTS_DIR, BUNDLED_V1_DEPLOYMENTS_DIR];
  const environment = opts.v1DeploymentNetwork ?? NETWORKS[network].environment;
  for (const root of roots) {
    const deployment = loadDeploymentFromRoot(root, environment, name);
    if (deployment) return deployment;
  }
  return null;
}

function requireV1Deployment(
  network: MigrationNetwork,
  name: string,
  opts: V1DeploymentOptions = {},
): JsonDeployment {
  const deployment = loadV1Deployment(network, name, opts);
  if (!deployment) {
    const environment =
      opts.v1DeploymentNetwork ?? NETWORKS[network].environment;
    throw new Error(`Missing ${environment} v1 deployment: ${name}`);
  }
  return deployment;
}

function loadV2Deployment(
  root: string,
  environment: string,
  name: string,
): JsonDeployment {
  const deployment = loadDeploymentFromRoot(resolve(root), environment, name);
  if (!deployment) {
    throw new Error(
      `Missing v2 deployment: ${resolve(root)}/${environment}/${name}.json`,
    );
  }
  return deployment;
}

function maybeLoadV2Deployment(
  root: string,
  environment: string,
  name: string,
): JsonDeployment | null {
  return loadDeploymentFromRoot(resolve(root), environment, name);
}

function resolveDeploymentAddress(
  explicitAddress: Address | undefined,
  deploymentsDir: string,
  environment: string,
  name: string,
): Address {
  if (explicitAddress) return explicitAddress;
  return loadV2Deployment(deploymentsDir, environment, name).address;
}

function parseNumber(
  value: string | number | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, got: ${JSON.stringify(value)}`);
  }
  return parsed;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function envPrivateKey(...names: string[]): `0x${string}` | undefined {
  return envValue(...names) as `0x${string}` | undefined;
}

function parseResumeFromPhase(value: string | undefined): 2 | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.toLowerCase().replace(/^phase-?/, "");
  if (normalized === "2") return 2;
  throw new Error(`Unsupported --resume-from-phase value: ${value}`);
}

// Locate the label column case-insensitively (matching the premigration run
// parser), accepting either a `labelName` or `label` header. Returns -1 when
// neither is present so callers can fail loudly instead of guessing a column.
// How many CSV rows name a v1 registration that is still claimable at `chainNow`.
//
// The exporter's query has no expiry filter, so a CSV holds every registration the
// subgraph ever indexed. Comparing that raw total against an index of claimable names
// puts two correct sources millions of rows apart and calls it a discrepancy. Where
// the CSV carries expiries the rows are filtered to match; where it does not — a
// hand-made export — the count is reported as unfiltered rather than as comparable.
function countClaimableCsvRows(
  csvFile: string,
  chainNow: bigint,
): { count: number; filtered: boolean; unknownExpiry: number } {
  const lines = readFileSync(csvFile, "utf-8").trim().split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) {
    return { count: 0, filtered: false, unknownExpiry: 0 };
  }
  const fieldsOfHeader = parseCSVLine(lines[0]);
  const labelIndex = csvLabelColumnIndex(fieldsOfHeader);
  const expiryIndex = fieldsOfHeader
    .map((field) => field.trim().toLowerCase())
    .indexOf("expirydate");
  if (labelIndex < 0) {
    throw new Error(`CSV must contain a labelName or label column: ${csvFile}`);
  }

  let labelled = 0;
  let expired = 0;
  let dated = 0;
  for (const line of lines.slice(1)) {
    const fields = parseCSVLine(line);
    if (!fields[labelIndex]?.trim()) continue;
    labelled++;
    if (expiryIndex < 0) continue;
    const raw = fields[expiryIndex]?.trim();
    if (!raw) continue;
    let expiry: bigint;
    try {
      expiry = BigInt(raw);
    } catch {
      continue;
    }
    dated++;
    if (expiry + V1_GRACE_PERIOD_SECONDS <= chainNow) expired++;
  }

  // A row whose expiry the CSV does not carry is of unknown claimability, not
  // expired, so it stays in the count. And a column that is present but empty on
  // every row carries no expiry data at all, whatever the header says.
  return {
    count: labelled - expired,
    filtered: dated > 0,
    unknownExpiry: labelled - dated,
  };
}

function csvLabelColumnIndex(header: string[]): number {
  const normalized = header.map((field) => field.trim().toLowerCase());
  const labelNameIndex = normalized.indexOf("labelname");
  if (labelNameIndex >= 0) return labelNameIndex;
  return normalized.indexOf("label");
}

function readLabelsFromCsv(csvFile: string, limit?: number): string[] {
  const lines = readFileSync(csvFile, "utf-8").trim().split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) return [];
  const header = parseCSVLine(lines[0]);
  const labelIndex = csvLabelColumnIndex(header);
  if (labelIndex < 0) {
    throw new Error(`CSV must contain a labelName or label column: ${csvFile}`);
  }
  const labels: string[] = [];
  for (const line of lines.slice(1)) {
    if (limit !== undefined && labels.length >= limit) break;
    const label = parseCSVLine(line)[labelIndex]?.trim();
    if (label) labels.push(label);
  }
  return labels;
}

function transformCsvForPreMigration(
  sourcePath: string,
  targetPath: string,
): number {
  const lines = readFileSync(sourcePath, "utf-8").trim().split(/\r?\n/);
  if (lines.length === 0) throw new Error(`CSV is empty: ${sourcePath}`);

  const sourceHeader = parseCSVLine(lines[0]);
  const labelIndex = csvLabelColumnIndex(sourceHeader);
  if (labelIndex < 0) {
    throw new Error(
      `CSV must contain either a labelName or label column: ${sourcePath}`,
    );
  }

  const output = [PREMIGRATION_CSV_HEADER];
  for (const line of lines.slice(1)) {
    const columns = parseCSVLine(line);
    const label = columns[labelIndex]?.trim();
    if (label) output.push(premigrationCsvRow(label));
  }
  writeFileSync(targetPath, `${output.join("\n")}\n`);
  return output.length - 1;
}

function prependCsvLabels(csvFile: string, labels: string[]): void {
  const lines = readFileSync(csvFile, "utf-8").trimEnd().split(/\r?\n/);
  const [header, ...rows] = lines;
  const added = labels.map(premigrationCsvRow);
  writeFileSync(csvFile, `${[header, ...added, ...rows].join("\n")}\n`);
}

/// The smoke names phase 2 reserves, which later phases migrate and re-register.
type ReservedSmokeLabels = {
  migrate: string;
  reservedOnly: string;
  migrateWrapped: string;
};

/// Reads back the reserved smoke names an earlier run chose.
///
/// They cannot be recovered from the CSV: its leading rows belong to whatever
/// was prepended last, which is the fixture corpus whenever one seeds.
function readReservedSmokeLabels(path: string): ReservedSmokeLabels {
  if (!existsSync(path)) {
    throw new Error(
      `cannot resume phase 2 without the smoke labels the earlier run recorded: ${path}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ReservedSmokeLabels;
}

function labelId(label: string): bigint {
  return BigInt(keccak256(stringToHex(label)));
}

async function requestAny(
  client: RpcProvider,
  requests: Array<{ method: string; params: unknown[] }>,
) {
  let lastError: unknown;
  for (const request of requests) {
    try {
      return await client.request({
        method: request.method as any,
        params: request.params as any,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function increaseTime(
  client: ReturnType<typeof publicClient>,
  seconds: bigint,
) {
  await requestAny(client, [
    { method: "anvil_increaseTime", params: [Number(seconds)] },
    { method: "evm_increaseTime", params: [Number(seconds)] },
  ]);
  await requestAny(client, [
    { method: "anvil_mine", params: [1] },
    { method: "evm_mine", params: [] },
  ]);
}

async function waitForCommitmentAge(
  client: ReturnType<typeof publicClient>,
  seconds: bigint,
  useRpcStateControls: boolean,
) {
  if (useRpcStateControls) {
    await increaseTime(client, seconds);
    return;
  }
  const startTimestamp = (await client.getBlock()).timestamp;
  const targetTimestamp = startTimestamp + seconds + 15n;
  console.log(
    `waiting for commitment age until block timestamp ${targetTimestamp}`,
  );
  for (;;) {
    const currentTimestamp = (await client.getBlock()).timestamp;
    if (currentTimestamp >= targetTimestamp) return;
    const remainingSeconds = targetTimestamp - currentTimestamp;
    const delaySeconds = remainingSeconds < 12n ? remainingSeconds : 12n;
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, Number(delaySeconds) * 1000),
    );
  }
}

async function setBalance(client: RpcProvider, address: Address) {
  const balance = `0x${parseEther("100").toString(16)}`;
  await requestAny(client, [
    { method: "anvil_setBalance", params: [address, balance] },
    { method: "hardhat_setBalance", params: [address, balance] },
    { method: "tenderly_setBalance", params: [address, balance] },
    { method: "tenderly_setBalance", params: [[address], balance] },
  ]);
}

// An EIP-7702 delegation designator makes an EOA run its delegate's code on every
// call. The delegates found on widely-known public test keys do not return the
// ERC-1155 acceptance value, so any token mint or safe transfer to such an account
// reverts. A fork of a live chain inherits whatever delegations exist there, which
// silently breaks the registry writes that hand a migration signer its root names
// and roles. Clearing the code restores a plain EOA, which skips the acceptance
// callback entirely. Reading the designator rather than matching known addresses
// keeps this working as delegates are rotated.
const EIP7702_DESIGNATOR_PREFIX = "0xef0100";

async function clearAccountDelegations(
  client: ReturnType<typeof publicClient>,
  accounts: Array<{ address: Address; label: string }>,
) {
  const seen = new Set<string>();
  for (const { address, label } of accounts) {
    const key = getAddress(address);
    if (seen.has(key)) continue;
    seen.add(key);
    const code = await client.getCode({ address });
    if (!code || !code.toLowerCase().startsWith(EIP7702_DESIGNATOR_PREFIX))
      continue;
    try {
      await requestAny(client, [
        { method: "anvil_setCode", params: [address, "0x"] },
        { method: "hardhat_setCode", params: [address, "0x"] },
        { method: "tenderly_setCode", params: [address, "0x"] },
      ]);
    } catch (error) {
      console.log(
        `warning: ${label} ${address} carries an EIP-7702 delegation that could not be cleared (${errorMessageChain(error)[0]}); token mints to it will revert`,
      );
      continue;
    }
    console.log(`cleared EIP-7702 delegation on ${label} ${address}`);
  }
}

async function impersonate(client: RpcProvider, address: Address) {
  await requestAny(client, [
    { method: "anvil_impersonateAccount", params: [address] },
    { method: "hardhat_impersonateAccount", params: [address] },
    { method: "tenderly_impersonateAccount", params: [address] },
    { method: "tenderly_impersonateAccount", params: [[address]] },
  ]);
  await setBalance(client, address);
}

async function waitForRpc(rpcUrl: string, chain: Chain): Promise<void> {
  const client = publicClient(rpcUrl, chain);
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      await client.getChainId();
      return;
    } catch {
      try {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
        });
        const payload = await response.json();
        if (typeof payload?.result === "string") return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for RPC at ${rpcUrl}`);
}

function buildFeeHistoryResult(params: any) {
  const blockCount = Number(BigInt(params?.[0] ?? "0x1"));
  const percentiles = params?.[2] ?? [];
  return {
    oldestBlock: "0x1",
    baseFeePerGas: Array.from({ length: blockCount + 1 }, () => "0x1"),
    gasUsedRatio: Array.from({ length: blockCount }, () => 0),
    reward: Array.from({ length: blockCount }, () =>
      Array.from({ length: percentiles.length }, () => "0x1"),
    ),
  };
}

function buildFeeHistoryResponse(request: any) {
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: buildFeeHistoryResult(request.params),
  };
}

function isMissingFeeHistory(error: any): boolean {
  const message = String(error?.details ?? error?.message ?? "");
  return (
    error?.code === -32601 ||
    error?.code === -32001 ||
    message.includes("eth_feeHistory") ||
    message.includes("Method not found") ||
    message.includes("method not found") ||
    message === "not found"
  );
}

function withRpcCompatibility(
  provider: RpcProvider,
  debugRpc = false,
): RpcProvider {
  return {
    async request(args) {
      try {
        return await provider.request(args);
      } catch (error) {
        if (args.method === "eth_feeHistory" && isMissingFeeHistory(error)) {
          return buildFeeHistoryResult(
            Array.isArray(args.params) ? args.params : [],
          );
        }
        if (debugRpc) {
          console.error(`rpc error from ${args.method}:`, error);
        }
        throw error;
      }
    },
  };
}

function httpRpcProvider(rpcUrl: string): RpcProvider {
  let id = 0;
  return {
    async request(args) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: args.method,
          params: args.params ?? [],
        }),
      });
      const payload = (await response.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (payload.error) {
        const error = new Error(
          payload.error.message ?? "JSON-RPC error",
        ) as Error & {
          code?: number;
          data?: unknown;
        };
        error.code = payload.error.code;
        error.data = payload.error.data;
        throw error;
      }
      return payload.result;
    },
  };
}

function privateKeyRpcProvider({
  rpcUrl,
  chain,
  privateKey,
}: {
  rpcUrl: string;
  chain: Chain;
  privateKey: `0x${string}`;
}): RpcProvider {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { retryCount: RPC_RETRY_COUNT }),
  });
  const fallback = httpRpcProvider(rpcUrl);
  const normalizeTransaction = (transaction: any) => {
    if (transaction.type === "0x2") {
      return { ...transaction, type: "eip1559" };
    }
    if (transaction.maxFeePerGas || transaction.maxPriorityFeePerGas) {
      const { gasPrice: _gasPrice, type: _type, ...rest } = transaction;
      return { ...rest, type: "eip1559" };
    }
    return transaction;
  };
  return {
    async request(args) {
      if (args.method === "eth_accounts")
        return [account.address.toLowerCase()];
      if (args.method === "eth_sendTransaction") {
        const [transaction] = (args.params ?? []) as [any];
        return await client.sendTransaction(normalizeTransaction(transaction));
      }
      if (args.method === "eth_signTransaction") {
        const [transaction] = (args.params ?? []) as [any];
        return await client.signTransaction(normalizeTransaction(transaction));
      }
      return fallback.request(args);
    },
  };
}

function privateKeySignerProtocol(rpcUrl: string, chain: Chain) {
  return async (protocolString: string) => {
    const privateKey = protocolString.slice(
      "privateKey:".length,
    ) as `0x${string}`;
    return {
      type: "remote" as const,
      signer: privateKeyRpcProvider({ rpcUrl, chain, privateKey }) as any,
    } as any;
  };
}

function impersonatedAccountProvider(
  provider: RpcProvider,
  address: Address,
): RpcProvider {
  return {
    async request(args) {
      if (args.method === "eth_accounts") return [address];
      return provider.request(args);
    },
  };
}

function impersonationProvider(opts: DeployV2Options): RpcProvider | undefined {
  if (opts.rpcUrl) {
    return withRpcCompatibility(
      httpRpcProvider(opts.rpcUrl),
      Boolean(opts.debugRpc),
    );
  }
  if (!opts.provider) return undefined;
  return opts.rpcCompatibility
    ? withRpcCompatibility(opts.provider, Boolean(opts.debugRpc))
    : opts.provider;
}

export async function createRpcSnapshot(
  provider: RpcProvider,
): Promise<string> {
  const snapshotId = await provider.request({
    method: "evm_snapshot",
    params: [],
  });
  if (typeof snapshotId !== "string") {
    throw new Error(`unexpected evm_snapshot response: ${String(snapshotId)}`);
  }
  return snapshotId;
}

export function saveRpcSnapshotFile(
  path: string,
  snapshotId: string,
  network: string,
) {
  const filePath = resolve(path);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        network,
        snapshotId,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/// Reads outside the `eth_get*` family that a dropped connection can re-issue.
const RETRYABLE_RPC_METHODS = new Set([
  "eth_accounts",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_protocolVersion",
  "eth_syncing",
  "net_listening",
  "net_version",
  "web3_clientVersion",
]);

/// Whether re-issuing a request cannot change the chain.
///
/// Reads are recognised explicitly so a method nobody has classified is left
/// alone rather than replayed on a guess. Transaction submission is the case
/// this exists to exclude: a node-signed send carries no client nonce, so a
/// replay lands a second, distinct transaction rather than being rejected as a
/// duplicate. The state controls are equally unsafe — replaying a clock
/// increment advances it twice — and a batch is an array whose members cannot be
/// judged from the envelope.
export function isRetryableRpcRequest(request: any): boolean {
  if (!request || Array.isArray(request)) return false;
  const method = request.method;
  return (
    typeof method === "string" &&
    (method.startsWith("eth_get") || RETRYABLE_RPC_METHODS.has(method))
  );
}

/// Retries a fetch that never produced a response.
///
/// A long deploy issues thousands of RPC calls, and a single dropped connection
/// would otherwise abort it partway through — leaving a half-deployed namespace
/// that cannot be resumed. Only transport failures are retried: an HTTP response
/// of any status is returned untouched, so JSON-RPC errors keep their existing
/// handling.
///
/// Only idempotent requests are retried. Replaying a send would be unsafe, and
/// would not help either: a node that accepted the first submission rejects the
/// second as already known, so the run aborts whether or not it is retried.
async function fetchWithTransportRetry(
  originalFetch: typeof globalThis.fetch,
  input: any,
  init: any,
  request: any,
): Promise<Response> {
  const attempts = isRetryableRpcRequest(request) ? RPC_TRANSPORT_RETRIES : 0;
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await originalFetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const backoff = RPC_TRANSPORT_BACKOFF_MS * 2 ** attempt;
      await sleep(backoff + Math.floor(Math.random() * backoff));
    }
  }
  throw lastError;
}

/**
 * Permanently monkey-patches `globalThis.fetch` to add JSON-RPC compatibility
 * fallbacks for HTTP traffic issued by libraries we do not control (rocketh/viem
 * internals): when an RPC lacks `eth_feeHistory` and returns an error, a synthetic
 * fee-history response is fabricated so EIP-1559 fee estimation can proceed. With
 * `debugRpc` enabled, JSON-RPC error payloads are also logged. The patch is
 * process-wide, never uninstalled, and otherwise passes responses through untouched.
 */
function installRpcCompatibility(debugRpc: boolean): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const request = (() => {
      if (typeof init?.body !== "string") return null;
      try {
        return JSON.parse(init.body);
      } catch {
        return null;
      }
    })();
    const response = await fetchWithTransportRetry(
      originalFetch,
      input,
      init,
      request,
    );
    try {
      const payload = await response.clone().json();
      if (
        request?.method === "eth_feeHistory" &&
        isMissingFeeHistory(payload?.error)
      ) {
        return new Response(JSON.stringify(buildFeeHistoryResponse(request)), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (debugRpc && payload?.error) {
        console.error(
          `rpc error from ${request?.method ?? "unknown"}:`,
          payload.error,
        );
      }
    } catch {
      // Non-JSON responses are unrelated to JSON-RPC compatibility handling.
    }
    return response;
  };
}

function isLocalRpcUrl(rpcUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/i.test(rpcUrl);
}

// Tenderly virtual testnets expose state-control RPC methods (impersonation, time
// travel, setBalance) just like a local node, so they can run the rehearsal
// without configured signer keys.
export function isTenderlyVirtualRpc(rpcUrl: string): boolean {
  try {
    const hostname = new URL(rpcUrl).hostname.toLowerCase();
    return (
      hostname.startsWith("virtual.") && hostname.endsWith(".rpc.tenderly.co")
    );
  } catch {
    return false;
  }
}

function printPreparedCall(
  label: string,
  target: Address,
  data: `0x${string}`,
): void {
  console.log(`${label}`);
  console.log(`  to:   ${target}`);
  console.log(`  data: ${data}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePreparedOwnerTransaction(
  value: unknown,
  lineNumber: number,
): PreparedOwnerTransaction {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid owner tx on line ${lineNumber}: expected object`);
  }
  const input = value as Record<string, unknown>;
  const to = optionalString(input.to);
  const data = optionalString(input.data);
  if (!to)
    throw new Error(`Invalid owner tx on line ${lineNumber}: missing to`);
  if (!data?.startsWith("0x")) {
    throw new Error(`Invalid owner tx on line ${lineNumber}: missing calldata`);
  }

  const rawValue = input.value;
  return {
    account: optionalString(input.account),
    role: optionalString(input.role),
    from: input.from ? getAddress(String(input.from)) : undefined,
    to: getAddress(to),
    value: rawValue === undefined ? undefined : String(rawValue),
    data: data as `0x${string}`,
    phase: optionalString(input.phase),
    label: optionalString(input.label),
    functionName: optionalString(input.functionName),
    deployment: optionalString(input.deployment),
  };
}

function readPreparedOwnerTransactions(
  file: string,
  role?: string,
): PreparedOwnerTransaction[] {
  const roleFilter = role?.toLowerCase();
  return readFileSync(resolve(file), "utf-8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) =>
      parsePreparedOwnerTransaction(JSON.parse(line), lineNumber),
    )
    .filter((tx) => {
      if (!roleFilter) return true;
      return [tx.role, tx.account]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase() === roleFilter);
    });
}

function preparedOwnerTransactionRole(tx: PreparedOwnerTransaction): string {
  return tx.role ?? tx.account ?? "owner";
}

function preparedOwnerTransactionLabel(tx: PreparedOwnerTransaction): string {
  const action = tx.label ?? tx.functionName ?? tx.deployment ?? "transaction";
  return [tx.phase, action].filter(Boolean).join(": ");
}

// Role-specific env-var prefixes for prepared owner transactions. Roles not listed
// here fall back to OWNER_TX_ENV_DEFAULT_PREFIXES. Role names are matched after
// lowercasing and stripping dashes (e.g. "v1-owner" -> "v1owner").
const OWNER_TX_ENV_PREFIXES: Record<string, readonly string[]> = {
  v1owner: ["SEPOLIA_V1_OWNER", "V1_OWNER"],
  sepoliatopurpowner: ["SEPOLIA_TOP_URP_OWNER", "TOP_URP_OWNER"],
};

const OWNER_TX_ENV_DEFAULT_PREFIXES = [
  "OWNER_TX",
  "SEPOLIA_V1_OWNER",
  "V1_OWNER",
  "SEPOLIA_TOP_URP_OWNER",
  "TOP_URP_OWNER",
] as const;

function normalizeOwnerTransactionRole(role: string | undefined): string {
  return role?.toLowerCase().replace(/-/g, "") ?? "";
}

function ownerTransactionEnv(
  role: string | undefined,
  suffix: string,
): string | undefined {
  const prefixes =
    OWNER_TX_ENV_PREFIXES[normalizeOwnerTransactionRole(role)] ??
    OWNER_TX_ENV_DEFAULT_PREFIXES;
  return envValue(...prefixes.map((prefix) => `${prefix}${suffix}`));
}

function ownerTransactionPrivateKey(
  role: string | undefined,
  privateKey: `0x${string}` | undefined,
): `0x${string}` | undefined {
  if (privateKey) return privateKey;
  if (normalizeOwnerTransactionRole(role) === "deployer") {
    return envPrivateKey("DEPLOYER_KEY");
  }
  return ownerTransactionEnv(role, "_KEY") as `0x${string}` | undefined;
}

function ownerTransactionMnemonic(
  role: string | undefined,
): string | undefined {
  return ownerTransactionEnv(role, "_MNEMONIC");
}

function ownerTransactionMnemonicPath(
  role: string | undefined,
): string | undefined {
  return ownerTransactionEnv(role, "_MNEMONIC_PATH");
}

function ownerTransactionMnemonicPassphrase(
  role: string | undefined,
): string | undefined {
  return ownerTransactionEnv(role, "_MNEMONIC_PASSPHRASE");
}

function ownerTransactionMnemonicIndex(role: string | undefined): number {
  return parseNumber(ownerTransactionEnv(role, "_MNEMONIC_INDEX"), 0);
}

function ownerTransactionSigner(
  role: string | undefined,
  privateKey: `0x${string}` | undefined,
): WalletAccount | undefined {
  const resolvedPrivateKey = ownerTransactionPrivateKey(role, privateKey);
  if (resolvedPrivateKey) return privateKeyToAccount(resolvedPrivateKey);

  const mnemonic = ownerTransactionMnemonic(role);
  if (!mnemonic) return undefined;

  const path = ownerTransactionMnemonicPath(role);
  const passphrase = ownerTransactionMnemonicPassphrase(role);
  return mnemonicToAccount(
    mnemonic,
    (path
      ? { path, passphrase }
      : {
          addressIndex: ownerTransactionMnemonicIndex(role),
          passphrase,
        }) as never,
  );
}

// Identity of a prepared transaction, independent of its position in the file, so a
// re-run recognises one it has already sent even if the file was regenerated or
// filtered differently.
function preparedOwnerTransactionId(tx: PreparedOwnerTransaction): string {
  return keccak256(
    stringToHex(
      [
        normalizeOwnerTransactionRole(tx.role),
        getAddress(tx.to),
        tx.data,
        BigInt(tx.value ?? "0").toString(),
      ].join("|"),
    ),
  );
}

type OwnerTransactionJournal = Record<
  string,
  {
    label: string;
    hash: string;
    // Recorded so a journal left over from a fork rehearsal cannot suppress the same
    // transaction on a different chain. Chain id alone does not settle it — a
    // mainnet fork answers 1 — so the block the transaction landed in is recorded
    // too, and re-checked against the connected chain before anything is skipped.
    chainId: number;
    blockNumber: string;
    blockHash: string;
    executedAt: string;
  }
>;

function ownerTransactionJournalPath(file: string, explicit?: string): string {
  return explicit ?? `${file}.executed.json`;
}

// Whether a journalled transaction is still where the journal says it is. An absent
// receipt means it never landed here; a reverted one means it landed and did nothing;
// a different block hash means the branch it was in is no longer canonical.
async function journalledTransactionStillLanded(
  client: ReturnType<typeof publicClient>,
  entry: OwnerTransactionJournal[string],
): Promise<boolean> {
  if (!entry.blockHash) return false;
  try {
    const receipt = await client.getTransactionReceipt({
      hash: entry.hash as `0x${string}`,
    });
    return (
      receipt.status === "success" &&
      receipt.blockHash.toLowerCase() === entry.blockHash.toLowerCase()
    );
  } catch {
    return false;
  }
}

function readOwnerTransactionJournal(path: string): OwnerTransactionJournal {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OwnerTransactionJournal;
  } catch {
    return {};
  }
}

export async function executePreparedOwnerTransactions(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  file: string;
  role?: string;
  privateKey?: `0x${string}`;
  dryRun?: boolean;
  journalFile?: string;
  // Re-send transactions the journal already records as executed.
  force?: boolean;
}) {
  const transactions = readPreparedOwnerTransactions(opts.file, opts.role);
  if (transactions.length === 0) {
    throw new Error(`No prepared owner transactions found in ${opts.file}`);
  }

  const account = ownerTransactionSigner(opts.role, opts.privateKey);
  if (!account && !opts.dryRun) {
    throw new Error(
      "Missing --private-key, owner key env var, or owner mnemonic env var for prepared owner transactions",
    );
  }

  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const wallet = account
    ? walletClient({ rpcUrl: opts.rpcUrl, chain, account })
    : null;

  // These are owner-gated writes against live v1 contracts. Re-running the file
  // after a partial failure must not re-send what already landed, so each success is
  // journalled and skipped on a later run.
  const journalPath = ownerTransactionJournalPath(opts.file, opts.journalFile);
  const journal = readOwnerTransactionJournal(journalPath);
  let executed = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const label = preparedOwnerTransactionLabel(tx);
    const role = preparedOwnerTransactionRole(tx);
    const id = preparedOwnerTransactionId(tx);
    const previous = journal[id];

    // A journal entry is only evidence if the transaction it names is still on this
    // chain. A rehearsal on a mainnet fork writes entries claiming chain 1, and a
    // reorg can take a real one back out; skipping on either would leave an
    // owner-gated write unsent while the run reports it as already done.
    const alreadyExecuted =
      previous?.chainId === chain.id &&
      (await journalledTransactionStillLanded(client, previous));
    if (previous && !alreadyExecuted && !opts.dryRun) {
      console.log(
        `journalled ${role}: ${label} (tx ${previous.hash}) is not on this chain — re-sending`,
      );
    }
    if (alreadyExecuted && !opts.force && !opts.dryRun) {
      skipped++;
      console.log(
        `already executed ${role}: ${label} (tx ${previous.hash}, block ${previous.blockNumber}) — skipping; pass --force to re-send`,
      );
      continue;
    }

    console.log(`${opts.dryRun ? "prepared" : "executing"} ${role}: ${label}`);
    console.log(`  to:   ${tx.to}`);
    console.log(`  data: ${tx.data}`);
    if (alreadyExecuted && opts.dryRun) {
      console.log(`  note: already executed as ${previous.hash}`);
    }

    if (
      account &&
      tx.from &&
      getAddress(account.address) !== getAddress(tx.from)
    ) {
      throw new Error(
        `Signer ${account.address} does not match prepared tx sender ${tx.from} for ${label}`,
      );
    }
    if (opts.dryRun) continue;

    const hash = await wallet!.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? "0"),
    });
    const receipt = await waitForSuccessfulReceipt(client, hash, label);
    console.log(`  tx:   ${hash}`);

    journal[id] = {
      label,
      hash,
      chainId: chain.id,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      executedAt: new Date().toISOString(),
    };
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    executed++;
  }

  if (!opts.dryRun) {
    console.log(
      `owner transactions: ${executed} executed, ${skipped} already executed (journal ${journalPath})`,
    );
  }
}

async function runFetchData(opts: {
  thegraphApiKey?: string;
  network?: string;
  batchSize?: string;
  startId?: string;
  limit?: string;
  block?: string;
  output: string;
}) {
  const thegraphApiKey =
    opts.thegraphApiKey ?? envValue("THEGRAPH_API_KEY", "GRAPH_API_KEY");
  if (!thegraphApiKey) {
    throw new Error(
      "Missing --thegraph-api-key or THEGRAPH_API_KEY/GRAPH_API_KEY",
    );
  }
  const args = [
    "bun",
    "script/exportTheGraphRegistrations.ts",
    "--thegraph-api-key",
    thegraphApiKey,
    "--network",
    opts.network ?? "mainnet",
    "--batch-size",
    String(parseNumber(opts.batchSize, 1000)),
    "--output",
    opts.output,
  ];
  if (opts.startId) args.push("--start-id", opts.startId);
  if (opts.limit) args.push("--limit", opts.limit);
  if (opts.block) args.push("--block", opts.block);
  await exportRegistrationsMain(args);
}

export async function runPreMigrationCommand(
  opts: {
    rpcUrl: string;
    mainnetRpcUrl?: string;
    network?: MigrationNetwork;
    v1DeploymentsDir?: string;
    v1DeploymentNetwork?: string;
    deploymentNetwork?: string;
    deploymentsDir?: string;
    registry?: Address;
    batchRegistrar?: Address;
    privateKey?: `0x${string}`;
    account?: Address;
    csvFile: string;
    batchSize?: string;
    limit?: string;
    bonusPeriodDays?: string;
    v1Resolver?: Address;
    v1BaseRegistrar?: Address;
    workDir?: string;
    dryRun?: boolean;
    metadataLabel?: string;
    persistMetadata?: boolean;
  },
  resume: boolean,
  run: (args: string[]) => Promise<void> = preMigrationMain,
) {
  const network = opts.network ?? "mainnet";
  const deploymentNetwork = opts.deploymentNetwork ?? network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  // Seeding from a suffix of the registration set leaves the missing names with
  // nothing to report them, so a partial export is refused before any of it is read.
  assertCompleteCsv(opts.csvFile);
  const registry = resolveDeploymentAddress(
    opts.registry,
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistry",
  );
  const batchRegistrar = resolveDeploymentAddress(
    opts.batchRegistrar,
    deploymentsDir,
    deploymentNetwork,
    "BatchRegistrar",
  );
  const v1Resolver = resolveDeploymentAddress(
    opts.v1Resolver,
    deploymentsDir,
    deploymentNetwork,
    "ENSV1Resolver",
  );
  const v1BaseRegistrar =
    opts.v1BaseRegistrar ??
    requireV1Deployment(network, V1_BASE_REGISTRAR_NAME, opts).address;
  const envFallbackKey = envPrivateKey(
    "PREMIGRATION_PRIVATE_KEY",
    "BATCH_REGISTRAR_OWNER_KEY",
    "DEPLOYER_KEY",
  );
  // When the caller supplies an impersonated account, only consult the env
  // fallback key if it actually controls that account; otherwise the batch run
  // would sign as the wrong address and BatchRegistrar.onlyOwner would revert.
  const fallbackKey =
    opts.account && envFallbackKey
      ? getAddress(privateKeyToAccount(envFallbackKey).address) ===
        getAddress(opts.account)
        ? envFallbackKey
        : undefined
      : envFallbackKey;
  const privateKey = opts.privateKey ?? fallbackKey;
  const previousCwd = process.cwd();

  if (opts.workDir) {
    mkdirSync(resolve(opts.workDir), { recursive: true });
    process.chdir(resolve(opts.workDir));
  }

  try {
    const args = [
      "bun",
      "script/preMigration.ts",
      "--rpc-url",
      opts.rpcUrl,
      "--registry",
      registry,
      "--batch-registrar",
      batchRegistrar,
      "--csv-file",
      resolve(previousCwd, opts.csvFile),
      "--v1-resolver",
      v1Resolver,
      "--mainnet-rpc-url",
      opts.mainnetRpcUrl ?? opts.rpcUrl,
      "--v1-base-registrar",
      v1BaseRegistrar,
      "--batch-size",
      String(parseNumber(opts.batchSize, 50)),
    ];
    if (privateKey) args.push("--private-key", privateKey);
    if (opts.account) args.push("--account", opts.account);
    if (opts.limit) args.push("--limit", opts.limit);
    if (opts.dryRun) args.push("--dry-run");
    if (opts.bonusPeriodDays)
      args.push("--bonus-period-days", opts.bonusPeriodDays);
    if (resume) args.push("--continue");
    await run(args);

    // Persist a durable counts sidecar into the deployment namespace. Skipped on
    // dry runs and when the caller opts out (e.g. a fork rehearsal that does not
    // save deployments), so a committed namespace is never touched by a throwaway
    // run. The checkpoint lands in the workDir (or cwd when none was set).
    if (!opts.dryRun && (opts.persistMetadata ?? true)) {
      const cpDir = opts.workDir ? resolve(opts.workDir) : previousCwd;
      const checkpoint = loadCheckpoint(join(cpDir, CHECKPOINT_FILE));
      if (checkpoint) {
        recordPreMigrationMetadata({
          deploymentsDir,
          deploymentNetwork,
          network,
          label: opts.metadataLabel ?? "run",
          checkpoint,
        });
      }
    }
  } finally {
    process.chdir(previousCwd);
  }
}

async function printPreMigrationStatus(opts: { workDir?: string }) {
  const previousCwd = process.cwd();
  if (opts.workDir) process.chdir(resolve(opts.workDir));
  try {
    const checkpoint = loadCheckpoint() ?? createFreshCheckpoint();
    console.log(JSON.stringify(checkpoint, null, 2));
  } finally {
    process.chdir(previousCwd);
  }
}

async function verifyPreMigration(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  mainnetRpcUrl?: string;
  chainId?: string;
  csvFile: string;
  registry?: Address;
  v1Resolver?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  v1BaseRegistrar?: Address;
  limit?: string;
  expectedStatus?: "reserved" | "registered" | "reserved-or-registered";
  bonusPeriodDays?: string;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chainId = parseNumber(opts.chainId, NETWORKS[opts.network].chain.id);
  const chain = forkChain(opts.network, chainId, opts.rpcUrl);
  const client = publicClient(opts.rpcUrl, chain);
  const v1Client = publicClient(opts.mainnetRpcUrl ?? opts.rpcUrl, chain);
  const registry = getContract({
    address: resolveDeploymentAddress(
      opts.registry,
      deploymentsDir,
      deploymentNetwork,
      "ETHRegistry",
    ),
    abi: Artifact_PermissionedRegistry.abi,
    client,
  });
  const expectedResolver =
    opts.v1Resolver ??
    maybeLoadV2Deployment(deploymentsDir, deploymentNetwork, "ENSV1Resolver")
      ?.address;
  const baseRegistrar =
    opts.v1BaseRegistrar ??
    requireV1Deployment(opts.network, V1_BASE_REGISTRAR_NAME, opts).address;
  const expectedStatus = opts.expectedStatus ?? "reserved-or-registered";
  const labels = readLabelsFromCsv(
    opts.csvFile,
    opts.limit ? Number(opts.limit) : undefined,
  );
  const v1Block = await v1Client.getBlock();
  const v2Block = await client.getBlock();
  const v1Now = BigInt(v1Block.timestamp);
  const v2Now = BigInt(v2Block.timestamp);
  const bonusPeriodDays = parseNumber(opts.bonusPeriodDays, 62);
  const bonusPeriodSeconds = BigInt(bonusPeriodDays) * SEC_PER_DAY;
  const errors: string[] = [];
  let eligible = 0;
  let skipped = 0;
  let invalid = 0;
  let verifiedActive = 0;
  let verifiedExpiredBonus = 0;

  for (
    let start = 0;
    start < labels.length;
    start += PREMIGRATION_VERIFY_BATCH_SIZE
  ) {
    const batch = labels.slice(start, start + PREMIGRATION_VERIFY_BATCH_SIZE);
    const validBatch = batch.filter((label) => {
      if (isValidLabel(label)) return true;
      invalid++;
      return false;
    });
    if (validBatch.length === 0) continue;

    const expiryResults = await v1Client.multicall({
      allowFailure: true,
      contracts: validBatch.map((label) => ({
        address: baseRegistrar,
        abi: Artifact_BaseRegistrarImplementation.abi,
        functionName: "nameExpires",
        args: [labelId(label)],
      })),
    });
    const stateResults = await client.multicall({
      allowFailure: true,
      contracts: validBatch.map((label) => ({
        address: registry.address,
        abi: Artifact_PermissionedRegistry.abi,
        functionName: "getState",
        args: [labelId(label)],
      })),
    });
    const resolverChecks: string[] = [];

    for (let index = 0; index < validBatch.length; index++) {
      const label = validBatch[index];
      const expiryResult = expiryResults[index];
      const stateResult = stateResults[index];

      if (expiryResult.status === "failure") {
        errors.push(
          `${label}.eth v1 expiry lookup failed: ${expiryResult.error}`,
        );
        continue;
      }
      if (stateResult.status === "failure") {
        errors.push(
          `${label}.eth v2 state lookup failed: ${stateResult.error}`,
        );
        continue;
      }

      const expiry = expiryResult.result as bigint;
      const v1IsClaimable =
        expiry > 0n && expiry + V1_GRACE_PERIOD_SECONDS > v1Now;
      if (!v1IsClaimable) {
        skipped++;
        continue;
      }

      eligible++;
      // Same cap pre-migration applies; see bonusAdjustedExpiry.
      const expectedExpiry = bonusAdjustedExpiry(expiry, bonusPeriodSeconds);
      const state = stateResult.result as unknown as {
        status: number;
        expiry: bigint | number;
        latestOwner: Address;
      };
      if (BigInt(state.expiry) !== expectedExpiry) {
        errors.push(
          `${label}.eth expiry mismatch: v2=${state.expiry} expected=${expectedExpiry} v1=${expiry}`,
        );
        continue;
      }

      if (expectedExpiry <= v2Now) {
        verifiedExpiredBonus++;
        continue;
      }

      const status = Number(state.status);
      const statusOk =
        expectedStatus === "reserved"
          ? status === STATUS.RESERVED
          : expectedStatus === "registered"
            ? status === STATUS.REGISTERED
            : status === STATUS.RESERVED || status === STATUS.REGISTERED;
      if (!statusOk) {
        errors.push(`${label}.eth has status ${status}`);
        continue;
      }
      // The premigration fallback resolver is only asserted for names that remain
      // RESERVED. A REGISTERED name has already been migrated and carries the
      // resolver from its migration data (custom or zero), not the fallback, so
      // asserting the fallback here would fail legitimate migrated names.
      if (expectedResolver && status === STATUS.RESERVED) {
        resolverChecks.push(label);
      } else {
        verifiedActive++;
      }
    }

    const resolverToCheck = expectedResolver;
    if (resolverToCheck && resolverChecks.length > 0) {
      const resolverResults = await client.multicall({
        allowFailure: true,
        contracts: resolverChecks.map((label) => ({
          address: registry.address,
          abi: Artifact_PermissionedRegistry.abi,
          functionName: "getResolver",
          args: [label],
        })),
      });
      for (let index = 0; index < resolverChecks.length; index++) {
        const label = resolverChecks[index];
        const result = resolverResults[index];
        if (result.status === "failure") {
          errors.push(`${label}.eth resolver lookup failed: ${result.error}`);
          continue;
        }
        const actualResolver = result.result as Address;
        if (getAddress(actualResolver) !== getAddress(resolverToCheck)) {
          errors.push(`${label}.eth resolver mismatch: ${actualResolver}`);
          continue;
        }
        verifiedActive++;
      }
    }
  }

  console.log(`labels scanned: ${labels.length}`);
  console.log(`invalid labels: ${invalid}`);
  console.log(`eligible v1 names: ${eligible}`);
  console.log(`skipped ineligible names: ${skipped}`);
  console.log(`verified active names: ${verifiedActive}`);
  console.log(`verified expired-bonus names: ${verifiedExpiredBonus}`);
  console.log(`verified names: ${verifiedActive + verifiedExpiredBonus}`);
  if (errors.length > 0) {
    console.error(errors.slice(0, 20).join("\n"));
    if (errors.length > 20) {
      console.error(`...and ${errors.length - 20} more errors`);
    }
    throw new Error(
      `pre-migration verification failed for ${errors.length} names`,
    );
  }
}

// The block a contract was deployed in, so a v2-side event scan starts there rather
// than at genesis.
function readDeploymentBlock(
  deploymentsDir: string,
  environment: string,
  name: string,
): bigint | undefined {
  const path = join(resolve(deploymentsDir), environment, `${name}.json`);
  if (!existsSync(path)) return undefined;
  const record = JSON.parse(readFileSync(path, "utf-8")) as {
    receipt?: { blockNumber?: string | number };
  };
  const block = record.receipt?.blockNumber;
  if (block === undefined) return undefined;
  return BigInt(block);
}

// The deploy block recorded on an already-loaded artifact. Bundled v1 artifacts
// carry it as a hex string, locally deployed ones as a number.
// The address that sent a deployment's own transaction. The deploy scripts grant the
// constructor roles to whoever deployed, so this is what the role audit has to compare
// against — the configured owner is a different address on any live deployment, and on
// mainnet it is the DAO.
function deploymentOrigin(deployment: JsonDeployment): Address | undefined {
  const origin = (deployment as { transaction?: { origin?: string } })
    .transaction?.origin;
  return origin ? getAddress(origin) : undefined;
}

function deploymentBlockNumber(deployment: JsonDeployment): number | undefined {
  const block = (deployment as { receipt?: { blockNumber?: string | number } })
    .receipt?.blockNumber;
  if (block === undefined) return undefined;
  return Number(BigInt(block));
}

const RESERVED_EVENT = parseAbiItem(
  "event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)",
);
const REGISTERED_EVENT = parseAbiItem(
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
);

// Every labelhash the v2 registry has ever created an entry for. The registry is new,
// so this is a short scan from its deploy block — unlike the v1 side, which is why
// the v1 half of the reconciliation comes from an indexer instead.
async function discoverV2SeededLabelhashes(
  client: ReturnType<typeof publicClient>,
  registry: Address,
  fromBlock: bigint,
): Promise<Map<string, string>> {
  const toBlock = await client.getBlockNumber();
  const seeded = new Map<string, string>();
  for (const event of [RESERVED_EVENT, REGISTERED_EVENT]) {
    const logs = await readEventLogs(client, {
      address: registry,
      event,
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const args = log.args as { labelHash?: string; label?: string };
      if (!args.labelHash) continue;
      seeded.set(args.labelHash.toLowerCase(), args.label ?? "");
    }
  }
  return seeded;
}

// The v2 registry keys entries by a canonical id whose low 32 bits are a version
// counter. A raw v1 labelhash is accepted as a lookup id because the registry zeroes
// those bits internally, but a token id read back out carries them — so comparisons
// between the two sides must happen on the canonical form, never on a token id.
function canonicalLabelId(labelhash: string): bigint {
  return BigInt(labelhash) & ~0xffffffffn;
}

function toLabelhashHex(id: bigint): string {
  return `0x${id.toString(16).padStart(64, "0")}`;
}

type ReconcileResult = {
  claimable: number;
  reserved: number;
  registered: number;
  missing: string[];
  expiryMismatched: string[];
  unexpected: string[];
  /// Names the exporter could not decode a label for, so pre-migration cannot seed
  /// them: `BatchRegistrar.batchRegister` takes a plaintext label.
  unmigratableNoLabel: number;
  /// Wrapped names whose `CANNOT_TRANSFER` fuse is burned. They can be reserved on
  /// v2, but their owner can never move the token to a migration controller, so the
  /// reservation is unclaimable through the transfer-based path.
  unmigratableCannotTransfer: number | null;
  /// Live-name counts from each source, when both are available. Two independent
  /// indexers disagreeing means one of them is wrong.
  crossSource: { csv: number; index: number } | null;
};

// Compares the v1 name set against what v2 actually holds, in both directions.
//
// The CSV-driven check can only ever confirm the names it was told about, so a name
// missing from the CSV is invisible to it. This starts from an independently-built
// index of v1 instead, which is what makes "nothing was missed" answerable.
export async function reconcilePreMigration(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  mainnetRpcUrl?: string;
  chainId?: string;
  workDir: string;
  csvFile?: string;
  registry?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  bonusPeriodDays?: string;
  expectedStatus?: "reserved" | "reserved-or-registered";
  reportOnly?: boolean;
  fromBlock?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  // Count names whose CANNOT_TRANSFER fuse is burned. One wrapper read per claimable
  // name, so opt-in.
  checkFuses?: boolean;
}): Promise<ReconcileResult> {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chainId = parseNumber(opts.chainId, NETWORKS[opts.network].chain.id);
  const chain = forkChain(opts.network, chainId, opts.rpcUrl);
  const client = publicClient(opts.rpcUrl, chain);
  const v1Client = publicClient(opts.mainnetRpcUrl ?? opts.rpcUrl, chain);

  const index = loadV1NameIndex(opts.workDir);
  if (opts.csvFile) {
    assertCompleteCsv(opts.csvFile);
    assertIndependentSource(index.meta.source, opts.csvFile);
  }

  const registry = resolveRegistry({
    registry: opts.registry,
    deploymentsDir,
    deploymentNetwork,
  });
  const registryAddress = registry.address;

  // Claimability is judged against chain time, not wall-clock time: on a fork pinned
  // to a past block the two disagree, and a wall-clock "now" would mark names
  // eligible that the chain considers long released.
  const v1Now = BigInt((await v1Client.getBlock()).timestamp);
  // The index's own filter has to reach at least as far back as this reconciliation
  // does, or names it dropped are absent here and pass unexamined.
  assertIndexCoversChainTime(index.meta, v1Now);
  const bonusPeriodSeconds =
    BigInt(parseNumber(opts.bonusPeriodDays, 62)) * SEC_PER_DAY;
  const expectedStatus = opts.expectedStatus ?? "reserved";

  const claimable: Array<{ id: string; expiry: bigint }> = [];
  for (const [id, expiry] of index.expiries) {
    if (expiry + V1_GRACE_PERIOD_SECONDS > v1Now)
      claimable.push({ id, expiry });
  }

  const result: ReconcileResult = {
    claimable: claimable.length,
    reserved: 0,
    registered: 0,
    missing: [],
    expiryMismatched: [],
    unexpected: [],
    unmigratableNoLabel: 0,
    unmigratableCannotTransfer: null,
    crossSource: null,
  };

  // Two independent views of the same chain should agree on how many names are
  // live. A disagreement means one of them is wrong, and it is far cheaper to learn
  // that here than after the freeze.
  if (opts.csvFile && existsSync(opts.csvFile)) {
    const csv = countClaimableCsvRows(opts.csvFile, v1Now);
    result.crossSource = { csv: csv.count, index: claimable.length };
    console.log(
      csv.filtered
        ? `cross-source: CSV holds ${csv.count} claimable label(s)${csv.unknownExpiry > 0 ? ` (${csv.unknownExpiry} of them with no expiry recorded, counted as claimable)` : ""}, the index has ${claimable.length} claimable name(s)`
        : `cross-source: CSV holds ${csv.count} label(s) and records no expiries, so this is every row it carries and not a claimable count; the index has ${claimable.length} claimable name(s)`,
    );
  }

  console.log(
    `v1 index: ${index.expiries.size} names @ block ${index.meta.block} (${index.meta.source})`,
  );
  console.log(`claimable v1 names: ${claimable.length}`);

  // Forward: every claimable v1 name must exist on v2 with the bonus-adjusted expiry.
  for (
    let start = 0;
    start < claimable.length;
    start += PREMIGRATION_VERIFY_BATCH_SIZE
  ) {
    const batch = claimable.slice(
      start,
      start + PREMIGRATION_VERIFY_BATCH_SIZE,
    );
    const states = await client.multicall({
      allowFailure: true,
      contracts: batch.map((entry) => ({
        address: registryAddress,
        abi: Artifact_PermissionedRegistry.abi,
        functionName: "getState",
        args: [BigInt(entry.id)],
      })),
    });

    for (let index = 0; index < batch.length; index++) {
      const entry = batch[index];
      const state = states[index];
      if (state.status === "failure") {
        result.missing.push(`${entry.id} state lookup failed: ${state.error}`);
        continue;
      }
      const value = state.result as unknown as {
        status: number;
        expiry: bigint | number;
      };
      const status = Number(value.status);
      const actualExpiry = BigInt(value.expiry);

      // Nothing on v2 at all: the name was never seeded.
      if (status === STATUS.AVAILABLE && actualExpiry === 0n) {
        result.missing.push(entry.id);
        continue;
      }
      // Computed with the same cap pre-migration applies, or every name near the
      // uint64 ceiling reads as a permanent mismatch and the gate never opens.
      const expectedExpiry = bonusAdjustedExpiry(
        entry.expiry,
        bonusPeriodSeconds,
      );
      if (actualExpiry !== expectedExpiry) {
        result.expiryMismatched.push(
          `${entry.id} v2=${actualExpiry} expected=${expectedExpiry}`,
        );
        continue;
      }
      if (status === STATUS.RESERVED) {
        result.reserved++;
      } else if (status === STATUS.REGISTERED) {
        result.registered++;
        // Before migration opens no name can legitimately be claimed on v2, so a
        // REGISTERED entry in that window is an anomaly rather than a user action.
        if (expectedStatus === "reserved") {
          result.unexpected.push(
            `${entry.id} is REGISTERED before migration opened`,
          );
        }
      } else {
        result.missing.push(`${entry.id} has status ${status}`);
      }
    }
  }

  // Reverse: anything seeded onto v2 that no claimable v1 name accounts for. This is
  // what catches a stray registrar writing into the registry, or a seed run against
  // the wrong data.
  const fromBlock =
    opts.fromBlock !== undefined
      ? BigInt(opts.fromBlock)
      : (readDeploymentBlock(
          deploymentsDir,
          deploymentNetwork,
          "ETHRegistry",
        ) ?? 0n);
  const seeded = await discoverV2SeededLabelhashes(
    client,
    registryAddress,
    fromBlock,
  );
  const claimableIds = new Set(
    claimable.map((entry) => toLabelhashHex(canonicalLabelId(entry.id))),
  );
  // An entry whose v1 name has passed grace since it was seeded is expected — it was
  // claimable at the time. But "v1 once knew this labelhash" is not enough on its own:
  // a seed written after the name became unclaimable, or written with the wrong
  // expiry, would be waved through on the strength of the labelhash alone. A
  // legitimate seed carries the bonus-adjusted v1 expiry whether or not the name has
  // since lapsed, so that is what distinguishes the two.
  const staleSeeds = [...seeded.keys()].filter(
    (labelhash) =>
      !claimableIds.has(toLabelhashHex(canonicalLabelId(labelhash))) &&
      index.expiries.has(labelhash),
  );
  const staleStates = await readV2StatesInBatches(
    client,
    registryAddress,
    staleSeeds,
  );
  for (const [labelhash, label] of seeded) {
    if (claimableIds.has(toLabelhashHex(canonicalLabelId(labelhash)))) continue;
    const known = index.expiries.get(labelhash);
    if (known !== undefined) {
      const expected = bonusAdjustedExpiry(known, bonusPeriodSeconds);
      const actual = staleStates.get(labelhash);
      if (actual === expected) continue;
      result.unexpected.push(
        `${labelhash}${label ? ` (${label}.eth)` : ""} is on v2 with expiry ${actual ?? "unreadable"}, but its v1 name lapsed carrying ${expected}`,
      );
      continue;
    }
    result.unexpected.push(
      `${labelhash}${label ? ` (${label}.eth)` : ""} is on v2 but not a v1 name`,
    );
  }

  // Names whose owner can never hand the token to a migration controller. Off by
  // default because it is one wrapper read per claimable name, which is a large
  // scan on mainnet — but the number matters, since these owners keep a reservation
  // they cannot claim through the transfer-based path.
  if (opts.checkFuses) {
    const nameWrapper = loadV1Deployment(opts.network, "NameWrapper", opts);
    if (!nameWrapper) {
      console.log("no NameWrapper artifact; skipping CANNOT_TRANSFER scan");
    } else if (!opts.csvFile || !existsSync(opts.csvFile)) {
      // NameWrapper keys tokens by namehash, which can only be derived from a
      // plaintext label. The index holds labelhashes by design, so the labels have
      // to come from the CSV. Refusing is the honest answer: querying by labelhash
      // reads empty records and would report zero however many names are affected.
      throw new Error(
        "--check-fuses needs --csv-file: NameWrapper is keyed by namehash, which requires the plaintext label",
      );
    } else {
      const labelByHash = new Map<string, string>();
      for (const label of readLabelsFromCsv(opts.csvFile)) {
        labelByHash.set(
          toLabelhashHex(canonicalLabelId(toLabelhashHex(labelId(label)))),
          label,
        );
      }

      const resolvable: Array<{ id: string; label: string }> = [];
      let unmappable = 0;
      for (const entry of claimable) {
        const label = labelByHash.get(
          toLabelhashHex(canonicalLabelId(entry.id)),
        );
        if (label === undefined) unmappable++;
        else resolvable.push({ id: entry.id, label });
      }

      let cannotTransfer = 0;
      let unreadable = 0;
      for (
        let start = 0;
        start < resolvable.length;
        start += PREMIGRATION_VERIFY_BATCH_SIZE
      ) {
        const batch = resolvable.slice(
          start,
          start + PREMIGRATION_VERIFY_BATCH_SIZE,
        );
        // Through the v1 client: NameWrapper is a v1 contract, and every other
        // eligibility read here uses that endpoint. Asking the v2 endpoint for it
        // fails on every entry where the two differ, and the failures were being
        // skipped — which reports zero burned fuses rather than an error.
        const results = await v1Client.multicall({
          allowFailure: true,
          contracts: batch.map((entry) => ({
            address: nameWrapper.address,
            abi: nameWrapper.abi,
            functionName: "getData",
            args: [BigInt(namehash(`${entry.label}.eth`))],
          })),
        });
        for (const outcome of results) {
          if (outcome.status === "failure") {
            unreadable++;
            continue;
          }
          const [, fuses] = outcome.result as [Address, number, bigint];
          if ((Number(fuses) & FUSES.CANNOT_TRANSFER) !== 0) cannotTransfer++;
        }
      }
      // A scan that could not read the wrapper has not established that no fuse is
      // burned; reporting zero would be the same vacuous pass the labelhash bug gave.
      if (unreadable > 0) {
        throw new Error(
          `could not read NameWrapper ${nameWrapper.address} for ${unreadable} of ${resolvable.length} name(s); the CANNOT_TRANSFER count would be meaningless. Check --mainnet-rpc-url points at the chain the wrapper is on.`,
        );
      }
      result.unmigratableCannotTransfer = cannotTransfer;
      console.log(
        `unmigratable (CANNOT_TRANSFER burned): ${cannotTransfer} of ${resolvable.length} checked`,
      );
      if (unmappable > 0) {
        // Not silently treated as fuse-free: these are names the CSV has no label
        // for, so their fuses are simply unknown.
        result.unmigratableNoLabel = unmappable;
        console.log(
          `fuses unknown (no label in the CSV for this labelhash): ${unmappable}`,
        );
      }
    }
  }

  console.log(`v2 reserved: ${result.reserved}`);
  console.log(`v2 registered: ${result.registered}`);
  console.log(`missing from v2: ${result.missing.length}`);
  console.log(`expiry mismatches: ${result.expiryMismatched.length}`);
  console.log(`unexpected on v2: ${result.unexpected.length}`);

  const problems = [
    ...result.missing.map((entry) => `missing: ${entry}`),
    ...result.expiryMismatched.map((entry) => `expiry: ${entry}`),
    ...result.unexpected.map((entry) => `unexpected: ${entry}`),
  ];
  if (problems.length > 0) {
    // A failing reconciliation must revoke any earlier pass, not just decline to
    // record a new one: phase 3 would otherwise read the stale success and permit
    // the irreversible freeze despite the latest evidence showing incompleteness.
    clearVerification(
      resolve(deploymentsDir),
      deploymentNetwork,
      PRECONDITION_RECONCILE,
    );
  } else {
    // Phase 3 freezes v1. Recording the pass lets it refuse to run when the
    // reconciliation that proves nothing was missed has not been done.
    //
    // The block recorded is the index's, not the chain head: names registered after
    // the index was built were never examined, so the index is what limits how much
    // of the chain this pass actually covers. Recording the head instead would let a
    // week-old index be read as a brand-new pass, and the freshness bound the freeze
    // applies would have nothing to bite on.
    const indexBlock = BigInt(index.meta.block);
    const indexBlockHash = (
      await v1Client.getBlock({ blockNumber: indexBlock })
    ).hash;
    recordVerification(resolve(deploymentsDir), deploymentNetwork, {
      check: PRECONDITION_RECONCILE,
      chainId,
      blockNumber: indexBlock.toString(),
      blockHash: indexBlockHash,
      verifiedAt: new Date().toISOString(),
      details: {
        claimable: result.claimable,
        reserved: result.reserved,
        registered: result.registered,
        rpcHead: (await client.getBlockNumber()).toString(),
      },
    });
  }
  if (problems.length > 0) {
    console.error(problems.slice(0, 20).join("\n"));
    if (problems.length > 20) {
      console.error(`...and ${problems.length - 20} more`);
    }
    if (!opts.reportOnly) {
      throw new Error(`reconciliation failed for ${problems.length} names`);
    }
  }
  return result;
}

// Current v2 expiry per labelhash, batched. Used by the reverse pass, which has to
// judge a seed by what it carries rather than by the fact that it exists.
async function readV2StatesInBatches(
  client: ReturnType<typeof publicClient>,
  registryAddress: Address,
  labelhashes: string[],
): Promise<Map<string, bigint>> {
  const expiries = new Map<string, bigint>();
  for (
    let start = 0;
    start < labelhashes.length;
    start += PREMIGRATION_VERIFY_BATCH_SIZE
  ) {
    const batch = labelhashes.slice(
      start,
      start + PREMIGRATION_VERIFY_BATCH_SIZE,
    );
    const states = await client.multicall({
      allowFailure: true,
      contracts: batch.map((labelhash) => ({
        address: registryAddress,
        abi: Artifact_PermissionedRegistry.abi,
        functionName: "getState",
        args: [BigInt(labelhash)],
      })),
    });
    for (const [index, labelhash] of batch.entries()) {
      const state = states[index];
      if (state.status === "failure") continue;
      expiries.set(
        labelhash,
        BigInt((state.result as unknown as { expiry: bigint | number }).expiry),
      );
    }
  }
  return expiries;
}

type ContractRef = { address: Address; abi: readonly any[] };

// Read owner() from the gating contract, reject a private key that does not
// control it, optionally impersonate it on a fork, and return a wallet able to
// sign as the owner.
async function resolveOwnerGatedWallet(opts: {
  client: ReturnType<typeof publicClient>;
  chain: Chain;
  rpcUrl: string;
  provider?: RpcProvider;
  gate: ContractRef;
  ownerLabel: string;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
}): Promise<{ owner: Address; wallet: ReturnType<typeof walletClient> }> {
  const owner = (await opts.client.readContract({
    address: opts.gate.address,
    abi: opts.gate.abi,
    functionName: "owner",
  })) as Address;
  if (
    opts.privateKey &&
    getAddress(privateKeyToAccount(opts.privateKey).address) !==
      getAddress(owner)
  ) {
    throw new Error(`private key does not match ${opts.ownerLabel} ${owner}`);
  }
  if (opts.impersonateOwner) await impersonate(opts.client, owner);
  const wallet = walletClient({
    rpcUrl: opts.rpcUrl,
    chain: opts.chain,
    privateKey: opts.privateKey,
    account: opts.impersonateOwner ? owner : undefined,
    provider: opts.provider,
  });
  return { owner, wallet };
}

// Send a single owner-gated write: print calldata when only preparing a
// multisig transaction, otherwise resolve the owner-signing wallet, broadcast,
// and assert the receipt did not revert.
async function sendOwnerGatedWrite(opts: {
  client: ReturnType<typeof publicClient>;
  chain: Chain;
  rpcUrl: string;
  provider?: RpcProvider;
  target: ContractRef;
  gate?: ContractRef;
  functionName: string;
  args: readonly unknown[];
  ownerLabel: string;
  calldataLabel: string;
  receiptLabel: string;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}): Promise<void> {
  const data = encodeFunctionData({
    abi: opts.target.abi,
    functionName: opts.functionName,
    args: opts.args,
  });
  if (opts.calldataOnly) {
    printPreparedCall(opts.calldataLabel, opts.target.address, data);
    return;
  }
  const { wallet } = await resolveOwnerGatedWallet({
    client: opts.client,
    chain: opts.chain,
    rpcUrl: opts.rpcUrl,
    provider: opts.provider,
    gate: opts.gate ?? opts.target,
    ownerLabel: opts.ownerLabel,
    privateKey: opts.privateKey,
    impersonateOwner: opts.impersonateOwner,
  });
  const hash = await wallet.writeContract({
    address: opts.target.address,
    abi: opts.target.abi,
    functionName: opts.functionName,
    args: opts.args,
  });
  await waitForSuccessfulReceipt(opts.client, hash, opts.receiptLabel);
}

// Send an admin-gated write where the authorized account is supplied directly
// rather than read from the contract's owner().
async function sendAdminWrite(opts: {
  client: ReturnType<typeof publicClient>;
  chain: Chain;
  rpcUrl: string;
  provider?: RpcProvider;
  target: ContractRef;
  functionName: string;
  args: readonly unknown[];
  receiptLabel: string;
  calldataLabel?: string;
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
  calldataOnly?: boolean;
}): Promise<void> {
  const data = encodeFunctionData({
    abi: opts.target.abi,
    functionName: opts.functionName,
    args: opts.args,
  });
  if (opts.calldataOnly) {
    printPreparedCall(
      opts.calldataLabel ?? opts.receiptLabel,
      opts.target.address,
      data,
    );
    return;
  }
  if (opts.impersonateAccount)
    await impersonate(opts.client, opts.impersonateAccount);
  const wallet = walletClient({
    rpcUrl: opts.rpcUrl,
    chain: opts.chain,
    privateKey: opts.privateKey,
    account: opts.impersonateAccount,
    provider: opts.provider,
  });
  const hash = await wallet.writeContract({
    address: opts.target.address,
    abi: opts.target.abi,
    functionName: opts.functionName,
    args: opts.args,
  });
  await waitForSuccessfulReceipt(opts.client, hash, opts.receiptLabel);
}

// v1-side controllers able to mint `.eth` registrations, removed by the freeze.
const V1_REGISTRATION_CONTROLLER_NAMES = [
  "LegacyETHRegistrarController",
  "ETHRegistrarController",
  "WrappedETHRegistrarController",
  "NameWrapper",
] as const;

const V1_BASE_REGISTRAR_NAME = "BaseRegistrarImplementation";

// v1 reverse registrars a migration is granted control of: the premigration
// registrar writes reverse records on a registrant's behalf, and the adapters
// forward reverse updates for the accounts they are allowed to name. These are
// shared v1 contracts, so a superseded deployment's grant stays live across
// re-deploys.
const V1_REVERSE_REGISTRAR_NAMES = [
  "ReverseRegistrar",
  "DefaultReverseRegistrar",
] as const;

// v2-side contracts a migration authorizes against v1, keyed by the v1 contract
// holding the grant. Every deployment namespace holds its own instances, so
// re-deploying leaves the previous namespace's copies authorized until they are
// explicitly revoked — including the testnet premigration registrar, which
// registers names permissionlessly.
const V1_HANDOFF_CONTROLLERS: Record<
  typeof V1_BASE_REGISTRAR_NAME | (typeof V1_REVERSE_REGISTRAR_NAMES)[number],
  readonly string[]
> = {
  BaseRegistrarImplementation: [
    "ETHRenewerV1",
    "Graveyard",
    "TestnetV1PremigrationRegistrar",
  ],
  ReverseRegistrar: [
    "TestnetV1PremigrationRegistrar",
    "ReverseRegistrarAdapter",
  ],
  DefaultReverseRegistrar: [
    "TestnetV1PremigrationRegistrar",
    "DefaultReverseRegistrarAdapter",
  ],
};

const V1_HANDOFF_CONTROLLER_ENTRIES = Object.entries(V1_HANDOFF_CONTROLLERS);

// Every handoff contract name once, so each namespace's artifact is read a single
// time regardless of how many v1 surfaces it is authorized on.
const V1_HANDOFF_CONTROLLER_NAMES = [
  ...new Set(Object.values(V1_HANDOFF_CONTROLLERS).flat()),
];

// Controller-history events, differing per v1 surface: the BaseRegistrar records
// grants and revocations separately, the reverse registrars carry both in one event.
const V1_CONTROLLER_ADDED_EVENT = parseAbiItem(
  "event ControllerAdded(address indexed controller)",
);
const V1_CONTROLLER_REMOVED_EVENT = parseAbiItem(
  "event ControllerRemoved(address indexed controller)",
);
const V1_CONTROLLER_CHANGED_EVENT = parseAbiItem(
  "event ControllerChanged(address indexed controller, bool enabled)",
);

// Getter each handoff contract exposes for the reverse registrar it forwards to,
// so an instance no local artifact describes can still be recognised from chain
// state. v1's own reverse controllers hold the registrar under a different name
// and so do not answer these calls.
const V1_REVERSE_REGISTRAR_BACK_REFERENCES: Record<
  (typeof V1_REVERSE_REGISTRAR_NAMES)[number],
  string
> = {
  ReverseRegistrar: "REVERSE_REGISTRAR",
  DefaultReverseRegistrar: "DEFAULT_REVERSE_REGISTRAR",
};

type V1ControllerState = {
  // The v1 contract holding the authorization, e.g. "v1 BaseRegistrar".
  surface: string;
  name: string;
  address: Address;
  enabled: boolean;
  // Authorized by the active deployment and expected to stay enabled.
  keep: boolean;
  // A v1-side controller this tooling never granted. Reported but never revoked:
  // the reverse registrars' own controllers set reverse records during
  // registration, so revoking them would break unrelated v1 behaviour.
  foreign: boolean;
  // Contract the revoke transaction targets, and whose owner() gates it.
  target: JsonDeployment;
  revokeFunctionName: string;
  revokeArgs: readonly unknown[];
};

type V1ControllerAudit = {
  controllers: V1ControllerState[];
};

function v1ControllersToRemove(audit: V1ControllerAudit): V1ControllerState[] {
  return audit.controllers.filter(
    (controller) =>
      controller.enabled && !controller.keep && !controller.foreign,
  );
}

// Grants the active deployment depends on that are not in place. The revoke-side
// filter cannot see these: it tests `enabled` first, so a missing grant is indexed
// as "already revoked" and the audit passes over it. A revoked adapter stops reverse
// records being written and nothing else reports it.
function v1ControllersMissing(audit: V1ControllerAudit): V1ControllerState[] {
  return audit.controllers.filter(
    (controller) => controller.keep && !controller.enabled,
  );
}

function describeV1Controller(controller: V1ControllerState): string {
  return `${controller.surface}: ${controller.name} ${controller.address}`;
}

// Reads `controllers(address)` for a batch of candidates on one v1 contract.
async function readControllerFlags(
  client: ReturnType<typeof publicClient>,
  contract: JsonDeployment,
  addresses: Address[],
): Promise<boolean[]> {
  return Promise.all(
    addresses.map(
      (address) =>
        client.readContract({
          address: contract.address,
          abi: contract.abi,
          functionName: "controllers",
          args: [address],
        }) as Promise<boolean>,
    ),
  );
}

// Reads a namespace's recorded chain id, absent when the namespace predates the
// metadata. A metadata file that exists but cannot be parsed raises.
function readDeploymentChainId(path: string): number | undefined {
  const chainPath = join(path, ".chain");
  if (!existsSync(chainPath)) return undefined;
  let chainId: unknown;
  try {
    ({ chainId } = JSON.parse(readFileSync(chainPath, "utf-8")));
  } catch (error) {
    throw new Error(`unreadable deployment metadata: ${chainPath}`, {
      cause: error,
    });
  }
  const parsed = Number(chainId);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid chainId in ${chainPath}: ${String(chainId)}`);
  }
  return parsed;
}

// Deployment namespaces that target the same chain: every namespace named for one
// of the given base names — the canonical one, the dated archives a fresh deploy
// renamed aside, and the `-fork` / `-clean-` runtime sets. The network is included
// alongside the active namespace so a fork run (`sepolia-fork`) still recognises the
// canonical `sepolia` set as superseded, whose contracts hold live grants on the
// forked v1, and so a custom namespace (`--deployment-network staging`) still finds
// its own archives. A namespace whose recorded chain id matches none of the expected
// ids is excluded so unrelated deployment sets are never treated as this chain's
// orphans.
function siblingDeploymentNamespaces(opts: {
  deploymentsDir: string;
  networks: string[];
  chainIds: number[];
}): string[] {
  const root = resolve(opts.deploymentsDir);
  if (!existsSync(root)) return [];
  const bases = [...new Set(opts.networks)];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      bases.some((base) => name === base || name.startsWith(`${base}-`)),
    )
    .filter((name) => {
      const chainId = readDeploymentChainId(join(root, name));
      return chainId === undefined || opts.chainIds.includes(chainId);
    })
    .sort();
}

// Smallest block span worth requesting before a provider's refusal is taken at face
// value rather than as a demand for a narrower one.
const LOG_SCAN_MIN_SPAN = 1_000n;

// A decoded log with the position fields a consumer needs to order results or
// resume a scan. Decoded arguments stay untyped: the shape follows the event the
// caller passed, so each consumer narrows it to that event's parameters.
type ScannedLog = {
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
};

// Refusals of the span rather than of the query: the block range or the result count
// exceeded a server-side cap. Both are answered by requesting a narrower span.
const LOG_SCAN_SPAN_REFUSALS = [
  "block range",
  "range exceeds",
  // Some providers put the offending count between the words, e.g. Infura's
  // "range 11390003 exceeds limit of 10000", which "range exceeds" misses —
  // without this entry that refusal is rethrown as fatal instead of bisected.
  "exceeds limit",
  "narrow your filter",
  "query returned more than",
  "more than 10000 results",
  "log response size",
  "response size exceeded",
  "query timeout exceeded",
];

function isLogSpanRefusal(error: unknown): boolean {
  const message = errorMessageChain(error).join(" ").toLowerCase();
  return LOG_SCAN_SPAN_REFUSALS.some((refusal) => message.includes(refusal));
}

// One event's logs over a block range, in ascending block order. Providers cap
// `eth_getLogs` by block span or by result count, and a load-balanced endpoint may
// apply a cap to only some requests, so a refused span is bisected and each half
// requested in turn. The widest span the provider has accepted is carried across the
// scan, so the cap is discovered once rather than rediscovered per subrange. The
// blocks covered are the same either way; a refusal at the smallest span, or any
// error that is not about the span, raises.
async function readEventLogs(
  client: ReturnType<typeof publicClient>,
  args: {
    address: Address;
    event: AbiEvent;
    fromBlock?: bigint;
    toBlock: bigint;
  },
): Promise<ScannedLog[]> {
  let acceptedSpan: bigint | undefined;

  const readSpan = async (
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<ScannedLog[]> => {
    const span = toBlock - fromBlock + 1n;
    const bisect = () => {
      const mid = fromBlock + span / 2n;
      return readSpan(fromBlock, mid - 1n).then(async (left) => [
        ...left,
        ...(await readSpan(mid, toBlock)),
      ]);
    };
    if (acceptedSpan !== undefined && span > acceptedSpan) return bisect();
    try {
      const logs = await client.getLogs({
        address: args.address,
        event: args.event,
        fromBlock,
        toBlock,
      });
      if (acceptedSpan === undefined || span > acceptedSpan)
        acceptedSpan = span;
      return logs as unknown as ScannedLog[];
    } catch (error) {
      if (!isLogSpanRefusal(error) || span <= LOG_SCAN_MIN_SPAN) throw error;
      return bisect();
    }
  };
  return readSpan(args.fromBlock ?? 0n, args.toBlock);
}

// Every `controller` address one event has ever carried on a contract.
async function readControllerEventAddresses(
  client: ReturnType<typeof publicClient>,
  args: { address: Address; event: AbiEvent; toBlock: bigint },
): Promise<Address[]> {
  const logs = await readEventLogs(client, args);
  return logs.map((log) =>
    getAddress((log.args as { controller: Address }).controller),
  );
}

// Every address a v1 surface has ever had as a controller, across the whole chain.
async function discoverV1ControllerAddresses(
  client: ReturnType<typeof publicClient>,
  address: Address,
  events: readonly AbiEvent[],
): Promise<Address[]> {
  const toBlock = await client.getBlockNumber();
  const discovered = await Promise.all(
    events.map((event) =>
      readControllerEventAddresses(client, { address, event, toBlock }),
    ),
  );
  return discovered.flat();
}

// True when the call reached the chain and the contract declined to answer: it
// reverted, or the address returned no data because it holds no such function. The
// message is checked alongside the error type because a provider that flattens
// JSON-RPC errors loses the type viem would otherwise attach.
function isContractProbeRejection(error: unknown): boolean {
  if (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError ||
        cause instanceof AbiDecodingZeroDataError,
    ) !== null
  ) {
    return true;
  }
  const message = errorMessageChain(error).join(" ").toLowerCase();
  return (
    message.includes("execution reverted") ||
    message.includes("reverted for an unknown reason") ||
    message.includes("returned no data")
  );
}

// Filters discovered addresses down to this tooling's own handoff contracts, by
// asking each one which reverse registrar it forwards to. An address that declines
// the call, or answers with a different registrar, belongs to v1. Any other failure
// means the answer is unknown and is raised.
async function filterHandoffControllersByBackReference(
  client: ReturnType<typeof publicClient>,
  surface: JsonDeployment,
  getterName: string,
  addresses: Address[],
): Promise<Address[]> {
  const abi = [
    parseAbiItem(`function ${getterName}() view returns (address)`),
  ] as const;
  const matches = await Promise.all(
    addresses.map(async (address) => {
      try {
        const backReference = (await client.readContract({
          address,
          abi,
          functionName: getterName,
        })) as Address;
        return getAddress(backReference) === getAddress(surface.address);
      } catch (error) {
        if (!isContractProbeRejection(error)) throw error;
        return false;
      }
    }),
  );
  return addresses.filter((_, index) => matches[index]);
}

type V1ControllerAuditOptions = {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
};

// Builds the full picture of the v1 authorizations a migration hands out, across
// every v1 contract it grants against.
//
// Candidates come from three places: the named v1 registration controllers, the
// handoff contracts recorded in each deployment namespace on this chain (so a
// superseded deployment's instances are not left authorized), and a scan of each
// surface's controller events that catches addresses no local artifact describes.
//
// What a discovered address means differs by surface. On the BaseRegistrar the
// freeze bans all v1 minting, so every controller the active deployment did not
// authorize is revoked. On the reverse registrars only this tooling's own forwarders
// are in remit: a discovered address is claimed only when it reports forwarding to
// that registrar, and everything else — the official registrar controllers, which set
// reverse records during registration — is reported and left alone, since revoking
// them would break unrelated v1 behaviour.
//
// The active namespace's handoff contracts are read directly rather than through the
// namespace scan, so a namespace naming or chain-id mismatch can only ever cause an
// under-revoke, never revoke the live deployment's own grants.
async function auditV1Controllers(
  opts: V1ControllerAuditOptions & { client: ReturnType<typeof publicClient> },
): Promise<V1ControllerAudit> {
  const baseRegistrar = requireV1Deployment(
    opts.network,
    V1_BASE_REGISTRAR_NAME,
    opts,
  );
  const registrarSecurityController = loadV1Deployment(
    opts.network,
    "RegistrarSecurityController",
    opts,
  );
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const canonicalChainId = NETWORKS[opts.network].chain.id;

  // Candidates are tracked per v1 surface, since a handoff contract authorized on
  // one reverse registrar has no grant to answer for on the other.
  const surfaceCandidates = new Map<string, Map<Address, string>>();
  const candidatesFor = (surface: string) => {
    let candidates = surfaceCandidates.get(surface);
    if (!candidates) {
      candidates = new Map<Address, string>();
      surfaceCandidates.set(surface, candidates);
    }
    return candidates;
  };
  const keepAddresses = new Set<Address>();
  const addCandidate = (
    map: Map<Address, string>,
    address: Address,
    name: string,
  ) => {
    const key = getAddress(address);
    if (!map.has(key)) map.set(key, name);
  };

  const registrarCandidates = candidatesFor(V1_BASE_REGISTRAR_NAME);
  for (const name of V1_REGISTRATION_CONTROLLER_NAMES) {
    const controller = loadV1Deployment(opts.network, name, opts);
    if (controller) addCandidate(registrarCandidates, controller.address, name);
  }

  // Registers a namespace's handoff contracts against every surface they hold a
  // grant on, and reports how many the namespace actually describes.
  const addNamespaceHandoffControllers = (
    namespace: string,
    isActiveNamespace: boolean,
  ) => {
    let found = 0;
    for (const name of V1_HANDOFF_CONTROLLER_NAMES) {
      const controller = maybeLoadV2Deployment(deploymentsDir, namespace, name);
      if (!controller) continue;
      found += 1;
      if (isActiveNamespace) keepAddresses.add(getAddress(controller.address));
      const label = `${name} (${namespace})`;
      for (const [surface, handoffNames] of V1_HANDOFF_CONTROLLER_ENTRIES) {
        if (handoffNames.includes(name)) {
          addCandidate(candidatesFor(surface), controller.address, label);
        }
      }
    }
    return found;
  };

  // The active namespace is read directly, and first so its label wins, rather than
  // waiting for the scan below to surface it: an empty keep set would mark the live
  // deployment's own grants superseded and revoke them.
  if (addNamespaceHandoffControllers(deploymentNetwork, true) === 0) {
    throw new Error(
      `no handoff contract artifacts under ${join(resolve(deploymentsDir), deploymentNetwork)}: cannot tell the active deployment's v1 authorizations from a superseded deployment's`,
    );
  }

  for (const namespace of siblingDeploymentNamespaces({
    deploymentsDir,
    networks: [opts.network, deploymentNetwork],
    chainIds: [parseNumber(opts.chainId, canonicalChainId), canonicalChainId],
  })) {
    if (namespace === deploymentNetwork) continue;
    addNamespaceHandoffControllers(namespace, false);
  }

  const registrarRoute = await resolveRegistrarControlRoute({
    client: opts.client,
    baseRegistrar,
    registrarSecurityController,
  });
  const surfaces: Array<{
    surface: string;
    authority: JsonDeployment;
    target: JsonDeployment;
    revokeFunctionName: string;
    revokeArgs: (address: Address) => readonly unknown[];
    candidates: Map<Address, string>;
    events: readonly AbiEvent[];
    // Getter a discovered address must answer with this surface to be claimed as
    // this tooling's own. Absent on the BaseRegistrar, where the freeze revokes
    // every controller the active deployment did not authorize.
    backReferenceGetter?: string;
  }> = [
    {
      surface: "v1 BaseRegistrar",
      authority: baseRegistrar,
      target: registrarRoute.target,
      revokeFunctionName: registrarRoute.removeFunctionName,
      revokeArgs: (address) => [address],
      candidates: registrarCandidates,
      events: [V1_CONTROLLER_ADDED_EVENT, V1_CONTROLLER_REMOVED_EVENT],
    },
  ];

  for (const name of V1_REVERSE_REGISTRAR_NAMES) {
    const reverseRegistrar = requireV1Deployment(opts.network, name, opts);
    surfaces.push({
      surface: `v1 ${name}`,
      authority: reverseRegistrar,
      target: reverseRegistrar,
      revokeFunctionName: "setController",
      revokeArgs: (address) => [address, false],
      candidates: candidatesFor(name),
      events: [V1_CONTROLLER_CHANGED_EVENT],
      backReferenceGetter: V1_REVERSE_REGISTRAR_BACK_REFERENCES[name],
    });
  }

  const controllers: V1ControllerState[] = [];
  for (const surface of surfaces) {
    const discovered = await discoverV1ControllerAddresses(
      opts.client,
      surface.authority.address,
      surface.events,
    );

    // Addresses the history turned up that no artifact accounts for. Each is
    // claimed or disowned before it joins the candidate set, so the revoke pass
    // never has to guess whose grant it is.
    const unknown = [
      ...new Set(discovered.map((address) => getAddress(address))),
    ].filter((address) => !surface.candidates.has(address));
    const claimed = new Set(
      surface.backReferenceGetter
        ? await filterHandoffControllersByBackReference(
            opts.client,
            surface.authority,
            surface.backReferenceGetter,
            unknown,
          )
        : unknown,
    );
    const foreignAddresses = new Set(
      unknown.filter((address) => !claimed.has(address)),
    );
    for (const address of unknown) {
      addCandidate(
        surface.candidates,
        address,
        !surface.backReferenceGetter
          ? "unrecognized controller"
          : claimed.has(address)
            ? "handoff contract (no local artifact)"
            : "v1 controller",
      );
    }

    const entries = [...surface.candidates.entries()];
    if (entries.length === 0) continue;
    const flags = await readControllerFlags(
      opts.client,
      surface.authority,
      entries.map(([address]) => address),
    );
    entries.forEach(([address, name], index) => {
      controllers.push({
        surface: surface.surface,
        name,
        address,
        enabled: flags[index],
        keep: keepAddresses.has(address),
        foreign: foreignAddresses.has(address),
        target: surface.target,
        revokeFunctionName: surface.revokeFunctionName,
        revokeArgs: surface.revokeArgs(address),
      });
    });
  }

  return { controllers };
}

export async function disableV1Registrars(
  opts: V1ControllerAuditOptions & {
    privateKey?: `0x${string}`;
    impersonateOwner?: boolean;
    calldataOnly?: boolean;
    // Proceed without the reconciliation gate. Needed for a rehearsal on a chain
    // whose reconciliation cannot run, and as an operator escape hatch.
    skipPreconditions?: boolean;
    // How old the reconciliation pass may be, in blocks. Roughly a day by default.
    maxReconcileAgeBlocks?: string;
  },
) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);

  // This is the irreversible step: once v1 registration is frozen, a name that
  // pre-migration missed cannot be picked up by re-running it. So it will not run
  // until the reconciliation that proves nothing was missed has passed.
  if (!opts.skipPreconditions) {
    const deploymentsDir = resolve(
      opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
    );
    const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
    const failure = await checkPrecondition({
      record: readVerification(
        deploymentsDir,
        deploymentNetwork,
        PRECONDITION_RECONCILE,
      ),
      chainId: chain.id,
      currentBlock: await client.getBlockNumber(),
      // Proves the recorded block belongs to the chain about to be frozen. A
      // reconciliation run on a fork reports this chain's id, and the freeze cannot
      // be undone, so the record has to name a block this chain actually has.
      canonicalBlockHash: async (blockNumber) => {
        try {
          return (await client.getBlock({ blockNumber })).hash;
        } catch {
          return null;
        }
      },
      // A pass says the chain looked complete at the block it observed. Names keep
      // being registered on v1 until the freeze, so a pass from long ago says
      // nothing about now — re-run it rather than freezing on stale evidence.
      maxAgeBlocks: parseNumber(opts.maxReconcileAgeBlocks, 7200)
        ? BigInt(parseNumber(opts.maxReconcileAgeBlocks, 7200))
        : undefined,
    });
    if (failure) {
      throw new Error(
        `refusing to freeze v1 registrations: ${describePreconditionFailure(
          PRECONDITION_RECONCILE,
          failure,
        )}`,
      );
    }
    console.log(`precondition satisfied: ${PRECONDITION_RECONCILE}`);
  }

  const audit = await auditV1Controllers({ ...opts, client });

  for (const controller of audit.controllers) {
    const { enabled, keep, foreign } = controller;
    if (enabled && foreign) {
      console.log(
        `leaving v1-owned controller: ${describeV1Controller(controller)}`,
      );
    } else if (enabled && keep) {
      console.log(
        `keeping active deployment grant: ${describeV1Controller(controller)}`,
      );
    } else if (!enabled) {
      console.log(`already revoked: ${describeV1Controller(controller)}`);
    }
  }

  const toRemove = v1ControllersToRemove(audit);
  if (toRemove.length === 0) {
    console.log("no superseded v1 authorizations left to revoke");
    return;
  }

  // Surfaces are gated by different owners, so resolve one signing wallet per gate.
  const wallets = new Map<Address, ReturnType<typeof walletClient>>();
  const walletForGate = async (gate: JsonDeployment, ownerLabel: string) => {
    const key = getAddress(gate.address);
    const existing = wallets.get(key);
    if (existing) return existing;
    const { wallet } = await resolveOwnerGatedWallet({
      client,
      chain,
      rpcUrl: opts.rpcUrl,
      provider: opts.provider,
      gate,
      ownerLabel,
      privateKey: opts.privateKey,
      impersonateOwner: opts.impersonateOwner,
    });
    wallets.set(key, wallet);
    return wallet;
  };

  for (const controller of toRemove) {
    const { target, revokeFunctionName, revokeArgs, surface } = controller;
    const label = describeV1Controller(controller);
    const data = encodeFunctionData({
      abi: target.abi,
      functionName: revokeFunctionName,
      args: revokeArgs,
    });
    if (opts.calldataOnly) {
      printPreparedCall(`revoke ${label}`, target.address, data);
      continue;
    }

    const wallet = await walletForGate(target, `${surface} owner`);
    const hash = await wallet.writeContract({
      address: target.address,
      abi: target.abi,
      functionName: revokeFunctionName,
      args: revokeArgs,
    });
    await waitForSuccessfulReceipt(client, hash, `revoke ${label}`);
    console.log(`revoked ${label}`);
  }
}

async function authorizeTestnetV1PremigrationRegistrar(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  registrar?: Address;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const registrar = resolveDeploymentAddress(
    opts.registrar,
    deploymentsDir,
    deploymentNetwork,
    "TestnetV1PremigrationRegistrar",
  );
  await setV1RegistrarController({
    ...opts,
    controller: registrar,
    label: "TestnetV1PremigrationRegistrar",
    enabled: true,
  });
}

async function setV1RegistrarController(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  controller: Address;
  label: string;
  enabled: boolean;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const baseRegistrar = requireV1Deployment(
    opts.network,
    V1_BASE_REGISTRAR_NAME,
    opts,
  );
  const registrarSecurityController = loadV1Deployment(
    opts.network,
    "RegistrarSecurityController",
    opts,
  );
  const current = (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "controllers",
    args: [opts.controller],
  })) as boolean;
  console.log(`${opts.label} v1 registrar controller enabled: ${current}`);
  if (current === opts.enabled) return;

  const route = await resolveRegistrarControlRoute({
    client,
    baseRegistrar,
    registrarSecurityController,
  });
  const functionName = opts.enabled
    ? route.addFunctionName
    : route.removeFunctionName;
  await sendOwnerGatedWrite({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    provider: opts.provider,
    target: route.target,
    functionName,
    args: [opts.controller],
    ownerLabel: "v1 registrar owner",
    calldataLabel: `${opts.enabled ? "authorize" : "disable"} ${opts.label}`,
    receiptLabel: `${functionName} ${opts.label}`,
    privateKey: opts.privateKey,
    impersonateOwner: opts.impersonateOwner,
    calldataOnly: opts.calldataOnly,
  });
  if (opts.calldataOnly) return;

  const updated = (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "controllers",
    args: [opts.controller],
  })) as boolean;
  console.log(
    `${opts.label} v1 registrar controller enabled after phase: ${updated}`,
  );
  if (updated !== opts.enabled) {
    throw new Error(
      `${opts.label} v1 registrar controller did not reach expected state`,
    );
  }
}

async function activateV1Graveyard(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  graveyard?: Address;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const graveyard = resolveDeploymentAddress(
    opts.graveyard,
    deploymentsDir,
    deploymentNetwork,
    "Graveyard",
  );
  await setV1RegistrarController({
    ...opts,
    controller: graveyard,
    label: "Graveyard",
    enabled: true,
  });
}

async function activateV1HandoffControllers(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  graveyard?: Address;
  testnetV1PremigrationRegistrar?: Address;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const testnetV1PremigrationRegistrar =
    opts.testnetV1PremigrationRegistrar ??
    maybeLoadV2Deployment(
      deploymentsDir,
      deploymentNetwork,
      "TestnetV1PremigrationRegistrar",
    )?.address;

  if (testnetV1PremigrationRegistrar) {
    await setV1RegistrarController({
      ...opts,
      controller: testnetV1PremigrationRegistrar,
      label: "TestnetV1PremigrationRegistrar",
      enabled: true,
    });
  } else {
    console.log(
      "no TestnetV1PremigrationRegistrar deployment found; skipping testnet helper authorization",
    );
  }

  await activateV1Graveyard(opts);
}

// Minimal interface of a prior migration's ETHRenewerV1, which holds v1
// BaseRegistrar ownership once a migration has completed.
const PRIOR_RENEWER_ABI = [
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferRegistrarOwnership",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// On a chain that has already completed a migration, the v1 BaseRegistrar is
// owned by the previous deployment's ETHRenewerV1 contract, so the EOA-signed
// v1-owner controller steps cannot run. Reclaim ownership back to the v1 owner
// by routing through the prior renewer's `transferRegistrarOwnership`, signed by
// the prior renewer's own owner. No-op on a pristine chain (BaseRegistrar still
// owned by the v1 owner EOA) or once ownership is already with the v1 owner.
async function reclaimV1RegistrarOwnership(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  v1Owner: Address;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
}) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const baseRegistrar = requireV1Deployment(
    opts.network,
    V1_BASE_REGISTRAR_NAME,
    opts,
  );
  const currentOwner = (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "owner",
  })) as Address;
  if (getAddress(currentOwner) === getAddress(opts.v1Owner)) return;

  const code = await client.getCode({ address: currentOwner });
  if (!code || code === "0x") {
    console.log(
      `v1 BaseRegistrar owner ${currentOwner} is an EOA other than the v1 owner; skipping reclaim`,
    );
    return;
  }

  // On a pristine chain the BaseRegistrar is owned by the live
  // RegistrarSecurityController, not a prior deployment's ETHRenewerV1. Treating
  // it as a prior renewer would move ownership to the v1 owner EOA and break the
  // controller phases, which route addController through the security controller.
  const registrarSecurityController = loadV1Deployment(
    opts.network,
    "RegistrarSecurityController",
    opts,
  );
  if (
    registrarSecurityController &&
    getAddress(currentOwner) === getAddress(registrarSecurityController.address)
  ) {
    console.log(
      `v1 BaseRegistrar owner ${currentOwner} is the RegistrarSecurityController, not a prior renewer; skipping reclaim`,
    );
    return;
  }

  const gate: ContractRef = { address: currentOwner, abi: PRIOR_RENEWER_ABI };
  const { owner: priorRenewerOwner, wallet } = await resolveOwnerGatedWallet({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    provider: opts.provider,
    gate,
    ownerLabel: "prior renewer owner",
    privateKey: opts.privateKey,
    impersonateOwner: opts.impersonateOwner,
  });
  console.log(
    `reclaiming v1 BaseRegistrar ownership from prior renewer ${currentOwner} (owner ${priorRenewerOwner}) to ${opts.v1Owner}`,
  );
  const hash = await wallet.writeContract({
    address: currentOwner,
    abi: PRIOR_RENEWER_ABI,
    functionName: "transferRegistrarOwnership",
    args: [opts.v1Owner],
  });
  await waitForSuccessfulReceipt(
    client,
    hash,
    "reclaim v1 BaseRegistrar ownership to v1 owner",
  );

  const updatedOwner = (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "owner",
  })) as Address;
  if (getAddress(updatedOwner) !== getAddress(opts.v1Owner)) {
    throw new Error(
      `v1 BaseRegistrar ownership reclaim failed; owner is ${updatedOwner}`,
    );
  }
}

async function authorizeV1Renewer(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  ethRenewerV1?: Address;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const ethRenewerV1 = resolveDeploymentAddress(
    opts.ethRenewerV1,
    deploymentsDir,
    deploymentNetwork,
    "ETHRenewerV1",
  );

  await setV1RegistrarController({
    ...opts,
    controller: ethRenewerV1,
    label: "ETHRenewerV1",
    enabled: true,
  });

  return ethRenewerV1;
}

async function activateV1RenewerAndTransferOwnership(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  ethRenewerV1?: Address;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const ethRenewerV1 = await authorizeV1Renewer(opts);

  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const baseRegistrar = requireV1Deployment(
    opts.network,
    V1_BASE_REGISTRAR_NAME,
    opts,
  );
  const registrarSecurityController = loadV1Deployment(
    opts.network,
    "RegistrarSecurityController",
    opts,
  );
  const currentOwner = (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "owner",
  })) as Address;
  console.log(`v1 BaseRegistrar owner: ${currentOwner}`);
  if (getAddress(currentOwner) === getAddress(ethRenewerV1)) return;

  const route = await resolveRegistrarControlRoute({
    client,
    baseRegistrar,
    registrarSecurityController,
    owner: currentOwner,
  });
  await sendOwnerGatedWrite({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    provider: opts.provider,
    target: route.target,
    functionName: route.transferFunctionName,
    args: [ethRenewerV1],
    ownerLabel: "v1 registrar owner",
    calldataLabel: "transfer v1 BaseRegistrar ownership to ETHRenewerV1",
    receiptLabel: "transfer v1 BaseRegistrar ownership to ETHRenewerV1",
    privateKey: opts.privateKey,
    impersonateOwner: opts.impersonateOwner,
    calldataOnly: opts.calldataOnly,
  });
  if (opts.calldataOnly) return;

  const updatedOwner = (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "owner",
  })) as Address;
  console.log(`v1 BaseRegistrar owner after phase: ${updatedOwner}`);
  if (getAddress(updatedOwner) !== getAddress(ethRenewerV1)) {
    throw new Error(`unexpected v1 BaseRegistrar owner: ${updatedOwner}`);
  }
}

// Asserts the *complete* set of v1 authorizations the migration hands out — across
// the BaseRegistrar and the reverse registrars — not just the named registration
// controllers. Anything enabled that the active deployment did not authorize can mint
// or mutate v1 names and so fails the check.
export async function verifyV1RegistrarsDisabled(
  opts: V1ControllerAuditOptions & {
    // Also assert the active deployment's own grants are present. Off by default
    // because the handoff contracts are authorized across several phases: the
    // reverse adapters in phase 1, ETHRenewerV1 in phase 4, and the Graveyard in
    // phase 6. Turn it on once the last of them has run.
    requireActiveGrants?: boolean;
  },
) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const audit = await auditV1Controllers({ ...opts, client });

  for (const controller of audit.controllers) {
    const state = controller.enabled
      ? controller.foreign
        ? "enabled (v1-owned, outside migration remit)"
        : controller.keep
          ? "enabled (authorized by active deployment)"
          : "ENABLED"
      : controller.keep
        ? "MISSING (expected to be authorized by active deployment)"
        : "disabled";
    console.log(`${describeV1Controller(controller)}: ${state}`);
  }

  const unexpected = v1ControllersToRemove(audit);
  if (unexpected.length > 0) {
    throw new Error(
      `superseded v1 authorizations still enabled: ${unexpected
        .map(describeV1Controller)
        .join(", ")}`,
    );
  }

  if (opts.requireActiveGrants) {
    const missing = v1ControllersMissing(audit);
    if (missing.length > 0) {
      throw new Error(
        `active deployment authorizations missing: ${missing
          .map(describeV1Controller)
          .join(", ")}`,
      );
    }
  }
}

// Gives an address a balance of a real ERC-20 on a fork.
//
// Mainnet whitelists real USDC/DAI instead of the free-mint mocks, so every
// paid-registration smoke is skipped there and the entire ETHRegistrar payment path
// goes unexercised on the one network it matters most for. Writing the balance
// directly lets the same smokes run against the real token.
//
// Tenderly exposes a purpose-built method. On Anvil the balances mapping has to be
// located first: its slot is an implementation detail that differs per token (and
// per proxy), so candidate slots are written and read back until `balanceOf` agrees.
async function setErc20Balance(opts: {
  client: ReturnType<typeof publicClient>;
  token: Address;
  account: Address;
  amount: bigint;
  tenderly: boolean;
}): Promise<void> {
  const readBalance = async () =>
    (await opts.client.readContract({
      address: opts.token,
      abi: Artifact_MockERC20.abi,
      functionName: "balanceOf",
      args: [opts.account],
    })) as bigint;

  if (opts.tenderly) {
    await requestAny(opts.client, [
      {
        method: "tenderly_setErc20Balance",
        params: [opts.token, opts.account, `0x${opts.amount.toString(16)}`],
      },
    ]);
    if ((await readBalance()) < opts.amount) {
      throw new Error(
        `tenderly_setErc20Balance did not fund ${opts.account} with ${opts.token}`,
      );
    }
    return;
  }

  const original = await readBalance();
  const value = `0x${opts.amount.toString(16).padStart(64, "0")}` as const;
  for (let slot = 0; slot < 32; slot++) {
    const key = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [opts.account, BigInt(slot)],
      ),
    );
    const previous = (await opts.client.request({
      method: "eth_getStorageAt" as never,
      params: [opts.token, key, "latest"] as never,
    })) as `0x${string}`;
    await requestAny(opts.client, [
      { method: "anvil_setStorageAt", params: [opts.token, key, value] },
      { method: "hardhat_setStorageAt", params: [opts.token, key, value] },
    ]);
    if ((await readBalance()) === opts.amount) return;
    // Wrong slot: put back exactly what was there rather than leaving a stray write.
    await requestAny(opts.client, [
      { method: "anvil_setStorageAt", params: [opts.token, key, previous] },
      { method: "hardhat_setStorageAt", params: [opts.token, key, previous] },
    ]);
  }
  throw new Error(
    `could not locate the balances slot for ${opts.token} (balance still ${original})`,
  );
}

// Resolves a set of names through a Universal Resolver and records every answer.
// Used to capture the pre-cutover state and to re-read it afterwards, so phase 7 can
// be verified by comparison rather than by checking that resolution returns
// something non-zero.
async function captureResolutionSnapshot(opts: {
  client: ReturnType<typeof publicClient>;
  universalResolver: Address;
  names: string[];
  coinTypes?: readonly bigint[];
  textKeys?: readonly string[];
  // Ask exactly the records a previous snapshot captured, per name, instead of the
  // configured set. Verification uses this so both halves answer the same questions.
  recordsByName?: Map<string, string[]>;
}): Promise<ResolutionSnapshot> {
  const names: NameSnapshot[] = [];

  for (const name of opts.names) {
    const previous = opts.recordsByName?.get(name);
    const queries = previous
      ? queriesFromSnapshot(name, previous)
      : recordQueries(name, {
          coinTypes: opts.coinTypes,
          textKeys: opts.textKeys,
        });
    const records: Record<string, Hex | null> = {};
    let resolver: Address = zeroAddress;

    for (const query of queries) {
      try {
        const [answer, usedResolver] = (await opts.client.readContract({
          address: opts.universalResolver,
          abi: Artifact_UniversalResolverV2.abi,
          functionName: "resolve",
          args: [dnsEncodeName(name), query.call],
        })) as [Hex, Address];
        records[query.label] = answer;
        if (usedResolver) resolver = usedResolver;
      } catch {
        // A record a name does not carry reverts, which is a legitimate answer and
        // recorded as such — the comparison cares whether it *changes*.
        records[query.label] = null;
      }
    }
    names.push({ name, resolver, records });
  }

  return {
    capturedAt: new Date().toISOString(),
    chainId: await opts.client.getChainId(),
    resolverAddress: opts.universalResolver,
    names,
  };
}

// How many candidate names to probe, and how many resolvable ones to keep. The pool
// is larger than the sample because most names carry no records at all.
const RESOLUTION_CANDIDATE_POOL = 25;
const RESOLUTION_SAMPLE_SIZE = 5;

// Picks names that actually carry records, so the cutover comparison has something
// to compare. Candidates are probed with the address lookups alone rather than the
// full record set, keeping the cost proportional to the pool size rather than to the
// records per name.
async function selectResolvableNames(opts: {
  client: ReturnType<typeof publicClient>;
  universalResolver: Address;
  candidates: string[];
  limit: number;
}): Promise<string[]> {
  const chosen: string[] = [];
  for (const name of opts.candidates) {
    if (chosen.length >= opts.limit) break;
    const probe = await captureResolutionSnapshot({
      client: opts.client,
      universalResolver: opts.universalResolver,
      names: [name],
      coinTypes: [],
      textKeys: [],
    });
    if (snapshotCarriesRecords(probe)) chosen.push(name);
  }
  return chosen;
}

function dnsEncodeName(name: string): Hex {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    const labelBytes = Buffer.from(label, "utf8");
    if (labelBytes.length > 255) throw new Error(`label is too long: ${label}`);
    bytes.push(labelBytes.length, ...labelBytes);
  }
  bytes.push(0);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export async function snapshotResolution(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  names: string;
  universalResolver?: Address;
  outFile: string;
  coinTypes?: string;
  textKeys?: string;
}) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const names = opts.names
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error("no names given to snapshot");

  const snapshot = await captureResolutionSnapshot({
    client,
    universalResolver:
      opts.universalResolver ?? DEPLOYED_UNIVERSAL_RESOLVER_PROXY,
    names,
    coinTypes: opts.coinTypes
      ? opts.coinTypes.split(",").map((value) => BigInt(value.trim()))
      : undefined,
    textKeys: opts.textKeys
      ? opts.textKeys.split(",").map((value) => value.trim())
      : undefined,
  });

  writeFileSync(opts.outFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const recordCount = snapshot.names.reduce(
    (total, entry) => total + Object.keys(entry.records).length,
    0,
  );
  console.log(
    `captured ${snapshot.names.length} name(s), ${recordCount} record(s) -> ${opts.outFile}`,
  );
  return snapshot;
}

export async function verifyResolution(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  snapshotFile: string;
  universalResolver?: Address;
  reportOnly?: boolean;
}) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const before = JSON.parse(
    readFileSync(opts.snapshotFile, "utf8"),
  ) as ResolutionSnapshot;

  const after = await captureResolutionSnapshot({
    client,
    universalResolver:
      opts.universalResolver ??
      (before.resolverAddress as Address) ??
      DEPLOYED_UNIVERSAL_RESOLVER_PROXY,
    names: before.names.map((entry) => entry.name),
    // Re-ask exactly the questions the snapshot answered. Falling back to the
    // defaults would compare a different record set: anything captured under custom
    // coin types or text keys would be absent here and read as a revert.
    recordsByName: new Map(
      before.names.map((entry) => [entry.name, Object.keys(entry.records)]),
    ),
  });

  const differences = diffResolutionSnapshots(before, after);
  console.log(
    `compared ${before.names.length} name(s) against ${opts.snapshotFile}`,
  );
  if (differences.length === 0) {
    console.log("resolution unchanged across the cutover");
    return differences;
  }

  for (const difference of differences.slice(0, 40)) {
    console.error(describeDifference(difference));
  }
  if (differences.length > 40) {
    console.error(`...and ${differences.length - 40} more`);
  }
  if (!opts.reportOnly) {
    throw new Error(
      `resolution changed across the cutover for ${differences.length} record(s)`,
    );
  }
  return differences;
}

// Name of the reconciliation gate, shared by the check that records it and the
// phase that requires it.
const PRECONDITION_RECONCILE = "premigration-reconcile";

const EAC_ROLES_CHANGED_EVENT = parseAbiItem(
  "event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 previousRoles, uint256 newRoles)",
);

// Registries whose role matrix is audited, and the contracts expected to hold roles
// on each. Derived from the deploy scripts rather than from the README table, which
// documents contracts that are never deployed and omits grants that are.
const AUDITED_REGISTRIES = ["RootRegistry", "ETHRegistry"] as const;

// Root-scope grants each deploy script makes, keyed by the registry they land on.
// `deployer` is the constructor's initial role holder; the rest are explicit grants.
//
// Expectations are the bitmaps as granted, not as effective. An admin bit does not
// add the regular role to what an account *holds* — `withAdminRolesApplied` governs
// what an account may grant or revoke for others
// (`EnhancedAccessControl._getSettableRoles`), not `roles()`. The distinction is
// worth stating because it is not a privilege boundary: an account holding
// REGISTRAR_ADMIN can grant itself REGISTRAR at any time, which is exactly what the
// devnet fixture does. Treat an admin bit as implying the regular one when reasoning
// about authority, while still auditing the two separately.
const EXPECTED_ROOT_ROLES: Record<
  (typeof AUDITED_REGISTRIES)[number],
  Array<{ deployment: string; roles: bigint; onlyBeforeHandoff?: boolean }>
> = {
  RootRegistry: [
    { deployment: "@deployer", roles: DEPLOYMENT_ROLES.ROOT_REGISTRY_ROOT },
    { deployment: "@owner", roles: ROLES.REGISTRY.CAN_NAME },
  ],
  ETHRegistry: [
    { deployment: "@deployer", roles: DEPLOYMENT_ROLES.ETH_REGISTRY_ROOT },
    { deployment: "@owner", roles: ROLES.REGISTRY.CAN_NAME },
    {
      deployment: "ETHRegistrar",
      roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    },
    // BatchRegistrar seeds pre-migration reservations and is stripped of its roles
    // in phase 6, so what it should hold depends on where the migration is.
    {
      deployment: "BatchRegistrar",
      roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
      onlyBeforeHandoff: true,
    },
    { deployment: "ETHRenewerV1", roles: DEPLOYMENT_ROLES.ETH_RENEWER_V1_ROOT },
    {
      deployment: "UnlockedMigrationController",
      roles: DEPLOYMENT_ROLES.MIGRATION_CONTROLLER_ROOT,
    },
    {
      deployment: "LockedMigrationController",
      roles: DEPLOYMENT_ROLES.MIGRATION_CONTROLLER_ROOT,
    },
    {
      deployment: "TestnetV1PremigrationRegistrar",
      roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    },
    {
      deployment: "FastETHRegistrar",
      roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    },
    {
      deployment: "MockPremigrator",
      roles: DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT,
    },
  ],
};

// Token-scoped grants the deploy scripts make, keyed by the registry they land on.
// `register` grants its role bitmap to the new owner at the *token's* resource, not
// at the root, so none of these appear in a root-only audit.
//
// Only RootRegistry is audited this way. Its token set is the TLDs the deployment
// creates, so an unexpected scoped grant there means something. ETHRegistry's token
// set is the whole namespace — every registered name grants its owner roles at its
// own resource — so the same sweep would report the entire namespace as unexpected.
const EXPECTED_TOKEN_ROLES: Record<
  (typeof AUDITED_REGISTRIES)[number],
  Array<{ label: string; deployment: string; roles: bigint }>
> = {
  RootRegistry: [
    // 01_ETHRegistry.ts registers `eth` to the deployer.
    {
      label: "eth",
      deployment: "@deployer",
      roles: DEPLOYMENT_ROLES.ETH_TOKEN,
    },
    // 01_ReverseMirror.ts registers `reverse` to the owner.
    {
      label: "reverse",
      deployment: "@owner",
      roles: DEPLOYMENT_ROLES.REVERSE_REGISTRY_ROOT,
    },
  ],
  ETHRegistry: [],
};

const AUDIT_TOKEN_SCOPES: Record<(typeof AUDITED_REGISTRIES)[number], boolean> =
  { RootRegistry: true, ETHRegistry: false };

// Every (resource, account) a role has ever been granted at on a registry. Used only
// to decide who to ask about — what they actually hold is read live, because expiry
// and re-registration change effective authority without emitting anything.
//
// The resource is kept rather than discarded: a grant scoped to a token is invisible
// at the root, so dropping it here is what let a scoped privilege go unexamined.
async function discoverRoleGrants(
  client: ReturnType<typeof publicClient>,
  registry: Address,
  fromBlock: bigint,
): Promise<Array<{ resource: bigint; account: Address }>> {
  const toBlock = await client.getBlockNumber();
  const logs = await readEventLogs(client, {
    address: registry,
    event: EAC_ROLES_CHANGED_EVENT,
    fromBlock,
    toBlock,
  });
  const grants = new Map<string, { resource: bigint; account: Address }>();
  for (const log of logs) {
    const args = log.args as { resource?: bigint; account?: Address };
    if (!args.account || args.resource === undefined) continue;
    const account = getAddress(args.account);
    grants.set(`${args.resource}|${account.toLowerCase()}`, {
      resource: args.resource,
      account,
    });
  }
  return [...grants.values()];
}

// How a resource is named in the audit output. The root is the root; a token scope is
// named by its label where the deployment defines one, and by its resource id where
// it does not.
function describeScope(
  resource: bigint,
  labelByResource: Map<string, string>,
): string {
  if (resource === 0n) return "root";
  return labelByResource.get(resource.toString()) ?? `resource ${resource}`;
}

export async function verifyV2Roles(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  deployer?: Address;
  owner?: Address;
  fromBlock?: string;
  reportOnly?: boolean;
  // Audit the state before phase 6 hands the registrar over, where BatchRegistrar
  // still holds the roles it seeds reservations with.
  preHandoff?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);

  const owner = opts.owner ?? NETWORKS[opts.network].defaultOwner;
  // Falling back to the owner here made the audit compare every constructor grant
  // against the wrong address: on a live deployment the deployer and the owner
  // differ, so the real deployer was reported as unexpected and the owner as missing
  // the roles it never had. The deploy transaction recorded in the namespace names
  // the deployer; where no record carries one, say so rather than guess.
  const deployer =
    opts.deployer ??
    AUDITED_REGISTRIES.map((name) =>
      maybeLoadV2Deployment(deploymentsDir, deploymentNetwork, name),
    )
      .map((record) => record && deploymentOrigin(record))
      .find((address): address is Address => address !== undefined);
  if (!deployer) {
    throw new Error(
      `cannot determine the deployer for ${deploymentNetwork}: no deployment record carries its deploy transaction. Pass --deployer.`,
    );
  }

  console.log(
    `auditing the ${opts.preHandoff ? "pre-handoff" : "post-handoff"} role matrix (pass --pre-handoff to audit before phase 6)`,
  );

  const holders: RoleHolder[] = [];
  const expectations: RoleExpectation[] = [];

  for (const registryName of AUDITED_REGISTRIES) {
    const registry = maybeLoadV2Deployment(
      deploymentsDir,
      deploymentNetwork,
      registryName,
    );
    if (!registry) continue;

    const resolveAccount = (deployment: string): Address | undefined => {
      if (deployment === "@deployer") return deployer;
      if (deployment === "@owner") return owner;
      return maybeLoadV2Deployment(
        deploymentsDir,
        deploymentNetwork,
        deployment,
      )?.address;
    };

    for (const entry of EXPECTED_ROOT_ROLES[registryName]) {
      // A pre-handoff-only grant must be absent once phase 6 has run, so after the
      // handoff it is expected to hold nothing rather than simply not being checked.
      if (entry.onlyBeforeHandoff && !opts.preHandoff) continue;
      const address = resolveAccount(entry.deployment);
      // A contract this deployment does not include simply has no expectation; the
      // discovery pass below still reports it if it somehow holds roles.
      if (!address) continue;
      expectations.push({
        contract: registryName,
        scope: "root",
        account: getAddress(address),
        roles: entry.roles,
      });
    }

    // The resource a token's grants live at moves when the name expires or is
    // re-registered, so it is resolved live rather than taken from the grant event.
    const labelByResource = new Map<string, string>();
    const wanted = new Map<string, { resource: bigint; account: Address }>();
    const want = (resource: bigint, account: Address) => {
      wanted.set(`${resource}|${account.toLowerCase()}`, { resource, account });
    };

    for (const entry of EXPECTED_TOKEN_ROLES[registryName]) {
      const address = resolveAccount(entry.deployment);
      if (!address) continue;
      const resource = (await client.readContract({
        address: registry.address,
        abi: Artifact_PermissionedRegistry.abi,
        functionName: "getResource",
        args: [labelId(entry.label)],
      })) as bigint;
      labelByResource.set(resource.toString(), entry.label);
      expectations.push({
        contract: registryName,
        scope: entry.label,
        account: getAddress(address),
        roles: entry.roles,
      });
      want(resource, getAddress(address));
    }

    const fromBlock =
      opts.fromBlock !== undefined
        ? BigInt(opts.fromBlock)
        : (readDeploymentBlock(
            deploymentsDir,
            deploymentNetwork,
            registryName,
          ) ?? 0n);
    const discovered = await discoverRoleGrants(
      client,
      registry.address,
      fromBlock,
    );

    // Everyone ever granted anything here is asked about the root, whichever scope
    // they were discovered at: a token grantee may hold root roles too.
    const rootAccounts = new Set<Address>([
      ...discovered.map((grant) => grant.account),
      ...expectations
        .filter((expectation) => expectation.contract === registryName)
        .map((expectation) => getAddress(expectation.account as Address)),
    ]);
    for (const account of rootAccounts) want(0n, account);

    // A scoped grant survives in storage after the name it belongs to is expired or
    // re-registered, but the resource it sits at is no longer the one the registry
    // consults, so the roles cannot be exercised. Reporting those would be noise;
    // the current resource is the only one that carries authority.
    if (AUDIT_TOKEN_SCOPES[registryName]) {
      const scoped = discovered.filter((grant) => grant.resource !== 0n);
      const resources = [...new Set(scoped.map((grant) => grant.resource))];
      const current = await client.multicall({
        allowFailure: true,
        contracts: resources.map((resource) => ({
          address: registry.address,
          abi: Artifact_PermissionedRegistry.abi,
          functionName: "getResource",
          args: [resource],
        })),
      });
      const live = new Set<string>();
      let orphaned = 0;
      for (const [index, resource] of resources.entries()) {
        const result = current[index];
        if (result.status === "failure") continue;
        if ((result.result as bigint) === resource)
          live.add(resource.toString());
        else orphaned++;
      }
      for (const grant of scoped) {
        if (live.has(grant.resource.toString())) {
          want(grant.resource, grant.account);
        }
      }
      if (orphaned > 0) {
        console.log(
          `${registryName}: ${orphaned} scoped grant resource(s) superseded by a re-registration, so no longer reachable`,
        );
      }
    }

    // Reading live is what makes the audit sound: a replay of the discovery events
    // would report grants that expiry or a version bump has since made unreachable.
    const pairs = [...wanted.values()];
    const results = await client.multicall({
      allowFailure: true,
      contracts: pairs.map((pair) => ({
        address: registry.address,
        abi: Artifact_PermissionedRegistry.abi,
        functionName: "roles",
        args: [pair.resource, pair.account],
      })),
    });

    for (const [index, pair] of pairs.entries()) {
      const result = results[index];
      const scope = describeScope(pair.resource, labelByResource);
      if (result.status === "failure") {
        throw new Error(
          `${registryName}: roles(${scope}, ${pair.account}) failed: ${result.error}`,
        );
      }
      const roles = result.result as bigint;
      if (roles === 0n) continue;
      holders.push({
        contract: registryName,
        address: registry.address,
        scope,
        account: pair.account,
        roles,
      });
    }
  }

  for (const holder of holders) {
    console.log(
      `${holder.contract} [${holder.scope}] ${holder.account}: ${describeRoleBitmap(holder.roles)}`,
    );
  }

  const findings = diffRoleMatrix(holders, expectations);
  if (findings.length === 0) {
    console.log(`role audit passed: ${holders.length} holder(s) as expected`);
    return findings;
  }

  for (const finding of findings) {
    console.error(describeRoleFinding(finding));
  }
  if (!opts.reportOnly) {
    throw new Error(`role audit failed: ${findings.length} finding(s)`);
  }
  return findings;
}

// Compares a transaction about to be signed against the prepared one it claims to be.
//
// The owner-gated phases emit calldata that travels by hand into a Safe. Nothing
// checks that what gets signed is what was produced, and a wrong target or argument
// is invisible by inspection. This is the check that makes "verified the calldata"
// a real statement.
export async function verifyOwnerTransaction(opts: {
  file: string;
  to: string;
  data: string;
  value?: string;
  role?: string;
}) {
  const prepared = readPreparedOwnerTransactions(opts.file, opts.role);
  if (prepared.length === 0) {
    throw new Error(`No prepared owner transactions found in ${opts.file}`);
  }

  const actual = { to: opts.to, data: opts.data, value: opts.value };

  // The Safe transaction should correspond to exactly one prepared call. Reporting
  // the closest near-miss is what makes a mismatch diagnosable rather than just a
  // refusal.
  let closest: { label: string; verdict: CalldataVerdict } | null = null;
  for (const candidate of prepared) {
    const verdict = compareCalldata(
      { to: candidate.to, data: candidate.data, value: candidate.value },
      actual,
    );
    const label = preparedOwnerTransactionLabel(candidate);
    if (verdict.kind === "match") {
      console.log(`${describeVerdict(verdict)}: ${label}`);
      console.log(`  to:   ${candidate.to}`);
      console.log(`  data: ${candidate.data}`);
      return { matched: label };
    }
    // A same-target mismatch is a closer near-miss than a different-target one, so
    // it wins when reporting what went wrong.
    if (closest === null || verdict.kind !== "target-mismatch") {
      closest = { label, verdict };
    }
  }

  console.error(
    `no prepared transaction in ${opts.file} matches this one (${prepared.length} candidate(s))`,
  );
  if (closest) {
    console.error(`closest was ${closest.label}:`);
    console.error(describeVerdict(closest.verdict));
  }
  throw new Error(
    "the transaction about to be signed does not match any prepared transaction",
  );
}

// Checks that the registrar can actually take money for a name.
//
// Nothing verifies this today, and it fails quietly: the registrar is enabled, roles
// are correct, every wiring check passes — and registration still reverts because
// the price oracle rejects the payment token, or succeeds while sending the fee to an
// address nobody controls. On mainnet the tokens are real USDC/DAI, which the fork
// rehearsal skipped until now, so this had no coverage at all.
export async function verifyRegistrarEconomics(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  expectedBeneficiary?: Address;
  paymentTokens?: string;
  reportOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);

  const ethRegistrar = loadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistrar",
  );
  const problems: string[] = [];

  const oracle = (await client.readContract({
    address: ethRegistrar.address,
    abi: ethRegistrar.abi,
    functionName: "rentPriceOracle",
  })) as Address;
  console.log(`ETHRegistrar rent price oracle: ${oracle}`);
  if (getAddress(oracle) === getAddress(zeroAddress)) {
    problems.push("rent price oracle is the zero address");
  } else if ((await client.getCode({ address: oracle })) === undefined) {
    problems.push(`rent price oracle ${oracle} has no code`);
  }

  const beneficiary = (await client.readContract({
    address: ethRegistrar.address,
    abi: ethRegistrar.abi,
    functionName: "BENEFICIARY",
  })) as Address;
  console.log(`ETHRegistrar beneficiary: ${beneficiary}`);
  // Registration fees are transferred here. A zero beneficiary means every payment
  // is burned, which no other check would notice.
  if (getAddress(beneficiary) === getAddress(zeroAddress)) {
    problems.push(
      "beneficiary is the zero address; registration fees would be burnt",
    );
  }
  if (
    opts.expectedBeneficiary &&
    getAddress(beneficiary) !== getAddress(opts.expectedBeneficiary)
  ) {
    problems.push(
      `beneficiary is ${beneficiary}, expected ${opts.expectedBeneficiary}`,
    );
  }

  // Every token a user is expected to be able to pay with must be accepted by the
  // oracle, and must actually quote a price.
  const tokens = (
    opts.paymentTokens
      ? opts.paymentTokens.split(",").map((value) => value.trim())
      : [
          maybeLoadV2Deployment(deploymentsDir, deploymentNetwork, "MockUSDC")
            ?.address,
          maybeLoadV2Deployment(deploymentsDir, deploymentNetwork, "MockDAI")
            ?.address,
          // The free-mint mocks are testnet-only (00_MockTokens returns early where
          // the DAO owns the deployment), so on mainnet the real tokens the oracle is
          // configured with are the whole list. Both of them: checking only one
          // leaves the other able to be unaccepted or unpriceable and still pass.
          ...(opts.network === "mainnet" ? [MAINNET_USDC, MAINNET_DAI] : []),
        ]
  ).filter((token): token is string => Boolean(token));

  if (tokens.length === 0) {
    problems.push("no payment tokens to check");
  }
  for (const token of tokens) {
    const address = getAddress(token as Address);
    const accepted = (await client.readContract({
      address: oracle,
      abi: Artifact_StandardRentPriceOracle.abi,
      functionName: "isPaymentToken",
      args: [address],
    })) as boolean;
    if (!accepted) {
      problems.push(`payment token ${address} is not accepted by the oracle`);
      continue;
    }
    // Accepting a token is not the same as being able to price in it.
    try {
      const price = (await client.readContract({
        address: ethRegistrar.address,
        abi: ethRegistrar.abi,
        functionName: "getRegisterPrice",
        args: ["averagelengthname", V2_REGISTRATION_DURATION, address],
      })) as [bigint, bigint];
      const total = price[0] + price[1];
      console.log(`payment token ${address}: accepted, price ${total}`);
      if (total === 0n) {
        problems.push(`payment token ${address} prices a name at zero`);
      }
    } catch (error) {
      problems.push(
        `payment token ${address} accepted but pricing failed: ${errorMessageChain(error)[0]}`,
      );
    }
  }

  for (const problem of problems) console.error(problem);
  if (problems.length > 0 && !opts.reportOnly) {
    throw new Error(
      `registrar economics verification failed: ${problems.length} problem(s)`,
    );
  }
  if (problems.length === 0) {
    console.log(
      `registrar economics verified: ${tokens.length} payment token(s)`,
    );
  }
  return problems;
}

// Checks that every contract a namespace describes is actually the contract running
// at that address, and that its cross-contract references stay inside the namespace.
//
// Deploying fresh onto an already-migrated chain archives the previous namespace and
// leaves it on-chain. An address leaking from the archive into the live set is the
// failure mode that invites, and it is invisible to every other check: the wrong
// contract answers calls perfectly well, it is just the wrong one.
export async function verifyDeployment(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  reportOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = resolve(
    opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
  );
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);

  const namespaceDir = join(deploymentsDir, deploymentNetwork);
  if (!existsSync(namespaceDir)) {
    throw new Error(`no deployment namespace at ${namespaceDir}`);
  }
  const files = readdirSync(namespaceDir).filter(
    (name) => name.endsWith(".json") && !name.startsWith("."),
  );
  if (files.length === 0) {
    throw new Error(`no deployment records under ${namespaceDir}`);
  }

  // Addresses this namespace owns. Any reference to something outside it — and not
  // to a v1 contract — points at another deployment.
  const ownAddresses = new Map<string, string>();
  type DeploymentRecord = {
    address?: Address;
    deployedBytecode?: string;
    immutableReferences?: ImmutableReferences;
    argsData?: string;
    receipt?: unknown;
    transaction?: unknown;
  };
  const byName = new Map<string, DeploymentRecord>();
  const records: Array<{ name: string; record: DeploymentRecord }> = [];
  for (const file of files) {
    const name = file.slice(0, -".json".length);
    const record = JSON.parse(
      readFileSync(join(namespaceDir, file), "utf8"),
    ) as (typeof records)[number]["record"];
    byName.set(name, record);
    if (!record.address) continue;
    records.push({ name, record });
    ownAddresses.set(getAddress(record.address).toLowerCase(), name);
  }

  // Addresses recorded by the *other* namespaces under the same deployments
  // directory — archived deployments, and rehearsal namespaces. An immutable
  // pointing into one of these is the leak this check exists to find.
  const foreignAddresses = new Map<string, string>();
  for (const entry of readdirSync(deploymentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === deploymentNetwork) continue;
    const dir = join(deploymentsDir, entry.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      let foreign: { address?: Address };
      try {
        foreign = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }
      if (!foreign.address) continue;
      const key = getAddress(foreign.address).toLowerCase();
      if (ownAddresses.has(key) || foreignAddresses.has(key)) continue;
      foreignAddresses.set(
        key,
        `${entry.name}/${file.slice(0, -".json".length)}`,
      );
    }
  }

  const problems: string[] = [];
  let matched = 0;
  let skipped = 0;
  let immutablesChecked = 0;

  // The bytecode comparison blanks the immutable ranges, so a record leaking a
  // contract of the same type from an archived namespace matches on every byte it
  // looks at. The constructor-set addresses are read back out of the deployed code
  // and checked against the namespaces on disk, which is the only place the leak
  // shows.
  const auditImmutables = (
    name: string,
    address: Address,
    onChain: string,
    immutableReferences: ImmutableReferences | undefined,
  ) => {
    for (const immutable of extractImmutableValues(
      onChain,
      immutableReferences,
    )) {
      if (immutable.inconsistent) {
        problems.push(
          `${name} ${address}: immutable ${immutable.astId} differs between its copies in the deployed code`,
        );
        continue;
      }
      const referenced = immutableAsAddress(immutable);
      if (!referenced) continue;
      immutablesChecked++;
      // Set membership is what decides whether these bytes are a wiring at all: a
      // scalar immutable has the same shape as an address and will never collide
      // with a deployed one, so anything the namespaces do not know is left alone.
      const foreign = foreignAddresses.get(referenced.toLowerCase());
      if (foreign) {
        problems.push(
          `${name} ${address}: immutable at byte ${immutable.offsets[0]} points at ${referenced}, recorded in namespace ${foreign} rather than ${deploymentNetwork}`,
        );
      }
    }
  };

  for (const { name, record } of records) {
    const address = getAddress(record.address as Address);
    if (!record.deployedBytecode || record.deployedBytecode === "0x") {
      skipped++;
      continue;
    }
    // An address this deployment adopted rather than deployed — the reused URPs, for
    // instance — has no deploy transaction here. Its artifact describes a contract
    // built elsewhere, so comparing bytecode compares two different builds.
    if (!record.receipt && !record.transaction) {
      skipped++;
      continue;
    }
    // A proxy-backed record holds the *implementation's* bytecode at the *proxy's*
    // address, so the proxy's own artifact is what runs there.
    const proxyRecord = byName.get(`${name}_Proxy`);
    const expected =
      proxyRecord && proxyRecord.deployedBytecode ? proxyRecord : record;

    const onChain = await client.getCode({ address });
    const comparison = compareDeployedBytecode({
      onChain,
      artifact: expected.deployedBytecode,
      immutableReferences: expected.immutableReferences,
    });
    if (comparison.kind === "match") {
      matched++;
      auditImmutables(
        name,
        address,
        onChain ?? "",
        expected.immutableReferences,
      );
      continue;
    }
    problems.push(describeComparison(name, address, comparison));
  }

  console.log(
    `deployment integrity: ${matched} verified, ${skipped} without comparable bytecode, ${problems.length} problem(s)`,
  );
  console.log(
    `immutable wiring: ${immutablesChecked} constructor-set value(s) checked against ${foreignAddresses.size} address(es) recorded outside ${deploymentNetwork}`,
  );
  for (const problem of problems) console.error(problem);

  if (problems.length > 0 && !opts.reportOnly) {
    throw new Error(
      `deployment verification failed for ${problems.length} contract(s)`,
    );
  }
  return { matched, skipped, problems };
}

// The reverse adapters are what let v2 write reverse records on the v1 registrars.
// They are granted in phase 1 and must stay granted for the rest of the migration,
// but the controller audit is one-sided — it only looks for grants that should be
// gone — so a revoked adapter passes it silently. This asserts the other direction.
export async function verifyReverseAdapters(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);

  // Each adapter, the v1 registrar it should be a controller on, and the getter it
  // exposes naming that registrar — so a mismatched pair is caught as well as a
  // missing grant.
  const pairs = [
    {
      adapterName: "ReverseRegistrarAdapter",
      registrarName: "ReverseRegistrar",
      backReference: "REVERSE_REGISTRAR",
    },
    {
      adapterName: "DefaultReverseRegistrarAdapter",
      registrarName: "DefaultReverseRegistrar",
      backReference: "DEFAULT_REVERSE_REGISTRAR",
    },
  ] as const;

  const problems: string[] = [];
  let checked = 0;

  for (const pair of pairs) {
    const adapter = maybeLoadV2Deployment(
      deploymentsDir,
      deploymentNetwork,
      pair.adapterName,
    );
    // Not every deployment carries both adapters; only what was deployed is checked.
    if (!adapter) continue;
    const registrar = loadV1Deployment(opts.network, pair.registrarName, opts);
    if (!registrar) {
      problems.push(`${pair.registrarName}: no v1 deployment artifact`);
      continue;
    }
    checked++;

    const enabled = (await client.readContract({
      address: registrar.address,
      abi: registrar.abi,
      functionName: "controllers",
      args: [adapter.address],
    })) as boolean;
    console.log(
      `${pair.registrarName}: ${pair.adapterName} ${adapter.address} controller=${enabled}`,
    );
    if (!enabled) {
      problems.push(
        `${pair.adapterName} ${adapter.address} is not a ${pair.registrarName} controller`,
      );
      continue;
    }

    // An adapter granted on the wrong registrar would still read as enabled, so
    // confirm it points back at the registrar holding the grant.
    try {
      const target = (await client.readContract({
        address: adapter.address,
        abi: [
          parseAbiItem(
            `function ${pair.backReference}() view returns (address)`,
          ),
        ],
        functionName: pair.backReference,
      })) as Address;
      if (getAddress(target) !== getAddress(registrar.address)) {
        problems.push(
          `${pair.adapterName} forwards to ${target}, not ${pair.registrarName} ${registrar.address}`,
        );
      }
    } catch (error) {
      if (!isContractProbeRejection(error)) throw error;
      problems.push(
        `${pair.adapterName} ${adapter.address} did not answer ${pair.backReference}()`,
      );
    }
  }

  if (checked === 0) {
    throw new Error(
      `no reverse adapters found under ${join(resolve(deploymentsDir), deploymentNetwork)}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `reverse adapter verification failed: ${problems.join(", ")}`,
    );
  }
  console.log(`reverse adapters verified: ${checked}`);
}

export async function setV1ReverseDefaultResolver(opts: {
  network: MigrationNetwork;
  rpcUrl?: string;
  chainId?: string;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
}) {
  const rpcUrl = requireRpcUrl(opts, opts.network);
  const chain = forkChain(
    opts.network,
    parseNumber(opts.chainId, NETWORKS[opts.network].chain.id),
    rpcUrl,
  );
  const client = publicClient(rpcUrl, chain, opts.provider);
  const reverseRegistrar = requireV1Deployment(
    opts.network,
    "ReverseRegistrar",
    opts,
  );
  const publicResolver = requireV1Deployment(
    opts.network,
    "PublicResolver",
    opts,
  );
  const currentResolver = (await client.readContract({
    address: reverseRegistrar.address,
    abi: reverseRegistrar.abi,
    functionName: "defaultResolver",
  })) as Address;
  console.log(`v1 reverse registrar default resolver: ${currentResolver}`);
  if (getAddress(currentResolver) === getAddress(publicResolver.address)) {
    return;
  }

  // setDefaultResolver is owner-gated; the v1 ReverseRegistrar owner is the v1
  // owner, not the deployer, so a key controlling it (or impersonation) is
  // required.
  await sendOwnerGatedWrite({
    client,
    chain,
    rpcUrl,
    provider: opts.provider,
    target: reverseRegistrar,
    functionName: "setDefaultResolver",
    args: [publicResolver.address],
    ownerLabel: "v1 reverse registrar owner",
    calldataLabel: "set v1 reverse default resolver",
    receiptLabel: "set v1 reverse default resolver",
    privateKey: opts.privateKey,
    impersonateOwner: opts.impersonateOwner,
    calldataOnly: opts.calldataOnly,
  });
  if (opts.calldataOnly) return;

  const updatedResolver = (await client.readContract({
    address: reverseRegistrar.address,
    abi: reverseRegistrar.abi,
    functionName: "defaultResolver",
  })) as Address;
  console.log(
    `v1 reverse registrar default resolver after update: ${updatedResolver}`,
  );
  if (getAddress(updatedResolver) !== getAddress(publicResolver.address)) {
    throw new Error(
      `unexpected v1 reverse default resolver: ${updatedResolver}`,
    );
  }
}

// Resolve the v2 ETHRegistry to write to: an explicit address (with the default
// PermissionedRegistry abi) or the deployment artifact (carrying its own abi).
function resolveRegistry(opts: {
  registry?: Address;
  deploymentsDir: string;
  deploymentNetwork: string;
}): ContractRef {
  const registry = opts.registry
    ? null
    : loadV2Deployment(
        opts.deploymentsDir,
        opts.deploymentNetwork,
        "ETHRegistry",
      );
  return {
    address: opts.registry ?? registry!.address,
    abi: registry?.abi ?? Artifact_PermissionedRegistry.abi,
  };
}

// Read whether an account holds the registrar/renew root roles on the registry.
async function readHasRegistrarRoles(
  client: ReturnType<typeof publicClient>,
  registry: ContractRef,
  account: Address,
): Promise<boolean> {
  return (await client.readContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "hasRootRoles",
    args: [REGISTRAR_ROLES, account],
  })) as boolean;
}

async function enableV2Registrar(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  registry?: Address;
  ethRegistrar?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const registry = resolveRegistry({
    registry: opts.registry,
    deploymentsDir,
    deploymentNetwork,
  });
  const ethRegistrar = resolveDeploymentAddress(
    opts.ethRegistrar,
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistrar",
  );
  const beforeEnabled = await readHasRegistrarRoles(
    client,
    registry,
    ethRegistrar,
  );
  console.log(`v2 registrar already enabled: ${beforeEnabled}`);
  if (beforeEnabled) return;

  await sendAdminWrite({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    target: registry,
    functionName: "grantRootRoles",
    args: [REGISTRAR_ROLES, ethRegistrar],
    receiptLabel: "enable v2 registrar",
    privateKey: opts.privateKey,
    impersonateAccount: opts.impersonateAccount,
  });
  const afterEnabled = await readHasRegistrarRoles(
    client,
    registry,
    ethRegistrar,
  );
  console.log(`v2 registrar enabled after phase: ${afterEnabled}`);
}

async function disableBatchRegistrar(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  registry?: Address;
  batchRegistrar?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const registry = resolveRegistry({
    registry: opts.registry,
    deploymentsDir,
    deploymentNetwork,
  });
  const batchRegistrar = resolveDeploymentAddress(
    opts.batchRegistrar,
    deploymentsDir,
    deploymentNetwork,
    "BatchRegistrar",
  );
  const beforeEnabled = await readHasRegistrarRoles(
    client,
    registry,
    batchRegistrar,
  );
  console.log(`batch registrar enabled before phase: ${beforeEnabled}`);
  if (!beforeEnabled) return;

  await sendAdminWrite({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    target: registry,
    functionName: "revokeRootRoles",
    args: [REGISTRAR_ROLES, batchRegistrar],
    receiptLabel: `disable batch registrar ${batchRegistrar}`,
    privateKey: opts.privateKey,
    impersonateAccount: opts.impersonateAccount,
  });
  const afterEnabled = await readHasRegistrarRoles(
    client,
    registry,
    batchRegistrar,
  );
  console.log(`batch registrar enabled after phase: ${afterEnabled}`);
  if (afterEnabled)
    throw new Error("batch registrar still has registrar/renew roles");
}

async function verifyBatchRegistrarDisabled(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  registry?: Address;
  batchRegistrar?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const registry = resolveRegistry({
    registry: opts.registry,
    deploymentsDir,
    deploymentNetwork,
  });
  const batchRegistrar = resolveDeploymentAddress(
    opts.batchRegistrar,
    deploymentsDir,
    deploymentNetwork,
    "BatchRegistrar",
  );
  const enabled = await readHasRegistrarRoles(client, registry, batchRegistrar);
  console.log(`batch registrar enabled: ${enabled}`);
  if (enabled)
    throw new Error("batch registrar still has registrar/renew roles");
}

export async function checkBatchRegistrarOwner(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  batchRegistrar?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  expectedOwner?: Address;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const batchRegistrar = resolveDeploymentAddress(
    opts.batchRegistrar,
    deploymentsDir,
    deploymentNetwork,
    "BatchRegistrar",
  );
  const owner = (await client.readContract({
    address: batchRegistrar,
    abi: Artifact_BatchRegistrar.abi,
    functionName: "owner",
  })) as Address;

  console.log(`batch registrar: ${batchRegistrar}`);
  console.log(`batch registrar owner: ${owner}`);
  if (
    opts.expectedOwner !== undefined &&
    getAddress(owner) !== getAddress(opts.expectedOwner)
  ) {
    throw new Error(
      `unexpected BatchRegistrar owner: expected ${opts.expectedOwner}, got ${owner}`,
    );
  }
}

async function readBatchRegistrarOwner(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  batchRegistrar: Address;
}) {
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  return (await client.readContract({
    address: opts.batchRegistrar,
    abi: Artifact_BatchRegistrar.abi,
    functionName: "owner",
  })) as Address;
}

function preMigrationSigner(account: Address): {
  privateKey?: `0x${string}`;
  account?: Address;
} {
  return getAddress(account) === getAddress(DEFAULT_ANVIL_DEPLOYER)
    ? { privateKey: DEFAULT_ANVIL_KEY }
    : { account };
}

function adminSigner(account: Address): {
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
} {
  return getAddress(account) === getAddress(DEFAULT_ANVIL_DEPLOYER)
    ? { privateKey: DEFAULT_ANVIL_KEY }
    : { impersonateAccount: account };
}

async function verifyV2Registrar(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  registry?: Address;
  ethRegistrar?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const registry = resolveRegistry({
    registry: opts.registry,
    deploymentsDir,
    deploymentNetwork,
  });
  const ethRegistrar = resolveDeploymentAddress(
    opts.ethRegistrar,
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistrar",
  );
  const enabled = await readHasRegistrarRoles(client, registry, ethRegistrar);
  console.log(`v2 registrar enabled: ${enabled}`);
  if (!enabled) throw new Error("v2 registrar is not enabled");
}

async function verifyUrp(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  topUrp?: Address;
  managedUrp?: Address;
  expectedTopImplementation?: Address;
  expectedManagedImplementation?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain);
  const topUrp = opts.topUrp ?? DEPLOYED_UNIVERSAL_RESOLVER_PROXY;
  const managedUrp = resolveDeploymentAddress(
    opts.managedUrp,
    deploymentsDir,
    deploymentNetwork,
    "ManagedUniversalResolverProxy",
  );
  const top = getContract({
    address: topUrp,
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    client,
  });
  const managed = getContract({
    address: managedUrp,
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    client,
  });
  const topAdmin = (await top.read.admin()) as Address;
  const topImplementation = (await top.read.implementation()) as Address;
  const managedAdmin = (await managed.read.admin()) as Address;
  const managedImplementation =
    (await managed.read.implementation()) as Address;

  console.log(`top URP: ${topUrp}`);
  console.log(`top URP admin: ${topAdmin}`);
  console.log(`top URP implementation: ${topImplementation}`);
  console.log(`managed URP: ${managedUrp}`);
  console.log(`managed URP admin: ${managedAdmin}`);
  console.log(`managed URP implementation: ${managedImplementation}`);

  if (
    opts.expectedTopImplementation &&
    getAddress(topImplementation) !== getAddress(opts.expectedTopImplementation)
  ) {
    throw new Error("top URP implementation does not match expected address");
  }
  if (
    opts.expectedManagedImplementation &&
    getAddress(managedImplementation) !==
      getAddress(opts.expectedManagedImplementation)
  ) {
    throw new Error(
      "managed URP implementation does not match expected address",
    );
  }
}

async function switchTopUrpToManaged(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  topUrp?: Address;
  managedUrp?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
  calldataOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const topUrp = opts.topUrp ?? DEPLOYED_UNIVERSAL_RESOLVER_PROXY;
  const managedUrp = resolveDeploymentAddress(
    opts.managedUrp,
    deploymentsDir,
    deploymentNetwork,
    "ManagedUniversalResolverProxy",
  );
  // When the top URP already fronts the managed URP (the reuse flow), the switch
  // is already done — never touch the externally-administered top URP.
  const currentTopImplementation = (await client.readContract({
    address: topUrp,
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    functionName: "implementation",
  })) as Address;
  if (getAddress(currentTopImplementation) === getAddress(managedUrp)) {
    console.log(`top URP already fronts managed URP: ${managedUrp}`);
    return;
  }
  await sendAdminWrite({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    provider: opts.provider,
    target: {
      address: topUrp,
      abi: Artifact_UpgradableUniversalResolverProxy.abi,
    },
    functionName: "upgradeTo",
    args: [managedUrp],
    calldataLabel: "switch UniversalResolverProxy to managed URP",
    receiptLabel: "switch top URP to managed URP",
    privateKey: opts.privateKey,
    impersonateAccount: opts.impersonateAccount,
    calldataOnly: opts.calldataOnly,
  });
  if (opts.calldataOnly) return;
  const top = getContract({
    address: topUrp,
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    client,
  });
  const actualImplementation = (await top.read.implementation()) as Address;
  if (getAddress(actualImplementation) !== getAddress(managedUrp)) {
    throw new Error(`top URP implementation mismatch: ${actualImplementation}`);
  }
  console.log(`top URP implementation: ${actualImplementation}`);
}

async function upgradeManagedUrp(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId?: string;
  provider?: RpcProvider;
  managedUrp?: Address;
  implementation?: Address;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
  calldataOnly?: boolean;
}) {
  const deploymentNetwork = opts.deploymentNetwork ?? opts.network;
  const deploymentsDir = opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const chain = migrationChain(opts);
  const client = publicClient(opts.rpcUrl, chain, opts.provider);
  const managedUrp = resolveDeploymentAddress(
    opts.managedUrp,
    deploymentsDir,
    deploymentNetwork,
    "ManagedUniversalResolverProxy",
  );
  const implementation = resolveDeploymentAddress(
    opts.implementation,
    deploymentsDir,
    deploymentNetwork,
    "UniversalResolverV2",
  );
  // When reusing an existing managed URP that already fronts this implementation
  // (e.g. a deterministic redeploy to the same address), the upgrade is a no-op
  // and the proxy reverts with SameImplementation; treat it as already done.
  const currentImplementation = (await client.readContract({
    address: managedUrp,
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    functionName: "implementation",
  })) as Address;
  if (getAddress(currentImplementation) === getAddress(implementation)) {
    console.log(`managed URP already at implementation: ${implementation}`);
    return;
  }
  await sendAdminWrite({
    client,
    chain,
    rpcUrl: opts.rpcUrl,
    provider: opts.provider,
    target: {
      address: managedUrp,
      abi: Artifact_UpgradableUniversalResolverProxy.abi,
    },
    functionName: "upgradeTo",
    args: [implementation],
    calldataLabel: "upgrade managed URP",
    receiptLabel: "upgrade managed URP",
    privateKey: opts.privateKey,
    impersonateAccount: opts.impersonateAccount,
    calldataOnly: opts.calldataOnly,
  });
  if (opts.calldataOnly) return;
  const managed = getContract({
    address: managedUrp,
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    client,
  });
  const actualImplementation = (await managed.read.implementation()) as Address;
  if (getAddress(actualImplementation) !== getAddress(implementation)) {
    throw new Error(
      `managed URP implementation mismatch: ${actualImplementation}`,
    );
  }
  console.log(`managed URP implementation: ${actualImplementation}`);
}

type DeployV2Options = {
  network: MigrationNetwork;
  rpcUrl?: string;
  chainId?: string;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  saveDeployments?: boolean;
  fresh?: boolean;
  tags?: readonly string[];
  tenderly?: boolean;
  includeTestnetPremigrationRegistrar?: boolean;
  deferV1OwnerTransactions?: boolean;
  deferredV1OwnerTransactionsFile?: string;
  cleanTestnet?: boolean;
  deployer?: AccountDefinition;
  deployerPrivateKey?: `0x${string}`;
  owner?: AccountDefinition;
  ownerPrivateKey?: `0x${string}`;
  urManager?: AccountDefinition;
  urManagerPrivateKey?: `0x${string}`;
  v1Owner?: AccountDefinition;
  v1OwnerPrivateKey?: `0x${string}`;
  impersonateV1Owner?: boolean;
  rpcCompatibility?: boolean;
  debugRpc?: boolean;
  provider?: RpcProvider;
};

type DeployV1Options = {
  network: MigrationNetwork;
  rpcUrl?: string;
  chainId?: string;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  saveDeployments?: boolean;
  tenderly?: boolean;
  deployer?: AccountDefinition;
  deployerPrivateKey?: `0x${string}`;
  owner?: AccountDefinition;
  ownerPrivateKey?: `0x${string}`;
  rpcCompatibility?: boolean;
  debugRpc?: boolean;
  provider?: RpcProvider;
};

type RunForkFullOptions = {
  network: MigrationNetwork;
  rpcUrl?: string;
  provider?: RpcProvider;
  direct?: boolean;
  chainId?: string;
  port?: string;
  csvFile: string;
  batchSize?: string;
  initialLimit?: string;
  finishLimit?: string;
  workDir?: string;
  saveDeployments?: boolean;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  tenderly?: boolean;
  includeTestnetPremigrationRegistrar?: boolean;
  cleanTestnet?: boolean;
  rpcStateControls?: boolean;
  debugRpc?: boolean;
  keepAnvil?: boolean;
  snapshotFile?: string;
  deployer?: Address;
  deployerPrivateKey?: `0x${string}`;
  owner?: Address;
  ownerPrivateKey?: `0x${string}`;
  v1Owner?: Address;
  v1OwnerPrivateKey?: `0x${string}`;
  urManager?: Address;
  urManagerPrivateKey?: `0x${string}`;
  resumeFromPhase?: string;
  // Fail rather than silently running a reduced set of smoke checks.
  requireFullCoverage?: boolean;
  // Extra names to snapshot across the resolution cutover, comma-separated.
  resolutionNames?: string;
};

type RunCleanTestnetFullOptions = Omit<
  RunForkFullOptions,
  "csvFile" | "resumeFromPhase" | "direct" | "keepAnvil"
> & {
  csvFile?: string;
  resumeExistingDeployments?: boolean;
};

function uniqueTags(tags: readonly (string | undefined)[]): string[] {
  return [...new Set(tags.filter((tag): tag is string => Boolean(tag)))];
}

function normalizeAccountAddress(value: AccountDefinition): AccountDefinition {
  if (
    typeof value === "string" &&
    value.startsWith("0x") &&
    value.length === 42
  ) {
    return value.toLowerCase() as Address;
  }
  return value;
}

function normalizeAccountType(value: AccountType): AccountType {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, account]) => [
        key,
        normalizeAccountAddress(account as AccountDefinition),
      ]),
    ) as AccountType;
  }
  return normalizeAccountAddress(value as AccountDefinition);
}

function signerAccountDefinition(
  privateKey: `0x${string}` | undefined,
  fallback: AccountDefinition | undefined,
): AccountDefinition | undefined {
  return privateKey
    ? (`privateKey:${privateKey}` as AccountDefinition)
    : fallback;
}

function keyAddress(
  privateKey: `0x${string}` | undefined,
): Address | undefined {
  return privateKey ? privateKeyToAccount(privateKey).address : undefined;
}

function privateKeyForAddress(
  address: Address,
  keys: PrivateKeyOptions,
): `0x${string}` | undefined {
  const expected = getAddress(address);
  const entries = [
    keys.deployerPrivateKey,
    keys.ownerPrivateKey,
    keys.v1OwnerPrivateKey,
    keys.urManagerPrivateKey,
  ];
  return entries.find((privateKey) => {
    const account = keyAddress(privateKey);
    return account !== undefined && getAddress(account) === expected;
  });
}

function requirePrivateKeyForAddress(
  address: Address,
  keys: PrivateKeyOptions,
  label: string,
): `0x${string}` {
  const privateKey = privateKeyForAddress(address, keys);
  if (!privateKey) {
    throw new Error(
      `${label} ${address} is not backed by a configured private key`,
    );
  }
  return privateKey;
}

function applyAccountOverride(
  accounts: Record<string, AccountType>,
  name: string,
  value: AccountDefinition | undefined,
) {
  if (value !== undefined) {
    accounts[name] = { default: normalizeAccountAddress(value) };
  }
}

// Returns the first candidate key that controls `target`, or — when no target
// address is known — the first available key. Used so an owner/admin private
// key is only applied when it actually signs for the resolved account, keeping
// an explicit or network-default owner (e.g. the mainnet DAO) from being
// silently replaced by a fallback deployer key.
function signerKeyForAccount(
  target: Address | undefined,
  candidates: Array<`0x${string}` | undefined>,
): `0x${string}` | undefined {
  const keys = candidates.filter((key): key is `0x${string}` => Boolean(key));
  if (!target) return keys[0];
  return keys.find(
    (key) =>
      getAddress(privateKeyToAccount(key).address) === getAddress(target),
  );
}

// Resolve env-configured signer keys for the standalone rehearsal CLIs, attaching
// each key only when it controls the requested account so an env key is never used
// to sign for a different address. Used by the direct/real-RPC paths that lack the
// impersonation a local node or Tenderly fork would provide.
function envMigrationSignerKeys(accounts: {
  deployer?: Address;
  owner?: Address;
  v1Owner?: Address;
  urManager?: Address;
}): PrivateKeyOptions {
  const deployerKey = envPrivateKey("DEPLOYER_KEY");
  return {
    deployerPrivateKey: signerKeyForAccount(accounts.deployer, [deployerKey]),
    ownerPrivateKey: signerKeyForAccount(accounts.owner, [
      envPrivateKey("OWNER_KEY"),
      deployerKey,
    ]),
    v1OwnerPrivateKey: signerKeyForAccount(accounts.v1Owner, [
      envPrivateKey("SEPOLIA_V1_OWNER_KEY", "V1_OWNER_KEY"),
      deployerKey,
    ]),
    urManagerPrivateKey: signerKeyForAccount(accounts.urManager, [
      envPrivateKey("UR_MANAGER_KEY"),
      deployerKey,
    ]),
  };
}

function addressForImpersonation(
  account: AccountDefinition | undefined,
  fallback: Address,
  name: string,
): Address {
  if (account === undefined) return fallback;
  if (
    typeof account === "string" &&
    account.startsWith("0x") &&
    account.length === 42
  ) {
    return getAddress(account) as Address;
  }
  throw new Error(
    `${name} impersonation requires an address or omitted account override`,
  );
}

function chainIdOverrideProvider(
  provider: RpcProvider,
  chainId: number,
): RpcProvider {
  return {
    async request(args) {
      if (args.method === "eth_chainId") {
        return `0x${chainId.toString(16)}`;
      }
      return provider.request(args);
    },
  };
}

function buildDeployV2RockethConfig(
  opts: DeployV2Options,
  chainId: number,
  chain: Chain,
): UserConfig<any, any> {
  const network = NETWORKS[opts.network];
  const deploymentNetwork = opts.deploymentNetwork ?? network.environment;
  const baseConfig = rockethConfig as UserConfig<any, any>;
  const impersonatedV1Owner = opts.impersonateV1Owner
    ? addressForImpersonation(opts.v1Owner, network.defaultV1Owner, "v1Owner")
    : undefined;
  const signerProvider = impersonatedV1Owner
    ? impersonationProvider(opts)
    : undefined;
  const accounts = Object.fromEntries(
    Object.entries(baseConfig.accounts ?? {}).map(([name, account]) => [
      name,
      normalizeAccountType(account as AccountType),
    ]),
  ) as Record<string, AccountType>;
  applyAccountOverride(
    accounts,
    "deployer",
    signerAccountDefinition(opts.deployerPrivateKey, opts.deployer),
  );
  applyAccountOverride(
    accounts,
    "owner",
    signerAccountDefinition(opts.ownerPrivateKey, opts.owner),
  );
  applyAccountOverride(
    accounts,
    "urManager",
    signerAccountDefinition(opts.urManagerPrivateKey, opts.urManager),
  );
  applyAccountOverride(
    accounts,
    "v1Owner",
    signerAccountDefinition(opts.v1OwnerPrivateKey, opts.v1Owner),
  );
  if (impersonatedV1Owner) {
    accounts.v1Owner = {
      default: `impersonate:${impersonatedV1Owner.toLowerCase()}`,
    };
  }

  const baseEnvironments = baseConfig.environments ?? {};
  const baseEnvironment = baseEnvironments[network.environment] ?? {};
  const baseEnvironmentTags = baseEnvironment.overrides?.tags ?? [];
  const baseChainTags = [
    ...(baseConfig.chains?.[network.chain.id]?.tags ?? []),
    ...(baseConfig.chains?.[chainId]?.tags ?? []),
  ];
  const tags = uniqueTags([
    opts.network === "sepolia" ? "sepolia" : undefined,
    opts.tags?.includes("hca") ? "hca" : undefined,
    "deferV2Registrar",
    opts.tenderly ? "tenderly" : undefined,
    opts.includeTestnetPremigrationRegistrar
      ? "testnet-premigration-registrar"
      : undefined,
    opts.cleanTestnet ? "clean-testnet" : undefined,
    ...network.chainTags,
    ...baseChainTags,
    ...baseEnvironmentTags,
  ]);

  return {
    ...baseConfig,
    deployments: resolve(
      opts.deploymentsDir ?? baseConfig.deployments ?? DEFAULT_DEPLOYMENTS_DIR,
    ),
    accounts,
    signerProtocols: {
      ...(baseConfig.signerProtocols ?? {}),
      ...(opts.rpcUrl
        ? { privateKey: privateKeySignerProtocol(opts.rpcUrl, chain) }
        : {}),
      ...(impersonatedV1Owner && signerProvider
        ? {
            impersonate: async (protocolString: string) => {
              const address = getAddress(
                protocolString.slice("impersonate:".length),
              ).toLowerCase() as Address;
              return {
                type: "remote",
                signer: impersonatedAccountProvider(signerProvider, address),
              };
            },
          }
        : {}),
    } as any,
    chains: {
      ...(baseConfig.chains ?? {}),
      [chainId]: {
        ...(baseConfig.chains?.[network.chain.id] ?? {}),
        ...(baseConfig.chains?.[chainId] ?? {}),
        info: chain,
        ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
        tags,
      },
    },
    environments: {
      ...baseEnvironments,
      [deploymentNetwork]: {
        ...baseEnvironment,
        chain: chainId,
        overrides: {
          ...baseEnvironment.overrides,
          tags,
        },
      },
    },
  };
}

function buildDeployV1RockethConfig(
  opts: DeployV1Options,
  chainId: number,
  chain: Chain,
): UserConfig<any, any> {
  const network = NETWORKS[opts.network];
  const deploymentNetwork = opts.deploymentNetwork ?? network.environment;
  const baseConfig = rockethConfig as UserConfig<any, any>;
  const accounts = Object.fromEntries(
    Object.entries(baseConfig.accounts ?? {}).map(([name, account]) => [
      name,
      normalizeAccountType(account as AccountType),
    ]),
  ) as Record<string, AccountType>;
  applyAccountOverride(
    accounts,
    "deployer",
    signerAccountDefinition(opts.deployerPrivateKey, opts.deployer),
  );
  applyAccountOverride(
    accounts,
    "owner",
    signerAccountDefinition(opts.ownerPrivateKey, opts.owner),
  );

  // `allow_unsafe` is deliberately absent: it widens the DNS suffix batches past
  // what the fixed gas cap on the TLD-enabling batch can pay for, which leaves no
  // suffix enabled. The narrow batches cost more requests but estimate their own
  // gas and check each suffix first.
  const tags = uniqueTags([
    "test",
    "legacy",
    "use_root",
    opts.tenderly ? "tenderly" : undefined,
  ]);

  return {
    ...baseConfig,
    deployments: resolve(opts.deploymentsDir ?? LOCAL_V1_DEPLOYMENTS_DIR),
    accounts,
    signerProtocols: {
      ...(baseConfig.signerProtocols ?? {}),
      ...(opts.rpcUrl
        ? { privateKey: privateKeySignerProtocol(opts.rpcUrl, chain) }
        : {}),
    },
    chains: {
      ...(baseConfig.chains ?? {}),
      [chainId]: {
        ...(baseConfig.chains?.[network.chain.id] ?? {}),
        ...(baseConfig.chains?.[chainId] ?? {}),
        info: chain,
        ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
        tags,
      },
    },
    environments: {
      ...(baseConfig.environments ?? {}),
      [deploymentNetwork]: {
        chain: chainId,
        // Our own v1 steps come first so they can seed a deployment the bundled
        // scripts then skip, which is how a bundled step is corrected without
        // modifying the submodule.
        scripts: ["deploy-v1", "lib/ens-contracts/deploy"],
        overrides: { tags },
      },
    },
  };
}

async function waitForSuccessfulReceipt(
  client: ReturnType<typeof publicClient>,
  hash: `0x${string}`,
  label: string,
) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`${label} reverted: ${hash}`);
  }
  return receipt;
}

// Normalize the provider (RPC-compatibility shim, chain-id override) and resolve
// the chain id and chain, shared by the v1 and v2 deploy entrypoints.
async function resolveDeployProviderAndChain(opts: {
  network: MigrationNetwork;
  rpcUrl?: string;
  chainId?: string;
  provider?: RpcProvider;
  rpcCompatibility?: boolean;
  debugRpc?: boolean;
}): Promise<{ provider?: RpcProvider; chainId: number; chain: Chain }> {
  const network = NETWORKS[opts.network];
  if (!opts.rpcUrl && !opts.provider) {
    throw new Error("Missing rpcUrl or provider");
  }
  let provider =
    opts.provider && opts.rpcCompatibility
      ? withRpcCompatibility(opts.provider, Boolean(opts.debugRpc))
      : opts.provider;
  const chainId = opts.chainId
    ? parseNumber(opts.chainId, network.chain.id)
    : provider
      ? await getProviderChainId(provider)
      : network.chain.id;
  if (provider && opts.chainId) {
    provider = chainIdOverrideProvider(provider, chainId);
  }
  const chain = forkChain(
    opts.network,
    chainId,
    opts.rpcUrl ?? network.chain.rpcUrls.default.http[0],
  );
  return { provider, chainId, chain };
}

// Print each deployed contract's address, or a placeholder when the artifact is
// absent from the namespace.
function logDeployedAddresses(
  env: { get(name: string): { address: Address } },
  names: readonly string[],
  prefix = "",
): void {
  for (const name of names) {
    try {
      console.log(`${prefix}${name}: ${env.get(name).address}`);
    } catch {
      console.log(`${prefix}${name}: <not deployed>`);
    }
  }
}

async function deployV1(opts: DeployV1Options) {
  const network = NETWORKS[opts.network];
  const deploymentNetwork = opts.deploymentNetwork ?? network.environment;
  // The v1 deploy scripts refuse to deploy the batch gateway provider without a
  // gateway list. A throwaway v1 stack resolves through the local batch gateway,
  // the same one the devnet setup uses; an operator value still wins.
  process.env.BATCH_GATEWAY_URLS ??= JSON.stringify([LOCAL_BATCH_GATEWAY_URL]);
  const { provider, chainId, chain } =
    await resolveDeployProviderAndChain(opts);
  const env = await loadAndExecuteDeploymentsFromFilesWithConfig(
    {
      environment: deploymentNetwork,
      askBeforeProceeding: false,
      saveDeployments: Boolean(opts.saveDeployments),
      provider: provider as any,
    },
    buildDeployV1RockethConfig(opts, chainId, chain),
  );

  logDeployedAddresses(
    env,
    [
      "ENSRegistry",
      "Root",
      V1_BASE_REGISTRAR_NAME,
      "RegistrarSecurityController",
      "ReverseRegistrar",
      "DefaultReverseRegistrar",
      "NameWrapper",
      "PublicResolver",
      "BatchGatewayProvider",
      "UniversalResolver",
      "MigrationHelper",
    ],
    "v1 ",
  );

  return env;
}

export async function deployV2(opts: DeployV2Options) {
  const network = NETWORKS[opts.network];
  const deploymentNetwork = opts.deploymentNetwork ?? network.environment;
  const deploymentsDir = resolve(
    opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
  );
  // A fresh deployment archives any existing namespace and therefore must
  // persist the new one, so it implies saving regardless of the flag.
  const persist = Boolean(opts.saveDeployments) || Boolean(opts.fresh);
  if (opts.fresh && isHCAOnlyDeployment(opts.tags)) {
    throw new Error(
      "an HCA-only deploy requires --resume because it reuses the existing core deployments",
    );
  }
  const { provider, chainId, chain } =
    await resolveDeployProviderAndChain(opts);
  if (opts.deferV1OwnerTransactions && !opts.deferredV1OwnerTransactionsFile) {
    throw new Error(
      "deferring v1 owner transactions requires an output file; pass --deferred-v1-owner-transactions-file so the deferred calldata is persisted for execute-owner-txs",
    );
  }
  if (opts.deferredV1OwnerTransactionsFile) {
    const file = resolve(opts.deferredV1OwnerTransactionsFile);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  if (opts.impersonateV1Owner) {
    const v1Owner = addressForImpersonation(
      opts.v1Owner,
      network.defaultV1Owner,
      "v1Owner",
    );
    await impersonate(impersonationProvider(opts) ?? provider!, v1Owner);
  }

  if (opts.fresh) {
    archiveExistingDeploymentNamespace(deploymentsDir, deploymentNetwork);
  }

  const env = await loadAndExecuteDeploymentsFromFilesWithConfig(
    {
      environment: deploymentNetwork,
      askBeforeProceeding: false,
      saveDeployments: persist,
      tags: opts.tags ? [...opts.tags] : [...MIGRATION_DEPLOY_TAGS],
      provider: provider as any,
      extra: {
        v1DeploymentsDir: opts.v1DeploymentsDir,
        v1DeploymentNetwork:
          opts.v1DeploymentNetwork ??
          (opts.deploymentNetwork ? network.environment : undefined),
        deferV1OwnerTransactions: opts.deferV1OwnerTransactions,
        deferredV1OwnerTransactionsFile: opts.deferredV1OwnerTransactionsFile,
      },
    },
    buildDeployV2RockethConfig(opts, chainId, chain),
  );

  if (persist) {
    recordDeploymentMetadata(deploymentsDir, deploymentNetwork, chainId);
  }

  logDeployedAddresses(env, [
    "ETHRegistry",
    "UserRegistryImpl",
    "PermissionedResolverImpl",
    "BatchRegistrar",
    "ENSV1Resolver",
    "ETHRegistrar",
    "ETHRenewerV1",
    "UnlockedMigrationController",
    "LockedMigrationController",
    "UniversalResolverV2",
    "ManagedUniversalResolverProxy",
    "UpgradableUniversalResolverProxy",
    "ReverseRegistrarAdapter",
    "DefaultReverseRegistrarAdapter",
    "DefaultReverseRegistrarHCAAdapter",
    "MockRegistrationIntentExecutor",
    "HCAOwnerAndSessionValidator",
    "StandaloneHCAFactory",
    "HCAUpgradeSet",
    "StandaloneHCAImplementation",
  ]);

  // Refresh the generated address table, but only for a deploy into the network's
  // canonical namespace inside the canonical tree. The doc is named after the
  // network while its contents come from the namespace, so generating it for any
  // other namespace — a `-fork` rehearsal, a `-clean-` run, a custom
  // `--deployment-network` — or from a scratch deployments directory overwrites the
  // real network's published addresses with throwaway ones.
  if (persist) {
    if (
      deploymentsDir === resolve(DEFAULT_DEPLOYMENTS_DIR) &&
      deploymentNetwork === opts.network
    ) {
      const docPath = await generateAddressMarkdown({
        deploymentsDir,
        namespace: deploymentNetwork,
        docName: opts.network,
      });
      console.log(`address docs: ${docPath}`);
    } else {
      console.log(
        `address docs: skipped (namespace ${deploymentNetwork} in ${deploymentsDir} is not the canonical ${opts.network} deployment)`,
      );
    }
  }

  // Every persisted deploy also carries its address table next to its own
  // artifacts. A throwaway namespace never reaches the canonical docs above, so
  // without this its addresses would live only in the individual artifact JSON.
  if (persist) {
    // A clean testnet deploys its own v1 stack into a separate tree, and those
    // addresses belong in the same table: given only the v2 half, a reader
    // cannot reach the registry the migrated names actually live in. A run
    // against an existing v1 has nothing extra to record.
    const v1Namespace =
      opts.v1DeploymentNetwork ??
      (opts.deploymentNetwork ? network.environment : undefined);
    const v1Root = opts.v1DeploymentsDir
      ? resolve(opts.v1DeploymentsDir)
      : join(deploymentsDir, "v1");
    // Keyed on the run having deployed v1 itself, not on the two namespaces
    // coinciding: a canonical deploy given an explicit `--deployment-network`
    // also matches, and its v1 is the network's real one, not this run's.
    const includesFreshV1 =
      Boolean(opts.cleanTestnet) && v1Namespace !== undefined;

    const namespacePath = await generateAddressMarkdown({
      deploymentsDir,
      namespace: deploymentNetwork,
      docName: deploymentNetwork,
      outDir: join(deploymentsDir, deploymentNetwork),
      fileName: "addresses",
      generatedBy: "the deploy that wrote this namespace",
      extraSections: includesFreshV1
        ? [
            {
              title: "ENSv1 contracts (deployed by this testnet)",
              deploymentsDir: v1Root,
              namespace: v1Namespace,
            },
          ]
        : undefined,
    });
    console.log(`deployment address table: ${namespacePath}`);
  }

  return env;
}

async function registerViaV1Controller({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
  privateKey,
  account,
  useRpcStateControls = true,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  useRpcStateControls?: boolean;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  const wallet = walletClient({ rpcUrl, chain, privateKey, account, provider });
  const controller = requireV1Deployment(network, "ETHRegistrarController", {
    v1DeploymentsDir,
    v1DeploymentNetwork,
  });
  const registration = {
    label,
    owner,
    duration: V1_REGISTRATION_DURATION,
    secret: zeroHash,
    resolver: zeroAddress,
    data: [],
    reverseRecord: 0,
    referrer: zeroHash,
  };
  const commitment = (await client.readContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "makeCommitment",
    args: [registration],
  })) as `0x${string}`;
  let hash = await wallet.writeContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "commit",
    args: [commitment],
  });
  await waitForSuccessfulReceipt(client, hash, `v1 commit ${label}.eth`);
  const minCommitmentAge = (await client.readContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "minCommitmentAge",
  })) as bigint;
  await waitForCommitmentAge(
    client,
    minCommitmentAge + 1n,
    useRpcStateControls,
  );
  const price = (await client.readContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "rentPrice",
    args: [label, V1_REGISTRATION_DURATION],
  })) as { base: bigint; premium: bigint };
  const registerRequest = {
    address: controller.address,
    abi: controller.abi,
    functionName: "register" as const,
    args: [registration],
    value: price.base + price.premium,
    account: wallet.account,
  };
  // The estimate is the exact gas the call needs in isolation, which a nested
  // call can exceed under EIP-150's 63/64 rule once it runs for real — the
  // transaction then burns the whole limit and reverts. A buffer absorbs that.
  hash = await wallet.writeContract({
    ...registerRequest,
    gas: await bufferedGas(client, registerRequest),
  } as never);
  await waitForSuccessfulReceipt(client, hash, `v1 register ${label}.eth`);
}

async function assertV1Owner({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
}) {
  const actualOwner = await readV1Owner({
    network,
    rpcUrl,
    chain,
    provider,
    v1DeploymentsDir,
    v1DeploymentNetwork,
    label,
  });
  if (getAddress(actualOwner) !== getAddress(owner)) {
    throw new Error(`unexpected v1 owner for ${label}.eth: ${actualOwner}`);
  }
}

async function readV1Owner({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  const baseRegistrar = requireV1Deployment(network, V1_BASE_REGISTRAR_NAME, {
    v1DeploymentsDir,
    v1DeploymentNetwork,
  });
  return (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "ownerOf",
    args: [labelId(label)],
  })) as Address;
}

function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && messages.length < 10) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

/**
 * Asserts that `promise` rejects. When `expectedError` is given, the rejection's
 * message/cause chain must match it; otherwise unrelated failures (RPC outages,
 * wrong signer, ...) would make a negative test "pass" for the wrong reason.
 */
async function assertRejected(
  promise: Promise<unknown>,
  message: string,
  expectedError?: string | RegExp,
) {
  let rejection: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejection = error;
    rejected = true;
  }
  if (!rejected) {
    throw new Error(message.replace("rejected", "did not reject"));
  }
  const chain = errorMessageChain(rejection);
  if (expectedError !== undefined) {
    const matches = chain.some((candidate) =>
      typeof expectedError === "string"
        ? candidate.includes(expectedError)
        : expectedError.test(candidate),
    );
    if (!matches) {
      console.error(`unexpected rejection: ${chain.join(" <- ")}`);
      throw new Error(
        `${message.replace("rejected", "rejected for an unexpected reason")}; expected ${expectedError}, got: ${chain[0] ?? String(rejection)}`,
      );
    }
  }
  console.log(message);
  console.log(`  rejection: ${chain[0] ?? String(rejection)}`);
}

async function assertV2State({
  rpcUrl,
  chain,
  ethRegistry,
  label,
  status,
  owner,
}: {
  rpcUrl: string;
  chain: Chain;
  ethRegistry: JsonDeployment;
  label: string;
  status: number;
  owner?: Address;
}) {
  const client = publicClient(rpcUrl, chain);
  const state = (await client.readContract({
    address: ethRegistry.address,
    abi: ethRegistry.abi,
    functionName: "getState",
    args: [labelId(label)],
  })) as { status: number; latestOwner: Address };
  if (Number(state.status) !== status) {
    throw new Error(`unexpected v2 status for ${label}.eth: ${state.status}`);
  }
  if (owner && getAddress(state.latestOwner) !== getAddress(owner)) {
    throw new Error(
      `unexpected v2 owner for ${label}.eth: ${state.latestOwner}`,
    );
  }
}

export async function migrateUnwrappedV1Name({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
  privateKey,
  account,
  impersonateAccount,
  migrationController,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  impersonateAccount?: Address;
  migrationController: JsonDeployment;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  if (impersonateAccount) await impersonate(client, impersonateAccount);
  const wallet = walletClient({
    rpcUrl,
    chain,
    privateKey,
    account: account ?? impersonateAccount,
    provider,
  });
  const v1Deployments = { v1DeploymentsDir, v1DeploymentNetwork };
  const registry = requireV1Deployment(network, "ENSRegistry", v1Deployments);
  const baseRegistrar = requireV1Deployment(
    network,
    V1_BASE_REGISTRAR_NAME,
    v1Deployments,
  );
  const resolver = (await client.readContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "resolver",
    args: [namehash(`${label}.eth`)],
  })) as Address;
  const data = encodeAbiParameters(
    [{ type: "tuple", components: migrationDataComponents }],
    [{ label, owner, subregistry: zeroAddress, resolver }],
  );
  const hash = await wallet.writeContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "safeTransferFrom",
    args: [owner, migrationController.address, labelId(label), data],
  });
  await waitForSuccessfulReceipt(client, hash, `v2 commit ${label}.eth`);
}

// Wraps a v1 name, then migrates the resulting ERC-1155 to a migration controller.
//
// Wrapped names are a large share of `.eth` and travel a different path: the token
// is a NameWrapper 1155 keyed by namehash rather than a registrar 721 keyed by
// labelhash, and it lands on the unlocked or locked controller depending on its
// fuses. The rehearsal migrates only an unwrapped name, so nothing here is exercised
// against real chain state.
export async function migrateWrappedV1Name({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
  privateKey,
  account,
  impersonateAccount,
  migrationController,
  fuses = 0,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  impersonateAccount?: Address;
  migrationController: JsonDeployment;
  fuses?: number;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  if (impersonateAccount) await impersonate(client, impersonateAccount);
  const wallet = walletClient({
    rpcUrl,
    chain,
    privateKey,
    account: account ?? impersonateAccount,
    provider,
  });
  const v1Deployments = { v1DeploymentsDir, v1DeploymentNetwork };
  const registry = requireV1Deployment(network, "ENSRegistry", v1Deployments);
  const baseRegistrar = requireV1Deployment(
    network,
    V1_BASE_REGISTRAR_NAME,
    v1Deployments,
  );
  const nameWrapper = requireV1Deployment(
    network,
    "NameWrapper",
    v1Deployments,
  );

  // Wrapping is a 721 transfer into the wrapper with the wrap parameters as data.
  let hash = await wallet.writeContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "safeTransferFrom",
    args: [
      owner,
      nameWrapper.address,
      labelId(label),
      encodeAbiParameters(
        [
          { name: "label", type: "string" },
          { name: "owner", type: "address" },
          { name: "fuses", type: "uint16" },
          { name: "resolver", type: "address" },
        ],
        [label, owner, fuses, zeroAddress],
      ),
    ],
  });
  await waitForSuccessfulReceipt(client, hash, `wrap ${label}.eth`);

  const resolver = (await client.readContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "resolver",
    args: [namehash(`${label}.eth`)],
  })) as Address;
  const data = encodeAbiParameters(
    [{ type: "tuple", components: migrationDataComponents }],
    [{ label, owner, subregistry: zeroAddress, resolver }],
  );

  // NameWrapper ids are namehashes, unlike the registrar's labelhash ids.
  hash = await wallet.writeContract({
    address: nameWrapper.address,
    abi: nameWrapper.abi,
    functionName: "safeTransferFrom",
    args: [
      owner,
      migrationController.address,
      BigInt(namehash(`${label}.eth`)),
      1n,
      data,
    ],
  });
  await waitForSuccessfulReceipt(client, hash, `migrate wrapped ${label}.eth`);
}

async function registerViaV2Registrar({
  rpcUrl,
  chain,
  label,
  owner,
  privateKey,
  ethRegistrar,
  mockUsdc,
  useRpcStateControls = true,
  preFunded = false,
}: {
  rpcUrl: string;
  chain: Chain;
  label: string;
  owner: Address;
  privateKey: `0x${string}`;
  ethRegistrar: JsonDeployment;
  mockUsdc: JsonDeployment;
  useRpcStateControls?: boolean;
  // The payment token is a real one whose balance was set directly, so it has no
  // free-mint entrypoint to call.
  preFunded?: boolean;
}) {
  const client = publicClient(rpcUrl, chain);
  const wallet = walletClient({ rpcUrl, chain, privateKey });
  const payer = privateKeyToAccount(privateKey).address;
  // A registration that the registry rejects reverts with one of the registry's own
  // custom errors, which the registrar ABI does not declare — leaving the failure as
  // an undecodable selector. Merging the registry ABI in makes those errors readable,
  // so a rejection can be asserted by name instead of by "something reverted".
  const registrarAbi = [
    ...ethRegistrar.abi,
    ...Artifact_PermissionedRegistry.abi,
  ];
  const commitment = (await client.readContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "makeCommitment",
    args: [
      label,
      owner,
      zeroHash,
      zeroAddress,
      zeroAddress,
      V2_REGISTRATION_DURATION,
      zeroHash,
    ],
  })) as `0x${string}`;
  let hash = await wallet.writeContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "commit",
    args: [commitment],
  });
  await waitForSuccessfulReceipt(client, hash, `v2 commit ${label}.eth`);
  const minCommitmentAge = (await client.readContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "MIN_COMMITMENT_AGE",
  })) as bigint;
  await waitForCommitmentAge(
    client,
    minCommitmentAge + 1n,
    useRpcStateControls,
  );
  const [base, premium] = (await client.readContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "getRegisterPrice",
    args: [label, V2_REGISTRATION_DURATION, mockUsdc.address],
  })) as [bigint, bigint];
  if (!preFunded) {
    hash = await wallet.writeContract({
      address: mockUsdc.address,
      abi: mockUsdc.abi,
      functionName: "mint",
      args: [payer, base + premium],
    });
    await waitForSuccessfulReceipt(
      client,
      hash,
      `mint payment token for ${label}.eth`,
    );
  }
  hash = await wallet.writeContract({
    address: mockUsdc.address,
    abi: mockUsdc.abi,
    functionName: "approve",
    args: [ethRegistrar.address, base + premium],
  });
  await waitForSuccessfulReceipt(
    client,
    hash,
    `approve payment token for ${label}.eth`,
  );
  hash = await wallet.writeContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "register",
    args: [
      label,
      owner,
      zeroHash,
      zeroAddress,
      zeroAddress,
      V2_REGISTRATION_DURATION,
      mockUsdc.address,
      zeroHash,
    ],
  });
  await waitForSuccessfulReceipt(client, hash, `v2 register ${label}.eth`);
}

// Renews an unmigrated v1 name through ETHRenewerV1 and asserts the whole invariant.
//
// Between the phase 3 freeze and migration opening, renewal is the only thing a name
// owner can still do, and it has to extend three places at once: the v2 reservation,
// the v1 registration, and the NameWrapper's copy of the expiry. Phase 4 currently
// proves only that the renewer is an authorized controller, which says nothing about
// whether a renewal actually works or keeps the three in step.
export async function renewViaEthRenewerV1({
  rpcUrl,
  chain,
  label,
  privateKey,
  ethRenewerV1,
  ethRegistry,
  v1BaseRegistrar,
  nameWrapper,
  mockUsdc,
  duration = V2_REGISTRATION_DURATION,
  preFunded = false,
}: {
  rpcUrl: string;
  chain: Chain;
  label: string;
  privateKey: `0x${string}`;
  ethRenewerV1: JsonDeployment;
  ethRegistry: JsonDeployment;
  v1BaseRegistrar: JsonDeployment;
  nameWrapper: JsonDeployment | null;
  mockUsdc: JsonDeployment;
  duration?: bigint;
  // See registerViaV2Registrar: a real payment token cannot be minted.
  preFunded?: boolean;
}) {
  const client = publicClient(rpcUrl, chain);
  const wallet = walletClient({ rpcUrl, chain, privateKey });
  const payer = privateKeyToAccount(privateKey).address;
  const id = labelId(label);

  const readV1Expiry = () =>
    client.readContract({
      address: v1BaseRegistrar.address,
      abi: v1BaseRegistrar.abi,
      functionName: "nameExpires",
      args: [id],
    }) as Promise<bigint>;
  const readV2Expiry = async () =>
    BigInt(
      (
        (await client.readContract({
          address: ethRegistry.address,
          abi: ethRegistry.abi,
          functionName: "getState",
          args: [id],
        })) as { expiry: bigint | number }
      ).expiry,
    );
  // NameWrapper keys its ERC-1155 ids by namehash, not by the registrar's labelhash.
  // Reading it with the registrar id returns an empty record, which would look like
  // an unwrapped name.
  const wrapperId = BigInt(namehash(`${label}.eth`));
  const readWrapperExpiry = async () => {
    if (!nameWrapper) return null;
    const [, , expiry] = (await client.readContract({
      address: nameWrapper.address,
      abi: nameWrapper.abi,
      functionName: "getData",
      args: [wrapperId],
    })) as [Address, number, bigint];
    return BigInt(expiry);
  };

  const before = {
    v1: await readV1Expiry(),
    v2: await readV2Expiry(),
    wrapper: await readWrapperExpiry(),
  };

  // Unlike registration, renewal carries no premium, so this is a single total.
  const price = (await client.readContract({
    address: ethRenewerV1.address,
    abi: ethRenewerV1.abi,
    functionName: "getRenewPrice",
    args: [label, duration, mockUsdc.address],
  })) as bigint;

  let hash: `0x${string}`;
  if (!preFunded) {
    hash = await wallet.writeContract({
      address: mockUsdc.address,
      abi: mockUsdc.abi,
      functionName: "mint",
      args: [payer, price],
    });
    await waitForSuccessfulReceipt(client, hash, `mint renewal payment`);
  }
  hash = await wallet.writeContract({
    address: mockUsdc.address,
    abi: mockUsdc.abi,
    functionName: "approve",
    args: [ethRenewerV1.address, price],
  });
  await waitForSuccessfulReceipt(client, hash, `approve renewal payment`);

  hash = await wallet.writeContract({
    address: ethRenewerV1.address,
    abi: ethRenewerV1.abi,
    functionName: "renew",
    args: [{ label, duration, referrer: zeroHash }, mockUsdc.address],
  });
  await waitForSuccessfulReceipt(client, hash, `v1 renew ${label}.eth`);

  const after = {
    v1: await readV1Expiry(),
    v2: await readV2Expiry(),
    wrapper: await readWrapperExpiry(),
  };

  // Both sides must move by the same amount. A renewal that extended only one of
  // them would leave the name renewable on v1 but expiring on v2, or the reverse.
  const v1Delta = after.v1 - before.v1;
  const v2Delta = after.v2 - before.v2;
  if (v1Delta !== duration) {
    throw new Error(
      `renewal did not extend v1 by ${duration}: ${before.v1} -> ${after.v1}`,
    );
  }
  if (v2Delta !== duration) {
    throw new Error(
      `renewal did not extend v2 by ${duration}: ${before.v2} -> ${after.v2}`,
    );
  }
  // A wrapper expiry of zero means the name is not wrapped, and `NameWrapper.renew`
  // deliberately returns early for those — there is nothing to sync. Only a wrapped
  // name carries the third copy of the expiry, and only then must it move.
  //
  // The wrapper stores the registrar expiry plus the grace period, not the registrar
  // expiry itself (`NameWrapper.renew`), so the synced value is checked against that
  // exact figure. Asserting merely that it increased would accept a sync that left
  // the wrapper a second past where it started and still report it as synchronised.
  const wrapped = before.wrapper !== null && before.wrapper > 0n;
  if (wrapped && after.wrapper !== null) {
    const expected = after.v1 + V1_GRACE_PERIOD_SECONDS;
    if (after.wrapper !== expected) {
      throw new Error(
        `renewal did not sync the NameWrapper expiry to the v1 expiry plus the grace period: wrapper ${before.wrapper} -> ${after.wrapper}, expected ${expected} (v1 ${after.v1})`,
      );
    }
  }

  const state = (await client.readContract({
    address: ethRegistry.address,
    abi: ethRegistry.abi,
    functionName: "getState",
    args: [id],
  })) as { status: number };
  if (Number(state.status) !== STATUS.RESERVED) {
    throw new Error(
      `renewal changed ${label}.eth status to ${state.status}; expected it to stay RESERVED`,
    );
  }

  console.log(
    `smoke renewal extended ${label}.eth by ${duration}s on v1 and v2${wrapped ? " and synced NameWrapper" : " (name is unwrapped)"}, still RESERVED`,
  );
}

type V2RegistrarSmokeOptions = {
  network: MigrationNetwork;
  rpcUrl?: string;
  chainId?: string;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  label?: string;
  owner?: Address;
  privateKey: `0x${string}`;
  rpcStateControls?: boolean;
};

export async function runV2RegistrarSmoke(opts: V2RegistrarSmokeOptions) {
  const network = NETWORKS[opts.network];
  const rpcUrl = requireRpcUrl(opts, opts.network);
  const chainId = parseNumber(opts.chainId, network.chain.id);
  const chain = forkChain(opts.network, chainId, rpcUrl);
  const deploymentsDir = resolve(
    opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
  );
  const deploymentNetwork = opts.deploymentNetwork ?? network.environment;
  const client = publicClient(rpcUrl, chain);
  const owner = opts.owner ?? privateKeyToAccount(opts.privateKey).address;
  const label =
    opts.label ??
    `${opts.network === "mainnet" ? "mf" : "sf"}${Date.now().toString(36)}v2ok`;
  const ethRegistry = loadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistry",
  );
  const ethRegistrar = loadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistrar",
  );
  const mockUsdc = maybeLoadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "MockUSDC",
  );
  if (!mockUsdc) {
    throw new Error(
      `v2 registrar smoke needs a mintable mock payment token, which is not deployed for ${deploymentNetwork}; on networks with real payment tokens, fund a whitelisted token and register directly`,
    );
  }

  const enabled = (await client.readContract({
    address: ethRegistry.address,
    abi: ethRegistry.abi,
    functionName: "hasRootRoles",
    args: [REGISTRAR_ROLES, ethRegistrar.address],
  })) as boolean;
  if (!enabled) {
    throw new Error(`ETHRegistrar is not enabled for ${deploymentNetwork}`);
  }

  const available = (await client.readContract({
    address: ethRegistrar.address,
    abi: ethRegistrar.abi,
    functionName: "isAvailable",
    args: [label],
  })) as boolean;
  if (!available) {
    throw new Error(`${label}.eth is not available for v2 registration smoke`);
  }

  console.log(
    `smoke: registering ${label}.eth via ETHRegistrar ${ethRegistrar.address}`,
  );
  await registerViaV2Registrar({
    rpcUrl,
    chain,
    label,
    owner,
    privateKey: opts.privateKey,
    ethRegistrar,
    mockUsdc,
    useRpcStateControls: opts.rpcStateControls ?? false,
  });
  await assertV2State({
    rpcUrl,
    chain,
    ethRegistry,
    label,
    status: STATUS.REGISTERED,
    owner,
  });
  console.log(`v2 registrar registered ${label}.eth for ${owner}`);
}

// Contracts every v2 namespace describes, keyed by the field the migration code
// refers to them by.
const V2_REQUIRED_DEPLOYMENTS = {
  ethRegistry: "ETHRegistry",
  batchRegistrar: "BatchRegistrar",
  ensV1Resolver: "ENSV1Resolver",
  ethRegistrar: "ETHRegistrar",
  unlockedMigrationController: "UnlockedMigrationController",
  lockedMigrationController: "LockedMigrationController",
  migrationHelper: "MigrationHelper",
  universalResolverV2: "UniversalResolverV2",
  managedUrp: "ManagedUniversalResolverProxy",
  topUrp: "UpgradableUniversalResolverProxy",
  graveyard: "Graveyard",
} as const;

// Contracts only some networks or deploy modes carry: the mock payment tokens exist
// where no real ones are whitelisted, and the testnet helpers only on testnets.
const V2_OPTIONAL_DEPLOYMENTS = {
  ethRenewerV1: "ETHRenewerV1",
  mockUsdc: "MockUSDC",
  testnetV1PremigrationRegistrar: "TestnetV1PremigrationRegistrar",
} as const;

type V2MigrationDeployments = {
  [K in keyof typeof V2_REQUIRED_DEPLOYMENTS]: JsonDeployment;
} & {
  [K in keyof typeof V2_OPTIONAL_DEPLOYMENTS]: JsonDeployment | null;
};

// Build the deployment set from whichever pair of lookups the caller has: reading
// artifacts off disk, or querying a live deploy environment.
function mapV2MigrationDeployments(
  required: (name: string) => JsonDeployment,
  optional: (name: string) => JsonDeployment | null,
): V2MigrationDeployments {
  const deployments: Record<string, JsonDeployment | null> = {};
  for (const [field, name] of Object.entries(V2_REQUIRED_DEPLOYMENTS)) {
    deployments[field] = required(name);
  }
  for (const [field, name] of Object.entries(V2_OPTIONAL_DEPLOYMENTS)) {
    deployments[field] = optional(name);
  }
  return deployments as V2MigrationDeployments;
}

function loadV2MigrationDeployments(
  deploymentsDir: string,
  deploymentNetwork: string,
): V2MigrationDeployments {
  return mapV2MigrationDeployments(
    (name) => loadV2Deployment(deploymentsDir, deploymentNetwork, name),
    (name) => maybeLoadV2Deployment(deploymentsDir, deploymentNetwork, name),
  );
}

function collectV2MigrationDeployments(
  deployEnv: Awaited<ReturnType<typeof deployV2>>,
): V2MigrationDeployments {
  return mapV2MigrationDeployments(
    (name) => deployEnv.get(name),
    (name) => deployEnv.getOrNull(name),
  );
}

async function disableAndVerifyBatchRegistrar(opts: {
  network: MigrationNetwork;
  rpcUrl: string;
  chainId: string;
  registry: Address;
  batchRegistrar: Address;
  deploymentsDir: string;
  deploymentNetwork: string;
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
}) {
  await disableBatchRegistrar(opts);
  await verifyBatchRegistrarDisabled(opts);
}

// The smoke checks a rehearsal reports on. Naming each once keeps the "not
// exercised" and "still exercised" lists describing the same check in the same
// words, so a reader can line the two up.
const SMOKE_CHECKS = {
  v1Registration: "live v1 registration before the phase 3 freeze",
  freezeRejection:
    "the phase 3 freeze rejecting a registration that previously succeeded",
  reservedAssertions: "the pre-migration RESERVED assertions",
  migration: "the v1 → v2 migration smoke, unwrapped and wrapped",
  reservedRejection: "the phase 6 rejection of a pre-migrated reserved name",
  renewal:
    "the ETHRenewerV1 renewal smoke, and with it the v1 ↔ v2 expiry-sync invariant",
  preEnableRejection:
    "the v2 registrar rejecting a registration before phase 6 grants it REGISTRAR",
  paidRegistration:
    "every paid-registration smoke — the ETHRegistrar commit/reveal, pricing, and ERC-20 payment path",
  deployAndPreMigration:
    "the deploy, and pre-migration of the CSV names into v2 (phases 1, 2 and 5)",
  freezeAndHandoff:
    "the phase 3 freeze of the v1 registrars, and the v1 authorization handoff",
  renewerAuthorization:
    "phase 4 authorizing ETHRenewerV1 as a v1 renewal controller",
  freshV2Registration:
    "a fresh v2 registration through the ETHRegistrar commit/reveal and ERC-20 payment path",
} as const;

// One condition that stopped a rehearsal from covering everything, together with
// the checks it cost and the way to exercise them. Skips are filed under their
// cause rather than listed flat: several checks usually fall to a single condition,
// and a flat list reads as several independent problems.
type CoverageGap = {
  /** Short name for the condition, also used to merge later skips into it. */
  cause: string;
  why: string[];
  checks: string[];
  remedy: string[];
};

// Renders the end-of-run coverage report: the cause first, then what it cost, then
// what still ran, then what to run instead. A reader reaching this line has just
// watched a long rehearsal report success and needs to know how much that is worth.
function reportCoverage(opts: {
  skipped: CoverageGap[];
  covered: string[];
}): void {
  console.log("");
  if (opts.skipped.length === 0) {
    console.log("coverage: all smoke checks ran");
    return;
  }
  console.log("coverage: this rehearsal ran a reduced set of smoke checks.");
  for (const gap of opts.skipped) {
    console.log("");
    console.log(`  why: ${gap.why[0]}`);
    for (const line of gap.why.slice(1)) console.log(`  ${line}`);
    console.log("");
    console.log("  not exercised:");
    for (const check of gap.checks) console.log(`    - ${check}`);
    console.log("");
    for (const line of gap.remedy) console.log(`  ${line}`);
  }
  if (opts.covered.length > 0) {
    console.log("");
    console.log("  still exercised:");
    for (const check of opts.covered) console.log(`    - ${check}`);
  }
}

// Options selecting an optional ENSv1 fixture cohort for a rehearsal. Absent
// `fixtureRoot`, the whole stage is skipped and the rehearsal is unchanged.
export type FixtureRehearsalOptions = {
  fixtureRoot?: string;
  fixtureScenarios?: string;
  fixtureTiers?: string;
  fixtureIds?: string;
  fixtureLimit?: string;
  fixtureReplicasPerVector?: string;
  fixtureActorMnemonic?: string;
  fixturePrivateKey?: string;
};

// The corpus needs an operator account and a set of actor accounts. On a
// state-controlled RPC both are generated per run and funded directly, which
// keeps a rehearsal from depending on funded keys and from inheriting the
// EIP-7702 delegations that the well-known test accounts carry on live chains.
// The generated mnemonic is written beside the run state so a resumed rehearsal
// addresses the same actors.
async function fixtureRunOptions(
  opts: RunForkFullOptions & FixtureRehearsalOptions,
  base: {
    rpcUrl: string;
    chainId: number;
    client: ReturnType<typeof publicClient>;
    deploymentsDir: string;
    deploymentNetwork: string;
    v1DeploymentsDir?: string;
    v1DeploymentNetwork?: string;
    workDir: string;
    useRpcStateControls: boolean;
    v1Owner: Address;
  },
): Promise<any | null> {
  if (!opts.fixtureRoot) return null;
  const fixtureWorkDir = join(base.workDir, "fixture");
  mkdirSync(fixtureWorkDir, { recursive: true });

  const mnemonicFile = join(fixtureWorkDir, "actor-mnemonic.txt");
  let actorMnemonic =
    opts.fixtureActorMnemonic ?? process.env.MIGRATION_FIXTURE_ACTOR_MNEMONIC;
  if (!actorMnemonic && existsSync(mnemonicFile)) {
    actorMnemonic = readFileSync(mnemonicFile, "utf8").trim();
  }
  if (!actorMnemonic) {
    if (!base.useRpcStateControls) {
      throw new Error(
        "--fixture-root on a live RPC requires --fixture-actor-mnemonic or MIGRATION_FIXTURE_ACTOR_MNEMONIC",
      );
    }
    actorMnemonic = generateMnemonic(englishWordlist);
    writeFileSync(mnemonicFile, `${actorMnemonic}\n`);
  }

  const keyFile = join(fixtureWorkDir, "operator-key.txt");
  let privateKey =
    opts.fixturePrivateKey ?? process.env.MIGRATION_FIXTURE_PRIVATE_KEY;
  if (!privateKey && existsSync(keyFile)) {
    privateKey = readFileSync(keyFile, "utf8").trim();
  }
  if (!privateKey) {
    if (!base.useRpcStateControls) {
      throw new Error(
        "--fixture-root on a live RPC requires --fixture-private-key or MIGRATION_FIXTURE_PRIVATE_KEY",
      );
    }
    privateKey = generatePrivateKey();
    writeFileSync(keyFile, `${privateKey}\n`);
  }

  if (base.useRpcStateControls) {
    const operator = privateKeyToAccount(privateKey as `0x${string}`);
    await setBalance(base.client, operator.address);
    for (let index = 0; index < ACTOR_ALIASES.length; index += 1) {
      const actor = mnemonicToAccount(actorMnemonic, { accountIndex: index });
      await setBalance(base.client, actor.address);
    }
  }

  return {
    network: opts.network,
    rpcUrl: base.rpcUrl,
    chainId: String(base.chainId),
    fixtureRoot: resolve(opts.fixtureRoot),
    workDir: fixtureWorkDir,
    deploymentsDir: base.deploymentsDir,
    deploymentNetwork: base.deploymentNetwork,
    v1DeploymentsDir: base.v1DeploymentsDir,
    v1DeploymentNetwork: base.v1DeploymentNetwork,
    privateKey,
    actorMnemonic,
    // Seeding registers through the v1 controller. On a chain a previous
    // migration already froze, the corpus cannot be created until that
    // controller is re-authorised, which only the v1 owner can do.
    v1Owner: base.v1Owner,
    v1OwnerKey: opts.v1OwnerPrivateKey,
    limit: opts.fixtureLimit,
    tiers: opts.fixtureTiers,
    scenarios: opts.fixtureScenarios,
    fixtureIds: opts.fixtureIds,
    replicasPerVector: opts.fixtureReplicasPerVector,
    rpcStateControls: base.useRpcStateControls,
  };
}

export async function runForkFull(opts: RunForkFullOptions) {
  if (opts.direct || opts.debugRpc)
    installRpcCompatibility(Boolean(opts.debugRpc));
  const resumeFromPhase = parseResumeFromPhase(opts.resumeFromPhase);
  const network = NETWORKS[opts.network];
  const forkRpcUrl = requireRpcUrl(opts, opts.network);
  const port = parseNumber(opts.port, network.defaultForkPort);
  const chainId = parseNumber(opts.chainId, network.chain.id);
  const rpcUrl = opts.direct ? forkRpcUrl : `http://127.0.0.1:${port}`;
  const chain = forkChain(opts.network, chainId, rpcUrl);
  const provider = opts.provider;
  // State controls (impersonation, time travel, setBalance) are only available on
  // simulated RPCs: the local Anvil fork, other local nodes, or Tenderly forks.
  const useRpcStateControls =
    opts.rpcStateControls ?? (Boolean(opts.tenderly) || isLocalRpcUrl(rpcUrl));
  const keys: PrivateKeyOptions = {
    deployerPrivateKey: opts.deployerPrivateKey,
    ownerPrivateKey: opts.ownerPrivateKey,
    v1OwnerPrivateKey: opts.v1OwnerPrivateKey,
    urManagerPrivateKey: opts.urManagerPrivateKey,
  };
  const deploymentsDir = resolve(
    opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
  );
  // A rehearsal deploys into its own namespace rather than the canonical one. The
  // live namespace describes contracts that exist on the real chain — including
  // proxies whose admin is a real account — so deploying into it makes phase 1 try
  // to adopt and upgrade them, which fails on a fork with an opaque proxy-ownership
  // error. `-fork` namespaces are already gitignored for exactly this purpose.
  const deploymentNetwork =
    opts.deploymentNetwork ?? `${network.environment}-fork`;
  // Phase 3's controller audit reads the active deployment's handoff contracts off
  // disk to tell them apart from a superseded deployment's, so a rehearsal has to
  // persist them — whichever namespace it deployed into. Gating this on the
  // automatic `-fork` namespace meant a run given `--deployment-network` wrote no
  // artifacts and then threw in phase 3 for want of them. Writing into the
  // throwaway `-fork` namespace costs nothing either: it is gitignored and
  // re-created by the next run.
  const saveDeployments = true;
  const v1Deployments = {
    v1DeploymentsDir: opts.v1DeploymentsDir,
    v1DeploymentNetwork: opts.v1DeploymentNetwork,
  };
  if (resumeFromPhase !== undefined && !opts.workDir) {
    throw new Error("--resume-from-phase requires --work-dir");
  }
  const workDir = resolve(
    opts.workDir ??
      join(tmpdir(), `enschain-${opts.network}-migration-${Date.now()}`),
  );
  mkdirSync(workDir, { recursive: true });

  const transformedCsv = join(workDir, "premigration.csv");
  if (resumeFromPhase === 2) {
    if (!existsSync(transformedCsv)) {
      throw new Error(
        `Cannot resume phase 2 without existing transformed CSV: ${transformedCsv}`,
      );
    }
    console.log(
      `resuming from phase 2 with pre-migration CSV: ${transformedCsv}`,
    );
  } else {
    const totalRows = transformCsvForPreMigration(
      resolve(opts.csvFile),
      transformedCsv,
    );
    console.log(
      `prepared pre-migration CSV with ${totalRows} labels: ${transformedCsv}`,
    );
  }

  const anvil = opts.direct
    ? null
    : Bun.spawn(
        [
          "anvil",
          "--fork-url",
          forkRpcUrl,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--chain-id",
          String(chainId),
        ],
        { stdout: "ignore", stderr: "inherit" },
      );

  try {
    await waitForRpc(rpcUrl, chain);
    const client = publicClient(rpcUrl, chain, provider);
    if (opts.snapshotFile !== undefined) {
      const snapshotId = await createRpcSnapshot(client);
      saveRpcSnapshotFile(
        opts.snapshotFile,
        snapshotId,
        opts.direct ? network.environment : `${network.environment}-fork`,
      );
      console.log(`pre-rehearsal snapshot: ${snapshotId}`);
      console.log(`snapshot file: ${opts.snapshotFile}`);
    }
    const deployer =
      opts.deployer ?? (opts.direct ? undefined : DEFAULT_ANVIL_DEPLOYER);
    const owner =
      opts.owner ??
      (opts.direct && opts.network === "sepolia"
        ? undefined
        : network.defaultOwner);
    const urManager =
      opts.urManager ?? (opts.direct ? undefined : DEFAULT_ANVIL_DEPLOYER);
    if (deployer === undefined) {
      throw new Error(
        "--direct requires --deployer; use the Hardhat fork-full task to derive it from keystore",
      );
    }
    if (owner === undefined) {
      throw new Error(
        "--direct on sepolia requires --owner; use the Hardhat fork-full task to derive it from keystore",
      );
    }
    if (urManager === undefined) {
      throw new Error(
        "--direct requires --ur-manager; use the Hardhat fork-full task to derive it from keystore",
      );
    }
    if (!useRpcStateControls && !opts.deployerPrivateKey) {
      throw new Error(
        "direct migration without RPC state controls requires a deployer private key",
      );
    }
    const v1Owner = opts.v1Owner ?? network.defaultV1Owner;
    if (useRpcStateControls) {
      await setBalance(client, DEFAULT_ANVIL_DEPLOYER);
      await setBalance(client, deployer);
      await setBalance(client, owner);
      await setBalance(client, v1Owner);
      await setBalance(client, urManager);
      await clearAccountDelegations(client, [
        { address: DEFAULT_ANVIL_DEPLOYER, label: "default deployer" },
        { address: deployer, label: "deployer" },
        { address: owner, label: "owner" },
        { address: v1Owner, label: "v1 owner" },
      ]);
    }
    const generatedSmokePrivateKey = useRpcStateControls
      ? generatePrivateKey()
      : undefined;
    const smokeAccount = generatedSmokePrivateKey
      ? privateKeyToAccount(generatedSmokePrivateKey)
      : { address: deployer };
    const smokePrivateKey =
      generatedSmokePrivateKey ??
      privateKeyForAddress(smokeAccount.address, keys);
    const smokeSignerPrivateKey =
      smokePrivateKey ??
      (() => {
        throw new Error(
          `smoke account ${smokeAccount.address} is not backed by a configured private key`,
        );
      })();
    if (useRpcStateControls) {
      await setBalance(client, smokeAccount.address);
    }
    if (opts.direct && useRpcStateControls) {
      await impersonate(client, DEFAULT_ANVIL_DEPLOYER);
      await impersonate(client, deployer);
      await impersonate(client, owner);
      await impersonate(client, v1Owner);
      await impersonate(client, urManager);
    } else if (
      useRpcStateControls &&
      getAddress(deployer) !== getAddress(DEFAULT_ANVIL_DEPLOYER)
    ) {
      await impersonate(client, deployer);
    }

    const v1BaseRegistrar = requireV1Deployment(
      opts.network,
      V1_BASE_REGISTRAR_NAME,
      v1Deployments,
    );
    const v1RegistrarOwner = (await client.readContract({
      address: v1BaseRegistrar.address,
      abi: v1BaseRegistrar.abi,
      functionName: "owner",
    })) as Address;
    if (useRpcStateControls) await impersonate(client, v1RegistrarOwner);

    // A chain that has already completed the v1 hand-off (phase 3 disabled the
    // v1 registrar controllers) cannot perform a fresh v1 registration, so the
    // live-v1 smokes must be skipped. Detect that from the controller state: a
    // pristine chain (mainnet today) still exercises them while an
    // already-migrated chain (sepolia, or a repeat mainnet run) does not.
    //
    // Every known registration controller is checked, not just the bundled
    // `ETHRegistrarController`. If ENS rotates that one, reading it alone reports a
    // pristine chain as already migrated, which silently drops most of the
    // rehearsal's assertions while it still reports success.
    const v1RegistrationControllers: Array<{
      name: string;
      deployment: JsonDeployment;
    }> = [];
    for (const name of V1_REGISTRATION_CONTROLLER_NAMES) {
      const deployment = loadV1Deployment(opts.network, name, v1Deployments);
      if (deployment) v1RegistrationControllers.push({ name, deployment });
    }
    if (v1RegistrationControllers.length === 0) {
      throw new Error(
        "no v1 registration controller artifacts found: cannot tell a pristine chain from an already-migrated one",
      );
    }
    const enabledV1Controllers: string[] = [];
    for (const entry of v1RegistrationControllers) {
      const enabled = (await client.readContract({
        address: v1BaseRegistrar.address,
        abi: v1BaseRegistrar.abi,
        functionName: "controllers",
        args: [entry.deployment.address],
      })) as boolean;
      if (enabled) enabledV1Controllers.push(entry.name);
    }
    const postMigration = enabledV1Controllers.length === 0;

    // Records what a run did and did not cover, so a rehearsal cannot report success
    // while silently having proven far less than it appears to.
    const skippedCoverage: CoverageGap[] = [];
    const coveredChecks: string[] = [];
    const recordSkipped = (gap: CoverageGap) => {
      const existing = skippedCoverage.find(
        (entry) => entry.cause === gap.cause,
      );
      if (existing) existing.checks.push(...gap.checks);
      else skippedCoverage.push(gap);
    };
    // The paid smokes and the renewal smoke share this condition, so they share one
    // entry rather than appearing as two unrelated problems.
    const noPaymentTokenGap = (checks: string[]): CoverageGap => ({
      cause: "no mintable payment token",
      why: [
        `no free-mint mock token is deployed on ${opts.network} and real USDC could not be`,
        "funded on this fork, so nothing can pay the v2 registrar. This is not expected on a",
        "fork with state controls, which writes a USDC balance for the smoke account directly.",
      ],
      checks,
      remedy: [
        "to exercise these, re-run against a local Anvil fork or a Tenderly virtual testnet, or",
        "add --require-full-coverage to make a run that cannot fund the token fail outright.",
      ],
    });
    if (postMigration) {
      console.log(
        `post-migration mode: no v1 registration controller is authorized (checked ${v1RegistrationControllers
          .map((entry) => entry.name)
          .join(", ")}); skipping live v1 registration smokes`,
      );
      recordSkipped({
        cause: "post-migration mode",
        why: [
          `${opts.network} has already completed the v1 → v2 migration, so the fork starts from a`,
          "chain where no v1 registration controller is authorized on the v1 BaseRegistrar.",
          `Checked: ${v1RegistrationControllers.map((entry) => entry.name).join(", ")}.`,
          "Nothing can register a v1 name, so every check that needs one was skipped. This is",
          `expected on ${opts.network} and is not a failure; the code calls it post-migration mode.`,
        ],
        checks: [
          SMOKE_CHECKS.v1Registration,
          SMOKE_CHECKS.freezeRejection,
          SMOKE_CHECKS.reservedAssertions,
          SMOKE_CHECKS.migration,
          SMOKE_CHECKS.reservedRejection,
          SMOKE_CHECKS.renewal,
        ],
        remedy: [
          "to exercise these, rehearse against a chain whose v1 is still live:",
          "  bun run migration -- fork full --network mainnet --csv-file <csv>",
          "  bun run migration -- clean-testnet --network sepolia --rpc-url <url> --deployer <addr>",
        ],
      });
      if (opts.requireFullCoverage) {
        throw new Error(
          "post-migration mode detected but --require-full-coverage was set: the rehearsal would skip the live v1 registration, freeze, and migration smokes",
        );
      }
    } else {
      console.log(
        `pristine chain: v1 registration controllers still authorized (${enabledV1Controllers.join(", ")})`,
      );
    }

    // Re-running against an already-migrated chain leaves the v1 BaseRegistrar
    // owned by the prior deployment's ETHRenewerV1, so every v1-owner-signed
    // write to it reverts. Reclaim ownership before the first such write, which
    // is phase 1's repointing of the v1 `.eth` resolver at ENSV2Resolver — not
    // the phase 3 freeze. (No-op on a pristine chain. Live re-migrations use the
    // standalone `phase reclaim-v1-registrar-ownership` command beforehand.)
    if (useRpcStateControls) {
      await reclaimV1RegistrarOwnership({
        network: opts.network,
        rpcUrl,
        chainId: String(chainId),
        provider,
        ...v1Deployments,
        v1Owner,
        impersonateOwner: true,
      });
    }

    let v2Deployments: V2MigrationDeployments;

    if (resumeFromPhase === 2) {
      console.log("phase 1: skipped; loading saved v2 deployments");
      v2Deployments = loadV2MigrationDeployments(
        deploymentsDir,
        deploymentNetwork,
      );
    } else {
      console.log(
        `phase 1: deploy v2 contracts against ${opts.v1DeploymentNetwork ?? network.environment} v1 references`,
      );
      const deployEnv = await deployV2({
        network: opts.network,
        rpcUrl,
        provider,
        rpcCompatibility: Boolean(provider),
        chainId: String(chainId),
        deploymentsDir,
        deploymentNetwork,
        ...v1Deployments,
        saveDeployments,
        tenderly: opts.tenderly,
        includeTestnetPremigrationRegistrar:
          opts.includeTestnetPremigrationRegistrar,
        cleanTestnet: opts.cleanTestnet,
        deployer,
        deployerPrivateKey: opts.deployerPrivateKey,
        owner,
        ownerPrivateKey: opts.ownerPrivateKey,
        v1Owner,
        v1OwnerPrivateKey: opts.v1OwnerPrivateKey,
        // When the v1 owner is not backed by a private key, the deploy must
        // impersonate it so writes signed as the v1 owner (e.g. repointing the
        // .eth resolver) have an unlocked signer on the fork.
        impersonateV1Owner: useRpcStateControls && !opts.v1OwnerPrivateKey,
        urManager,
        urManagerPrivateKey: opts.urManagerPrivateKey,
      });
      if (saveDeployments) {
        console.log(
          `deployment files: ${join(deploymentsDir, deploymentNetwork)}`,
        );
      }

      v2Deployments = collectV2MigrationDeployments(deployEnv);
    }
    const {
      ethRegistry,
      batchRegistrar,
      ensV1Resolver,
      ethRegistrar,
      ethRenewerV1,
      mockUsdc: deployedMockUsdc,
      unlockedMigrationController,
      universalResolverV2,
      managedUrp,
      topUrp,
      graveyard,
      testnetV1PremigrationRegistrar,
    } = v2Deployments;

    // Where no free-mint mock exists — mainnet, which whitelists real USDC/DAI — the
    // real token stands in, funded directly on the fork. Without this every
    // paid-registration and renewal smoke is skipped on the network they matter most
    // for, and the ETHRegistrar payment path is never executed anywhere.
    let mockUsdc = deployedMockUsdc;
    let paymentTokenPreFunded = false;
    if (!mockUsdc && useRpcStateControls) {
      try {
        await setErc20Balance({
          client,
          token: MAINNET_USDC,
          account: privateKeyToAccount(smokeSignerPrivateKey).address,
          amount: 10n ** 12n,
          tenderly: isTenderlyVirtualRpc(rpcUrl),
        });
        mockUsdc = { address: MAINNET_USDC, abi: Artifact_MockERC20.abi };
        paymentTokenPreFunded = true;
        console.log(
          `funded ${smokeAccount.address} with real USDC on the fork; paid smokes will run`,
        );
      } catch (error) {
        console.log(
          `could not fund a real payment token on this fork (${errorMessageChain(error)[0]}); paid smokes will be skipped`,
        );
      }
    }

    const batchRegistrarOwner = await readBatchRegistrarOwner({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      batchRegistrar: batchRegistrar.address,
    });
    console.log(`batch registrar owner: ${batchRegistrarOwner}`);
    if (
      useRpcStateControls &&
      getAddress(batchRegistrarOwner) !== getAddress(DEFAULT_ANVIL_DEPLOYER)
    ) {
      await impersonate(client, batchRegistrarOwner);
    }
    const batchRegistrarSigner = useRpcStateControls
      ? preMigrationSigner(batchRegistrarOwner)
      : {
          privateKey: requirePrivateKeyForAddress(
            batchRegistrarOwner,
            keys,
            "BatchRegistrar owner",
          ),
        };
    const deploymentAdminSigner = useRpcStateControls
      ? adminSigner(batchRegistrarOwner)
      : {
          privateKey: requirePrivateKeyForAddress(
            batchRegistrarOwner,
            keys,
            "deployment admin",
          ),
        };
    // Signer for the v1-owner-gated controller changes (disable registrars,
    // authorize the renewer, hand off ownership). On a fork we impersonate the
    // owner; for a live run we require the key that controls it.
    const v1OwnerSigner:
      | { impersonateOwner: true }
      | { privateKey: `0x${string}` } = useRpcStateControls
      ? { impersonateOwner: true }
      : { privateKey: requirePrivateKeyForAddress(v1Owner, keys, "v1 owner") };

    // The migration wraps whatever the canonical top proxy currently serves.
    // When reusing a long-lived intermediate URP, the top proxy already fronts
    // it and the intermediate URP serves its own implementation (about to be
    // upgraded). Otherwise the freshly deployed managed proxy is seeded to the
    // top proxy's implementation, so both must report it before the switch.
    const baselineImplementation = (await client.readContract({
      address: topUrp.address,
      abi: Artifact_UpgradableUniversalResolverProxy.abi,
      functionName: "implementation",
    })) as Address;
    const topAlreadyFrontsManaged =
      getAddress(baselineImplementation) === getAddress(managedUrp.address);
    await verifyUrp({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      topUrp: topUrp.address,
      managedUrp: managedUrp.address,
      expectedTopImplementation: baselineImplementation,
      ...(topAlreadyFrontsManaged
        ? {}
        : { expectedManagedImplementation: baselineImplementation }),
    });

    const smokePrefix = `${opts.network === "mainnet" ? "mf" : "sf"}${Date.now().toString(36)}`;
    // Only the reserved names have to survive a resume: they were registered on v1
    // and seeded onto v2 by the interrupted run, so a replacement would be a name v1
    // never knew. The rest are chosen fresh each run because their assertions need
    // names the chain has never seen, which a replayed run would no longer offer.
    const reservedSmokeFile = join(workDir, "smoke-labels.json");
    const reservedSmoke =
      resumeFromPhase === 2
        ? readReservedSmokeLabels(reservedSmokeFile)
        : {
            migrate: `${smokePrefix}mig`,
            reservedOnly: `${smokePrefix}res`,
            migrateWrapped: `${smokePrefix}wrap`,
          };
    if (resumeFromPhase === 2) {
      console.log(
        `resumed smoke labels: ${reservedSmoke.migrate}.eth, ${reservedSmoke.reservedOnly}.eth, ${reservedSmoke.migrateWrapped}.eth`,
      );
    } else {
      writeFileSync(
        reservedSmokeFile,
        `${JSON.stringify(reservedSmoke, null, 2)}\n`,
      );
    }
    const smokeLabels = {
      v1BeforeDisable: `${smokePrefix}pre`,
      v1AfterDisable: `${smokePrefix}block`,
      v2BeforeEnable: `${smokePrefix}v2block`,
      v2AfterEnable: `${smokePrefix}v2ok`,
      ...reservedSmoke,
    };

    let smokeMigrationOwner = smokeAccount.address;
    let smokeMigrationPrivateKey: `0x${string}` | undefined = smokePrivateKey;

    const sharedSmokeV1 = {
      network: opts.network,
      rpcUrl,
      chain,
      provider,
      ...v1Deployments,
    };
    const registerSmokeV1 = (label: string) =>
      registerViaV1Controller({
        ...sharedSmokeV1,
        label,
        owner: smokeAccount.address,
        privateKey: smokePrivateKey,
        account: smokePrivateKey ? undefined : smokeAccount.address,
        useRpcStateControls,
      });
    const assertSmokeV1Owner = (label: string) =>
      assertV1Owner({ ...sharedSmokeV1, label, owner: smokeAccount.address });
    if (resumeFromPhase === 2) {
      smokeMigrationOwner = await readV1Owner({
        network: opts.network,
        rpcUrl,
        chain,
        provider,
        ...v1Deployments,
        label: smokeLabels.migrate,
      });
      smokeMigrationPrivateKey = undefined;
      if (useRpcStateControls) await impersonate(client, smokeMigrationOwner);
      console.log(`resumed smoke migration owner: ${smokeMigrationOwner}`);
    } else if (!postMigration) {
      console.log(
        "smoke: v1 registration succeeds before registrar disablement",
      );
      await registerSmokeV1(smokeLabels.v1BeforeDisable);
      await assertSmokeV1Owner(smokeLabels.v1BeforeDisable);
      await registerSmokeV1(smokeLabels.migrate);
      await assertSmokeV1Owner(smokeLabels.migrate);
      await registerSmokeV1(smokeLabels.reservedOnly);
      await assertSmokeV1Owner(smokeLabels.reservedOnly);
      // A wrapped name travels a different migration path than an unwrapped one, so
      // the rehearsal needs one of each.
      await registerSmokeV1(smokeLabels.migrateWrapped);
      await assertSmokeV1Owner(smokeLabels.migrateWrapped);
      prependCsvLabels(transformedCsv, [
        smokeLabels.migrate,
        smokeLabels.reservedOnly,
        smokeLabels.migrateWrapped,
      ]);
      console.log(
        `v1 registration succeeded before registrar disablement: ${smokeLabels.v1BeforeDisable}.eth`,
      );
      coveredChecks.push(SMOKE_CHECKS.v1Registration);
    }

    // The corpus is seeded here rather than before phase 1: a third of it
    // approves MigrationHelper while shaping its V1 state, which needs the V2
    // deployment phase 1 produces. It still lands before phase 3 closes V1
    // registration, and before pre-migration, which reserves the subset of its
    // labels that model a name already reserved on V2.
    const fixtureOptions = await fixtureRunOptions(opts, {
      rpcUrl,
      chainId,
      client,
      deploymentsDir,
      deploymentNetwork,
      ...v1Deployments,
      workDir,
      useRpcStateControls,
      v1Owner,
    });
    if (fixtureOptions && resumeFromPhase !== 2) {
      const { labels } = await runFixtureSeedStage(fixtureOptions);
      prependCsvLabels(transformedCsv, labels);
      console.log(
        `fixture: added ${labels.length} labels to the pre-migration CSV`,
      );
    }

    console.log("phase 2: initial pre-migration");
    await runPreMigrationCommand(
      {
        network: opts.network,
        rpcUrl,
        mainnetRpcUrl: rpcUrl,
        ...v1Deployments,
        deploymentsDir,
        deploymentNetwork,
        registry: ethRegistry.address,
        batchRegistrar: batchRegistrar.address,
        ...batchRegistrarSigner,
        csvFile: transformedCsv,
        v1Resolver: ensV1Resolver.address,
        v1BaseRegistrar: v1BaseRegistrar.address,
        batchSize: opts.batchSize,
        limit: opts.initialLimit,
        workDir,
        metadataLabel: "initial",
        persistMetadata: Boolean(opts.saveDeployments),
      },
      resumeFromPhase === 2,
    );
    if (!postMigration) {
      await assertV2State({
        rpcUrl,
        chain,
        ethRegistry,
        label: smokeLabels.migrate,
        status: STATUS.RESERVED,
      });
      console.log(`smoke pre-migration reserved ${smokeLabels.migrate}.eth`);
      coveredChecks.push(SMOKE_CHECKS.reservedAssertions);
    }

    console.log("phase 3: disable v1 registrars");
    await disableV1Registrars({
      // The rehearsal drives the phases itself and, on an already-migrated chain,
      // cannot run the reconciliation that gates the live command.
      skipPreconditions: true,
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      deploymentsDir,
      deploymentNetwork,
      ...v1Deployments,
      ...v1OwnerSigner,
    });
    if (!postMigration) {
      await assertRejected(
        registerSmokeV1(smokeLabels.v1AfterDisable),
        `v1 registration rejected after registrar disablement: ${smokeLabels.v1AfterDisable}.eth`,
        // The disabled controller can no longer mint on the BaseRegistrar, so the
        // registration must fail with a revert (at simulation or in the receipt).
        /revert/i,
      );
      coveredChecks.push(SMOKE_CHECKS.freezeRejection);
    }

    console.log(
      "phase 4: authorize ETHRenewerV1 so unmigrated names stay renewable",
    );
    if (!ethRenewerV1) {
      throw new Error("missing ETHRenewerV1 deployment for phase 4");
    }
    await authorizeV1Renewer({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      ...v1Deployments,
      deploymentsDir,
      deploymentNetwork,
      ethRenewerV1: ethRenewerV1.address,
      ...v1OwnerSigner,
    });
    {
      const renewerAuthorized = (await client.readContract({
        address: v1BaseRegistrar.address,
        abi: v1BaseRegistrar.abi,
        functionName: "controllers",
        args: [ethRenewerV1.address],
      })) as boolean;
      if (!renewerAuthorized) {
        throw new Error(
          "ETHRenewerV1 was not authorized as a v1 BaseRegistrar controller in phase 4",
        );
      }
      console.log("smoke ETHRenewerV1 authorized as a v1 renewal controller");
      coveredChecks.push(SMOKE_CHECKS.renewerAuthorization);
    }

    console.log("phase 5: sync remaining names and finish pre-migration");
    const finalSyncWorkDir = join(workDir, "final-sync");
    await runPreMigrationCommand(
      {
        network: opts.network,
        rpcUrl,
        mainnetRpcUrl: rpcUrl,
        ...v1Deployments,
        deploymentsDir,
        deploymentNetwork,
        registry: ethRegistry.address,
        batchRegistrar: batchRegistrar.address,
        ...batchRegistrarSigner,
        csvFile: transformedCsv,
        v1Resolver: ensV1Resolver.address,
        v1BaseRegistrar: v1BaseRegistrar.address,
        batchSize: opts.batchSize,
        limit: opts.finishLimit,
        workDir: finalSyncWorkDir,
        metadataLabel: "final-sync",
        persistMetadata: Boolean(opts.saveDeployments),
      },
      existsSync(join(finalSyncWorkDir, CHECKPOINT_FILE)),
    );
    coveredChecks.push(SMOKE_CHECKS.deployAndPreMigration);
    if (!postMigration) {
      await assertV2State({
        rpcUrl,
        chain,
        ethRegistry,
        label: smokeLabels.reservedOnly,
        status: STATUS.RESERVED,
      });
      console.log(
        `smoke pre-migration reserved ${smokeLabels.reservedOnly}.eth for registrar rejection`,
      );

      console.log("smoke: migrate a pre-migrated v1 name to v2");
      await migrateUnwrappedV1Name({
        network: opts.network,
        rpcUrl,
        chain,
        provider,
        ...v1Deployments,
        label: smokeLabels.migrate,
        owner: smokeMigrationOwner,
        privateKey: smokeMigrationPrivateKey,
        ...(smokeMigrationPrivateKey === undefined
          ? useRpcStateControls
            ? { impersonateAccount: smokeMigrationOwner }
            : { account: smokeMigrationOwner }
          : {}),
        migrationController: unlockedMigrationController,
      });
      await assertV2State({
        rpcUrl,
        chain,
        ethRegistry,
        label: smokeLabels.migrate,
        status: STATUS.REGISTERED,
        owner: smokeMigrationOwner,
      });
      console.log(
        `smoke migration registered ${smokeLabels.migrate}.eth on v2`,
      );

      // The wrapped path: the token is a NameWrapper 1155 keyed by namehash, not a
      // registrar 721 keyed by labelhash, and it is what most `.eth` names actually
      // hold. Nothing else in the rehearsal touches it.
      console.log("smoke: migrate a wrapped v1 name to v2");
      await migrateWrappedV1Name({
        network: opts.network,
        rpcUrl,
        chain,
        provider,
        ...v1Deployments,
        label: smokeLabels.migrateWrapped,
        owner: smokeMigrationOwner,
        privateKey: smokeMigrationPrivateKey,
        ...(smokeMigrationPrivateKey === undefined
          ? useRpcStateControls
            ? { impersonateAccount: smokeMigrationOwner }
            : { account: smokeMigrationOwner }
          : {}),
        migrationController: unlockedMigrationController,
      });
      await assertV2State({
        rpcUrl,
        chain,
        ethRegistry,
        label: smokeLabels.migrateWrapped,
        status: STATUS.REGISTERED,
        owner: smokeMigrationOwner,
      });
      console.log(
        `smoke migration registered wrapped ${smokeLabels.migrateWrapped}.eth on v2`,
      );
      coveredChecks.push(SMOKE_CHECKS.migration);
    }

    console.log(
      "phase 6: enable the v2 controller (disable batch registrar, hand off v1, enable v2 ETHRegistrar)",
    );
    await disableAndVerifyBatchRegistrar({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      registry: ethRegistry.address,
      batchRegistrar: batchRegistrar.address,
      deploymentsDir,
      deploymentNetwork,
      ...deploymentAdminSigner,
    });
    if (testnetV1PremigrationRegistrar) {
      console.log(
        `testnet premigration registrar remains enabled: ${testnetV1PremigrationRegistrar.address}`,
      );
    }

    await activateV1HandoffControllers({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      ...v1Deployments,
      deploymentsDir,
      deploymentNetwork,
      graveyard: graveyard.address,
      testnetV1PremigrationRegistrar: testnetV1PremigrationRegistrar?.address,
      ...v1OwnerSigner,
    });

    // Final lock-down of the v1 BaseRegistrar: hand its ownership to
    // ETHRenewerV1. This must follow the owner-signed handoff-controller grants
    // above, since the EOA can no longer manage controllers once ownership moves.
    await activateV1RenewerAndTransferOwnership({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      ...v1Deployments,
      deploymentsDir,
      deploymentNetwork,
      ethRenewerV1: ethRenewerV1.address,
      ...v1OwnerSigner,
    });

    // Being an authorized controller does not prove a renewal works. Renewal is the
    // only action a name owner has while a name is still unmigrated, and it must
    // extend the v1 registration, the v2 reservation, and the NameWrapper's copy of
    // the expiry together — so actually perform one.
    //
    // This runs after the ownership transfer above, not after phase 4's controller
    // grant: `renew()` calls `syncWrapper()`, which calls `addController` on the v1
    // BaseRegistrar, and that is owner-gated. Until ownership moves here, a renewal
    // through ETHRenewerV1 reverts.
    if (!postMigration && mockUsdc) {
      await renewViaEthRenewerV1({
        rpcUrl,
        chain,
        label: smokeLabels.reservedOnly,
        privateKey: smokeSignerPrivateKey,
        ethRenewerV1,
        ethRegistry,
        v1BaseRegistrar,
        nameWrapper: loadV1Deployment(
          opts.network,
          "NameWrapper",
          v1Deployments,
        ),
        mockUsdc,
        preFunded: paymentTokenPreFunded,
      });
      coveredChecks.push(SMOKE_CHECKS.renewal);
    } else if (!postMigration) {
      // Post-migration mode already accounts for this skip: the renewal needs the
      // v1 name that mode could not register. Recording it again would name the
      // same loss under a cause that is not the one that stopped it.
      recordSkipped(noPaymentTokenGap([SMOKE_CHECKS.renewal]));
    }

    // The handoff grants above are the last thing to touch v1 authorizations, so
    // assert the resulting set here, in both directions: only the active
    // deployment's contracts may hold a v1 grant, and every grant it depends on must
    // be in place. The first catches a superseded deployment's controller surviving
    // the freeze, which the phase 3 registration smoke cannot see; the second catches
    // an adapter or handoff contract that was never granted or was revoked, which
    // otherwise reads as "disabled" and passes.
    await verifyV1RegistrarsDisabled({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      ...v1Deployments,
      deploymentsDir,
      deploymentNetwork,
      requireActiveGrants: true,
    });
    coveredChecks.push(SMOKE_CHECKS.freezeAndHandoff);
    await verifyReverseAdapters({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      ...v1Deployments,
      deploymentsDir,
      deploymentNetwork,
    });

    const beforeEnabled = await client.readContract({
      address: ethRegistry.address,
      abi: ethRegistry.abi,
      functionName: "hasRootRoles",
      args: [REGISTRAR_ROLES, ethRegistrar.address],
    });
    if (beforeEnabled) {
      throw new Error("v2 registrar was enabled before the final phase");
    }
    // The paid-registration smokes need a mintable payment token, which only
    // exists on networks that deploy the mock tokens (mainnet whitelists real
    // USDC/DAI instead). Where there is no mock, still verify the role grant
    // directly and skip the paid registrations.
    if (mockUsdc) {
      await assertRejected(
        registerViaV2Registrar({
          rpcUrl,
          chain,
          label: smokeLabels.v2BeforeEnable,
          owner: smokeAccount.address,
          privateKey: smokeSignerPrivateKey,
          ethRegistrar,
          mockUsdc,
          useRpcStateControls,
          preFunded: paymentTokenPreFunded,
        }),
        `v2 registrar rejected registration before enablement: ${smokeLabels.v2BeforeEnable}.eth`,
        // Assert the specific cause. Matching any revert would let a wrong price,
        // an insufficient balance, or a bad nonce pass as proof the grant is absent.
        // The registry raises this when the registrar lacks REGISTRAR at root.
        /EACUnauthorizedAccountRoles/i,
      );
      coveredChecks.push(SMOKE_CHECKS.preEnableRejection);
    }
    await enableV2Registrar({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      registry: ethRegistry.address,
      ethRegistrar: ethRegistrar.address,
      deploymentsDir,
      deploymentNetwork,
      ...deploymentAdminSigner,
    });
    if (mockUsdc) {
      if (!postMigration) {
        await assertRejected(
          registerViaV2Registrar({
            rpcUrl,
            chain,
            label: smokeLabels.reservedOnly,
            owner: smokeAccount.address,
            privateKey: smokeSignerPrivateKey,
            ethRegistrar,
            mockUsdc,
            useRpcStateControls,
            preFunded: paymentTokenPreFunded,
          }),
          `v2 registrar rejected pre-migrated reserved name after enablement: ${smokeLabels.reservedOnly}.eth`,
          // Pin the rejection to an availability failure rather than accepting any
          // revert, which a payment or nonce problem would also satisfy. The
          // registrar rejects a pre-migrated name in its own availability check, so
          // the registry's reservation error is never reached; that the name is
          // RESERVED rather than merely taken is asserted separately above.
          /NameNotAvailable/i,
        );
        coveredChecks.push(SMOKE_CHECKS.reservedRejection);
      }
      await registerViaV2Registrar({
        rpcUrl,
        chain,
        label: smokeLabels.v2AfterEnable,
        owner: smokeAccount.address,
        privateKey: smokeSignerPrivateKey,
        ethRegistrar,
        mockUsdc,
        useRpcStateControls,
        preFunded: paymentTokenPreFunded,
      });
      await assertV2State({
        rpcUrl,
        chain,
        ethRegistry,
        label: smokeLabels.v2AfterEnable,
        status: STATUS.REGISTERED,
        owner: smokeAccount.address,
      });
      console.log(
        `v2 registrar registered ${smokeLabels.v2AfterEnable}.eth after enablement`,
      );
      coveredChecks.push(SMOKE_CHECKS.freshV2Registration);
    } else {
      const afterEnabled = await client.readContract({
        address: ethRegistry.address,
        abi: ethRegistry.abi,
        functionName: "hasRootRoles",
        args: [REGISTRAR_ROLES, ethRegistrar.address],
      });
      if (!afterEnabled) {
        throw new Error("v2 registrar was not enabled in phase 6");
      }
      console.log(
        "v2 registrar enabled (paid-registration smoke skipped: no mintable payment token on this network)",
      );
      recordSkipped(
        noPaymentTokenGap([
          SMOKE_CHECKS.paidRegistration,
          SMOKE_CHECKS.preEnableRejection,
        ]),
      );
    }

    // Being enabled is not the same as being able to take money. Reported rather
    // than enforced here: a rehearsal may run against a network whose real payment
    // tokens are not funded on the fork.
    await verifyRegistrarEconomics({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      deploymentsDir,
      deploymentNetwork,
      reportOnly: true,
    });

    // Every later check trusts these records to name the right contracts, so confirm
    // the code at each address is what the namespace claims before relying on them.
    await verifyDeployment({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      deploymentsDir,
      deploymentNetwork,
      reportOnly: true,
    });

    // Phase 6 is the last step to change v2 authority, so audit the whole role
    // matrix here rather than spot-checking one address. Reported, not enforced: a
    // rehearsal runs against fixtures that legitimately hold extra grants, and
    // failing on those would make the check something operators route around.
    console.log("phase 6: v2 role matrix");
    await verifyV2Roles({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      deploymentsDir,
      deploymentNetwork,
      deployer,
      owner,
      reportOnly: true,
    });

    console.log(
      "phase 7: switch the Universal Resolver to v2 (resolution cutover)",
    );

    // Capture how the sampled names resolve *before* the cutover. Phase 7 otherwise
    // proves only that the proxy points somewhere new — nothing about whether names
    // still resolve, or resolve to the same answers.
    // The bare `eth` TLD is deliberately registered in the v2 root with no
    // resolver, so it stops resolving at the cutover while every name under it
    // is unaffected. Sampling it would report that accepted difference on every
    // run, which trains readers to ignore an output whose whole purpose is to
    // surface real regressions. Names are what the cutover has to preserve.
    //
    // The smoke names alone cannot carry the comparison: they are registered with no
    // resolver, so every lookup reverts on both sides and the diff is empty however
    // the cutover behaves. Names from the operator's CSV already existed on the
    // forked chain with real records, which is precisely what the cutover must
    // preserve. The source is the operator's CSV, not the transformed one, because
    // phase 3 prepends the generated smoke labels to the latter.
    const resolvableCsvNames = await selectResolvableNames({
      client,
      universalResolver: topUrp.address,
      candidates: readLabelsFromCsv(
        resolve(opts.csvFile),
        RESOLUTION_CANDIDATE_POOL,
      ).map((label) => `${label}.eth`),
      limit: RESOLUTION_SAMPLE_SIZE,
    });
    const resolutionNames = [
      ...new Set(
        [
          smokeLabels.migrate && `${smokeLabels.migrate}.eth`,
          smokeLabels.v2AfterEnable && `${smokeLabels.v2AfterEnable}.eth`,
          ...resolvableCsvNames,
          ...(opts.resolutionNames?.split(",").map((name) => name.trim()) ??
            []),
        ].filter((name): name is string => Boolean(name)),
      ),
    ];
    const resolutionBefore = await captureResolutionSnapshot({
      client,
      universalResolver: topUrp.address,
      names: resolutionNames,
    });
    console.log(
      `captured pre-cutover resolution for ${resolutionBefore.names.length} name(s), ${resolvableCsvNames.length} of them carrying records before the switch`,
    );

    // Reuse flow: the top URP already fronts the intermediate URP, so the switch
    // is skipped and only the intermediate URP is upgraded below. Bootstrap flow:
    // point the top URP at the freshly deployed managed URP first.
    if (topAlreadyFrontsManaged) {
      console.log(
        `top URP already fronts managed URP: ${managedUrp.address}; skipping switch`,
      );
    } else {
      const topUrpAdmin = (await client.readContract({
        address: topUrp.address,
        abi: Artifact_UpgradableUniversalResolverProxy.abi,
        functionName: "admin",
      })) as Address;
      if (getAddress(topUrpAdmin) === getAddress(zeroAddress)) {
        throw new Error(
          "top URP admin is address(0); cannot impersonate admin for fork switch",
        );
      }
      console.log(`top URP admin: ${topUrpAdmin}`);
      await switchTopUrpToManaged({
        network: opts.network,
        rpcUrl,
        chainId: String(chainId),
        provider,
        topUrp: topUrp.address,
        managedUrp: managedUrp.address,
        ...(useRpcStateControls
          ? { impersonateAccount: topUrpAdmin }
          : {
              privateKey: requirePrivateKeyForAddress(
                topUrpAdmin,
                keys,
                "top URP admin",
              ),
            }),
      });
      console.log(`top URP switched to managed URP: ${managedUrp.address}`);
    }

    // On a reuse network the managed URP is adopted by address and its admin is a
    // real account, not the rehearsal's deployer. Read the admin and impersonate it
    // rather than requiring the operator to pass it: getting it wrong fails right at
    // the end of a long run, with `CallerNotAdmin` and nothing pointing at the cause.
    const managedUrpAdmin = (await client.readContract({
      address: managedUrp.address,
      abi: Artifact_UpgradableUniversalResolverProxy.abi,
      functionName: "admin",
    })) as Address;
    const urManagerIsAdmin =
      getAddress(managedUrpAdmin) === getAddress(urManager);
    if (!urManagerIsAdmin) {
      console.log(
        `managed URP admin is ${managedUrpAdmin}, not the configured ur-manager ${urManager}`,
      );
      if (!useRpcStateControls) {
        throw new Error(
          `managed URP admin is ${managedUrpAdmin}; pass --ur-manager with that address and a matching key`,
        );
      }
      await setBalance(client, managedUrpAdmin);
      await impersonate(client, managedUrpAdmin);
    }
    await upgradeManagedUrp({
      network: opts.network,
      rpcUrl,
      chainId: String(chainId),
      provider,
      managedUrp: managedUrp.address,
      implementation: universalResolverV2.address,
      ...(!useRpcStateControls
        ? {
            privateKey: requirePrivateKeyForAddress(
              urManager,
              keys,
              "managed URP admin",
            ),
          }
        : !urManagerIsAdmin
          ? { impersonateAccount: managedUrpAdmin }
          : urManager === DEFAULT_ANVIL_DEPLOYER
            ? { privateKey: DEFAULT_ANVIL_KEY }
            : { impersonateAccount: urManager }),
    });
    console.log(`managed URP upgraded to: ${universalResolverV2.address}`);

    // The cutover is only correct if the same questions still get the same answers.
    // Reported rather than enforced: a rehearsal's smoke names are created during
    // the run, so some legitimately change as the migration proceeds.
    const resolutionAfter = await captureResolutionSnapshot({
      client,
      universalResolver: topUrp.address,
      names: resolutionNames,
    });
    const resolutionDifferences = diffResolutionSnapshots(
      resolutionBefore,
      resolutionAfter,
    );
    // A sample that carried nothing on either side compares nothing and still
    // reports success. Say that rather than letting a vacuous pass read like a
    // verified cutover.
    const resolvedAnything = [resolutionBefore, resolutionAfter].some(
      snapshotCarriesRecords,
    );
    if (!resolvedAnything) {
      console.log(
        `resolution across the cutover was not verified: none of the ${resolutionNames.length} sampled name(s) resolved any record before or after, so there was nothing to compare — pass --resolution-names with a name that has records`,
      );
      console.log(`  sampled: ${resolutionNames.join(", ")}`);
      coveredChecks.push(
        "the phase 7 URP cutover, though resolution across it was not verified",
      );
    } else if (resolutionDifferences.length === 0) {
      console.log(
        `resolution unchanged across the cutover for ${resolutionNames.length} name(s)`,
      );
      coveredChecks.push(
        `the phase 7 URP cutover, with resolution unchanged across it for ${resolutionNames.length} name(s)`,
      );
    } else {
      console.log(
        `resolution changed across the cutover for ${resolutionDifferences.length} record(s):`,
      );
      for (const difference of resolutionDifferences.slice(0, 20)) {
        console.log(`  ${describeDifference(difference)}`);
      }
      coveredChecks.push(
        `the phase 7 URP cutover, with ${resolutionDifferences.length} record(s) reported as changed across it`,
      );
    }

    if (opts.network === "mainnet") {
      console.log(
        `mainnet DAO simulation used owner/v1Owner impersonation: ${owner}`,
      );
    }

    // A rehearsal that quietly covered less than it appears to is worse than one
    // that fails, so what was not exercised is stated at the end rather than left in
    // scrollback thousands of lines up.
    reportCoverage({ skipped: skippedCoverage, covered: coveredChecks });
    console.log("");
    console.log(`rehearsal work dir: ${workDir}`);
    // Post-migration mode fails early, before the rehearsal runs. The conditions
    // detected mid-run — a payment token that could not be funded — reach here
    // instead, and the flag has to fail on those too or it enforces only the case
    // that was already caught.
    if (opts.requireFullCoverage && skippedCoverage.length > 0) {
      throw new Error(
        `--require-full-coverage was set but the rehearsal ran a reduced set of smoke checks: ${skippedCoverage
          .map((gap) => gap.cause)
          .join("; ")}`,
      );
    }
  } finally {
    if (anvil && !opts.keepAnvil) {
      anvil.kill();
    }
  }
}

export async function runCleanTestnetFull(opts: RunCleanTestnetFullOptions) {
  // Clean testnet deploys always run directly against the configured RPC; no local
  // Anvil fork is ever spawned.
  installRpcCompatibility(Boolean(opts.debugRpc));
  if (opts.network !== "sepolia") {
    throw new Error(
      "clean testnet full deploy currently supports sepolia only",
    );
  }

  const network = NETWORKS[opts.network];
  const forkRpcUrl = requireRpcUrl(opts, opts.network);
  const useRpcStateControls =
    opts.tenderly ||
    isLocalRpcUrl(forkRpcUrl) ||
    isTenderlyVirtualRpc(forkRpcUrl);
  if (!useRpcStateControls && !opts.deployerPrivateKey) {
    throw new Error(
      "clean testnet full deploy requires a configured deployer private key",
    );
  }
  const chainId = parseNumber(opts.chainId, network.chain.id);
  const chain = forkChain(opts.network, chainId, forkRpcUrl);
  const client = publicClient(forkRpcUrl, chain, opts.provider);
  await waitForRpc(forkRpcUrl, chain);

  const deploymentNetwork =
    opts.deploymentNetwork ??
    `${network.environment}-clean-${Date.now().toString(36)}`;
  const v1DeploymentNetwork = opts.v1DeploymentNetwork ?? deploymentNetwork;
  const v1DeploymentsDir = resolve(
    opts.v1DeploymentsDir ?? LOCAL_V1_DEPLOYMENTS_DIR,
  );
  const deploymentsDir = resolve(
    opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
  );
  if (!opts.resumeExistingDeployments) {
    assertCleanDeploymentNamespace(
      deploymentsDir,
      deploymentNetwork,
      network.environment,
      "v2",
    );
    assertCleanDeploymentNamespace(
      v1DeploymentsDir,
      v1DeploymentNetwork,
      network.environment,
      "v1",
    );
  }
  const workDir = resolve(
    opts.workDir ??
      join(tmpdir(), `enschain-${deploymentNetwork}-clean-${Date.now()}`),
  );
  mkdirSync(workDir, { recursive: true });

  const deployer = opts.deployer;
  if (deployer === undefined) {
    throw new Error("clean testnet full deploy requires --deployer");
  }
  const owner = opts.owner ?? deployer;
  const v1Owner = opts.v1Owner ?? owner;
  const urManager = opts.urManager ?? deployer;

  if (useRpcStateControls) {
    await setBalance(client, deployer);
    await setBalance(client, owner);
    await setBalance(client, v1Owner);
    await setBalance(client, urManager);
    await clearAccountDelegations(client, [
      { address: deployer, label: "deployer" },
      { address: owner, label: "owner" },
      { address: v1Owner, label: "v1 owner" },
    ]);
    await impersonate(client, deployer);
    await impersonate(client, owner);
    await impersonate(client, v1Owner);
    await impersonate(client, urManager);
  }

  console.log(`clean deployment namespace: ${deploymentNetwork}`);
  console.log(
    `v1 deployment files: ${join(v1DeploymentsDir, v1DeploymentNetwork)}`,
  );
  console.log(
    `v2 deployment files: ${join(deploymentsDir, deploymentNetwork)}`,
  );

  const v1DeploymentPath = join(v1DeploymentsDir, v1DeploymentNetwork);
  const hasExistingV1Deployments =
    existsSync(v1DeploymentPath) &&
    readdirSync(v1DeploymentPath).some((file) => file.endsWith(".json"));
  if (opts.resumeExistingDeployments && hasExistingV1Deployments) {
    console.log("clean phase 0: skipped; using existing fresh v1 deployments");
  } else {
    console.log("clean phase 0: deploy fresh v1 contracts");
    await deployV1({
      network: opts.network,
      rpcUrl: forkRpcUrl,
      provider: opts.provider,
      chainId: String(chainId),
      deploymentsDir: v1DeploymentsDir,
      deploymentNetwork: v1DeploymentNetwork,
      saveDeployments: true,
      tenderly: opts.tenderly,
      deployer,
      deployerPrivateKey: opts.deployerPrivateKey,
      owner: v1Owner,
      // Only attach a key that actually controls v1Owner; otherwise leave it unset
      // so the fresh v1 stack is owned by the impersonated v1Owner rather than the
      // deployer (whose key would otherwise be used as a blanket fallback and make
      // later v1Owner-impersonated writes revert).
      ownerPrivateKey: signerKeyForAccount(v1Owner, [
        opts.v1OwnerPrivateKey,
        opts.ownerPrivateKey,
        opts.deployerPrivateKey,
      ]),
    });
  }

  const csvFile = opts.csvFile
    ? resolve(opts.csvFile)
    : join(workDir, "clean-premigration-source.csv");
  if (!opts.csvFile) {
    writeFileSync(csvFile, "labelName\n");
  }

  await runForkFull({
    ...opts,
    direct: true,
    rpcUrl: forkRpcUrl,
    provider: opts.provider,
    chainId: String(chainId),
    csvFile,
    workDir,
    deploymentsDir: opts.deploymentsDir,
    deploymentNetwork,
    v1DeploymentsDir,
    v1DeploymentNetwork,
    saveDeployments: true,
    tenderly: opts.tenderly,
    rpcStateControls: useRpcStateControls,
    includeTestnetPremigrationRegistrar: true,
    cleanTestnet: true,
    deployer,
    deployerPrivateKey: opts.deployerPrivateKey,
    owner,
    // Only attach a key that controls the resolved account so an explicit
    // --owner/--ur-manager/--v1-owner is not silently signed for by the
    // deployer key; unmatched accounts fall back to fork impersonation.
    ownerPrivateKey: signerKeyForAccount(owner, [
      opts.ownerPrivateKey,
      opts.deployerPrivateKey,
    ]),
    v1Owner,
    v1OwnerPrivateKey: signerKeyForAccount(v1Owner, [
      opts.v1OwnerPrivateKey,
      opts.ownerPrivateKey,
      opts.deployerPrivateKey,
    ]),
    urManager,
    urManagerPrivateKey: signerKeyForAccount(urManager, [
      opts.urManagerPrivateKey,
      opts.deployerPrivateKey,
    ]),
    resumeFromPhase: undefined,
  });
}

function addNetworkOptions(command: Command): Command {
  return command
    .requiredOption("--network <network>", "Network: sepolia or mainnet")
    .option("--rpc-url <url>", "Network RPC URL")
    .option("--chain-id <id>", "Chain id override");
}

function addDeploymentOptions(command: Command): Command {
  return command
    .option("--deployment-network <name>", "Deployment directory network name")
    .option(
      "--deployments-dir <path>",
      "Root directory for v2 deployments",
      DEFAULT_DEPLOYMENTS_DIR,
    );
}

function addV1DeploymentOptions(command: Command): Command {
  return command
    .option("--v1-deployments-dir <path>", "Root directory for v1 deployments")
    .option(
      "--v1-deployment-network <name>",
      "V1 deployment directory network name",
    );
}

// The signer options shared by every v1-owner-gated write command: a key, fork
// impersonation, or calldata-only preparation for a multisig.
function addV1OwnerWriteOptions(command: Command): Command {
  return command
    .option("--private-key <key>", "V1 owner private key")
    .option("--impersonate-owner", "Impersonate owner on a fork", false)
    .option("--calldata-only", "Print transaction target and calldata", false);
}

function assertCleanDeploymentNamespace(
  root: string,
  environment: string,
  canonicalEnvironment: string,
  label: string,
) {
  if (environment === canonicalEnvironment) {
    throw new Error(
      `clean testnet deploy refuses to use canonical ${label} namespace: ${environment}`,
    );
  }
  const path = join(root, environment);
  if (!existsSync(path)) return;
  const deploymentFiles = readdirSync(path).filter((file) =>
    file.endsWith(".json"),
  );
  if (deploymentFiles.length > 0) {
    throw new Error(
      `clean testnet deploy refuses to reuse populated ${label} namespace: ${path}`,
    );
  }
}

const DEPLOYMENT_METADATA_FILE = ".deployment.json";

// Records when a namespace was first deployed. rocketh ignores dotfiles other
// than `.migrations.json`, so this metadata never interferes with artifact
// loading. Written once so the timestamp reflects the original deployment and
// survives idempotent re-runs; the fresh-deploy archiver reads it back to name
// the archived folder.
function recordDeploymentMetadata(
  root: string,
  environment: string,
  chainId: number,
) {
  const dir = join(root, environment);
  if (!existsSync(dir)) return;
  const metadataPath = join(dir, DEPLOYMENT_METADATA_FILE);
  if (existsSync(metadataPath)) return;
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      { environment, chainId, deployedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );
}

const PREMIGRATION_METADATA_FILE = ".premigration.json";

// One summary entry per logical pre-migration run (initial, final-sync, or a
// standalone run). Counts only — never label strings.
interface PreMigrationRunSummary {
  label: string;
  finishedAt: string;
  totalExpected: number;
  totalProcessed: number;
  reserved: number;
  renewed: number;
  skippedNeverRegistered: number;
  skippedExpiredPastGrace: number;
  invalidLabels: number;
  alreadyOnV2: number;
  /// Reservations already carrying an expiry at least as long as this run would set,
  /// so nothing was submitted for them. They are pre-migrated all the same.
  upToDate: number;
  failed: number;
}

interface PreMigrationMetadata {
  network: string;
  deploymentNetwork: string;
  chainId?: number;
  updatedAt: string;
  resolved: {
    finishedAt: string;
    totalNames: number;
    namesPreMigrated: number;
    newReservations: number;
    expiryResyncs: number;
    alreadyCurrent: number;
    skippedNeverRegistered: number;
    skippedExpiredPastGrace: number;
    invalidLabels: number;
    alreadyOnV2: number;
    failed: number;
  };
  runs: PreMigrationRunSummary[];
}

function checkpointToRunSummary(
  label: string,
  checkpoint: Checkpoint,
): PreMigrationRunSummary {
  return {
    label,
    finishedAt: checkpoint.timestamp,
    totalExpected: checkpoint.totalExpected,
    totalProcessed: checkpoint.totalProcessed,
    reserved: checkpoint.successCount,
    renewed: checkpoint.renewedCount,
    skippedNeverRegistered: checkpoint.skippedNeverRegisteredCount,
    skippedExpiredPastGrace: checkpoint.skippedPastGraceCount,
    invalidLabels: checkpoint.invalidLabelCount,
    alreadyOnV2: checkpoint.alreadyRegisteredCount,
    upToDate: checkpoint.upToDateCount,
    failed: checkpoint.failedLines.length,
  };
}

// The resolved roll-up reflects the run that finished most recently, which in
// the phased flow is the final-sync pass that re-scans the whole corpus and so
// represents the end state. `namesPreMigrated` = names currently reserved on v2:
// newly reserved this run, already-reserved names whose expiry was re-synced, and
// already-reserved names that needed no change. The last group is most of the corpus
// by the final sync, and leaving it out made the published figure describe only what
// the last run happened to touch rather than what is on v2.
function resolveFromRuns(
  runs: PreMigrationRunSummary[],
): PreMigrationMetadata["resolved"] {
  const latest = runs.reduce((a, b) => (b.finishedAt >= a.finishedAt ? b : a));
  return {
    finishedAt: latest.finishedAt,
    totalNames: latest.totalExpected,
    namesPreMigrated: latest.reserved + latest.renewed + latest.upToDate,
    newReservations: latest.reserved,
    expiryResyncs: latest.renewed,
    alreadyCurrent: latest.upToDate,
    skippedNeverRegistered: latest.skippedNeverRegistered,
    skippedExpiredPastGrace: latest.skippedExpiredPastGrace,
    invalidLabels: latest.invalidLabels,
    alreadyOnV2: latest.alreadyOnV2,
    failed: latest.failed,
  };
}

// Persists a compact pre-migration counts sidecar into the deployment
// namespace, alongside `.deployment.json`. A dotfile so rocketh's loader ignores
// it (it only reads `.migrations.json` + non-dot `*.json` artifacts). Each run
// is upserted by `label` so a resume that re-writes its accumulated checkpoint
// updates its own entry in place instead of appending a duplicate.
function recordPreMigrationMetadata(opts: {
  deploymentsDir: string;
  deploymentNetwork: string;
  network: MigrationNetwork;
  label: string;
  checkpoint: Checkpoint;
}) {
  const dir = join(opts.deploymentsDir, opts.deploymentNetwork);
  if (!existsSync(dir)) return;
  const metadataPath = join(dir, PREMIGRATION_METADATA_FILE);

  let existing: PreMigrationMetadata | undefined;
  if (existsSync(metadataPath)) {
    try {
      existing = JSON.parse(readFileSync(metadataPath, "utf-8"));
    } catch {
      existing = undefined;
    }
  }

  const runs = (existing?.runs ?? []).filter((run) => run.label !== opts.label);
  runs.push(checkpointToRunSummary(opts.label, opts.checkpoint));

  const metadata: PreMigrationMetadata = {
    network: opts.network,
    deploymentNetwork: opts.deploymentNetwork,
    chainId: NETWORKS[opts.network].chain.id,
    updatedAt: new Date().toISOString(),
    resolved: resolveFromRuns(runs),
    runs,
  };

  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

// Resolves a namespace's deploy time, preferring the recorded metadata and
// falling back to the latest `.migrations.json` entry (unix-epoch seconds).
function readDeploymentDeployedAt(path: string): string | undefined {
  const metadataPath = join(path, DEPLOYMENT_METADATA_FILE);
  if (existsSync(metadataPath)) {
    try {
      const { deployedAt } = JSON.parse(readFileSync(metadataPath, "utf-8"));
      if (typeof deployedAt === "string") return deployedAt;
    } catch {}
  }
  const migrationsPath = join(path, ".migrations.json");
  if (existsSync(migrationsPath)) {
    try {
      const migrations = JSON.parse(
        readFileSync(migrationsPath, "utf-8"),
      ) as Record<string, number>;
      const timestamps = Object.values(migrations).filter(
        (value) => typeof value === "number" && Number.isFinite(value),
      );
      if (timestamps.length > 0) {
        return new Date(Math.max(...timestamps) * 1000).toISOString();
      }
    } catch {}
  }
  return undefined;
}

// Moves an existing deployment namespace aside so a fresh deployment can take
// its place. The archive is suffixed with the archived deployment's date and an
// auto-incrementing revision, e.g. `sepolia-20260525-r1`.
function archiveExistingDeploymentNamespace(root: string, environment: string) {
  const path = join(root, environment);
  if (!existsSync(path)) return;
  const hasArtifacts = readdirSync(path).some(
    (file) => file.endsWith(".json") || file === ".chain",
  );
  if (!hasArtifacts) return;
  const deployedAt = readDeploymentDeployedAt(path) ?? new Date().toISOString();
  const stamp = deployedAt.slice(0, 10).replace(/-/g, "");
  let revision = 1;
  let archive = `${environment}-${stamp}-r${revision}`;
  while (existsSync(join(root, archive))) {
    revision += 1;
    archive = `${environment}-${stamp}-r${revision}`;
  }
  renameSync(path, join(root, archive));
  console.log(`archived existing ${environment} deployment to ${archive}`);
}

// Minimal CLI option shapes. Commander hands us plain strings; the address and
// private-key fields below are boundary assertions for downstream signatures.
type NetworkCliOptions = {
  network: string;
  rpcUrl?: string;
  chainId?: string;
};

type DeploymentCliOptions = {
  deploymentNetwork?: string;
  deploymentsDir?: string;
};

type V1DeploymentCliOptions = {
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
};

// Phase commands that broadcast (or print calldata) as the v1 owner.
type V1OwnerWriteCliOptions = {
  privateKey?: `0x${string}`;
  impersonateOwner?: boolean;
  calldataOnly?: boolean;
};

// Phase commands that broadcast as a registry/proxy admin account.
type AdminSignerCliOptions = {
  privateKey?: `0x${string}`;
  impersonateAccount?: Address;
};

type PremigrationRunCliOptions = NetworkCliOptions &
  DeploymentCliOptions &
  V1DeploymentCliOptions & {
    privateKey?: `0x${string}`;
    csvFile: string;
    mainnetRpcUrl?: string;
    registry?: Address;
    batchRegistrar?: Address;
    v1Resolver?: Address;
    v1BaseRegistrar?: Address;
    batchSize?: string;
    limit?: string;
    bonusPeriodDays?: string;
    workDir?: string;
    dryRun?: boolean;
  };

type PremigrationVerifyCliOptions = NetworkCliOptions &
  DeploymentCliOptions &
  V1DeploymentCliOptions & {
    csvFile: string;
    mainnetRpcUrl?: string;
    registry?: Address;
    v1Resolver?: Address;
    v1BaseRegistrar?: Address;
    limit?: string;
    expectedStatus?: "reserved" | "registered" | "reserved-or-registered";
    bonusPeriodDays?: string;
  };

type DeployV2CliOptions = NetworkCliOptions &
  DeploymentCliOptions &
  V1DeploymentCliOptions & {
    resume?: boolean;
    includeTestnetPremigrationRegistrar?: boolean;
    deferV1OwnerTransactions?: boolean;
    deferredV1OwnerTransactionsFile?: string;
    deployer?: Address;
    owner?: Address;
    urManager?: Address;
    v1Owner?: Address;
    impersonateV1Owner?: boolean;
    rpcCompatibility?: boolean;
    debugRpc?: boolean;
    tags?: string;
  };

type ForkFullCliOptions = Omit<RunForkFullOptions, "network"> &
  NetworkCliOptions;

type CleanTestnetCliOptions = Omit<RunCleanTestnetFullOptions, "network"> &
  NetworkCliOptions;

function withNetwork<T extends NetworkCliOptions>(
  opts: T,
): Omit<T, "network"> & { network: MigrationNetwork } {
  return {
    ...opts,
    network: parseMigrationNetwork(opts.network),
  } as Omit<T, "network"> & { network: MigrationNetwork };
}

// Parse the network and resolve the RPC URL (option or env) in one step, the
// pair every live/fork command needs before calling into the migration logic.
function withNetworkRpc<T extends NetworkCliOptions>(
  input: T,
): Omit<T, "network"> & { network: MigrationNetwork; rpcUrl: string } {
  const networkOpts = withNetwork(input);
  return {
    ...networkOpts,
    rpcUrl: requireRpcUrl(networkOpts, networkOpts.network),
  };
}

// The v1-owner key for an owner-gated write: an explicit option, otherwise the
// conventional environment variables.
function v1OwnerKeyFromEnv(opts: {
  privateKey?: `0x${string}`;
}): `0x${string}` | undefined {
  return (
    opts.privateKey ?? envPrivateKey("SEPOLIA_V1_OWNER_KEY", "V1_OWNER_KEY")
  );
}

export async function main(argv = process.argv): Promise<void> {
  loadDotEnv(resolve(import.meta.dirname, "../.env"));

  const program = new Command()
    .name("migration")
    .description(
      "Operate and rehearse the ENS v1 to v2 migration in explicit phases.",
    );

  program.addCommand(
    new Command("fetch-data")
      .description("Fetch ENS registration data from TheGraph into a CSV")
      .option(
        "--thegraph-api-key <key>",
        "TheGraph Gateway API key; falls back to THEGRAPH_API_KEY or GRAPH_API_KEY",
      )
      .option(
        "--network <network>",
        "ENS registrations network: mainnet or sepolia",
        "mainnet",
      )
      .option("--batch-size <number>", "Rows per TheGraph request", "1000")
      .option(
        "--start-id <labelhash>",
        "Resume after this registration id (exclusive)",
      )
      .option("--limit <number>", "Maximum registrations to fetch")
      .option(
        "--block <number>",
        "Pin the export to this indexed block; defaults to the subgraph head",
      )
      .option(
        "--output <file>",
        "Output CSV file",
        `csv-data/ens-registrations-${new Date().toISOString().split("T")[0]}.csv`,
      )
      .action(
        async (opts: {
          thegraphApiKey?: string;
          network?: string;
          batchSize?: string;
          startId?: string;
          limit?: string;
          block?: string;
          output: string;
        }) => {
          await runFetchData(opts);
        },
      ),
  );

  const premigration = new Command("premigration").description(
    "Run, resume, inspect, and verify pre-migration reservations.",
  );

  const addPremigrationOptions = (command: Command) =>
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(command)
          .option("--private-key <key>", "BatchRegistrar owner private key")
          .requiredOption("--csv-file <path>", "Pre-migration CSV")
          .option("--mainnet-rpc-url <url>", "RPC URL for v1 expiry reads")
          .option("--registry <address>", "v2 ETHRegistry address")
          .option("--batch-registrar <address>", "BatchRegistrar address")
          .option("--v1-resolver <address>", "ENSV1Resolver address")
          .option("--v1-base-registrar <address>", "v1 BaseRegistrar address")
          .option("--batch-size <number>", "Names per batch", "50")
          .option("--limit <number>", "Maximum names to process")
          .option(
            "--bonus-period-days <days>",
            "Days added to each name's v1 expiry to compute its v2 expiry",
          )
          .option("--work-dir <path>", "Directory for checkpoints and logs")
          .option("--dry-run", "Simulate without transactions", false),
      ),
    );

  premigration.addCommand(
    addPremigrationOptions(
      new Command("run").description(
        "Start pre-migration from a fresh checkpoint",
      ),
    ).action(async (opts: PremigrationRunCliOptions) => {
      const networkOpts = withNetworkRpc(opts);
      await runPreMigrationCommand(
        {
          ...networkOpts,
          metadataLabel: "run",
        },
        false,
      );
    }),
  );
  premigration.addCommand(
    addPremigrationOptions(
      new Command("resume").description("Resume pre-migration from checkpoint"),
    ).action(async (opts: PremigrationRunCliOptions) => {
      const networkOpts = withNetworkRpc(opts);
      await runPreMigrationCommand(
        {
          ...networkOpts,
          metadataLabel: "run",
        },
        true,
      );
    }),
  );
  premigration.addCommand(
    new Command("status")
      .description("Print the current pre-migration checkpoint")
      .option(
        "--work-dir <path>",
        "Directory containing preMigration-checkpoint.json",
      )
      .action(async (opts: { workDir?: string }) => {
        await printPreMigrationStatus(opts);
      }),
  );
  premigration.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("verify")
            .description(
              "Verify eligible CSV names were reserved or registered on v2",
            )
            .requiredOption("--csv-file <path>", "Pre-migration CSV")
            .option("--mainnet-rpc-url <url>", "RPC URL for v1 expiry reads")
            .option("--registry <address>", "v2 ETHRegistry address")
            .option("--v1-resolver <address>", "Expected ENSV1Resolver address")
            .option("--v1-base-registrar <address>", "v1 BaseRegistrar address")
            .option("--limit <number>", "Maximum labels to verify")
            .option(
              "--expected-status <status>",
              "reserved, registered, or reserved-or-registered",
              "reserved-or-registered",
            )
            .option(
              "--bonus-period-days <days>",
              "Days added to each name's v1 expiry to compute its expected v2 expiry",
              "62",
            ),
        ),
      ),
    ).action(async (opts: PremigrationVerifyCliOptions) => {
      const networkOpts = withNetworkRpc(opts);
      await verifyPreMigration({
        ...networkOpts,
      });
    }),
  );

  premigration.addCommand(
    addV1DeploymentOptions(
      new Command("build-index")
        .description(
          "Build an independent labelhash-keyed index of v1 names for reconciliation",
        )
        .requiredOption("--work-dir <path>", "Directory to hold the index")
        .option(
          "--network <network>",
          "ENS registrations network: mainnet or sepolia",
          "mainnet",
        )
        .option(
          "--source <source>",
          "Where to read v1 names from: subgraph (TheGraph) or rpc (v1 BaseRegistrar logs)",
          "subgraph",
        )
        .option(
          "--thegraph-api-key <key>",
          "TheGraph Gateway API key; falls back to THEGRAPH_API_KEY or GRAPH_API_KEY",
        )
        .option("--batch-size <number>", "Rows per request", "1000")
        .option(
          "--block <number>",
          "Pin the index to this block; defaults to the source's head",
        )
        .option(
          "--resume",
          "Continue a partial index instead of rebuilding",
          false,
        )
        .option("--rpc-url <url>", "Network RPC URL (--source rpc)")
        .option("--chain-id <id>", "Chain id override (--source rpc)")
        .option(
          "--v1-base-registrar <address>",
          "v1 BaseRegistrar address (--source rpc)",
        )
        .option(
          "--from-block <number>",
          "First block to scan for registrations; defaults to the v1 BaseRegistrar deploy block (--source rpc)",
        )
        .option(
          "--scan-range <number>",
          "Blocks per log query before narrowing (--source rpc)",
          "250000",
        ),
    ).action(
      async (
        opts: V1DeploymentCliOptions & {
          workDir: string;
          network?: string;
          source?: string;
          thegraphApiKey?: string;
          batchSize?: string;
          block?: string;
          resume?: boolean;
          rpcUrl?: string;
          chainId?: string;
          v1BaseRegistrar?: Address;
          fromBlock?: string;
          scanRange?: string;
        },
      ) => {
        const network = parseENSRegistrationNetwork(opts.network ?? "mainnet");
        const source = opts.source ?? "subgraph";
        if (source !== "subgraph" && source !== "rpc") {
          throw new Error(
            `unknown --source ${source}: expected "subgraph" or "rpc"`,
          );
        }

        const onProgress = (entries: number, cursor: string) => {
          console.log(`indexed ${entries} names (at ${cursor})`);
        };

        const meta =
          source === "rpc"
            ? await (async () => {
                const networkOpts = withNetworkRpc({
                  ...opts,
                  network,
                } as NetworkCliOptions);
                const chain = migrationChain(networkOpts);
                const client = publicClient(networkOpts.rpcUrl, chain);
                const baseRegistrar = requireV1Deployment(
                  networkOpts.network,
                  V1_BASE_REGISTRAR_NAME,
                  opts,
                );
                // The registrar logged nothing before it existed, so its own
                // deploy block is the only sensible floor for the scan; without
                // it the walk starts at genesis and burns queries on empty
                // ranges.
                const fromBlock =
                  opts.fromBlock !== undefined
                    ? Number(opts.fromBlock)
                    : deploymentBlockNumber(baseRegistrar);
                if (fromBlock === undefined) {
                  throw new Error(
                    "cannot determine the v1 BaseRegistrar deploy block; pass --from-block",
                  );
                }
                console.log(
                  `scanning ${V1_BASE_REGISTRAR_NAME} ${baseRegistrar.address} from block ${fromBlock}`,
                );
                return buildV1NameIndexFromRpc(
                  {
                    network,
                    workDir: opts.workDir,
                    fromBlock,
                    block: opts.block ? Number(opts.block) : undefined,
                    scanRange: parseNumber(opts.scanRange, 250_000),
                    batchSize: parseNumber(opts.batchSize, 500),
                    resume: opts.resume,
                    onProgress,
                  },
                  createRpcIndexClient({
                    // viem's client satisfies the three calls the adapter makes;
                    // its overloaded signatures do not line up structurally.
                    client: client as unknown as Parameters<
                      typeof createRpcIndexClient
                    >[0]["client"],
                    baseRegistrar:
                      opts.v1BaseRegistrar ?? baseRegistrar.address,
                  }),
                );
              })()
            : await (async () => {
                const thegraphApiKey =
                  opts.thegraphApiKey ??
                  envValue("THEGRAPH_API_KEY", "GRAPH_API_KEY");
                if (!thegraphApiKey) {
                  throw new Error(
                    "Missing --thegraph-api-key or THEGRAPH_API_KEY/GRAPH_API_KEY",
                  );
                }
                return buildV1NameIndex({
                  thegraphApiKey,
                  network,
                  workDir: opts.workDir,
                  batchSize: parseNumber(opts.batchSize, 1000),
                  block: opts.block ? Number(opts.block) : undefined,
                  resume: opts.resume,
                  onProgress,
                });
              })();

        console.log(
          `index complete: ${meta.entries} names @ block ${meta.block} (${meta.source})`,
        );
      },
    ),
  );

  premigration.addCommand(
    new Command("index-status")
      .description("Print the local v1 name index metadata")
      .requiredOption("--work-dir <path>", "Directory holding the index")
      .action(async (opts: { workDir: string }) => {
        const meta = readV1NameIndexMeta(opts.workDir);
        if (!meta) {
          console.log(`no index in ${opts.workDir}`);
          return;
        }
        console.log(JSON.stringify(meta, null, 2));
      }),
  );

  premigration.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("reconcile")
            .description(
              "Reconcile the v1 name index against v2 state in both directions",
            )
            .requiredOption("--work-dir <path>", "Directory holding the index")
            .option(
              "--csv-file <path>",
              "Seeding CSV; checked to ensure it did not come from the index's own source",
            )
            .option("--mainnet-rpc-url <url>", "RPC URL for v1 reads")
            .option("--registry <address>", "v2 ETHRegistry address")
            .option(
              "--from-block <number>",
              "Block to scan v2 registry events from; defaults to the registry's deploy block",
            )
            .option(
              "--expected-status <status>",
              "reserved (before migration opens) or reserved-or-registered",
              "reserved",
            )
            .option(
              "--report-only",
              "Print the reconciliation without failing on discrepancies",
              false,
            )
            .option(
              "--check-fuses",
              "Also count names whose CANNOT_TRANSFER fuse is burned, which cannot be claimed through the transfer path (one wrapper read per name)",
              false,
            )
            .option(
              "--bonus-period-days <days>",
              "Days added to each name's v1 expiry to compute its expected v2 expiry",
              "62",
            ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions & {
          workDir: string;
          csvFile?: string;
          mainnetRpcUrl?: string;
          registry?: Address;
          fromBlock?: string;
          expectedStatus?: "reserved" | "reserved-or-registered";
          reportOnly?: boolean;
          checkFuses?: boolean;
          bonusPeriodDays?: string;
          deploymentsDir?: string;
          deploymentNetwork?: string;
        },
      ) => {
        await reconcilePreMigration({ ...withNetworkRpc(opts) });
      },
    ),
  );

  program.addCommand(premigration);

  // Test-only ENSv1 fixture corpus. Seeded between phases 1 and 3; the subset of
  // it that models a name already reserved on v2 is then reserved by the
  // pre-migration phases from the CSV it emits. See docs/migration.md.
  program.addCommand(
    addFixtureSubcommands(
      new Command("fixture").description(
        "Seed the weighted ENSv1 migration fixture corpus and carry it through pre-migration.",
      ),
    ),
  );

  const phase = new Command("phase").description(
    "Run or verify individual live/fork migration phases.",
  );

  phase.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("deploy-v2")
            .description(
              "Deploy the v2 migration contracts with the registrar deferred (archives any existing namespace and deploys fresh; use --resume to continue an interrupted deploy)",
            )
            .option(
              "--resume",
              "Continue an interrupted deploy into the existing namespace instead of archiving and deploying fresh",
              false,
            )
            .option(
              "--include-testnet-premigration-registrar",
              "Deploy the testnet v1 premigration registrar helper",
              false,
            )
            .option(
              "--defer-v1-owner-transactions",
              "Record v1-owner transactions instead of broadcasting them",
              false,
            )
            .option(
              "--deferred-v1-owner-transactions-file <path>",
              "JSONL file for deferred v1-owner transactions",
            )
            .option("--deployer <address>", "Deployer account address")
            .option("--owner <address>", "Owner/admin address")
            .option("--ur-manager <address>", "Managed URP admin address")
            .option("--v1-owner <address>", "v1 owner address for v1 writes")
            .option(
              "--impersonate-v1-owner",
              "Impersonate v1 owner on a fork",
              false,
            )
            .option(
              "--rpc-compatibility",
              "Enable compatibility fallbacks for fork RPCs",
              false,
            )
            .option("--debug-rpc", "Log JSON-RPC error responses", false)
            .option(
              "--tags <tags>",
              "Comma-separated deploy tags to run instead of the default v2 migration tags; use --resume --tags hca for an HCA-only update",
            ),
        ),
      ),
    ).action(async (opts: DeployV2CliOptions) => {
      const networkOpts = withNetworkRpc(opts);
      const network = networkOpts.network;
      const deployerKey = envPrivateKey("DEPLOYER_KEY");
      const deployerAddress = deployerKey
        ? privateKeyToAccount(deployerKey).address
        : undefined;
      // The owner defaults to the DAO on mainnet and to the deployer elsewhere;
      // urManager defaults to the deployer (securityCouncil -> deployer). Only
      // attach a key that controls the resolved account so the deployer key is
      // never used to act as the mainnet DAO.
      const ownerAddress =
        opts.owner ?? (network === "mainnet" ? MAINNET_DAO : deployerAddress);
      const urManagerAddress = opts.urManager ?? deployerAddress;
      const v1OwnerAddress = opts.v1Owner ?? NETWORKS[network].defaultV1Owner;
      // Respect an explicit --deployer override (e.g. an impersonated/unlocked
      // account during a rehearsal or a key rotation): only attach the env key
      // when it actually controls the requested deployer, so DEPLOYER_KEY never
      // silently replaces the supplied sender.
      const deployerAccount = opts.deployer ?? deployerAddress;
      await deployV2({
        ...networkOpts,
        deployer: opts.deployer,
        deployerPrivateKey: signerKeyForAccount(deployerAccount, [deployerKey]),
        ownerPrivateKey: signerKeyForAccount(ownerAddress, [
          envPrivateKey("OWNER_KEY"),
          deployerKey,
        ]),
        urManagerPrivateKey: signerKeyForAccount(urManagerAddress, [
          envPrivateKey("UR_MANAGER_KEY"),
          deployerKey,
        ]),
        v1Owner: v1OwnerAddress,
        // Wire the v1-owner account to a local key when one controls it, so it
        // is not left as a keyless node-signed address. Signers are keyed by
        // address, so a keyless v1-owner sharing the deployer's address would
        // otherwise overwrite the deployer's local signer and route every
        // deploy transaction through node-side signing the RPC cannot perform.
        v1OwnerPrivateKey: signerKeyForAccount(v1OwnerAddress, [
          envPrivateKey("SEPOLIA_V1_OWNER_KEY", "V1_OWNER_KEY"),
          deployerKey,
        ]),
        fresh: !opts.resume,
        saveDeployments: true,
        tags: opts.tags ? opts.tags.split(",").filter(Boolean) : undefined,
      });
    }),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addDeploymentOptions(
          addNetworkOptions(
            new Command("disable-v1-registrars")
              .option(
                "--skip-preconditions",
                "Freeze v1 without requiring that premigration reconcile has passed (the reconciliation is what proves no claimable name was missed)",
                false,
              )
              .option(
                "--max-reconcile-age-blocks <blocks>",
                "How old the reconciliation pass may be before it must be re-run (default ~1 day)",
                "7200",
              )
              .description(
                "Disable every v1 registrar controller the active deployment did not authorize",
              ),
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions & {
            skipPreconditions?: boolean;
            maxReconcileAgeBlocks?: string;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await disableV1Registrars({
          ...networkOpts,
        });
      },
    ),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addNetworkOptions(
          new Command("set-v1-reverse-default-resolver").description(
            "Point the v1 ReverseRegistrar default resolver at the v1 PublicResolver (v1-owner write)",
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions,
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await setV1ReverseDefaultResolver({
          ...networkOpts,
          privateKey: v1OwnerKeyFromEnv(opts),
        });
      },
    ),
  );
  phase.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("verify-v1-registrars-disabled")
            .description(
              "Verify no v1 registrar controller outside the active deployment is enabled",
            )
            .option(
              "--require-active-grants",
              "Also assert the active deployment's own v1 grants are in place (run after phase 6, once every handoff contract has been authorized)",
              false,
            ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions & { requireActiveGrants?: boolean },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await verifyV1RegistrarsDisabled({
          ...networkOpts,
          requireActiveGrants: opts.requireActiveGrants,
        });
      },
    ),
  );

  phase.addCommand(
    addNetworkOptions(
      new Command("snapshot-resolution")
        .description(
          "Record how names resolve today, to compare against after the phase 7 cutover",
        )
        .requiredOption("--names <list>", "Comma-separated names to resolve")
        .requiredOption("--out-file <path>", "Where to write the snapshot")
        .option(
          "--universal-resolver <address>",
          "Universal Resolver to resolve through; defaults to the deployed top proxy",
        )
        .option("--coin-types <list>", "Comma-separated coin types to record")
        .option("--text-keys <list>", "Comma-separated text keys to record"),
    ).action(
      async (
        opts: NetworkCliOptions & {
          names: string;
          outFile: string;
          universalResolver?: Address;
          coinTypes?: string;
          textKeys?: string;
        },
      ) => {
        await snapshotResolution({ ...withNetworkRpc(opts) });
      },
    ),
  );

  phase.addCommand(
    addNetworkOptions(
      new Command("verify-resolution")
        .description(
          "Re-resolve a snapshot's names and fail on any record that changed",
        )
        .requiredOption(
          "--snapshot-file <path>",
          "Snapshot written by snapshot-resolution",
        )
        .option(
          "--universal-resolver <address>",
          "Universal Resolver to resolve through; defaults to the snapshot's",
        )
        .option("--report-only", "Print differences without failing", false),
    ).action(
      async (
        opts: NetworkCliOptions & {
          snapshotFile: string;
          universalResolver?: Address;
          reportOnly?: boolean;
        },
      ) => {
        await verifyResolution({ ...withNetworkRpc(opts) });
      },
    ),
  );

  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("verify-roles")
          .description(
            "Audit who holds which roles on the v2 registries against the deployment's intent",
          )
          .option(
            "--deployer <address>",
            "Deployer address; defaults to the network's configured owner",
          )
          .option(
            "--owner <address>",
            "Owner address; defaults to the network's configured owner",
          )
          .option(
            "--from-block <number>",
            "Block to discover role holders from; defaults to the registry's deploy block",
          )
          .option(
            "--pre-handoff",
            "Audit the state before phase 6, where BatchRegistrar still holds its seeding roles",
            false,
          )
          .option("--report-only", "Print findings without failing", false),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & {
            deployer?: Address;
            owner?: Address;
            fromBlock?: string;
            reportOnly?: boolean;
            preHandoff?: boolean;
          },
      ) => {
        await verifyV2Roles({ ...withNetworkRpc(opts) });
      },
    ),
  );

  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("verify-registrar-economics")
          .description(
            "Verify the registrar can price and take payment: oracle, beneficiary, and accepted tokens",
          )
          .option(
            "--expected-beneficiary <address>",
            "Assert the registration-fee beneficiary is this address",
          )
          .option(
            "--payment-tokens <list>",
            "Comma-separated payment tokens to check; defaults to the deployed mocks plus real USDC on mainnet",
          )
          .option("--report-only", "Print findings without failing", false),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & {
            expectedBeneficiary?: Address;
            paymentTokens?: string;
            reportOnly?: boolean;
          },
      ) => {
        await verifyRegistrarEconomics({ ...withNetworkRpc(opts) });
      },
    ),
  );

  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("verify-deployment")
          .description(
            "Verify the code at every address in the namespace matches its artifact",
          )
          .option("--report-only", "Print findings without failing", false),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & { reportOnly?: boolean },
      ) => {
        await verifyDeployment({ ...withNetworkRpc(opts) });
      },
    ),
  );

  phase.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("verify-reverse-adapters").description(
            "Verify the active reverse-registrar adapters hold their v1 controller grants",
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions & DeploymentCliOptions & V1DeploymentCliOptions,
      ) => {
        await verifyReverseAdapters({ ...withNetworkRpc(opts) });
      },
    ),
  );
  phase.addCommand(
    new Command("verify-owner-tx")
      .description(
        "Check a transaction about to be signed against the prepared owner transactions",
      )
      .requiredOption(
        "--file <path>",
        "JSONL file of prepared owner transactions",
      )
      .requiredOption("--to <address>", "Target the Safe will call")
      .requiredOption("--data <hex>", "Calldata the Safe will send")
      .option("--value <wei>", "Value the Safe will send", "0")
      .option("--role <role>", "Only consider transactions for this role")
      .action(
        async (opts: {
          file: string;
          to: string;
          data: string;
          value?: string;
          role?: string;
        }) => {
          await verifyOwnerTransaction(opts);
        },
      ),
  );

  phase.addCommand(
    addNetworkOptions(
      new Command("execute-owner-txs")
        .description("Execute prepared owner transactions from a JSONL file")
        .requiredOption(
          "--file <path>",
          "JSONL file of prepared owner transactions",
        )
        .option(
          "--role <role>",
          "Only execute transactions for this role/account",
        )
        .option("--private-key <key>", "Owner private key")
        .option(
          "--journal-file <path>",
          "Record of executed transactions, so a re-run does not re-send them (default: <file>.executed.json)",
        )
        .option(
          "--force",
          "Re-send transactions the journal already records as executed",
          false,
        )
        .option(
          "--dry-run",
          "Print matching transactions without broadcasting",
          false,
        ),
    ).action(
      async (
        opts: NetworkCliOptions & {
          file: string;
          role?: string;
          privateKey?: `0x${string}`;
          dryRun?: boolean;
          journalFile?: string;
          force?: boolean;
        },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await executePreparedOwnerTransactions({
          ...networkOpts,
          privateKey: opts.privateKey,
          journalFile: opts.journalFile,
          force: opts.force,
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("verify-urp")
          .description("Verify top and managed UniversalResolverProxy status")
          .option("--top-urp <address>", "Top-level URP address")
          .option("--managed-urp <address>", "Managed URP address")
          .option(
            "--expected-top-implementation <address>",
            "Expected top-level URP implementation",
          )
          .option(
            "--expected-managed-implementation <address>",
            "Expected managed URP implementation",
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & {
            topUrp?: Address;
            managedUrp?: Address;
            expectedTopImplementation?: Address;
            expectedManagedImplementation?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await verifyUrp({
          ...networkOpts,
        });
      },
    ),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addDeploymentOptions(
          addNetworkOptions(
            new Command("authorize-testnet-v1-premigration-registrar")
              .description(
                "Authorize the testnet premigration helper as a v1 registrar controller",
              )
              .option(
                "--registrar <address>",
                "TestnetV1PremigrationRegistrar address",
              ),
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions & { registrar?: Address },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await authorizeTestnetV1PremigrationRegistrar({
          ...networkOpts,
          privateKey: v1OwnerKeyFromEnv(opts),
        });
      },
    ),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addDeploymentOptions(
          addNetworkOptions(
            new Command("activate-v1-graveyard")
              .description(
                "Phase 6: authorize Graveyard as a v1 BaseRegistrar controller",
              )
              .option("--graveyard <address>", "Graveyard address"),
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions & { graveyard?: Address },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await activateV1Graveyard({
          ...networkOpts,
          privateKey: v1OwnerKeyFromEnv(opts),
        });
      },
    ),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addDeploymentOptions(
          addNetworkOptions(
            new Command("activate-v1-handoff-controllers")
              .description(
                "Phase 6: authorize Graveyard and the testnet premigration helper as v1 BaseRegistrar controllers",
              )
              .option("--graveyard <address>", "Graveyard address")
              .option(
                "--testnet-v1-premigration-registrar <address>",
                "TestnetV1PremigrationRegistrar address",
              ),
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions & {
            graveyard?: Address;
            testnetV1PremigrationRegistrar?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await activateV1HandoffControllers({
          ...networkOpts,
          privateKey: v1OwnerKeyFromEnv(opts),
        });
      },
    ),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addDeploymentOptions(
          addNetworkOptions(
            new Command("authorize-v1-renewer")
              .description(
                "Phase 4: authorize ETHRenewerV1 as a v1 BaseRegistrar controller so unmigrated names stay renewable during the migration",
              )
              .option("--eth-renewer-v1 <address>", "ETHRenewerV1 address"),
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions & { ethRenewerV1?: Address },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await authorizeV1Renewer({
          ...networkOpts,
          privateKey: v1OwnerKeyFromEnv(opts),
        });
      },
    ),
  );
  phase.addCommand(
    addV1OwnerWriteOptions(
      addV1DeploymentOptions(
        addDeploymentOptions(
          addNetworkOptions(
            new Command("activate-v1-renewer")
              .description(
                "Phase 6: transfer v1 BaseRegistrar ownership to ETHRenewerV1 (re-authorizes it as a controller if needed)",
              )
              .option("--eth-renewer-v1 <address>", "ETHRenewerV1 address"),
          ),
        ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          V1DeploymentCliOptions &
          V1OwnerWriteCliOptions & { ethRenewerV1?: Address },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await activateV1RenewerAndTransferOwnership({
          ...networkOpts,
          privateKey: v1OwnerKeyFromEnv(opts),
        });
      },
    ),
  );
  phase.addCommand(
    addV1DeploymentOptions(
      addNetworkOptions(
        new Command("reclaim-v1-registrar-ownership")
          .description(
            "Reclaim v1 BaseRegistrar ownership from a prior migration's ETHRenewerV1 back to the v1 owner (run before re-migrating an already-migrated chain)",
          )
          .option("--v1-owner <address>", "v1 owner to reclaim ownership to")
          .option(
            "--private-key <key>",
            "Prior renewer owner private key (defaults to OWNER_KEY/DEPLOYER_KEY)",
          )
          .option(
            "--impersonate-owner",
            "Impersonate the prior renewer owner on a fork",
            false,
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          V1DeploymentCliOptions & {
            v1Owner?: Address;
            privateKey?: `0x${string}`;
            impersonateOwner?: boolean;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await reclaimV1RegistrarOwnership({
          ...networkOpts,
          v1Owner: opts.v1Owner ?? NETWORKS[networkOpts.network].defaultV1Owner,
          privateKey:
            opts.privateKey ?? envPrivateKey("OWNER_KEY", "DEPLOYER_KEY"),
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("switch-urp-to-managed")
          .description(
            "Switch the top UniversalResolverProxy to ManagedUniversalResolverProxy",
          )
          .option("--top-urp <address>", "Top-level URP address")
          .option("--managed-urp <address>", "Managed URP address")
          .option("--private-key <key>", "Top URP admin private key")
          .option(
            "--impersonate-account <address>",
            "Impersonate top URP admin on a fork",
          )
          .option(
            "--calldata-only",
            "Print transaction target and calldata",
            false,
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          AdminSignerCliOptions & {
            topUrp?: Address;
            managedUrp?: Address;
            calldataOnly?: boolean;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await switchTopUrpToManaged({
          ...networkOpts,
          privateKey:
            opts.privateKey ??
            envPrivateKey("SEPOLIA_TOP_URP_OWNER_KEY", "TOP_URP_OWNER_KEY"),
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("upgrade-managed-urp")
          .description("Upgrade the managed URP to UniversalResolverV2")
          .option("--managed-urp <address>", "Managed URP address")
          .option(
            "--implementation <address>",
            "UniversalResolverV2 implementation",
          )
          .option("--private-key <key>", "Managed URP admin private key")
          .option(
            "--impersonate-account <address>",
            "Impersonate admin on a fork",
          )
          .option(
            "--calldata-only",
            "Print transaction target and calldata",
            false,
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          AdminSignerCliOptions & {
            managedUrp?: Address;
            implementation?: Address;
            calldataOnly?: boolean;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await upgradeManagedUrp({
          ...networkOpts,
          privateKey:
            opts.privateKey ?? envPrivateKey("UR_MANAGER_KEY", "DEPLOYER_KEY"),
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("disable-batch-registrar")
          .description("Revoke registrar/renew roles from BatchRegistrar")
          .option("--registry <address>", "v2 ETHRegistry address")
          .option("--batch-registrar <address>", "BatchRegistrar address")
          .option("--private-key <key>", "Registry role admin private key")
          .option(
            "--impersonate-account <address>",
            "Impersonate registry role admin on a fork",
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          AdminSignerCliOptions & {
            registry?: Address;
            batchRegistrar?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await disableBatchRegistrar({
          ...networkOpts,
          privateKey:
            opts.privateKey ?? envPrivateKey("OWNER_KEY", "DEPLOYER_KEY"),
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("verify-batch-registrar-disabled")
          .description(
            "Verify BatchRegistrar no longer has registrar/renew roles",
          )
          .option("--registry <address>", "v2 ETHRegistry address")
          .option("--batch-registrar <address>", "BatchRegistrar address"),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & {
            registry?: Address;
            batchRegistrar?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await verifyBatchRegistrarDisabled({
          ...networkOpts,
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("batch-registrar-owner")
          .description("Print and optionally verify the BatchRegistrar owner")
          .option("--batch-registrar <address>", "BatchRegistrar address")
          .option(
            "--expected-owner <address>",
            "Expected BatchRegistrar owner",
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & {
            batchRegistrar?: Address;
            expectedOwner?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await checkBatchRegistrarOwner({
          ...networkOpts,
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("enable-v2-registrar")
          .description("Grant registrar/renew roles to ETHRegistrar")
          .option("--registry <address>", "v2 ETHRegistry address")
          .option("--eth-registrar <address>", "ETHRegistrar address")
          .option("--private-key <key>", "Registry role admin private key")
          .option(
            "--impersonate-account <address>",
            "Impersonate registry role admin on a fork",
          ),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions &
          AdminSignerCliOptions & {
            registry?: Address;
            ethRegistrar?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await enableV2Registrar({
          ...networkOpts,
          privateKey:
            opts.privateKey ?? envPrivateKey("OWNER_KEY", "DEPLOYER_KEY"),
        });
      },
    ),
  );
  phase.addCommand(
    addDeploymentOptions(
      addNetworkOptions(
        new Command("verify-v2-registrar")
          .description("Verify ETHRegistrar has registrar/renew roles")
          .option("--registry <address>", "v2 ETHRegistry address")
          .option("--eth-registrar <address>", "ETHRegistrar address"),
      ),
    ).action(
      async (
        opts: NetworkCliOptions &
          DeploymentCliOptions & {
            registry?: Address;
            ethRegistrar?: Address;
          },
      ) => {
        const networkOpts = withNetworkRpc(opts);
        await verifyV2Registrar({
          ...networkOpts,
        });
      },
    ),
  );
  program.addCommand(phase);

  const fork = new Command("fork").description("Run Anvil fork rehearsals.");
  fork.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("full")
            .description(
              "Run the full phased migration rehearsal against an Anvil fork",
            )
            .option(
              "--direct",
              "Use --rpc-url directly instead of starting Anvil",
              false,
            )
            .option("--port <port>", "Local Anvil port")
            .requiredOption("--csv-file <path>", "Registration CSV")
            .option("--batch-size <number>", "Names per pre-migration batch")
            .option(
              "--initial-limit <count>",
              "Optional cap before disabling v1 registrars",
            )
            .option(
              "--finish-limit <count>",
              "Optional cap after disabling v1 registrars",
            )
            .option(
              "--work-dir <path>",
              "Directory for fork logs, checkpoints, and generated CSV",
            )
            .option(
              "--resume-from-phase <phase>",
              "Resume the full rehearsal from phase 2",
            )
            .option(
              "--require-full-coverage",
              "Fail instead of silently running a reduced set of smoke checks (post-migration mode, or a network with no mintable payment token)",
              false,
            )
            .option(
              "--resolution-names <list>",
              "Extra comma-separated names to snapshot and re-check across the phase 7 cutover",
            )
            .option(
              "--save-deployments",
              "Persist deployment JSON files",
              false,
            )
            .option(
              "--include-testnet-premigration-registrar",
              "Deploy the testnet v1 premigration registrar helper",
              false,
            )
            .option(
              "--fixture-root <path>",
              "Seed the ENSv1 fixture corpus from this bundle as part of the rehearsal",
            )
            .option(
              "--fixture-scenarios <list>",
              "Fixture execution scenarios to include, e.g. live_now",
            )
            .option(
              "--fixture-tiers <list>",
              "Fixture popularity tiers to include",
            )
            .option("--fixture-ids <list>", "Explicit fixture IDs to include")
            .option(
              "--fixture-limit <count>",
              "Cap the number of fixture names",
            )
            .option(
              "--fixture-replicas-per-vector <count>",
              "Keep at most N replicas of each fixture scenario",
            )
            .option(
              "--fixture-actor-mnemonic <mnemonic>",
              "Dedicated fixture actor mnemonic (generated per run on a fork)",
            )
            .option(
              "--fixture-private-key <key>",
              "Fixture operator key (generated per run on a fork)",
            )
            .option(
              "--snapshot-file <path>",
              "Optional file to write a pre-rehearsal snapshot id",
            )
            .option("--deployer <address>", "Migration deployer address")
            .option("--owner <address>", "Migration owner/admin address")
            .option("--v1-owner <address>", "V1 owner address")
            .option("--ur-manager <address>", "Managed URP admin address")
            .option("--debug-rpc", "Log JSON-RPC error responses", false)
            .option(
              "--keep-anvil",
              "Leave the local Anvil process running",
              false,
            ),
        ),
      ),
    ).action(async (opts: ForkFullCliOptions) => {
      const networkOpts = withNetworkRpc(opts);
      const forkRpcUrl = networkOpts.rpcUrl;
      // Tenderly virtual testnets support state controls; the standalone CLI has
      // no --tenderly flag, so detect it from the RPC like the Hardhat task does.
      const tenderly =
        networkOpts.tenderly ??
        (networkOpts.direct ? isTenderlyVirtualRpc(forkRpcUrl) : undefined);
      // Only the direct path against a non-state-control RPC needs configured
      // signer keys; Anvil forks and Tenderly/local RPCs provide impersonation.
      const needsKeys =
        Boolean(networkOpts.direct) &&
        !(Boolean(tenderly) || isLocalRpcUrl(forkRpcUrl));
      await runForkFull({
        ...networkOpts,
        tenderly,
        ...(needsKeys
          ? envMigrationSignerKeys({
              deployer: networkOpts.deployer,
              owner: networkOpts.owner,
              v1Owner:
                networkOpts.v1Owner ??
                NETWORKS[networkOpts.network].defaultV1Owner,
              urManager: networkOpts.urManager,
            })
          : {}),
      });
    }),
  );
  program.addCommand(fork);

  program.addCommand(
    addV1DeploymentOptions(
      addDeploymentOptions(
        addNetworkOptions(
          new Command("clean-testnet")
            .description(
              "Deploy fresh testnet v1 contracts and run the full phased migration",
            )
            .option(
              "--csv-file <path>",
              "Optional registration CSV to seed in addition to generated smoke labels",
            )
            .option("--batch-size <number>", "Names per pre-migration batch")
            .option(
              "--initial-limit <count>",
              "Optional cap before disabling v1 registrars",
            )
            .option(
              "--finish-limit <count>",
              "Optional cap after disabling v1 registrars",
            )
            .option(
              "--work-dir <path>",
              "Directory for clean deploy logs, checkpoints, and generated CSV",
            )
            .option(
              "--fixture-root <path>",
              "Seed the ENSv1 fixture corpus from this bundle as part of the run",
            )
            .option(
              "--fixture-scenarios <list>",
              "Fixture execution scenarios to include, e.g. live_now",
            )
            .option(
              "--fixture-tiers <list>",
              "Fixture popularity tiers to include",
            )
            .option("--fixture-ids <list>", "Explicit fixture IDs to include")
            .option(
              "--fixture-limit <count>",
              "Cap the number of fixture names",
            )
            .option(
              "--fixture-replicas-per-vector <count>",
              "Keep at most N replicas of each fixture scenario",
            )
            .option(
              "--fixture-actor-mnemonic <mnemonic>",
              "Dedicated fixture actor mnemonic (generated per run when impersonating)",
            )
            .option(
              "--fixture-private-key <key>",
              "Fixture operator key (generated per run when impersonating)",
            )
            .option(
              "--snapshot-file <path>",
              "Optional file to write a pre-phase snapshot id after v1 deployment",
            )
            .option("--deployer <address>", "Migration deployer address")
            .option("--owner <address>", "Migration owner/admin address")
            .option("--v1-owner <address>", "V1 owner address")
            .option("--ur-manager <address>", "Managed URP admin address")
            .option(
              "--require-full-coverage",
              "Fail instead of silently running a reduced set of smoke checks",
              false,
            )
            .option(
              "--resolution-names <list>",
              "Extra comma-separated names to snapshot and re-check across the phase 7 cutover",
            )
            .option("--debug-rpc", "Log JSON-RPC error responses", false),
        ),
      ),
    ).action(async (opts: CleanTestnetCliOptions) => {
      const networkOpts = withNetworkRpc(opts);
      const forkRpcUrl = networkOpts.rpcUrl;
      // Hydrate signer keys only when the RPC lacks state controls; a local node
      // or Tenderly virtual testnet impersonates the configured accounts instead.
      const needsKeys = !(
        Boolean(networkOpts.tenderly) ||
        isLocalRpcUrl(forkRpcUrl) ||
        isTenderlyVirtualRpc(forkRpcUrl)
      );
      await runCleanTestnetFull({
        ...networkOpts,
        ...(needsKeys
          ? envMigrationSignerKeys({
              deployer: networkOpts.deployer,
              owner: networkOpts.owner ?? networkOpts.deployer,
              v1Owner:
                networkOpts.v1Owner ??
                networkOpts.owner ??
                networkOpts.deployer,
              urManager: networkOpts.urManager ?? networkOpts.deployer,
            })
          : {}),
      });
    }),
  );

  program.parse(argv);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
