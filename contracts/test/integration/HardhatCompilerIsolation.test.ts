import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Artifact = {
  buildInfoId: string;
  contractName: string;
  deployedBytecode: string;
  sourceName: string;
};

type BuildInfo = {
  solcLongVersion: string;
  solcVersion: string;
  input: {
    settings: {
      evmVersion: string;
      optimizer: {
        enabled: boolean;
        runs: number;
      };
      viaIR?: boolean;
    };
  };
};

type CompilerProfile = {
  evmVersion: string;
  optimizerRuns: number;
  solcLongVersion: string;
  solcVersion: string;
};

const contractsDir = resolve(import.meta.dirname, "../..");
const protocolProfile: CompilerProfile = {
  solcVersion: "0.8.25",
  solcLongVersion: "0.8.25+commit.b61c2a91",
  evmVersion: "cancun",
  optimizerRuns: 1000,
};
const hcaProfile: CompilerProfile = {
  solcVersion: "0.8.27",
  solcLongVersion: "0.8.27+commit.40a35a09",
  evmVersion: "cancun",
  optimizerRuns: 1000,
};
const hcaHotRuntimeProfile: CompilerProfile = {
  ...hcaProfile,
  optimizerRuns: 23_000,
};
const wrapperRegistryProfile: CompilerProfile = {
  solcVersion: "0.8.25",
  solcLongVersion: "0.8.25+commit.b61c2a91",
  evmVersion: "cancun",
  optimizerRuns: 100,
};
const nameWrapperProfile: CompilerProfile = {
  solcVersion: "0.8.17",
  solcLongVersion: "0.8.17+commit.8df45f5f",
  evmVersion: "london",
  optimizerRuns: 1200,
};
const hcaSources = new Set([
  "src/hca/HCAValidatorBase.sol",
  "src/hca/HCAFundingSessionValidator.sol",
  "src/hca/HCAOwnerAndSessionValidator.sol",
  "src/hca/StandaloneHCAFactory.sol",
  "src/hca/StandaloneSingleOwnerHCA.sol",
  "src/hca/libraries/HCAExecutionLib.sol",
  "src/hca/libraries/HCAOperationHashLib.sol",
  "src/hca/libraries/HCAPermit2Lib.sol",
  "src/hca/libraries/HCARegistrarPolicyLib.sol",
  "src/hca/libraries/HCAResolverPolicyLib.sol",
  "src/hca/libraries/HCASignatureLib.sol",
  "src/hca/libraries/HCASmartSessionLib.sol",
]);
const externalDeploymentSources = [
  "lib/ens-contracts/contracts/ccipRead/GatewayProvider.sol",
  "lib/ens-contracts/contracts/dnsregistrar/OffchainDNSResolver.sol",
  "lib/ens-contracts/contracts/dnsregistrar/SimplePublicSuffixList.sol",
  "lib/ens-contracts/contracts/dnssec-oracle/DNSSECImpl.sol",
  "lib/ens-contracts/contracts/ethregistrar/BaseRegistrarImplementation.sol",
  "lib/ens-contracts/contracts/ethregistrar/RegistrarSecurityController.sol",
  "lib/ens-contracts/contracts/registry/ENSRegistry.sol",
  "lib/ens-contracts/contracts/resolvers/OwnedResolver.sol",
  "lib/ens-contracts/contracts/resolvers/PublicResolver.sol",
  "lib/ens-contracts/contracts/reverseRegistrar/DefaultReverseRegistrar.sol",
  "lib/ens-contracts/contracts/reverseRegistrar/ReverseRegistrar.sol",
  "lib/ens-contracts/contracts/reverseResolver/DefaultReverseResolver.sol",
  "lib/ens-contracts/contracts/root/Root.sol",
  "lib/ens-contracts/contracts/universalResolver/UniversalResolver.sol",
  "lib/ens-contracts/contracts/wrapper/NameWrapper.sol",
  "lib/verifiable-factory/src/VerifiableFactory.sol",
] as const;
const auxiliaryDeploymentSources = [
  ["test/mocks/MockERC20.sol", "MockERC20", protocolProfile],
  ["test/mocks/MockPremigrator.sol", "MockPremigrator", protocolProfile],
  [
    "test/mocks/MockRegistrationIntentExecutor.sol",
    "MockRegistrationIntentExecutor",
    hcaProfile,
  ],
] as const;

const buildInfoCache = new Map<string, BuildInfo>();

async function readArtifact(
  sourcePath: string,
  contractName: string,
): Promise<Artifact> {
  const path = resolve(
    contractsDir,
    "artifacts",
    sourcePath,
    `${contractName}.json`,
  );
  return JSON.parse(await readFile(path, "utf8")) as Artifact;
}

async function readBuildInfo(artifact: Artifact): Promise<BuildInfo> {
  const cached = buildInfoCache.get(artifact.buildInfoId);
  if (cached) return cached;

  const path = resolve(
    contractsDir,
    "artifacts",
    "build-info",
    `${artifact.buildInfoId}.json`,
  );
  const buildInfo = JSON.parse(await readFile(path, "utf8")) as BuildInfo;
  buildInfoCache.set(artifact.buildInfoId, buildInfo);
  return buildInfo;
}

