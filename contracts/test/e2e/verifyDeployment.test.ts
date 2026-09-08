import { describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyDeployment } from "../../script/migrate.js";

const NAMESPACE = "mainnet";

// Contracts with real runtime bytecode in the devnet's records, so the comparison
// has something to check rather than skipping everything.
const CONTRACTS = [
  "ETHRegistry",
  "RootRegistry",
  "ETHRegistrar",
  "BatchRegistrar",
] as const;

describe("deployment integrity", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  setupEnv({ resetOnEach: true });

  function writeNamespace(): string {
    const dir = mkdtempSync(join(tmpdir(), "verify-deployment-"));
    const namespaceDir = join(dir, NAMESPACE);
    mkdirSync(namespaceDir, { recursive: true });
    for (const name of CONTRACTS) {
      const deployment = env.rocketh.deployments[name];
      if (!deployment) continue;
      writeFileSync(
        join(namespaceDir, `${name}.json`),
        JSON.stringify(deployment, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
    }
    return dir;
  }

  function verify(deploymentsDir: string, overrides = {}) {
    return verifyDeployment({
      network: "mainnet",
      rpcUrl: `http://${env.hostPort}`,
      chainId: "1",
      deploymentsDir,
      deploymentNetwork: NAMESPACE,
      ...overrides,
    });
  }

  it("passes when every record names the contract actually at its address", async () => {
    const dir = writeNamespace();
    try {
      const result = await verify(dir);
      // Immutables are masked, so contracts with constructor-set immutables — which
      // most of these have — still compare equal.
      expect(result.matched).toBeGreaterThan(0);
      expect(result.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("catches a record pointing at a different contract, as a leaked archive address would", async () => {
    const dir = writeNamespace();
    try {
      // Point ETHRegistry at ETHRegistrar's address. Both are real, deployed, and
      // answer calls — the record is simply wrong, which no liveness probe sees.
      const path = join(dir, NAMESPACE, "ETHRegistry.json");
      const record = JSON.parse(readFileSync(path, "utf8"));
      record.address = env.rocketh.deployments.ETHRegistrar.address;
      writeFileSync(path, JSON.stringify(record));

      await expect(verify(dir)).rejects.toThrow(
        /deployment verification failed/,
      );

      const result = await verify(dir, { reportOnly: true });
      expect(result.problems.some((p) => p.includes("ETHRegistry"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("catches a record pointing at an address with no code at all", async () => {
    const dir = writeNamespace();
    try {
      const path = join(dir, NAMESPACE, "ETHRegistry.json");
      const record = JSON.parse(readFileSync(path, "utf8"));
      record.address = "0x000000000000000000000000000000000000dEaD";
      writeFileSync(path, JSON.stringify(record));

      const result = await verify(dir, { reportOnly: true });
      expect(
        result.problems.some((p) => p.includes("no code at address")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses an empty or missing namespace rather than reporting success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-deployment-empty-"));
    try {
      await expect(verify(dir)).rejects.toThrow(/no deployment namespace/);

      mkdirSync(join(dir, NAMESPACE), { recursive: true });
      await expect(verify(dir)).rejects.toThrow(/no deployment records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
