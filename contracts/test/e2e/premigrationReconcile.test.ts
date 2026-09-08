import { describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, toHex, zeroAddress } from "viem";

import { reconcilePreMigration } from "../../script/migration.js";
import { main as preMigrationMain } from "../../script/preMigration.js";
import { V1_INDEX_META_FILE } from "../../script/premigrationIndex.js";
import { PREMIGRATION_CSV_HEADER } from "../../script/preMigrationUtils.js";
import { readVerification } from "../../script/phaseGate.js";
import { MAX_UINT64 } from "../../script/preMigration.js";
import { FUSES } from "../../script/deploy-constants.js";
import { idFromLabel } from "../utils/utils.js";
import {
  buildMainArgs,
  createCSVFile,
  registerV1Name,
  setupBaseRegistrarController,
} from "../utils/mockPreMigration.js";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const BONUS_PERIOD_DAYS = 62;
const BONUS_PERIOD_SECONDS = BigInt(BONUS_PERIOD_DAYS) * 86400n;

function labelhash(label: string): string {
  return keccak256(toHex(label));
}

// Stands in for `premigration build-index`, which would otherwise need a live
// subgraph. The reconciliation only consumes the index files, so writing them
// directly exercises exactly the same path.
// The export used in production carries an expiry per row; the shared test helper
// leaves that column empty, which the reconciliation correctly refuses to read as a
// claimable count. Rewrites the CSV with the expiries the names were registered with.
function writeDatedCsv(
  csvFile: string,
  labels: string[],
  entries: Array<{ expiry: bigint }>,
) {
  const rows = labels.map(
    (label, index) => `,,,,,,${label},,${entries[index].expiry.toString()}`,
  );
  writeFileSync(csvFile, [PREMIGRATION_CSV_HEADER, ...rows].join("\n"));
}

function writeIndex(
  workDir: string,
  entries: Array<{ id: string; expiry: bigint }>,
  overrides: {
    source?: string;
    complete?: boolean;
    /** The chain time the build filter was measured against. */
    filterTime?: bigint;
  } = {},
) {
  writeFileSync(
    join(workDir, "v1-name-index.ndjson"),
    entries
      .map((entry) =>
        JSON.stringify({ id: entry.id, expiry: entry.expiry.toString() }),
      )
      .join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf-8",
  );
  writeFileSync(
    join(workDir, V1_INDEX_META_FILE),
    JSON.stringify({
      source: overrides.source ?? "subgraph",
      network: "mainnet",
      block: 1,
      lastId: entries.at(-1)?.id ?? "",
      entries: entries.length,
      complete: overrides.complete ?? true,
      builtAt: new Date().toISOString(),
      // The devnet runs at roughly wall-clock time, so a build measured against it
      // covers what the reconciliation asks for.
      filterTime: (
        overrides.filterTime ?? BigInt(Math.floor(Date.now() / 1000))
      ).toString(),
    }),
    "utf-8",
  );
}

