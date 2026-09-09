#!/usr/bin/env bun

// Builds an independent view of which v1 `.eth` 2LD names exist and when they
// expire, keyed by labelhash.
//
// Pre-migration seeds v2 from a CSV. Verifying that CSV against the indexer that
// produced it proves nothing: a name missing from that source is missing from both
// sides of the comparison and the check passes. This index therefore has to come
// from a *different* source than the CSV did, and the reconciliation refuses to run
// when the two match.
//
// Names are keyed by labelhash rather than by label because that is the only key
// every registration has. An indexer cannot always decode a label preimage, but the
// registrar emitted the hash for every name ever registered, and the v2 registry
// accepts that hash directly as a lookup id.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  fetchIndexedBlock,
  getGatewayEndpoint,
  type ENSRegistrationNetwork,
} from "./exportTheGraphRegistrations.js";
import { isLogSpanRefusalMessage } from "./migrations/logSpanRefusal.js";
import { V1_GRACE_PERIOD_SECONDS } from "./preMigration.js";

export const V1_INDEX_FILE = "v1-name-index.ndjson";
export const V1_INDEX_META_FILE = "v1-name-index.meta.json";

// Build-time filtering only has to be cheap and safe, never exact: the
// reconciliation re-applies the grace rule against a chain block timestamp. Keeping
// an extra week of already-expired names means a name near the boundary can never be
// dropped here and then wanted there.
const BUILD_FILTER_MARGIN_SECONDS = 7n * 24n * 60n * 60n;

const PAGE_DELAY_MS = 200;

export type V1IndexSource = "subgraph" | "rpc";

export type V1IndexMeta = {
  source: V1IndexSource;
  network: string;
  block: number;
  /** Last registration id written; a resumed build continues after it. */
  lastId: string;
  entries: number;
  complete: boolean;
  builtAt: string;
  /**
   * Highest block whose registration logs have been read. Only the chain-log
   * builder sets it, which enumerates by block rather than by cursor id.
   */
  lastBlock?: number;
  /**
   * The "now" the build-time grace filter was measured against. A reconciliation
   * judges claimability against chain time, and if that is far enough behind this,
   * the build dropped names the reconciliation would still want — so it has to be
   * able to see what basis was used rather than assume the two agree.
   */
  filterTime: string;
};

export type V1NameIndex = {
  meta: V1IndexMeta;
  /** Labelhash (lowercase, 0x-prefixed) to the v1 expiry in seconds. */
  expiries: Map<string, bigint>;
};

type IndexedRegistration = { id: string; expiryDate: string | null };

function metaPath(workDir: string) {
  return join(workDir, V1_INDEX_META_FILE);
}

function indexPath(workDir: string) {
  return join(workDir, V1_INDEX_FILE);
}

function normalizeLabelhash(id: string): string {
  const hex = id.startsWith("0x") ? id.slice(2) : id;
  return `0x${hex.toLowerCase().padStart(64, "0")}`;
}

// One page of registrations ordered by id. Cursor paging is required rather than
// preferred: gateways cap `skip`, and an offset into a live result set silently
// duplicates and drops rows as new registrations are indexed.
async function fetchIndexPage(
  config: { thegraphApiKey: string; network: ENSRegistrationNetwork },
  afterId: string,
  first: number,
  block: number,
  fetchFn: typeof fetch,
): Promise<IndexedRegistration[]> {
  const query = `
    query IndexEthRegistrations($first: Int!, $afterId: ID!, $block: Int!) {
      registrations(
        first: $first
        where: { id_gt: $afterId }
        orderBy: id
        orderDirection: asc
        block: { number: $block }
      ) {
        id
        expiryDate
      }
    }
  `;

  const response = await fetchFn(getGatewayEndpoint(config), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { first, afterId, block } }),
  });

  if (!response.ok) {
    throw new Error(
      `HTTP error! status: ${response.status}, body: ${await response.text()}`,
    );
  }

  const result = (await response.json()) as {
    data?: { registrations?: IndexedRegistration[] };
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    throw new Error(
      `GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`,
    );
  }
  if (!result.data?.registrations) {
    throw new Error(
      "Invalid response structure from TheGraph: missing data.registrations",
    );
  }
  return result.data.registrations;
}

