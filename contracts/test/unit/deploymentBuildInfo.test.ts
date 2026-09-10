import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setupEnvironmentFromFiles } from "@rocketh/node";
import type { UserConfig } from "rocketh/types";

const CHAIN_ID = 31337;
const ENVIRONMENT = "sepolia";
const ADDRESS = "0x0000000000000000000000000000000000000001";
const TRANSACTION_HASH = `0x${"1".repeat(64)}` as `0x${string}`;
const BLOCK_HASH = `0x${"2".repeat(64)}` as `0x${string}`;
const GAS_ESTIMATES = { external: { "example()": "1" } } as const;

const { loadEnvironmentFromFilesWithConfig } = setupEnvironmentFromFiles({});

describe("deployment build info", () => {
  it("persists build info for direct and broadcast saves in the configured deployment root", async () => {
    const originalCwd = process.cwd();
    process.chdir(resolve(import.meta.dirname, "../.."));
    const tempRoot = mkdtempSync(join(tmpdir(), "rocketh-build-info-"));
    const deploymentsRoot = join(tempRoot, "deployments", "v1");
    const buildInfoId = `test-${basename(tempRoot)}`;
    const sourceBuildInfo = resolve(
      "artifacts",
      "build-info",
      `${buildInfoId}.json`,
    );
    const savedBuildInfo = join(
      deploymentsRoot,
      ENVIRONMENT,
      "build-info",
      `${buildInfoId}.json`,
    );
    const buildInfo = { id: buildInfoId, input: { settings: {} } };

    mkdirSync(dirname(sourceBuildInfo), { recursive: true });
    writeFileSync(sourceBuildInfo, JSON.stringify(buildInfo));

    try {
      const provider = {
        async request({ method }: { method: string }) {
          switch (method) {
            case "eth_chainId":
              return `0x${CHAIN_ID.toString(16)}`;
            case "eth_getBlockByNumber":
              return { hash: BLOCK_HASH };
            case "eth_accounts":
              return [];
            case "eth_sendRawTransaction":
              return TRANSACTION_HASH;
            case "eth_getTransactionByHash":
              return null;
            case "eth_getTransactionReceipt":
              return {
                blockHash: BLOCK_HASH,
                blockNumber: "0x1",
                contractAddress: ADDRESS,
                cumulativeGasUsed: "0x1",
                from: ADDRESS,
                gasUsed: "0x1",
                logs: [],
                logsBloom: `0x${"0".repeat(512)}`,
                status: "0x1",
                to: null,
                transactionHash: TRANSACTION_HASH,
                transactionIndex: "0x0",
                type: "0x2",
              };
            default:
              throw new Error(`unexpected RPC method: ${method}`);
          }
        },
      };
      const config = {
        deployments: deploymentsRoot,
        chains: {
          [CHAIN_ID]: {
            info: {
              id: CHAIN_ID,
              name: "Test",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: { default: { http: ["http://localhost"] } },
            },
            pollingInterval: 0.001,
          },
        },
        environments: {
          [ENVIRONMENT]: { chain: CHAIN_ID },
        },
      } as const satisfies UserConfig;
      const env = await loadEnvironmentFromFilesWithConfig(
        {
          environment: ENVIRONMENT,
          provider: provider as never,
          saveDeployments: true,
        },
        config,
      );
      const artifact = {
        abi: [] as const,
        bytecode: "0x00" as const,
        metadata: "{}",
        buildInfoId,
        evm: {
          gasEstimates: GAS_ESTIMATES,
          bytecode: { opcodes: "PUSH0 STOP" },
        },
      };

      await env.save("DirectSave", {
        ...artifact,
        address: ADDRESS,
      } as never);
      await waitForFile(join(deploymentsRoot, ENVIRONMENT, "DirectSave.json"));
      expectDeploymentFile(deploymentsRoot, "DirectSave", buildInfoId);
      expect(JSON.parse(readFileSync(savedBuildInfo, "utf8"))).toEqual(
        buildInfo,
      );

      rmSync(savedBuildInfo);
      await env.broadcastDeployment(
        "BroadcastSave",
        { type: "raw", from: ADDRESS, raw: "0x00" },
        {
          ...artifact,
          argsData: "0x",
        },
        { expectedAddress: ADDRESS },
      );
      await waitForFile(
        join(deploymentsRoot, ENVIRONMENT, "BroadcastSave.json"),
      );
      expectDeploymentFile(deploymentsRoot, "BroadcastSave", buildInfoId);
      expect(existsSync(savedBuildInfo)).toBe(true);
    } finally {
      rmSync(sourceBuildInfo, { force: true });
      rmSync(tempRoot, { recursive: true, force: true });
      process.chdir(originalCwd);
    }
  });
});

function expectDeploymentFile(
  deploymentsRoot: string,
  name: string,
  buildInfoId: string,
) {
  const deployment = JSON.parse(
    readFileSync(join(deploymentsRoot, ENVIRONMENT, `${name}.json`), "utf8"),
  );
  expect(deployment.buildInfoId).toBe(buildInfoId);
  expect(deployment.evm).toEqual({ gasEstimates: GAS_ESTIMATES });
}

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (existsSync(file)) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${file}`);
}
