import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCompleteCsv,
  assertIndexCoversChainTime,
  assertIndependentSource,
  buildV1NameIndex,
  buildV1NameIndexFromRpc,
  loadV1NameIndex,
  readV1NameIndexMeta,
  RangeTooWideError,
  type RpcIndexClient,
} from "../../script/premigrationIndex.js";
import { V1_GRACE_PERIOD_SECONDS } from "../../script/preMigration.js";

const HEAD_BLOCK = 21_000_000;
const NOW = 1_800_000_000n;

function labelhash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

type Row = { id: string; expiryDate: string };

// A subgraph holding `rows`, answering cursor queries. `failAfter` makes it throw
// part-way through so a resume can be exercised.
function fakeSubgraph(rows: Row[], failAfter?: number) {
  let pages = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (String(body.query).includes("_meta")) {
      return Response.json({
        data: { _meta: { block: { number: HEAD_BLOCK } } },
      });
    }
    if (failAfter !== undefined && pages >= failAfter) {
      throw new Error("simulated gateway failure");
    }
    pages++;
    const { first, afterId } = body.variables as {
      first: number;
      afterId: string;
    };
    const page = rows
      .filter((row) => row.id > afterId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, first);
    return Response.json({ data: { registrations: page } });
  }) as unknown as typeof fetch;
  return fetchFn;
}

function workDir() {
  return mkdtempSync(join(tmpdir(), "ens-index-"));
}

function build(
  dir: string,
  rows: Row[],
  opts: { batchSize?: number; resume?: boolean; failAfter?: number } = {},
) {
  return buildV1NameIndex(
    {
      thegraphApiKey: "key",
      network: "mainnet",
      workDir: dir,
      batchSize: opts.batchSize ?? 2,
      resume: opts.resume,
      now: NOW,
    },
    fakeSubgraph(rows, opts.failAfter),
  );
}

const live = (index: number, offset = 1_000_000n): Row => ({
  id: labelhash(index),
  expiryDate: (NOW + offset).toString(),
});