export type BuildV1NameIndexOptions = {
  thegraphApiKey: string;
  network: ENSRegistrationNetwork;
  workDir: string;
  batchSize?: number;
  /** Pin to a specific indexed block; defaults to the subgraph head. */
  block?: number;
  /** Continue a partial build instead of starting over. */
  resume?: boolean;
  /** Seconds since epoch used for the coarse build-time grace filter. */
  now?: bigint;
  onProgress?: (entries: number, lastId: string) => void;
};

// Streams the whole registration set into an NDJSON index. The file is appended page
// by page and the cursor recorded alongside it, so an interrupted build resumes
// where it stopped rather than repeating a multi-hour scan.
export async function buildV1NameIndex(
  opts: BuildV1NameIndexOptions,
  fetchFn: typeof fetch = fetch,
): Promise<V1IndexMeta> {
  const config = {
    thegraphApiKey: opts.thegraphApiKey,
    network: opts.network,
  };
  const batchSize = opts.batchSize ?? 1000;
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  const cutoff = now - V1_GRACE_PERIOD_SECONDS - BUILD_FILTER_MARGIN_SECONDS;

  mkdirSync(opts.workDir, { recursive: true });

  const existing = opts.resume ? readV1NameIndexMeta(opts.workDir) : null;
  if (existing && existing.complete) return existing;

  // A resumed build must continue against the same block, or the two halves of the
  // index describe different chain states.
  const block =
    existing?.block ?? opts.block ?? (await fetchIndexedBlock(config, fetchFn));
  if (existing && opts.block !== undefined && existing.block !== opts.block) {
    throw new Error(
      `cannot resume index at block ${opts.block}: partial index was built at block ${existing.block}`,
    );
  }

  let cursor = existing?.lastId ?? "";
  let entries = existing?.entries ?? 0;
  if (!existing) writeFileSync(indexPath(opts.workDir), "", "utf-8");

  const writeMeta = (complete: boolean): V1IndexMeta => {
    const meta: V1IndexMeta = {
      source: "subgraph",
      network: opts.network,
      block,
      lastId: cursor,
      entries,
      complete,
      builtAt: new Date().toISOString(),
      filterTime: now.toString(),
    };
    writeFileSync(
      metaPath(opts.workDir),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf-8",
    );
    return meta;
  };

  for (;;) {
    const page = await fetchIndexPage(
      config,
      cursor,
      batchSize,
      block,
      fetchFn,
    );
    if (page.length === 0) break;

    const lines: string[] = [];
    for (const registration of page) {
      const expiry = BigInt(registration.expiryDate ?? "0");
      // A name released long ago cannot be claimed by its former owner. Dropping it
      // here keeps the index proportional to live names rather than to all history.
      if (expiry === 0n || expiry <= cutoff) continue;
      lines.push(
        `${JSON.stringify({ id: normalizeLabelhash(registration.id), expiry: expiry.toString() })}`,
      );
    }
    if (lines.length > 0) {
      appendFileSync(indexPath(opts.workDir), `${lines.join("\n")}\n`, "utf-8");
      entries += lines.length;
    }

    cursor = page[page.length - 1].id;
    writeMeta(false);
    opts.onProgress?.(entries, cursor);

    if (page.length < batchSize) break;
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
  }

  return writeMeta(true);
}

// ---------------------------------------------------------------------------
// Chain-log index
// ---------------------------------------------------------------------------

