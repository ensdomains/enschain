import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { NewTaskActionFunction } from "hardhat/types/tasks";
import {
  createPublicClient,
  custom,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  getAddress,
  namehash,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import { Artifact_PermissionedRegistry } from "generated/artifacts/PermissionedRegistry.js";
import { Artifact_UniversalResolverV2 } from "generated/artifacts/UniversalResolverV2.js";
import { Artifact_UpgradableUniversalResolverProxy } from "generated/artifacts/UpgradableUniversalResolverProxy.js";
import {
  DEPLOYED_UNIVERSAL_RESOLVER_PROXY,
  ROLES,
} from "../../../script/deploy-constants.js";
import { dnsEncodeName } from "../../../script/migrations/plumbing.js";

type VerifyAllTaskArgs = {
  migrationNetwork: string;
  deploymentNetwork: string;
  deploymentsDir: string;
  names: string;
  topUrp: string;
};

type Deployment = {
  address: Address;
};

const REGISTRAR_ROLES = ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW;
const addrAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
]);
// The renewer names the v1 registrar it drives, so the pair can be checked without
// the v1 deployment artifacts this task does not otherwise read.
const renewerAbi = parseAbi([
  "function BASE_REGISTRAR() view returns (address)",
]);
const v1RegistrarAbi = parseAbi([
  "function owner() view returns (address)",
  "function controllers(address) view returns (bool)",
]);

async function loadDeployment(
  deploymentsDir: string,
  deploymentNetwork: string,
  name: string,
): Promise<Deployment> {
  const path = resolve(deploymentsDir, deploymentNetwork, `${name}.json`);
  const deployment = JSON.parse(await readFile(path, "utf8")) as Deployment;
  if (!deployment.address)
    throw new Error(`deployment missing address: ${path}`);
  return deployment;
}

function expectAddress(label: string, actual: Address, expected: Address) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`ok: ${label} = ${actual}`);
}

function expectAddressOneOf(
  label: string,
  actual: Address,
  expected: Array<{ label: string; address: Address }>,
) {
  const actualAddress = getAddress(actual);
  const match = expected.find(
    ({ address }) => actualAddress === getAddress(address),
  );
  if (!match) {
    const expectedLabels = expected
      .map(({ label, address }) => `${label} ${address}`)
      .join(", ");
    throw new Error(
      `${label}: expected one of ${expectedLabels}, got ${actual}`,
    );
  }
  console.log(`ok: ${label} = ${actual} (${match.label})`);
  return match.label;
}

function expectBoolean(label: string, actual: boolean, expected: boolean) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`ok: ${label} = ${actual}`);
}

