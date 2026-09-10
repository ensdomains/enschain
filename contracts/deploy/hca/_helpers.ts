import { getAddress, isAddress, type Address } from "viem";

import { RHINESTONE_INTENT_EXECUTOR } from "../../script/deploy-constants.js";

export const DEFAULT_ENTRY_POINT =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

export function isHCAOnlyDeployment(tags?: readonly string[]) {
  return tags?.length === 1 && tags[0] === "hca";
}

export const SUPERSEDED_CONTROLLER_ADDRESSES = "supersededControllerAddresses";

type DeploymentLike = {
  address: Address;
  linkedData?: Record<string, unknown>;
};

export function controllerAddressHistory(
  deployments: readonly (DeploymentLike | null | undefined)[],
): Address[] {
  return [
    ...new Set(
      deployments.flatMap((deployment) => {
        if (!deployment) return [];
        const linkedHistory =
          deployment.linkedData?.[SUPERSEDED_CONTROLLER_ADDRESSES];
        if (linkedHistory === undefined) {
          return [getAddress(deployment.address)];
        }
        if (
          !Array.isArray(linkedHistory) ||
          linkedHistory.some(
            (address) => typeof address !== "string" || !isAddress(address),
          )
        ) {
          throw new Error(
            `invalid ${SUPERSEDED_CONTROLLER_ADDRESSES} deployment metadata`,
          );
        }
        return [
          getAddress(deployment.address),
          ...linkedHistory.map((address) => getAddress(address)),
        ];
      }),
    ),
  ];
}

export function replacedDeploymentAddresses(
  deployment: DeploymentLike,
  previousDeployments: readonly (DeploymentLike | null | undefined)[],
): Address[] {
  const deployedAddress = getAddress(deployment.address);
  return controllerAddressHistory(previousDeployments).filter(
    (previousAddress) => previousAddress !== deployedAddress,
  );
}

type HCAAddressResolutionOptions = {
  tags: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
};

function usesMockHCAInfrastructure(tags: Record<string, unknown>) {
  return Boolean(tags.local || tags.test || tags["clean-testnet"]);
}

function usesSepoliaHCAProductionDefaults(tags: Record<string, unknown>) {
  return Boolean(tags.sepolia && !usesMockHCAInfrastructure(tags));
}

export function shouldDeployStandaloneHCA(tags: Record<string, unknown>) {
  return Boolean(
    tags.hca || tags.local || tags.dev || tags.test || tags["clean-testnet"],
  );
}

export function shouldDeployMockIntentExecutor(tags: Record<string, unknown>) {
  return usesMockHCAInfrastructure(tags);
}

export function resolveHCAIntentExecutor({
  tags,
  localExecutor,
  existingExecutor,
  env = process.env,
}: HCAAddressResolutionOptions & {
  localExecutor?: Address;
  existingExecutor?: Address;
}): Address | undefined {
  return (
    optionalEnvAddress("HCA_INTENT_EXECUTOR", env.HCA_INTENT_EXECUTOR) ??
    (usesSepoliaHCAProductionDefaults(tags)
      ? RHINESTONE_INTENT_EXECUTOR
      : undefined) ??
    localExecutor ??
    existingExecutor
  );
}

export function optionalEnvAddress(
  name: string,
  value = process.env[name],
): Address | undefined {
  if (!value) return undefined;
  if (!isAddress(value)) {
    throw new Error(`${name} is not a valid address`);
  }
  return value as Address;
}