// The registrar's own logs, read over plain RPC, are the other independent view of
// v1. They are what an indexer consumes, so they can confirm a CSV without trusting
// any indexer, and they stay available when a subgraph is deprecated, lagging, or
// simply has no gateway key to hand. That matters because this index gates the
// irreversible freeze.
//
// Two reads are needed rather than one. `NameRegistered` enumerates every label ever
// registered but carries only its expiry at registration time, and renewals move that
// afterwards. The current expiry therefore comes from `nameExpires` at the pinned
// block, which also folds in every renewal since.

export const V1_INDEX_IDS_FILE = "v1-name-index.ids.ndjson";

/** `NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)`. */
export const NAME_REGISTERED_TOPIC =
  "0xb3d987963d01b2f68493b4bdb130988f157ea43070d4ad840fee0466ed9370d9";

// Kept narrow on purpose: the builder needs three questions answered and nothing
// else, so a test can supply a fake chain without a node or a viem client.
export type RpcIndexClient = {
  /** Current head, used when no block is pinned. */
  getBlockNumber(): Promise<number>;
  /**
   * Registration ids logged in an inclusive block range. Throws
   * `RangeTooWideError` when the provider refuses the span, which the caller
   * answers by halving it.
   */
  getRegisteredIds(fromBlock: number, toBlock: number): Promise<string[]>;
  /** Expiry per id at `block`; null where the read failed. */
  getExpiries(ids: string[], block: number): Promise<Array<bigint | null>>;
  /**
   * Timestamp of a block. Optional: without it the filter falls back to wall-clock
   * time, which is right for a build against a live head and wrong for one pinned
   * to the past.
   */
  getBlockTimestamp?(block: number): Promise<bigint>;
};

// Providers cap a log query by result count, by block span, or by both, and each
// phrases the refusal differently. Rather than pattern-match every wording, the
// client raises this and the scan halves the range until the provider is satisfied.
export class RangeTooWideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RangeTooWideError";
  }
}

function idsPath(workDir: string) {
  return join(workDir, V1_INDEX_IDS_FILE);
}

function readScannedIds(workDir: string): string[] {
  const path = idsPath(workDir);
  if (!existsSync(path)) return [];
  const ids = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line !== "") ids.add(line);
  }
  // Sorted so a resumed expiry pass walks the same order it did before and can
  // continue from a count rather than having to record every id it wrote.
  return [...ids].sort();
}

export type BuildV1NameIndexFromRpcOptions = {
  network: string;
  workDir: string;
  /** First block to scan; the registrar's deploy block. */
  fromBlock: number;
  /** Pin to a specific block; defaults to the head. */
  block?: number;
  /** Blocks per log query before any narrowing. */
  scanRange?: number;
  /** Ids per `nameExpires` batch. */
  batchSize?: number;
  resume?: boolean;
  now?: bigint;
  onProgress?: (entries: number, cursor: string) => void;
};

