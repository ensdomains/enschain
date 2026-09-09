import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exportRegistrations,
  sourceStampPath,
  unlabelledFilePath,
} from "../../script/exportTheGraphRegistrations.js";

const HEAD_BLOCK = 21_000_000;

type Registration = {
  id: string;
  labelName: string | null;
};

function registration(id: string, labelName: string | null) {
  return {
    id,
    labelName,
    registrant: { id: "0x0000000000000000000000000000000000000001" },
    expiryDate: "1900000000",
    registrationDate: "1600000000",
    domain: {
      id: `${id}-domain`,
      name: labelName ? `${labelName}.eth` : null,
      labelhash: null,
      parent: { id: "eth" },
    },
  };
}

function labelhash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

// A subgraph that holds `rows` and answers cursor queries against them, recording
// every request so the test can assert on how it was paged.
function fakeSubgraph(
  rows: Registration[],
  short: { shortPageAt?: number; shortPageSize?: number } = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  let pageIndex = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (String(body.query).includes("_meta")) {
      return Response.json({
        data: { _meta: { block: { number: HEAD_BLOCK } } },
      });
    }
    const { first, afterId } = body.variables as {
      first: number;
      afterId: string;
    };
    // A real subgraph may answer with fewer rows than asked for and still have more
    // behind it, so one page can be made short without ending the result set.
    const take =
      pageIndex === short.shortPageAt ? (short.shortPageSize ?? 1) : first;
    pageIndex += 1;
    const page = rows
      .filter((row) => row.id > afterId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, take);
    return Response.json({ data: { registrations: page } });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

function runExport(
  rows: Registration[],
  overrides: {
    batchSize?: number;
    limit?: number | null;
    outputFile?: string;
    startId?: string;
    network?: "mainnet" | "sepolia";
    block?: number | null;
    shortPageAt?: number;
    shortPageSize?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ens-export-"));
  const outputFile = overrides.outputFile ?? join(dir, "registrations.csv");
  const { fetchFn, requests } = fakeSubgraph(rows, {
    shortPageAt: overrides.shortPageAt,
    shortPageSize: overrides.shortPageSize,
  });
  return {
    outputFile,
    requests,
    run: () =>
      exportRegistrations(
        {
          thegraphApiKey: "key",
          network: overrides.network ?? "mainnet",
          batchSize: overrides.batchSize ?? 2,
          startId: overrides.startId ?? "",
          limit: overrides.limit ?? null,
          outputFile,
          block: overrides.block ?? null,
        },
        fetchFn,
      ),
  };
}

function stampOf(outputFile: string) {
  return JSON.parse(readFileSync(sourceStampPath(outputFile), "utf8"));
}

function dataRows(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n").slice(1);
}

describe("exportTheGraphRegistrations", () => {
  it("pages by cursor until exhausted, without repeating or dropping rows", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const { outputFile, requests, run } = runExport(rows);

    await run();

    const exported = dataRows(outputFile);
    expect(exported).toHaveLength(7);

    // Every registration appears exactly once, keyed by its labelhash.
    const exportedHashes = exported.map((row) => row.split(",")[2]);
    expect(new Set(exportedHashes).size).toBe(7);
    expect(exportedHashes.sort()).toEqual(rows.map((row) => row.id).sort());

    // Each page asks for rows after the previous page's last id — never an offset.
    const cursors = requests
      .filter((body) => body.variables)
      .map((body) => (body.variables as { afterId: string }).afterId);
    expect(cursors).toEqual([
      "",
      labelhash(2),
      labelhash(4),
      labelhash(6),
      labelhash(7),
    ]);
  });

  it("pins every page to a single indexed block", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const { requests, run } = runExport(rows);

    await run();

    const blocks = requests
      .filter((body) => body.variables)
      .map((body) => (body.variables as { block: number }).block);
    expect(blocks.length).toBeGreaterThan(1);
    expect(new Set(blocks)).toEqual(new Set([HEAD_BLOCK]));
  });

  it("keeps undecodable labels in a sidecar instead of discarding them", async () => {
    const rows = [
      registration(labelhash(1), "alpha"),
      registration(labelhash(2), null),
      registration(labelhash(3), "gamma"),
      registration(labelhash(4), ""),
    ];
    const { outputFile, run } = runExport(rows);

    await run();

    // The main CSV stays consumable: every row carries a label.
    const exported = dataRows(outputFile);
    expect(exported).toHaveLength(2);
    for (const row of exported) {
      expect(row.split(",")[6]).not.toBe("");
    }

    // The undecodable ones survive as labelhashes rather than vanishing.
    const unlabelled = dataRows(unlabelledFilePath(outputFile));
    expect(unlabelled.map((row) => row.split(",")[0])).toEqual([
      labelhash(2),
      labelhash(4),
    ]);
  });

  it("stamps the source so a reconciliation can refuse a circular check", async () => {
    const rows = [
      registration(labelhash(1), "alpha"),
      registration(labelhash(2), null),
    ];
    const { outputFile, run } = runExport(rows);

    await run();

    const stamp = JSON.parse(readFileSync(sourceStampPath(outputFile), "utf8"));
    expect(stamp.source).toBe("subgraph");
    expect(stamp.network).toBe("mainnet");
    expect(stamp.block).toBe(HEAD_BLOCK);
    expect(stamp.totalRegistrations).toBe(2);
    expect(stamp.labelledRegistrations).toBe(1);
    expect(stamp.unlabelledRegistrations).toBe(1);
  });

  it("keeps earlier pages when an export is resumed", async () => {
    // A resume that truncated the file would leave only the rows after the cursor,
    // and the completed stamp would present that suffix as the whole set.
    const rows = Array.from({ length: 6 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const first = runExport(rows.slice(0, 3), { batchSize: 3 });
    await first.run();
    expect(dataRows(first.outputFile)).toHaveLength(3);

    const resumed = runExport(rows, {
      outputFile: first.outputFile,
      batchSize: 3,
      startId: labelhash(3),
      block: HEAD_BLOCK,
    });
    await resumed.run();

    const exported = dataRows(resumed.outputFile).map(
      (row) => row.split(",")[2],
    );
    expect(exported).toEqual(rows.map((row) => row.id));
    expect(stampOf(resumed.outputFile).totalRegistrations).toBe(6);
    expect(stampOf(resumed.outputFile).complete).toBe(true);
  });

  it("marks an interrupted export incomplete, with the cursor to resume from", async () => {
    // An export that stopped partway holds a suffix of the registration set. The
    // stamp has to say so, or the partial file reads as a finished one.
    const rows = Array.from({ length: 4 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const dir = mkdtempSync(join(tmpdir(), "ens-export-"));
    const outputFile = join(dir, "registrations.csv");
    const { fetchFn } = fakeSubgraph(rows);

    let pages = 0;
    const failingFetch = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.variables && pages++ === 1) throw new Error("gateway went away");
      return fetchFn(url as never, init as never);
    }) as unknown as typeof fetch;

    await expect(
      exportRegistrations(
        {
          thegraphApiKey: "key",
          network: "mainnet",
          batchSize: 2,
          startId: "",
          limit: null,
          outputFile,
          block: null,
        },
        failingFetch,
      ),
    ).rejects.toThrow(/gateway went away/);

    const stamp = stampOf(outputFile);
    expect(stamp.complete).toBe(false);
    expect(stamp.lastId).toBe(labelhash(2));
    expect(dataRows(outputFile)).toHaveLength(2);

    // And the recorded cursor is enough to finish it.
    const resumed = runExport(rows, {
      outputFile,
      batchSize: 2,
      startId: stamp.lastId,
      block: stamp.block,
    });
    await resumed.run();
    expect(dataRows(outputFile)).toHaveLength(4);
    expect(stampOf(outputFile).complete).toBe(true);
  });

  it("refuses a resume the existing file cannot support", async () => {
    const rows = [registration(labelhash(1), "alpha")];
    const missing = runExport(rows, {
      outputFile: join(
        mkdtempSync(join(tmpdir(), "ens-export-")),
        "absent.csv",
      ),
      startId: labelhash(1),
    });
    await expect(missing.run()).rejects.toThrow(/cannot resume/);

    const first = runExport(rows, { batchSize: 1 });
    await first.run();

    const wrongCursor = runExport(rows, {
      outputFile: first.outputFile,
      startId: labelhash(9),
    });
    await expect(wrongCursor.run()).rejects.toThrow(/stopped at/);

    const wrongNetwork = runExport(rows, {
      outputFile: first.outputFile,
      startId: labelhash(1),
      network: "sepolia",
    });
    await expect(wrongNetwork.run()).rejects.toThrow(/exported from mainnet/);

    const wrongBlock = runExport(rows, {
      outputFile: first.outputFile,
      startId: labelhash(1),
      block: HEAD_BLOCK - 1,
    });
    await expect(wrongBlock.run()).rejects.toThrow(/cannot resume at block/);
  });

  it("stops at the requested limit, and does not call the result complete", async () => {
    // --limit leaves a prefix of the registration set. Stamping it complete would
    // let pre-migration seed from it and report the missing names as never
    // registered on v1.
    const rows = Array.from({ length: 10 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const { outputFile, run } = runExport(rows, { batchSize: 4, limit: 5 });

    await run();

    expect(dataRows(outputFile)).toHaveLength(5);
    expect(stampOf(outputFile).complete).toBe(false);
  });

  it("calls a limit larger than the result set complete", async () => {
    // The cap never bit: the source ran out first, so the file is the whole set.
    const rows = Array.from({ length: 3 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const { outputFile, run } = runExport(rows, { batchSize: 2, limit: 50 });

    await run();

    expect(dataRows(outputFile)).toHaveLength(3);
    expect(stampOf(outputFile).complete).toBe(true);
  });

  it("does not call a limit-truncated export complete after a short page", async () => {
    // A short page is evidence that the result set ended, but only about that page.
    // Latching it means a later --limit truncation is stamped complete, and
    // `assertCompleteCsv` then accepts a prefix of the registrations as all of them.
    const rows = Array.from({ length: 12 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const { outputFile, run } = runExport(rows, {
      batchSize: 4,
      limit: 9,
      shortPageAt: 0,
      shortPageSize: 2,
    });

    await run();

    expect(stampOf(outputFile).complete).toBe(false);
  });

  it("calls a limit that exactly consumes the result set complete", async () => {
    // The final page came back short, which proves exhaustion even though the
    // limit was also reached on the same page.
    const rows = Array.from({ length: 3 }, (_, index) =>
      registration(labelhash(index + 1), `name${index + 1}`),
    );
    const { outputFile, run } = runExport(rows, { batchSize: 2, limit: 3 });

    await run();

    expect(dataRows(outputFile)).toHaveLength(3);
    expect(stampOf(outputFile).complete).toBe(true);
  });
});
