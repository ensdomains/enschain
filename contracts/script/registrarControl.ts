import { getAddress, type Address } from "viem";

import type { JsonDeployment } from "./migrationFixture/types.js";

export type RegistrarControlRoute = {
  // Contract the owner-gated write targets, and whose owner() gates it.
  target: JsonDeployment;
  addFunctionName: string;
  removeFunctionName: string;
  transferFunctionName: string;
};

type ContractReader = {
  readContract(args: {
    address: Address;
    abi: readonly any[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
};

// The contract that currently drives the v1 BaseRegistrar's owner-gated entrypoints.
// The security controller is a pass-through that forwards to the registrar as its
// owner, so it only works while it still holds that ownership: once a migration has
// handed the registrar to a renewer, or a reclaim has returned it to the v1 owner,
// its calls revert. The route is therefore chosen from the registrar's live owner
// rather than from the presence of a security controller artifact.
export async function resolveRegistrarControlRoute(opts: {
  client: ContractReader;
  baseRegistrar: JsonDeployment;
  registrarSecurityController: JsonDeployment | null;
  owner?: Address;
}): Promise<RegistrarControlRoute> {
  const { baseRegistrar, registrarSecurityController } = opts;
  if (registrarSecurityController) {
    const owner =
      opts.owner ??
      ((await opts.client.readContract({
        address: baseRegistrar.address,
        abi: baseRegistrar.abi,
        functionName: "owner",
      })) as Address);
    if (getAddress(owner) === getAddress(registrarSecurityController.address)) {
      return {
        target: registrarSecurityController,
        addFunctionName: "addRegistrarController",
        removeFunctionName: "removeRegistrarController",
        transferFunctionName: "transferRegistrarOwnership",
      };
    }
  }
  return {
    target: baseRegistrar,
    addFunctionName: "addController",
    removeFunctionName: "removeController",
    transferFunctionName: "transferOwnership",
  };
}
