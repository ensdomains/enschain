import { execute } from "@rocketh";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_UnlockedMigrationController } from "generated/abis/UnlockedMigrationController.js";
import type { Abi_LockedMigrationController } from "generated/abis/LockedMigrationController.js";
import type { Abi_StandaloneHCAFactory } from "generated/abis/StandaloneHCAFactory.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_MigrationHelper } from "generated/artifacts/src/migration/MigrationHelper.sol/MigrationHelper.js";

export default execute(
  async ({ deploy, get, namedAccounts: { deployer } }) => {
    const rootRegistry = get<Abi_IPermissionedRegistry>("RootRegistry");
    const unlockedMigrationController = get<Abi_UnlockedMigrationController>(
      "UnlockedMigrationController",
    );
    const lockedMigrationController = get<Abi_LockedMigrationController>(
      "LockedMigrationController",
    );
    const standaloneHCAFactory = get<Abi_StandaloneHCAFactory>(
      "StandaloneHCAFactory",
    );
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("MigrationHelper", {
      account: deployer,
      artifact: Artifact_MigrationHelper,
      args: [
        rootRegistry.address,
        unlockedMigrationController.address,
        lockedMigrationController.address,
        standaloneHCAFactory.address,
        contractNamer.address,
      ],
    });
  },
  {
    tags: ["MigrationHelper", "migration:phase1:deploy-v2", "v2", "hca"],
    dependencies: [
      "RootRegistry",
      "UnlockedMigrationController",
      "LockedMigrationController",
      "StandaloneHCAFactory",
      "ContractNamer",
    ],
  },
);