const action: NewTaskActionFunction<VerifyAllTaskArgs> = async (args, hre) => {
  const deploymentNetwork = args.deploymentNetwork || args.migrationNetwork;
  const connection = await hre.network.connect();
  try {
    const chainId = Number(
      await connection.provider.request({ method: "eth_chainId" }),
    );
    const client = createPublicClient({
      chain: defineChain({
        id: chainId,
        name: connection.networkName,
        nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
        rpcUrls: { default: { http: [] } },
      }),
      transport: custom(connection.provider),
    });

    const rootRegistry = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "RootRegistry",
    );
    const ethRegistry = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "ETHRegistry",
    );
    const ethRegistrar = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "ETHRegistrar",
    );
    const batchRegistrar = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "BatchRegistrar",
    );
    const universalResolverV2 = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "UniversalResolverV2",
    );
    const topUrp = (args.topUrp ||
      DEPLOYED_UNIVERSAL_RESOLVER_PROXY) as Address;
    const managedUrp = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "ManagedUniversalResolverProxy",
    );

    const rootEthSubregistry = (await client.readContract({
      address: rootRegistry.address,
      abi: Artifact_PermissionedRegistry.abi,
      functionName: "getSubregistry",
      args: ["eth"],
    })) as Address;
    expectAddress(
      "RootRegistry .eth subregistry",
      rootEthSubregistry,
      ethRegistry.address,
    );

    const [parent, label] = (await client.readContract({
      address: ethRegistry.address,
      abi: Artifact_PermissionedRegistry.abi,
      functionName: "getParent",
    })) as [Address, string];
    expectAddress("ETHRegistry parent", parent, rootRegistry.address);
    if (label !== "eth")
      throw new Error(`ETHRegistry parent label: expected eth, got ${label}`);
    console.log(`ok: ETHRegistry parent label = ${label}`);

    const topImplementation = (await client.readContract({
      address: topUrp,
      abi: Artifact_UpgradableUniversalResolverProxy.abi,
      functionName: "implementation",
    })) as Address;

    const managedImplementation = (await client.readContract({
      address: managedUrp.address,
      abi: Artifact_UpgradableUniversalResolverProxy.abi,
      functionName: "implementation",
    })) as Address;
    expectAddress(
      "managed URP implementation",
      managedImplementation,
      universalResolverV2.address,
    );
    expectAddressOneOf("deployed URP implementation", topImplementation, [
      { label: "managed-hop state", address: managedUrp.address },
      {
        label: "direct implementation state",
        address: universalResolverV2.address,
      },
    ]);

    const batchRegistrarEnabled = (await client.readContract({
      address: ethRegistry.address,
      abi: Artifact_PermissionedRegistry.abi,
      functionName: "hasRootRoles",
      args: [REGISTRAR_ROLES, batchRegistrar.address],
    })) as boolean;
    expectBoolean(
      "BatchRegistrar registrar roles",
      batchRegistrarEnabled,
      false,
    );

    const ethRegistrarEnabled = (await client.readContract({
      address: ethRegistry.address,
      abi: Artifact_PermissionedRegistry.abi,
      functionName: "hasRootRoles",
      args: [REGISTRAR_ROLES, ethRegistrar.address],
    })) as boolean;
    expectBoolean("ETHRegistrar registrar roles", ethRegistrarEnabled, true);

    // A renewal through ETHRenewerV1 syncs the NameWrapper expiry through the
    // owner-gated addController, so the controller grant alone does not make an
    // unmigrated name renewable — the renewer has to own the registrar too.
    const ethRenewerV1 = await loadDeployment(
      args.deploymentsDir,
      deploymentNetwork,
      "ETHRenewerV1",
    );
    const v1BaseRegistrar = (await client.readContract({
      address: ethRenewerV1.address,
      abi: renewerAbi,
      functionName: "BASE_REGISTRAR",
    })) as Address;
    const renewerIsController = (await client.readContract({
      address: v1BaseRegistrar,
      abi: v1RegistrarAbi,
      functionName: "controllers",
      args: [ethRenewerV1.address],
    })) as boolean;
    expectBoolean(
      "ETHRenewerV1 v1 registrar controller",
      renewerIsController,
      true,
    );
    const v1RegistrarOwner = (await client.readContract({
      address: v1BaseRegistrar,
      abi: v1RegistrarAbi,
      functionName: "owner",
    })) as Address;
    expectAddress(
      "v1 BaseRegistrar owner",
      v1RegistrarOwner,
      ethRenewerV1.address,
    );

    const names = args.names
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of names) {
      const call = encodeFunctionData({
        abi: addrAbi,
        functionName: "addr",
        args: [namehash(name)],
      });
      const [result, resolver] = (await client.readContract({
        address: topUrp,
        abi: Artifact_UniversalResolverV2.abi,
        functionName: "resolve",
        args: [dnsEncodeName(name), call],
      })) as [Hex, Address];
      const address = decodeFunctionResult({
        abi: addrAbi,
        functionName: "addr",
        data: result,
      }) as Address;
      if (getAddress(address) === getAddress(zeroAddress)) {
        throw new Error(
          `${name} resolved to zero address via resolver ${resolver}`,
        );
      }
      console.log(`ok: ${name} resolves to ${address} via ${resolver}`);
    }

    console.log("verify-all passed");
  } finally {
    await connection.close();
  }
};

export default action;