describe("premigrationIndex", () => {
  it("indexes every live name keyed by labelhash", async () => {
    const dir = workDir();
    const rows = [live(1), live(2), live(3), live(4), live(5)];

    const meta = await build(dir, rows);

    expect(meta.complete).toBe(true);
    expect(meta.entries).toBe(5);
    expect(meta.block).toBe(HEAD_BLOCK);
    expect(meta.source).toBe("subgraph");

    const index = loadV1NameIndex(dir);
    expect(index.expiries.size).toBe(5);
    expect(index.expiries.get(labelhash(3))).toBe(NOW + 1_000_000n);
  });

  it("drops names released long ago but keeps names inside grace", async () => {
    const dir = workDir();
    const rows: Row[] = [
      live(1),
      // Expired but still inside the 90-day grace: the owner can still claim it.
      { id: labelhash(2), expiryDate: (NOW - 10n).toString() },
      // Released long ago — no longer its former owner's to migrate.
      {
        id: labelhash(3),
        expiryDate: (NOW - V1_GRACE_PERIOD_SECONDS - 400n * 86400n).toString(),
      },
      // Never registered.
      { id: labelhash(4), expiryDate: "0" },
    ];

    await build(dir, rows);

    const index = loadV1NameIndex(dir);
    expect([...index.expiries.keys()].sort()).toEqual([
      labelhash(1),
      labelhash(2),
    ]);
  });

  it("normalizes labelhashes so short ids still join correctly", async () => {
    const dir = workDir();
    // Some indexers drop leading zeros when hex-encoding an id.
    const rows: Row[] = [{ id: "0xabc", expiryDate: (NOW + 100n).toString() }];

    await build(dir, rows);

    const index = loadV1NameIndex(dir);
    expect(index.expiries.has(`0x${"abc".padStart(64, "0")}`)).toBe(true);
  });

  it("resumes an interrupted build without losing or repeating entries", async () => {
    const dir = workDir();
    const rows = Array.from({ length: 9 }, (_, i) => live(i + 1));

    // Fail after two pages of two, leaving a partial index behind.
    await expect(build(dir, rows, { failAfter: 2 })).rejects.toThrow(
      "simulated gateway failure",
    );

    const partial = readV1NameIndexMeta(dir);
    expect(partial?.complete).toBe(false);
    expect(partial?.entries).toBe(4);

    // Loading a partial index must fail loudly rather than under-report.
    expect(() => loadV1NameIndex(dir)).toThrow(/incomplete/);

    const meta = await build(dir, rows, { resume: true });

    expect(meta.complete).toBe(true);
    expect(meta.entries).toBe(9);
    // The resumed half stays pinned to the block the first half used.
    expect(meta.block).toBe(HEAD_BLOCK);

    const index = loadV1NameIndex(dir);
    expect(index.expiries.size).toBe(9);
    expect([...index.expiries.keys()].sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
  });

  it("refuses to verify a CSV against the indexer that produced it", () => {
    const dir = workDir();
    const csv = join(dir, "registrations.csv");
    writeFileSync(csv, "label\n", "utf-8");
    writeFileSync(
      `${csv}.source.json`,
      JSON.stringify({ source: "subgraph", network: "mainnet" }),
      "utf-8",
    );

    expect(() => assertIndependentSource("subgraph", csv)).toThrow(
      /refusing to reconcile/,
    );
    // A different source is the whole point, so it passes.
    expect(() => assertIndependentSource("rpc", csv)).not.toThrow();
  });

  it("allows a CSV with no source stamp, as a manual export has none", () => {
    const dir = workDir();
    const csv = join(dir, "dune.csv");
    writeFileSync(csv, "label\n", "utf-8");

    expect(() => assertIndependentSource("subgraph", csv)).not.toThrow();
  });

  it("refuses a CSV whose export never finished", () => {
    // A partial export holds a suffix of the registration set. Seeding from it
    // leaves the earlier names missing with nothing to report them.
    const dir = workDir();
    const csv = join(dir, "partial.csv");
    writeFileSync(csv, "label\n", "utf-8");
    const stamp = (complete: boolean) =>
      writeFileSync(
        `${csv}.source.json`,
        JSON.stringify({
          source: "subgraph",
          network: "mainnet",
          lastId: labelhash(4),
          complete,
        }),
        "utf-8",
      );

    stamp(false);
    expect(() => assertCompleteCsv(csv)).toThrow(/never completed/);
    stamp(true);
    expect(() => assertCompleteCsv(csv)).not.toThrow();
  });

  it("allows a CSV whose stamp predates the completion flag", () => {
    const dir = workDir();
    const csv = join(dir, "old.csv");
    writeFileSync(csv, "label\n", "utf-8");
    writeFileSync(
      `${csv}.source.json`,
      JSON.stringify({ source: "subgraph", network: "mainnet" }),
      "utf-8",
    );

    expect(() => assertCompleteCsv(csv)).not.toThrow();
  });

  it("records progress so a partial build is inspectable", async () => {
    const dir = workDir();
    const rows = Array.from({ length: 6 }, (_, i) => live(i + 1));
    const seen: number[] = [];

    await buildV1NameIndex(
      {
        thegraphApiKey: "key",
        network: "mainnet",
        workDir: dir,
        batchSize: 2,
        now: NOW,
        onProgress: (entries) => seen.push(entries),
      },
      fakeSubgraph(rows),
    );

    expect(seen).toEqual([2, 4, 6]);
    const written = readFileSync(join(dir, "v1-name-index.ndjson"), "utf8");
    expect(written.trim().split("\n")).toHaveLength(6);
  });
});

const FROM_BLOCK = 3_700_000;
const RPC_HEAD = 3_900_000;

type Registration = { id: string; block: number; expiry: bigint };

// A chain holding `registrations`. `maxLogs` mimics a provider that refuses a query
// returning too many results, so the range-narrowing walk can be exercised.
// `failAt` makes the scan throw once the given block is reached.
function fakeChain(
  registrations: Registration[],
  opts: { maxLogs?: number; failAt?: number } = {},
) {
  const calls = { logs: 0, expiries: 0 };
  const client: RpcIndexClient = {
    async getBlockNumber() {
      return RPC_HEAD;
    },
    async getRegisteredIds(fromBlock, toBlock) {
      if (opts.failAt !== undefined && toBlock >= opts.failAt) {
        throw new Error("simulated rpc failure");
      }
      calls.logs++;
      const hits = registrations.filter(
        (entry) => entry.block >= fromBlock && entry.block <= toBlock,
      );
      if (opts.maxLogs !== undefined && hits.length > opts.maxLogs) {
        throw new RangeTooWideError("query returns too many logs");
      }
      return hits.map((entry) => entry.id);
    },
    async getExpiries(ids) {
      calls.expiries++;
      // Reads current expiry, which is what a renewal moves — the registration
      // log's own expiry is deliberately not consulted.
      return ids.map(
        (id) => registrations.find((entry) => entry.id === id)?.expiry ?? null,
      );
    },
  };
  return { client, calls };
}

function buildFromRpc(
  dir: string,
  client: RpcIndexClient,
  opts: { scanRange?: number; batchSize?: number; resume?: boolean } = {},
) {
  return buildV1NameIndexFromRpc(
    {
      network: "sepolia",
      workDir: dir,
      fromBlock: FROM_BLOCK,
      scanRange: opts.scanRange ?? 100_000,
      batchSize: opts.batchSize ?? 2,
      resume: opts.resume,
      now: NOW,
    },
    client,
  );
}

const registered = (
  index: number,
  block: number,
  expiry = NOW + 1_000_000n,
): Registration => ({ id: labelhash(index), block, expiry });

describe("premigrationIndex from chain logs", () => {
  it("indexes registrations with the expiry renewals left behind", async () => {
    const dir = workDir();
    const { client } = fakeChain([
      registered(1, 3_710_000),
      registered(2, 3_800_000),
      // Registered once, renewed since: the index must carry the later expiry.
      registered(3, 3_750_000, NOW + 9_000_000n),
    ]);

    const meta = await buildFromRpc(dir, client);

    expect(meta.complete).toBe(true);
    expect(meta.source).toBe("rpc");
    expect(meta.entries).toBe(3);
    expect(meta.block).toBe(RPC_HEAD);

    const index = loadV1NameIndex(dir);
    expect(index.expiries.size).toBe(3);
    expect(index.expiries.get(labelhash(3))).toBe(NOW + 9_000_000n);
  });

  it("narrows the block range when the provider refuses the span", async () => {
    const dir = workDir();
    // Eight registrations in one scan window against a provider capping at two
    // results forces the walk to halve until each query fits.
    const { client, calls } = fakeChain(
      Array.from({ length: 8 }, (_, i) =>
        registered(i + 1, 3_710_000 + i * 100),
      ),
      { maxLogs: 2 },
    );

    const meta = await buildFromRpc(dir, client, { scanRange: 200_000 });

    expect(meta.complete).toBe(true);
    expect(meta.entries).toBe(8);
    // Narrowing means more queries than windows, which is the point.
    expect(calls.logs).toBeGreaterThan(2);
  });

  it("drops names released long ago but keeps names inside grace", async () => {
    const dir = workDir();
    const { client } = fakeChain([
      registered(1, 3_710_000),
      registered(2, 3_720_000, NOW - 10n),
      registered(3, 3_730_000, NOW - V1_GRACE_PERIOD_SECONDS - 400n * 86400n),
      registered(4, 3_740_000, 0n),
    ]);

    await buildFromRpc(dir, client);

    const index = loadV1NameIndex(dir);
    expect([...index.expiries.keys()].sort()).toEqual([
      labelhash(1),
      labelhash(2),
    ]);
  });

  it("resumes an interrupted scan without losing or repeating entries", async () => {
    const dir = workDir();
    const registrations = Array.from({ length: 9 }, (_, i) =>
      registered(i + 1, 3_710_000 + i * 20_000),
    );

    await expect(
      buildFromRpc(dir, fakeChain(registrations, { failAt: 3_900_000 }).client),
    ).rejects.toThrow("simulated rpc failure");

    const partial = readV1NameIndexMeta(dir);
    expect(partial?.complete).toBe(false);
    expect(() => loadV1NameIndex(dir)).toThrow(/incomplete/);

    const meta = await buildFromRpc(dir, fakeChain(registrations).client, {
      resume: true,
    });

    expect(meta.complete).toBe(true);
    expect(meta.entries).toBe(9);
    // The resumed half stays pinned to the block the first half used.
    expect(meta.block).toBe(RPC_HEAD);

    const index = loadV1NameIndex(dir);
    expect(index.expiries.size).toBe(9);
    expect([...index.expiries.keys()].sort()).toEqual(
      registrations.map((entry) => entry.id).sort(),
    );
  });

  it("refuses to resume a partial index built from another source", async () => {
    const dir = workDir();
    await expect(
      build(dir, [live(1), live(2), live(3)], { failAfter: 1 }),
    ).rejects.toThrow();

    await expect(
      buildFromRpc(dir, fakeChain([registered(1, 3_710_000)]).client, {
        resume: true,
      }),
    ).rejects.toThrow(/built from "subgraph"/);
  });

  it("pairs with a subgraph CSV and refuses one built the same way", async () => {
    const dir = workDir();
    const csv = join(dir, "rpc-export.csv");
    writeFileSync(csv, "label\n", "utf-8");
    writeFileSync(
      `${csv}.source.json`,
      JSON.stringify({ source: "rpc", network: "sepolia" }),
      "utf-8",
    );

    expect(() => assertIndependentSource("rpc", csv)).toThrow(
      /--source subgraph/,
    );
    expect(() => assertIndependentSource("subgraph", csv)).not.toThrow();
  });
});

describe("assertIndexCoversChainTime", () => {
  const meta = (filterTime: bigint) =>
    ({
      source: "rpc",
      network: "mainnet",
      block: 1,
      lastId: "",
      entries: 0,
      complete: true,
      builtAt: "2026-01-01T00:00:00.000Z",
      filterTime: filterTime.toString(),
    }) as const;

  const MARGIN = 7n * 24n * 60n * 60n;

  it("accepts a build measured against the same chain time", () => {
    expect(() => assertIndexCoversChainTime(meta(NOW), NOW)).not.toThrow();
  });

  it("accepts a build behind the chain, which drops nothing the reconcile wants", () => {
    // The build kept MORE than it needed to. Harmless.
    expect(() =>
      assertIndexCoversChainTime(meta(NOW - 400n * 24n * 60n * 60n), NOW),
    ).not.toThrow();
  });

  it("accepts skew inside the build margin", () => {
    expect(() =>
      assertIndexCoversChainTime(meta(NOW + MARGIN), NOW),
    ).not.toThrow();
  });

  it("refuses a build whose filter ran ahead of the chain being judged", () => {
    // Wall-clock build reconciled against a fork pinned to the past: names still
    // claimable at that block were dropped, so a pass would prove nothing.
    expect(() =>
      assertIndexCoversChainTime(meta(NOW + MARGIN + 1n), NOW),
    ).toThrow(/refusing to reconcile/);
  });

  it("refuses an index built before the filter basis was recorded", () => {
    const stale = { ...meta(NOW) } as Record<string, unknown>;
    delete stale.filterTime;
    expect(() =>
      assertIndexCoversChainTime(
        stale as unknown as Parameters<typeof assertIndexCoversChainTime>[0],
        NOW,
      ),
    ).toThrow(/predates/);
  });
});