describe("premigration reconcile", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  const v1DeploymentsDir = mkdtempSync(join(tmpdir(), "reconcile-v1-"));

  setupEnv({
    resetOnEach: true,
    async initialize() {
      await setupBaseRegistrarController(env);
      // The fuse scan resolves NameWrapper from deployment artifacts.
      const dir = join(v1DeploymentsDir, "mainnet");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "NameWrapper.json"),
        JSON.stringify({
          address: env.v1.NameWrapper.address,
          abi: env.v1.NameWrapper.abi,
        }),
      );
    },
  });

  // Registers `labels` on v1, seeds them onto v2 through the real pre-migration
  // path, and returns everything the reconciliation needs to run against them.
  async function seed(labels: string[]) {
    const { user } = env.namedAccounts;
    const workDir = mkdtempSync(join(tmpdir(), "reconcile-"));
    const csvFile = join(workDir, "registrations.csv");

    // The devnet fixture seeds names of its own onto v2 before any of this runs.
    // Production scans from the registry's deploy block for the same reason: the
    // reverse check should only account for entries this migration created.
    const fromBlock = await env.client.getBlockNumber();

    const v1Expiries = new Map<string, bigint>();
    for (const label of labels) {
      v1Expiries.set(
        label,
        await registerV1Name(env, label, user.address, ONE_YEAR_SECONDS),
      );
    }

    createCSVFile(csvFile, labels);
    await preMigrationMain(
      buildMainArgs(env, csvFile, { bonusPeriodDays: BONUS_PERIOD_DAYS }),
    );

    const indexEntries = labels.map((label) => ({
      id: labelhash(label),
      expiry: v1Expiries.get(label)!,
    }));

    return { workDir, csvFile, indexEntries, fromBlock };
  }

  function run(
    workDir: string,
    fromBlock: bigint,
    extra: Record<string, unknown> = {},
  ): ReturnType<typeof reconcilePreMigration> {
    return reconcilePreMigration({
      network: "mainnet",
      rpcUrl: `http://${env.hostPort}`,
      workDir,
      registry: env.v2.ETHRegistry.address,
      bonusPeriodDays: String(BONUS_PERIOD_DAYS),
      fromBlock: fromBlock.toString(),
      ...extra,
    });
  }

  it("passes when every claimable v1 name is reserved on v2", async () => {
    const { workDir, indexEntries, fromBlock } = await seed([
      "alpha",
      "beta",
      "gamma",
    ]);
    writeIndex(workDir, indexEntries);

    const result = await run(workDir, fromBlock);

    expect(result.claimable).toBe(3);
    expect(result.reserved).toBe(3);
    expect(result.missing).toEqual([]);
    expect(result.expiryMismatched).toEqual([]);
    expect(result.unexpected).toEqual([]);
  });

  it("reports a v1 name the CSV never contained — the gap CSV verification cannot see", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha", "beta"]);
    const { user } = env.namedAccounts;

    // A real v1 name that pre-migration was never told about. It is absent from the
    // CSV, so a CSV-scoped check passes; the index knows it exists.
    const missed = "forgotten";
    const missedExpiry = await registerV1Name(
      env,
      missed,
      user.address,
      ONE_YEAR_SECONDS,
    );
    writeIndex(workDir, [
      ...indexEntries,
      { id: labelhash(missed), expiry: missedExpiry },
    ]);

    await expect(run(workDir, fromBlock)).rejects.toThrow(
      /reconciliation failed/,
    );

    const result = await run(workDir, fromBlock, { reportOnly: true });
    expect(result.claimable).toBe(3);
    expect(result.reserved).toBe(2);
    expect(result.missing).toEqual([labelhash(missed)]);
  });

  it("reports an entry on v2 that no v1 name accounts for", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha", "beta"]);

    // Drop one from the index: v2 holds it, but as far as the independent view of
    // v1 is concerned it was never a name.
    writeIndex(workDir, indexEntries.slice(0, 1));

    const result = await run(workDir, fromBlock, { reportOnly: true });

    expect(result.unexpected).toHaveLength(1);
    expect(result.unexpected[0]).toContain("beta");
    expect(result.unexpected[0]).toContain("not a v1 name");
  });

  it("reports an expiry that does not match the bonus-adjusted v1 expiry", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);

    // Claim a different v1 expiry than the one the name was seeded from.
    writeIndex(workDir, [
      { id: indexEntries[0].id, expiry: indexEntries[0].expiry + 12345n },
    ]);

    const result = await run(workDir, fromBlock, { reportOnly: true });

    expect(result.expiryMismatched).toHaveLength(1);
    expect(result.expiryMismatched[0]).toContain(indexEntries[0].id);
    expect(result.missing).toEqual([]);
  });

  it("applies the bonus period when computing the expected v2 expiry", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);
    writeIndex(workDir, indexEntries);

    // The default bonus differs from the one the names were seeded with, so every
    // expiry should now be judged wrong.
    const result = await run(workDir, fromBlock, {
      bonusPeriodDays: String(BONUS_PERIOD_DAYS + 1),
      reportOnly: true,
    });

    expect(result.expiryMismatched).toHaveLength(1);
    expect(result.expiryMismatched[0]).toContain(
      (indexEntries[0].expiry + BONUS_PERIOD_SECONDS + 86400n).toString(),
    );
  });

  it("refuses a CSV produced by the same indexer as the index", async () => {
    const { workDir, csvFile, indexEntries, fromBlock } = await seed(["alpha"]);
    writeIndex(workDir, indexEntries);
    writeFileSync(
      `${csvFile}.source.json`,
      JSON.stringify({ source: "subgraph", network: "mainnet" }),
      "utf-8",
    );

    await expect(run(workDir, fromBlock, { csvFile })).rejects.toThrow(
      /refusing to reconcile/,
    );
  });

  it("compares live counts across the two sources as a cheap tripwire", async () => {
    const { workDir, csvFile, indexEntries, fromBlock } = await seed([
      "alpha",
      "beta",
    ]);
    writeIndex(workDir, indexEntries);

    const result = await run(workDir, fromBlock, { csvFile, reportOnly: true });

    // Both views agree, which is the signal worth having: a disagreement means one
    // of the two indexers is wrong and it is far cheaper to learn that before the
    // freeze than after it.
    expect(result.crossSource).toEqual({ csv: 2, index: 2 });
  });

  it("fails when the two sources disagree on how many names are live", async () => {
    const { workDir, csvFile, indexEntries, fromBlock } = await seed([
      "alpha",
      "beta",
    ]);
    // The counts are only comparable when the CSV carries expiries, so this one does.
    writeDatedCsv(csvFile, ["alpha", "beta"], indexEntries);
    // An index holding one of the two names, as a lagging indexer would produce.
    // Both sources are internally consistent, so nothing but the counts reports that
    // a name went unexamined.
    writeIndex(workDir, indexEntries.slice(0, 1));

    await expect(run(workDir, fromBlock, { csvFile })).rejects.toThrow(
      /disagree on how many names are live/,
    );
  });

  it("accepts a disagreement inside an explicit tolerance", async () => {
    const { workDir, csvFile, indexEntries, fromBlock } = await seed([
      "alpha",
      "beta",
    ]);
    writeDatedCsv(csvFile, ["alpha", "beta"], indexEntries);
    writeIndex(workDir, indexEntries.slice(0, 1));

    // `reportOnly` because the short index also leaves the reverse pass with a
    // complaint of its own; the tolerance is what this test is about.
    const result = await run(workDir, fromBlock, {
      csvFile,
      crossSourceTolerance: "1",
      reportOnly: true,
    });

    expect(result.crossSource).toEqual({ csv: 2, index: 1 });
  });

  it("counts names whose CANNOT_TRANSFER fuse blocks the transfer path", async () => {
    const { workDir, csvFile, indexEntries, fromBlock } = await seed([
      "alpha",
      "beta",
    ]);
    writeIndex(workDir, indexEntries);

    // Wrap `beta` with CANNOT_TRANSFER burned. It stays reservable on v2 but its
    // owner can never hand the token to a migration controller, so it is counted as
    // unmigratable. Asserting a non-zero figure is the point: reading the wrong
    // storage key returns empty records and reports zero however many exist.
    const { user } = env.namedAccounts;
    await env.v1.BaseRegistrar.write.safeTransferFrom(
      [
        user.address,
        env.v1.NameWrapper.address,
        idFromLabel("beta"),
        encodeAbiParameters(
          [
            { name: "label", type: "string" },
            { name: "owner", type: "address" },
            { name: "fuses", type: "uint16" },
            { name: "resolver", type: "address" },
          ],
          [
            "beta",
            user.address,
            FUSES.CANNOT_UNWRAP | FUSES.CANNOT_TRANSFER,
            zeroAddress,
          ],
        ),
      ],
      { account: user },
    );

    const result = await run(workDir, fromBlock, {
      csvFile,
      reportOnly: true,
      checkFuses: true,
      v1DeploymentsDir,
      v1DeploymentNetwork: "mainnet",
    });

    expect(result.unmigratableCannotTransfer).toBe(1);
  });

  it("refuses the fuse scan without labels rather than reporting a false zero", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);
    writeIndex(workDir, indexEntries);

    // NameWrapper is keyed by namehash, which needs the plaintext label. Without a
    // CSV the scan would read empty records and report zero regardless of reality.
    await expect(
      run(workDir, fromBlock, {
        reportOnly: true,
        checkFuses: true,
        v1DeploymentsDir,
        v1DeploymentNetwork: "mainnet",
      }),
    ).rejects.toThrow(/--check-fuses needs --csv-file/);
  });

  it("reconciles a name whose bonus-adjusted expiry hits the uint64 cap", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);

    // Pre-migration caps the stored expiry at uint64 max, so reconciliation has to
    // expect the capped value too — otherwise every such name is a permanent
    // mismatch and the phase 3 gate can never open.
    writeIndex(workDir, [{ id: indexEntries[0].id, expiry: MAX_UINT64 - 10n }]);

    const result = await run(workDir, fromBlock, { reportOnly: true });
    expect(result.expiryMismatched).not.toContain(
      expect.stringContaining("expected=" + (MAX_UINT64 + 1n).toString()),
    );
  });

  it("leaves the fuse count unset unless asked, since it is a per-name read", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);
    writeIndex(workDir, indexEntries);

    const result = await run(workDir, fromBlock, { reportOnly: true });

    expect(result.unmigratableCannotTransfer).toBeNull();
  });

  it("records a pass, which is what gates the irreversible v1 freeze", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);
    writeIndex(workDir, indexEntries);

    const gateDir = mkdtempSync(join(tmpdir(), "reconcile-gate-"));
    mkdirSync(join(gateDir, "mainnet"), { recursive: true });

    expect(
      readVerification(gateDir, "mainnet", "premigration-reconcile"),
    ).toBeNull();

    await run(workDir, fromBlock, {
      deploymentsDir: gateDir,
      deploymentNetwork: "mainnet",
    });

    // Phase 3 reads this record before freezing v1. Freezing without it strands any
    // name pre-migration missed, and nothing can pick it up afterwards.
    const recorded = readVerification(
      gateDir,
      "mainnet",
      "premigration-reconcile",
    );
    expect(recorded).not.toBeNull();
    expect(recorded?.chainId).toBe(1);
    expect(BigInt(recorded!.blockNumber)).toBeGreaterThan(0n);
  });

  it("revokes an earlier pass when a later reconciliation fails", async () => {
    const gateDir = mkdtempSync(join(tmpdir(), "reconcile-gate-revoke-"));
    mkdirSync(join(gateDir, "mainnet"), { recursive: true });

    // First: a clean reconciliation records a pass.
    const clean = await seed(["alpha"]);
    writeIndex(clean.workDir, clean.indexEntries);
    await run(clean.workDir, clean.fromBlock, {
      deploymentsDir: gateDir,
      deploymentNetwork: "mainnet",
    });
    expect(
      readVerification(gateDir, "mainnet", "premigration-reconcile"),
    ).not.toBeNull();

    // Then a reconciliation that finds a missing name must revoke it, not merely
    // decline to renew it — otherwise phase 3 reads the stale success and permits
    // the irreversible freeze on evidence the latest run contradicts.
    writeIndex(clean.workDir, [
      ...clean.indexEntries,
      { id: labelhash("neverseeded"), expiry: clean.indexEntries[0].expiry },
    ]);
    await run(clean.workDir, clean.fromBlock, {
      deploymentsDir: gateDir,
      deploymentNetwork: "mainnet",
      reportOnly: true,
    });

    expect(
      readVerification(gateDir, "mainnet", "premigration-reconcile"),
    ).toBeNull();
  });

  it("records nothing when the reconciliation finds problems", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha", "beta"]);
    // Drop one, so a claimable name is missing from v2.
    writeIndex(workDir, indexEntries.slice(0, 1));

    const gateDir = mkdtempSync(join(tmpdir(), "reconcile-gate-fail-"));
    mkdirSync(join(gateDir, "mainnet"), { recursive: true });

    await run(workDir, fromBlock, {
      deploymentsDir: gateDir,
      deploymentNetwork: "mainnet",
      reportOnly: true,
    });

    // A reconciliation that found discrepancies must not unlock the freeze.
    expect(
      readVerification(gateDir, "mainnet", "premigration-reconcile"),
    ).toBeNull();
  });

  it("refuses an incomplete index rather than under-reporting", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);
    writeIndex(workDir, indexEntries, { complete: false });

    await expect(run(workDir, fromBlock)).rejects.toThrow(/incomplete/);
  });

  it("ignores v1 names that have passed grace", async () => {
    const { workDir, indexEntries, fromBlock } = await seed(["alpha"]);

    // A name whose registration lapsed long ago is no longer its owner's to claim,
    // so it must not be counted against v2.
    writeIndex(workDir, [
      ...indexEntries,
      { id: labelhash("ancient"), expiry: 1n },
    ]);

    const result = await run(workDir, fromBlock, { reportOnly: true });

    expect(result.claimable).toBe(1);
    expect(result.missing).toEqual([]);
  });
});
