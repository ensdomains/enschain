import { describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroAddress } from "viem";

import { snapshotResolution, verifyResolution } from "../../script/migrate.js";
import type { ResolutionSnapshot } from "../../script/migrations/resolutionSnapshot.js";
import { idFromLabel } from "../utils/utils.js";

// The devnet gives each named contract an address record under `ens.eth`, so this
// name resolves to something. `ens.eth` itself carries no records: a snapshot of it
// compares equal to any other empty one, which is the tautology `verifyResolution`
// now refuses.
const NAME = "renewer.ens.eth";
const PARENT_LABEL = "ens";

describe("resolution snapshot", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  setupEnv({ resetOnEach: true });

  function paths() {
    const dir = mkdtempSync(join(tmpdir(), "resolution-"));
    return { outFile: join(dir, "resolution.json") };
  }

  function options() {
    return {
      network: "mainnet" as const,
      rpcUrl: `http://${env.hostPort}`,
      chainId: "1",
      universalResolver: env.v2.UniversalResolver.address,
    };
  }

  it("captures records and confirms they are unchanged when nothing moved", async () => {
    const { outFile } = paths();

    const snapshot = await snapshotResolution({
      ...options(),
      names: NAME,
      outFile,
    });

    expect(snapshot.names).toHaveLength(1);
    const records = snapshot.names[0].records;
    // Every captured axis is present, whether or not the name carries a value.
    expect(Object.keys(records)).toContain("addr");
    expect(Object.keys(records)).toContain("contenthash");
    expect(Object.keys(records)).toContain("addr(60)");
    expect(Object.keys(records)).toContain("text(url)");

    // The snapshot is on disk and round-trips.
    const onDisk = JSON.parse(
      readFileSync(outFile, "utf8"),
    ) as ResolutionSnapshot;
    expect(onDisk.names[0].name).toBe(NAME);

    // Re-reading immediately must find nothing changed.
    const differences = await verifyResolution({
      ...options(),
      snapshotFile: outFile,
    });
    expect(differences).toEqual([]);
  }, 120_000);

  it("re-asks the snapshot's own records, not the defaults", async () => {
    const { outFile } = paths();

    // Capture a deliberately non-default record set.
    const snapshot = await snapshotResolution({
      ...options(),
      names: NAME,
      outFile,
      coinTypes: "9999",
      textKeys: "custom.key",
    });
    expect(Object.keys(snapshot.names[0].records).sort()).toEqual([
      "addr",
      "addr(9999)",
      "contenthash",
      "text(custom.key)",
    ]);

    // Verification must ask these, not the defaults. Falling back would leave the
    // custom records absent from the post-cutover read, where they would look like
    // reverts and be reported as regressions that never happened.
    const differences = await verifyResolution({
      ...options(),
      snapshotFile: outFile,
    });
    expect(differences).toEqual([]);
  }, 120_000);

  it("fails when a record changes after the snapshot — what a liveness check misses", async () => {
    const { outFile } = paths();
    await snapshotResolution({ ...options(), names: NAME, outFile });

    // Break resolution the way a bad cutover would: the name still exists and
    // still resolves, but its answers are gone. A non-zero-address check would
    // not necessarily notice; a diff does.
    await env.v2.ETHRegistry.write.setResolver(
      [idFromLabel(PARENT_LABEL), zeroAddress],
      { account: env.namedAccounts.owner },
    );

    await expect(
      verifyResolution({ ...options(), snapshotFile: outFile }),
    ).rejects.toThrow(/resolution changed across the cutover/);

    const differences = await verifyResolution({
      ...options(),
      snapshotFile: outFile,
      reportOnly: true,
    });
    expect(differences.length).toBeGreaterThan(0);
    expect(differences[0].name).toBe(NAME);
  }, 120_000);
});