async function readArtifactsRecursively(
  directory: string,
): Promise<Artifact[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const artifacts = await Promise.all(
    entries.map(async (entry): Promise<Artifact[]> => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return readArtifactsRecursively(path);
      if (!entry.name.endsWith(".json") || entry.name.endsWith(".dbg.json")) {
        return [];
      }
      return [JSON.parse(await readFile(path, "utf8")) as Artifact];
    }),
  );
  return artifacts.flat();
}

async function expectExactSourcePragma(
  sourceName: string,
  expectedVersion: string,
): Promise<void> {
  const source = await readFile(resolve(contractsDir, sourceName), "utf8");
  const pragma = source.match(/^pragma solidity ([^;]+);$/m)?.[1];
  expect(pragma, sourceName).toBe(expectedVersion);
}

function expectedFirstPartyProfile(sourceName: string): CompilerProfile {
  if (sourceName === "src/hca/HCAOwnerAndSessionValidator.sol") {
    return hcaHotRuntimeProfile;
  }
  if (hcaSources.has(sourceName)) return hcaProfile;
  if (sourceName === "src/registry/WrapperRegistry.sol") {
    return wrapperRegistryProfile;
  }
  return protocolProfile;
}

async function expectCompilerProfile(
  artifact: Artifact,
  expected: CompilerProfile,
): Promise<void> {
  const buildInfo = await readBuildInfo(artifact);
  const label = `${artifact.sourceName}:${artifact.contractName}`;

  expect(buildInfo.solcVersion, label).toBe(expected.solcVersion);
  expect(buildInfo.solcLongVersion, label).toBe(expected.solcLongVersion);
  expect(buildInfo.input.settings.evmVersion, label).toBe(expected.evmVersion);
  expect(buildInfo.input.settings.optimizer.enabled, label).toBe(true);
  expect(buildInfo.input.settings.optimizer.runs, label).toBe(
    expected.optimizerRuns,
  );
  expect(buildInfo.input.settings.viaIR ?? false, label).toBe(false);
}

describe("Hardhat compiler isolation", () => {
  it("exact-pins every deployable first-party source to its compiler", async () => {
    const artifacts = await readArtifactsRecursively(
      resolve(contractsDir, "artifacts", "src"),
    );
    const deployableSources = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.deployedBytecode === "0x") continue;
      const source = await readFile(
        resolve(contractsDir, artifact.sourceName),
        "utf8",
      );
      if (
        new RegExp(`^contract\\s+${artifact.contractName}\\b`, "m").test(source)
      ) {
        deployableSources.add(artifact.sourceName);
      }
    }
    expect(deployableSources.size).toBeGreaterThan(0);

    for (const sourceName of deployableSources) {
      await expectExactSourcePragma(
        sourceName,
        expectedFirstPartyProfile(sourceName).solcVersion,
      );
    }

    for (const [sourceName, , profile] of auxiliaryDeploymentSources) {
      await expectExactSourcePragma(sourceName, profile.solcVersion);
    }
  });

  it("pins every first-party production artifact to its compiler profile", async () => {
    const artifacts = await readArtifactsRecursively(
      resolve(contractsDir, "artifacts", "src"),
    );
    expect(artifacts.length).toBeGreaterThan(0);

    for (const artifact of artifacts) {
      await expectCompilerProfile(
        artifact,
        expectedFirstPartyProfile(artifact.sourceName),
      );
    }
  });

  it("pins externally sourced deployment roots to their compiler profiles", async () => {
    for (const sourcePath of externalDeploymentSources) {
      const contractName = sourcePath.slice(
        sourcePath.lastIndexOf("/") + 1,
        -".sol".length,
      );
      const artifact = await readArtifact(sourcePath, contractName);
      await expectCompilerProfile(
        artifact,
        sourcePath === "lib/ens-contracts/contracts/wrapper/NameWrapper.sol"
          ? nameWrapperProfile
          : protocolProfile,
      );
    }
  });

  it("pins auxiliary deployment roots to their compiler profiles", async () => {
    for (const [
      sourcePath,
      contractName,
      profile,
    ] of auxiliaryDeploymentSources) {
      await expectCompilerProfile(
        await readArtifact(sourcePath, contractName),
        profile,
      );
    }
  });

  it.skipIf(Boolean(process.env.COVERAGE))(
    "uses the HCA compiler without exceeding the deployment size limit",
    async () => {
      const hcaContracts = [
        [
          "src/hca/HCAFundingSessionValidator.sol",
          "HCAFundingSessionValidator",
        ],
        [
          "src/hca/HCAOwnerAndSessionValidator.sol",
          "HCAOwnerAndSessionValidator",
        ],
        ["src/hca/StandaloneHCAFactory.sol", "StandaloneHCAFactory"],
        ["src/hca/StandaloneSingleOwnerHCA.sol", "StandaloneSingleOwnerHCA"],
      ] as const;

      for (const [sourcePath, contractName] of hcaContracts) {
        const artifact = await readArtifact(sourcePath, contractName);
        const deployedSize = (artifact.deployedBytecode.length - 2) / 2;

        expect(deployedSize, contractName).toBeLessThanOrEqual(24_576);
      }
    },
  );
});
