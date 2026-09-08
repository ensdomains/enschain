import { describe, expect, it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(120_000);

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, zeroAddress } from "viem";

import { verifyRegistrarEconomics } from "../../script/migrate.js";

const NAMESPACE = "mainnet";
const CONTRACTS = ["ETHRegistrar", "MockUSDC", "MockDAI"] as const;

describe("registrar economics", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  setupEnv({ resetOnEach: true });

  function writeNamespace(): string {
    const dir = mkdtempSync(join(tmpdir(), "registrar-economics-"));
    const namespaceDir = join(dir, NAMESPACE);
    mkdirSync(namespaceDir, { recursive: true });
    for (const name of CONTRACTS) {
      const deployment = env.rocketh.deployments[name];
      if (!deployment) continue;
      writeFileSync(
        join(namespaceDir, `${name}.json`),
        JSON.stringify({
          address: deployment.address,
          abi: deployment.abi,
        }),
      );
    }
    return dir;
  }

  function verify(deploymentsDir: string, overrides = {}) {
    return verifyRegistrarEconomics({
      network: "mainnet",
      rpcUrl: `http://${env.hostPort}`,
      chainId: "1",
      deploymentsDir,
      deploymentNetwork: NAMESPACE,
      ...overrides,
    });
  }

  it("confirms the oracle prices names in every accepted payment token", async () => {
    const dir = writeNamespace();
    try {
      const problems = await verify(dir, {
        paymentTokens: [
          env.rocketh.deployments.MockUSDC.address,
          env.rocketh.deployments.MockDAI.address,
        ].join(","),
      });
      expect(problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("catches a token the oracle does not accept, which would revert every registration", async () => {
    const dir = writeNamespace();
    try {
      // A real ERC-20 that was simply never whitelisted. Registration in it
      // reverts, and no wiring or role check would show why.
      await expect(
        verify(dir, {
          paymentTokens: "0x000000000000000000000000000000000000c0de",
        }),
      ).rejects.toThrow(/registrar economics verification failed/);

      const problems = await verify(dir, {
        paymentTokens: "0x000000000000000000000000000000000000c0de",
        reportOnly: true,
      });
      expect(problems.some((p) => p.includes("not accepted"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails a beneficiary that does not match the one expected", async () => {
    const dir = writeNamespace();
    try {
      const problems = await verify(dir, {
        paymentTokens: env.rocketh.deployments.MockUSDC.address,
        expectedBeneficiary: getAddress(
          "0x000000000000000000000000000000000000bEEF",
        ),
        reportOnly: true,
      });
      expect(problems.some((p) => p.includes("beneficiary is"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("passes when the beneficiary matches, so the assertion is not vacuous", async () => {
    const dir = writeNamespace();
    try {
      const registrar = env.rocketh.deployments.ETHRegistrar;
      const beneficiary = (await env.client.readContract({
        address: registrar.address,
        abi: registrar.abi,
        functionName: "BENEFICIARY",
      })) as `0x${string}`;
      expect(getAddress(beneficiary)).not.toBe(getAddress(zeroAddress));

      const problems = await verify(dir, {
        paymentTokens: env.rocketh.deployments.MockUSDC.address,
        expectedBeneficiary: beneficiary,
      });
      expect(problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
