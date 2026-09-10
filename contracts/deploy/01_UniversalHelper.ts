import { execute } from "@rocketh";
import type { Abi_PermissionedRegistry } from "generated/abis/PermissionedRegistry.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_UniversalHelper } from "generated/artifacts/UniversalHelper.js";

export default execute(
  async ({ get, deploy, namedAccounts: { deployer } }) => {
    const rootRegistry = get<Abi_PermissionedRegistry>("RootRegistry");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("UniversalHelper", {
      account: deployer,
      artifact: Artifact_UniversalHelper,
      args: [rootRegistry.address, contractNamer.address],
    });
  },
  {
    tags: ["UniversalHelper", "v2", "migration:phase1:deploy-v2"],
    dependencies: ["RootRegistry", "ContractNamer"],
  },
);
