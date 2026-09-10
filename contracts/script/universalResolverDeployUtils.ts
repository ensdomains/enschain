import type { ExecutionArgs, ReadFunction } from "@rocketh/read-execute";
import type { Deployment } from "rocketh/types";
import {
  type Abi,
  type Address,
  type ContractFunctionName,
  encodeFunctionData,
  getAddress,
} from "viem";
import { Artifact_UpgradableUniversalResolverProxy } from "generated/artifacts/UpgradableUniversalResolverProxy.js";
import {
  DEPLOYED_UNIVERSAL_RESOLVER_PROXY,
  KNOWN_INTERMEDIATE_URP,
} from "./deploy-constants.js";

export const TOP_URP_CREATE3_SALT =
  "0xdeac7148fb7f566f1fc8c8d6720530de8809f3658cf10141ceee7ba0d45eef85" as const;

const KNOWN_TOP_PROXY_NETWORKS = new Set(["holesky", "mainnet", "sepolia"]);

export type UpgradableUniversalResolverProxyDeployment = Deployment<
  (typeof Artifact_UpgradableUniversalResolverProxy)["abi"]
>;

export async function loadKnownTopProxyDeployment(
  networkName: string,
): Promise<UpgradableUniversalResolverProxyDeployment | null> {
  if (!KNOWN_TOP_PROXY_NETWORKS.has(networkName)) {
    return null;
  }
  return {
    address: DEPLOYED_UNIVERSAL_RESOLVER_PROXY,
    argsData: "0x",
    ...Artifact_UpgradableUniversalResolverProxy,
  } as UpgradableUniversalResolverProxyDeployment;
}

export async function loadKnownIntermediateUrpDeployment(
  networkName: string,
): Promise<UpgradableUniversalResolverProxyDeployment | null> {
  const address = KNOWN_INTERMEDIATE_URP[networkName];
  if (!address) {
    return null;
  }
  return {
    address,
    argsData: "0x",
    ...Artifact_UpgradableUniversalResolverProxy,
  } as UpgradableUniversalResolverProxyDeployment;
}

export function isDeployedTopProxy(
  deployment: UpgradableUniversalResolverProxyDeployment,
): boolean {
  return (
    getAddress(deployment.address) ===
    getAddress(DEPLOYED_UNIVERSAL_RESOLVER_PROXY)
  );
}

export function logUpgradeCalldata(
  label: string,
  target: Address,
  implementation: Address,
  ownerLabel = "DAO",
) {
  const calldata = encodeFunctionData({
    abi: Artifact_UpgradableUniversalResolverProxy.abi,
    functionName: "upgradeTo",
    args: [implementation],
  });
  console.log(`${label} requires a ${ownerLabel} transaction`);
  console.log(`  target: ${target}`);
  console.log(`  calldata: ${calldata}`);
}

export function externalTopProxyOwnerLabel(tags: Record<string, unknown>) {
  return tags.hasDao ? "DAO" : tags.sepolia ? "top URP owner" : undefined;
}

// Normalizes a deploy environment to the network key used by the known-proxy
// lookups, collapsing tag-aliased environments (e.g. dev variants) onto their
// base network and otherwise falling back to the environment name.
export function knownProxyNetworkName(
  tags: Record<string, unknown>,
  name: string,
): string {
  return tags.sepolia ? "sepolia" : tags.hasDao ? "mainnet" : name;
}

// matches the bound `execute` deploy-script extension (see rocketh/config.ts);
// the return type is widened to `unknown` because the custom `execute` override
// returns a receipt rather than the EIP1193DATA of rocketh's ExecuteFunction
type WriteFunction = <
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
>(
  deployment: Deployment<TAbi>,
  args: ExecutionArgs<TAbi, TFunctionName>,
) => Promise<unknown>;

export async function setProxyImplementationIfNeeded({
  read,
  write,
  deployment,
  implementation,
  account,
  label,
}: {
  read: ReadFunction;
  write: WriteFunction;
  deployment: UpgradableUniversalResolverProxyDeployment;
  implementation: Address;
  account: string;
  label: string;
}) {
  const currentImplementation = await read(deployment, {
    functionName: "implementation",
  });
  if (getAddress(currentImplementation) === getAddress(implementation)) {
    console.log(`${label}: already ${implementation}`);
    return;
  }

  console.log(`${label}: ${currentImplementation} -> ${implementation}`);
  await write(deployment, {
    functionName: "upgradeTo",
    args: [implementation],
    account,
  });
}