export async function buildV1NameIndexFromRpc(
  opts: BuildV1NameIndexFromRpcOptions,
  client: RpcIndexClient,
): Promise<V1IndexMeta> {
  const scanRange = opts.scanRange ?? 250_000;
  const batchSize = opts.batchSize ?? 500;

  mkdirSync(opts.workDir, { recursive: true });

  const existing = opts.resume ? readV1NameIndexMeta(opts.workDir) : null;
  if (existing && existing.complete) return existing;
  if (existing && existing.source !== "rpc") {
    throw new Error(
      `cannot resume: the partial index in ${opts.workDir} was built from "${existing.source}"`,
    );
  }

  const block =
    existing?.block ?? opts.block ?? (await client.getBlockNumber());
  if (existing && opts.block !== undefined && existing.block !== opts.block) {
    throw new Error(
      `cannot resume index at block ${opts.block}: partial index was built at block ${existing.block}`,
    );
  }

  // The filter asks whether a name was still claimable, which is a question about
  // chain time at the pinned block — not about the clock on the machine running the
  // build. They agree when pinned to the head and disagree by months when pinned to
  // a past block or to a fork.
  const now =
    opts.now ??
    (await client.getBlockTimestamp?.(block)) ??
    BigInt(Math.floor(Date.now() / 1000));
  const cutoff = now - V1_GRACE_PERIOD_SECONDS - BUILD_FILTER_MARGIN_SECONDS;

  let entries = existing?.entries ?? 0;
  let cursor = existing?.lastId ?? "";
  let scannedTo = existing?.lastBlock ?? opts.fromBlock - 1;
  if (!existing) {
    writeFileSync(indexPath(opts.workDir), "", "utf-8");
    writeFileSync(idsPath(opts.workDir), "", "utf-8");
  }

  const writeMeta = (complete: boolean): V1IndexMeta => {
    const meta: V1IndexMeta = {
      source: "rpc",
      network: opts.network,
      block,
      lastId: cursor,
      entries,
      complete,
      builtAt: new Date().toISOString(),
      lastBlock: scannedTo,
      filterTime: now.toString(),
    };
    writeFileSync(
      metaPath(opts.workDir),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf-8",
    );
    return meta;
  };

  // Phase one: enumerate. Ids are appended as they are found and the scanned-to
  // block recorded beside them, so an interrupted scan resumes at a block boundary
  // rather than restarting a long walk.
  const scan = async (from: number, to: number): Promise<void> => {
    let ids: string[];
    try {
      ids = await client.getRegisteredIds(from, to);
    } catch (error) {
      if (!(error instanceof RangeTooWideError)) throw error;
      if (from >= to) throw error;
      const mid = Math.floor((from + to) / 2);
      await scan(from, mid);
      await scan(mid + 1, to);
      return;
    }
    if (ids.length > 0) {
      appendFileSync(
        idsPath(opts.workDir),
        `${ids.map(normalizeLabelhash).join("\n")}\n`,
        "utf-8",
      );
    }
  };

  while (scannedTo < block) {
    const from = scannedTo + 1;
    const to = Math.min(from + scanRange - 1, block);
    await scan(from, to);
    scannedTo = to;
    writeMeta(false);
    opts.onProgress?.(entries, `block ${scannedTo}`);
  }

  // Phase two: date the names. The id list is sorted, so a resumed pass picks up at
  // the first id after the recorded cursor. Resuming by cursor rather than by a
  // count keeps `entries` meaning what it means for the subgraph build — names
  // written to the index — even though an expired name consumes an id without
  // producing a line.
  const ids = readScannedIds(opts.workDir);
  const after = cursor === "" ? -1 : ids.findIndex((id) => id > cursor);
  const resumeAt = cursor === "" ? 0 : after === -1 ? ids.length : after;

  for (let start = resumeAt; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const expiries = await client.getExpiries(batch, block);

    const lines: string[] = [];
    for (let index = 0; index < batch.length; index++) {
      const expiry = expiries[index];
      if (expiry === null || expiry === undefined) {
        throw new Error(
          `could not read nameExpires for ${batch[index]} at block ${block}; re-run with --resume`,
        );
      }
      // A name released long ago cannot be claimed by its former owner. Dropping it
      // here keeps the index proportional to live names rather than to all history.
      if (expiry === 0n || expiry <= cutoff) continue;
      lines.push(
        JSON.stringify({ id: batch[index], expiry: expiry.toString() }),
      );
    }
    if (lines.length > 0) {
      appendFileSync(indexPath(opts.workDir), `${lines.join("\n")}\n`, "utf-8");
      entries += lines.length;
    }

    cursor = batch[batch.length - 1];
    writeMeta(false);
    opts.onProgress?.(entries, cursor);
  }

  // A batch interrupted between its append and its checkpoint is re-read on resume
  // and appends the same names twice, so the running total can overshoot. The file
  // is the authority; recount it before declaring the build complete.
  entries = countIndexedNames(opts.workDir);
  return writeMeta(true);
}

function countIndexedNames(workDir: string): number {
  const path = indexPath(workDir);
  if (!existsSync(path)) return 0;
  const ids = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line !== "") ids.add((JSON.parse(line) as { id: string }).id);
  }
  return ids.size;
}

