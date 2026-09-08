import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Chain,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";

import type {
  CommonOptions,
  FixtureActor,
  FixtureEnvelope,
  JsonDeployment,
} from "./types.js";

/// The named actors the corpus refers to. Index is the mnemonic account index,
/// so an alias always resolves to the same address across runs.
export const ACTOR_ALIASES = [
  "owner_a",
  "owner_b",
  "owner_c",
  "operator",
  "attacker",
] as const;

export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[match[1]] = value;
  }
}

export function parseNumber(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`invalid number: ${value}`);
  return n;
}

export function networkChain(
  network: "sepolia" | "mainnet",
  rpcUrl: string,
  chainId?: string,
): Chain {
  const base = network === "sepolia" ? sepolia : mainnet;
  const id = parseNumber(chainId, base.id);
  return defineChain({
    ...base,
    id,
    name: id === base.id ? base.name : `${base.name} fixture ${id}`,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function deployment(
  root: string,
  environment: string,
  name: string,
): JsonDeployment {
  const path = join(resolve(root), environment, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing deployment: ${path}`);
  return readJson<JsonDeployment>(path);
}

export function optionalDeployment(
  root: string,
  environment: string,
  name: string,
): JsonDeployment | null {
  const path = join(resolve(root), environment, `${name}.json`);
  return existsSync(path) ? readJson<JsonDeployment>(path) : null;
}

export function v1Deployment(
  opts: CommonOptions,
  name: string,
): JsonDeployment {
  const roots = opts.v1DeploymentsDir
    ? [resolve(opts.v1DeploymentsDir)]
    : [resolve("./deployments/v1"), resolve("./lib/ens-contracts/deployments")];
  const environment = opts.v1DeploymentNetwork ?? opts.network;
  for (const root of roots) {
    const path = join(root, environment, `${name}.json`);
    if (existsSync(path)) return readJson<JsonDeployment>(path);
  }
  throw new Error(`missing V1 deployment ${environment}/${name}.json`);
}

export function optionalV1Deployment(
  opts: CommonOptions,
  name: string,
): JsonDeployment | null {
  try {
    return v1Deployment(opts, name);
  } catch {
    return null;
  }
}

export function v2Deployment(
  opts: CommonOptions,
  name: string,
): JsonDeployment {
  return deployment(
    opts.deploymentsDir,
    opts.deploymentNetwork ?? opts.network,
    name,
  );
}

export function fixtureFile(opts: CommonOptions): string {
  return join(resolve(opts.fixtureRoot), "weighted-scenarios.jsonl");
}

export function runStatePath(opts: CommonOptions): string {
  return join(resolve(opts.workDir), "fixture-run.json");
}

function splitList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

/// Loads the corpus and applies cohort selection. Selection order matters:
/// coarse filters first, then per-vector replica truncation, then `--limit`.
export function loadFixture(opts: CommonOptions): FixtureEnvelope[] {
  const file = fixtureFile(opts);
  if (!existsSync(file)) throw new Error(`missing fixture file: ${file}`);

  const tiers = splitList(opts.tiers);
  const ids = splitList(opts.fixtureIds);
  const scenarios = splitList(opts.scenarios);

  let rows = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEnvelope);

  if (tiers.size) rows = rows.filter((r) => tiers.has(r.popularity_tier));
  if (ids.size) rows = rows.filter((r) => ids.has(r.fixture_id));
  if (scenarios.size) {
    rows = rows.filter((r) => scenarios.has(r.scenario.execution.scenario));
  }

  const perVector = parseNumber(opts.replicasPerVector, 0);
  if (perVector > 0) {
    const seen = new Map<string, number>();
    rows = rows
      .slice()
      .sort(
        (a, b) =>
          a.source_scenario_id.localeCompare(b.source_scenario_id) ||
          a.replica_index - b.replica_index,
      )
      .filter((r) => {
        const n = seen.get(r.source_scenario_id) ?? 0;
        if (n >= perVector) return false;
        seen.set(r.source_scenario_id, n + 1);
        return true;
      });
  }

  const limit = parseNumber(opts.limit, 0);
  if (limit > 0) rows = rows.slice(0, limit);

  const seenIds = new Set<string>();
  for (const row of rows) {
    if (seenIds.has(row.fixture_id)) {
      throw new Error(`duplicate fixture id: ${row.fixture_id}`);
    }
    seenIds.add(row.fixture_id);
  }
  return rows;
}

export function fixtureDigest(rows: FixtureEnvelope[]): Hex {
  return keccak256(stringToHex(rows.map((r) => r.fixture_id).join("\n")));
}

/// Builds the named actor set. Unlike the previous hash-derived scheme, an alias
/// maps to a fixed mnemonic index so `owner_b` is the same account everywhere.
export function accounts(opts: CommonOptions): FixtureActor[] {
  const mnemonic =
    opts.actorMnemonic ?? process.env.MIGRATION_FIXTURE_ACTOR_MNEMONIC;
  if (!mnemonic) {
    throw new Error(
      "missing --actor-mnemonic or MIGRATION_FIXTURE_ACTOR_MNEMONIC; use a dedicated fixture mnemonic",
    );
  }
  return ACTOR_ALIASES.map((alias, accountIndex) => ({
    alias,
    account: mnemonicToAccount(mnemonic, { accountIndex }),
  }));
}

export function requirePrivateKey(opts: CommonOptions): Hex {
  const key =
    opts.privateKey ??
    (process.env.MIGRATION_FIXTURE_PRIVATE_KEY as Hex | undefined);
  if (!key)
    throw new Error("missing --private-key or MIGRATION_FIXTURE_PRIVATE_KEY");
  return key;
}

export function clients(opts: CommonOptions) {
  const chain = networkChain(opts.network, opts.rpcUrl, opts.chainId);
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const account = privateKeyToAccount(requirePrivateKey(opts));
  const wallet = createWalletClient({
    chain,
    account,
    transport: http(opts.rpcUrl),
  });
  return { chain, client, wallet, account };
}

/// Margin added over an estimated gas limit for batched writes.
///
/// A batch fans out into many nested calls, and a gas estimator that searches
/// for the lowest passing limit can settle on one where the outermost frame
/// keeps just enough for itself but a later inner call runs out. The estimate is
/// then returned as valid and the transaction reverts out of gas. The margin is
/// free on a rehearsal chain and harmless on a live one, where unused gas is not
/// charged.
const GAS_BUFFER_BPS = 3_000n;

export async function bufferedGas(
  client: any,
  request: Record<string, unknown>,
): Promise<bigint> {
  const estimate = (await client.estimateContractGas(request)) as bigint;
  return estimate + (estimate * GAS_BUFFER_BPS) / 10_000n;
}

/// Price is quoted before the transaction lands, so a buffer absorbs movement
/// between quote and execution. Without it one underfunded name reverts the
/// whole batch it travels in. Any excess is refunded by the batcher.
export const PRICE_BUFFER_BPS = 1_000n;

export const withPriceBuffer = (price: bigint): bigint =>
  price + (price * PRICE_BUFFER_BPS) / 10_000n;

export async function receipt(client: any, hash: Hex, label: string) {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return r;
}

/// Issues the first spelling of a state-control call the endpoint accepts.
///
/// Node families name these differently — Anvil, Hardhat and Tenderly each have
/// their own, and Tenderly's take either a bare address or a one-element array —
/// so a caller lists the equivalents and the first that succeeds wins. The last
/// failure surfaces when the endpoint supports none of them.
export async function rpcAny(
  opts: CommonOptions,
  requests: { method: string; params: unknown[] }[],
): Promise<unknown> {
  let lastError: unknown;
  for (const request of requests) {
    try {
      return await rpc(opts, request.method, request.params);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function rpc(
  opts: CommonOptions,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await fetch(opts.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
