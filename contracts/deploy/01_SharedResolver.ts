import { execute } from "@rocketh";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_SharedResolver } from "generated/artifacts/SharedResolver.js";

export default execute(
  async ({ deploy, get, namedAccounts: { deployer } }) => {
    const rootRegistry = get<Abi_IPermissionedRegistry>("RootRegistry");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("SharedResolver", {
      account: deployer,
      artifact: Artifact_SharedResolver,
      args: [rootRegistry.address, contractNamer.address],
    });
  },
  {
    tags: ["SharedResolver", "v2"],
    dependencies: ["RootRegistry", "ContractNamer"],
  },
);