// Canonical Multicall3, deployed at the same address on every chain this runs
// against. Overridable for a chain that placed it elsewhere.
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const NAME_EXPIRES_ABI = [
  {
    type: "function",
    name: "nameExpires",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Adapts a viem public client to the three questions the builder asks. Kept out of
// `buildV1NameIndexFromRpc` so the builder stays testable without a node.
export function createRpcIndexClient(opts: {
  client: {
    getBlockNumber(): Promise<bigint>;
    getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
    request(args: { method: string; params: unknown[] }): Promise<unknown>;
    multicall(
      args: unknown,
    ): Promise<Array<{ status: "success" | "failure"; result?: unknown }>>;
  };
  baseRegistrar: string;
  multicallAddress?: string;
}): RpcIndexClient {
  return {
    async getBlockNumber() {
      return Number(await opts.client.getBlockNumber());
    },

    async getBlockTimestamp(block) {
      const { timestamp } = await opts.client.getBlock({
        blockNumber: BigInt(block),
      });
      return BigInt(timestamp);
    },

    async getRegisteredIds(fromBlock, toBlock) {
      try {
        const logs = (await opts.client.request({
          method: "eth_getLogs",
          params: [
            {
              address: opts.baseRegistrar,
              fromBlock: `0x${fromBlock.toString(16)}`,
              toBlock: `0x${toBlock.toString(16)}`,
              topics: [NAME_REGISTERED_TOPIC],
            },
          ],
        })) as Array<{ topics: string[] }>;
        return logs.map((log) => log.topics[1]);
      } catch (error) {
        // Providers phrase the refusal differently, and all of them mean the same
        // thing to the caller: ask for less. Anything else is a real failure and
        // propagates — including a rate limit, which a keyword match would read as a
        // span refusal and answer by bisecting a range that was never the problem.
        const message = String(
          (error as { details?: string; message?: string })?.details ??
            (error as { message?: string })?.message ??
            error,
        );
        if (isLogSpanRefusalMessage(message)) {
          throw new RangeTooWideError(message);
        }
        throw error;
      }
    },

    async getExpiries(ids, block) {
      const results = await opts.client.multicall({
        allowFailure: true,
        blockNumber: BigInt(block),
        multicallAddress: opts.multicallAddress ?? MULTICALL3_ADDRESS,
        contracts: ids.map((id) => ({
          address: opts.baseRegistrar,
          abi: NAME_EXPIRES_ABI,
          functionName: "nameExpires",
          args: [BigInt(id)],
        })),
      });
      return results.map((entry) =>
        entry.status === "success" ? BigInt(entry.result as bigint) : null,
      );
    },
  };
}

// Whether the index's build filter can be trusted for a reconciliation judging
// claimability at `chainNow`.
//
// The build drops names expired before `filterTime - GRACE - MARGIN`; the
// reconciliation wants every name expired after `chainNow - GRACE`. So a name is
// dropped that the reconciliation still wants exactly when `filterTime` runs more
// than MARGIN ahead of `chainNow` — a build against wall-clock time reconciled
// against a fork pinned to the past, say. The names are simply absent by then, so the
// completeness check would pass without ever having looked at them. Refusing is the
// only honest answer.
export function assertIndexCoversChainTime(
  meta: V1IndexMeta,
  chainNow: bigint,
): void {
  if (meta.filterTime === undefined) {
    throw new Error(
      `the index in this work dir predates the build-filter timestamp record, so it cannot be shown to cover chain time ${chainNow}. Rebuild it with premigration build-index.`,
    );
  }
  const filterTime = BigInt(meta.filterTime);
  if (filterTime > chainNow + BUILD_FILTER_MARGIN_SECONDS) {
    throw new Error(
      `refusing to reconcile: the index filtered expired names against ${filterTime} but the chain is at ${chainNow}, ` +
        `more than the ${BUILD_FILTER_MARGIN_SECONDS}s build margin behind it. Names still claimable at this block were dropped from the index, ` +
        `so a pass would prove nothing about them. Rebuild the index against this chain.`,
    );
  }
}

export function readV1NameIndexMeta(workDir: string): V1IndexMeta | null {
  const path = metaPath(workDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as V1IndexMeta;
}

// Loads a completed index into memory. A partial index is refused rather than
// silently under-reporting: a reconciliation reads "absent from the index" as
// "not a v1 name", which is exactly the wrong conclusion to draw from a short read.
export function loadV1NameIndex(workDir: string): V1NameIndex {
  const meta = readV1NameIndexMeta(workDir);
  if (!meta) {
    throw new Error(
      `no v1 name index in ${workDir}: run premigration build-index`,
    );
  }
  if (!meta.complete) {
    throw new Error(
      `v1 name index in ${workDir} is incomplete (${meta.entries} entries, stopped at ${meta.lastId}): resume the build before reconciling`,
    );
  }

  const expiries = new Map<string, bigint>();
  const contents = readFileSync(indexPath(workDir), "utf8");
  for (const line of contents.split("\n")) {
    if (line === "") continue;
    const entry = JSON.parse(line) as { id: string; expiry: string };
    const expiry = BigInt(entry.expiry);
    // The subgraph folds renewals into a single entity per labelhash, so a repeated
    // id means a rebuilt or appended index; keep the longest life seen.
    const previous = expiries.get(entry.id);
    if (previous === undefined || expiry > previous) {
      expiries.set(entry.id, expiry);
    }
  }
  return { meta, expiries };
}

// How a CSV was produced, when the exporter recorded it. Absent for a CSV that
// arrived out of band, which is the normal case for a manually-run Dune export.
export function readCsvSourceStamp(csvFile: string): {
  source?: string;
  network?: string;
  block?: number;
  lastId?: string;
  complete?: boolean;
} | null {
  const path = `${csvFile}.source.json`;
  // Absent and unparseable are different answers. A CSV with no stamp arrived out of
  // band and is the operator's to vouch for; a stamp that will not parse is a stamp
  // whose contents are unknown, and reading it as "no stamp" turns off both the
  // completeness refusal and the independence refusal at once.
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read the export stamp beside ${csvFile}: ${path} is not valid JSON (${String(error)}). ` +
        `It records whether the export completed and which indexer produced it; delete it to vouch for the CSV yourself, or re-export.`,
    );
  }
}

// An export that stopped partway holds a suffix of the registration set, and reading
// it as the whole set is how a name goes missing before the irreversible freeze. A
// CSV with no stamp arrived out of band — the normal case for a manual Dune export —
// and is left to the operator to vouch for.
export function assertCompleteCsv(csvFile: string): void {
  const stamp = readCsvSourceStamp(csvFile);
  if (!stamp || stamp.complete !== false) return;
  throw new Error(
    `refusing to use ${csvFile}: its export stopped at ${stamp.lastId ?? "an unrecorded id"} and never completed. ` +
      `Resume it with export-registrations --start-id ${stamp.lastId ?? "<id>"}, or re-export from the start.`,
  );
}

// The reconciliation is only meaningful when its index and the CSV came from
// different indexers. This catches the circular case rather than trusting an
// operator to remember which file came from where.
export function assertIndependentSource(
  indexSource: V1IndexSource,
  csvFile: string,
): void {
  const stamp = readCsvSourceStamp(csvFile);
  if (!stamp?.source) return;
  if (stamp.source === indexSource) {
    throw new Error(
      `refusing to reconcile: ${csvFile} was produced from "${stamp.source}" and the index was built from "${indexSource}". ` +
        `Verifying a CSV against the indexer that produced it cannot detect a name missing from that indexer. ` +
        `Rebuild the index with premigration build-index --source ${indexSource === "rpc" ? "subgraph" : "rpc"}, or reconcile a CSV from a different source.`,
    );
  }
}
