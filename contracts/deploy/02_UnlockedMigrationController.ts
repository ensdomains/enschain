import { execute } from "@rocketh";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_Graveyard } from "generated/abis/Graveyard.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_UnlockedMigrationController } from "generated/artifacts/UnlockedMigrationController.js";
import { DEPLOYMENT_ROLES } from "../script/deploy-constants.js";

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    getV1,
    namedAccounts: { deployer },
  }) => {
    const nameWrapper = await getV1<Abi_INameWrapper>("NameWrapper");
    const graveyard = get<Abi_Graveyard>("Graveyard");
    const ethRegistry = get<Abi_IPermissionedRegistry>("ETHRegistry");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    const migrationController = await deploy("UnlockedMigrationController", {
      account: deployer,
      artifact: Artifact_UnlockedMigrationController,
      args: [
        nameWrapper.address,
        graveyard.address,
        ethRegistry.address,
        contractNamer.address,
      ],
    });

    // see: UnlockedMigrationController.t.sol
    await write(ethRegistry, {
      account: deployer,
      functionName: "grantRootRoles",
      args: [
        DEPLOYMENT_ROLES.MIGRATION_CONTROLLER_ROOT,
        migrationController.address,
      ],
    });
  },
  {
    tags: ["UnlockedMigrationController", "migration:phase1:deploy-v2", "v2"],
    dependencies: ["NameWrapper", "Graveyard", "ETHRegistry", "ContractNamer"],
  },
);
