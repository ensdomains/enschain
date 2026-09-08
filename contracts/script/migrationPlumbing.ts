/// Primitives the migration tooling shares.
///
/// These are the pieces every entry point needs — the CLI, the hardhat tasks, and the
/// fixture corpus — and which each had grown its own copy of. A second copy of a
/// primitive is not just repetition: the copies drift, and the drift is invisible
/// until an operator runs one entry point from a directory the other never sees.
///
/// Nothing here reaches back into the modules that use it, so it can be imported from
/// anywhere in the tooling without closing a cycle.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPublicClient,
  custom,
  defineChain,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { mainnet, sepolia } from "viem/chains";

import { config as rockethConfig } from "../rocketh/config.js";

/// A name in the length-prefixed wire encoding the v1 and v2 resolvers read.
export function dnsEncodeName(name: string): Hex {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    const labelBytes = Buffer.from(label, "utf8");
    if (labelBytes.length > 255) throw new Error(`label is too long: ${label}`);
    bytes.push(labelBytes.length, ...labelBytes);
  }
  bytes.push(0);
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/// Every message in an error's `cause` chain, outermost first.
///
/// Providers bury the useful part — a reverted call, a refused block span — under
/// several layers of wrapping, so a match against the outermost message alone misses
/// it. Bounded so a self-referencing chain cannot spin.
export function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && messages.length < 10) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

////////////////////////////////////////////////////////////////////////
// Networks
////////////////////////////////////////////////////////////////////////

export type MigrationNetwork = "sepolia" | "mainnet";

/// A JSON-RPC endpoint, narrowed to the one method every caller needs.
export type RpcProvider = {
  request(args: {
    method: string;
    params?: readonly unknown[] | object;
  }): Promise<unknown>;
};

/// A deployment artifact as rocketh writes it.
export type JsonDeployment = {
  address: Address;
  abi: readonly any[];
};

export type V1DeploymentOptions = {
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
};

export type NetworkConfig = {
  chain: Chain;
  environment: MigrationNetwork;
  rpcEnv: string;
  defaultForkPort: number;
  defaultOwner: Address;
  defaultV1Owner: Address;
  chainTags: string[];
};

const DEFAULT_ANVIL_OWNER =
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const MAINNET_DAO = "0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7" as const;
// The Sepolia ENS v1 BaseRegistrar owner EOA; derived from the `v1Owner` named
// account in rocketh/config.ts so the two values cannot drift apart.
const SEPOLIA_V1_OWNER = getAddress(rockethConfig.accounts.v1Owner.sepolia);

export const NETWORKS: Record<MigrationNetwork, NetworkConfig> = {
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

////////////////////////////////////////////////////////////////////////
// Deployment artifact roots
////////////////////////////////////////////////////////////////////////

// Anchored to this file rather than to the process working directory. A cwd-relative
// root resolves differently depending on where a command was launched from, so the
// same artifacts are found by one entry point and missed by another.
export const DEFAULT_DEPLOYMENTS_DIR = resolve(
  import.meta.dirname,
  "../deployments",
);
export const BUNDLED_V1_DEPLOYMENTS_DIR = resolve(
  import.meta.dirname,
  "../lib/ens-contracts/deployments",
);
export const LOCAL_V1_DEPLOYMENTS_DIR = resolve(
  import.meta.dirname,
  "../deployments/v1",
);

////////////////////////////////////////////////////////////////////////
// Chains and clients
////////////////////////////////////////////////////////////////////////

/// Transport-level retries for a dropped connection, on top of viem's own JSON-RPC
/// retries, which never see a request that failed to reach the node.
const RPC_RETRY_COUNT = 3;

export function forkChain(
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

export function migrationChain(opts: {
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

export function publicClient(
  rpcUrl: string,
  chain: Chain,
  provider?: RpcProvider,
) {
  return createPublicClient({
    chain,
    transport: provider
      ? custom(provider as any)
      : http(rpcUrl, { retryCount: RPC_RETRY_COUNT }),
  });
}

////////////////////////////////////////////////////////////////////////
// Deployment artifacts
////////////////////////////////////////////////////////////////////////

function loadDeploymentFromRoot(
  root: string,
  environment: string,
  name: string,
): JsonDeployment | null {
  const path = join(root, environment, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as JsonDeployment;
}

export function loadV1Deployment(
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

export function requireV1Deployment(
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

export function loadV2Deployment(
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

export function maybeLoadV2Deployment(
  root: string,
  environment: string,
  name: string,
): JsonDeployment | null {
  return loadDeploymentFromRoot(resolve(root), environment, name);
}

export function resolveDeploymentAddress(
  explicitAddress: Address | undefined,
  deploymentsDir: string,
  environment: string,
  name: string,
): Address {
  if (explicitAddress) return explicitAddress;
  return loadV2Deployment(deploymentsDir, environment, name).address;
}

////////////////////////////////////////////////////////////////////////
// Parsing
////////////////////////////////////////////////////////////////////////

/// A numeric option, with a fallback for the absent case only.
///
/// A value that is present but will not parse is an error rather than the fallback:
/// a typo in a batch size or a bonus period would otherwise run the whole command
/// against a number nobody chose.
export function parseNumber(
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

export function parseMigrationNetwork(
  value: string | undefined,
): MigrationNetwork {
  if (value === "mainnet" || value === "sepolia") return value;
  throw new Error(`Unsupported network: ${value ?? "<missing>"}`);
}
