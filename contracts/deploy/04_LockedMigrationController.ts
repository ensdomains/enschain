import { execute } from "@rocketh";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_Graveyard } from "generated/abis/Graveyard.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IVerifiableFactory } from "generated/abis/IVerifiableFactory.js";
import type { Abi_WrapperRegistry } from "generated/abis/WrapperRegistry.js";
import type { Abi_IAddressSet } from "generated/abis/IAddressSet.js";
import type { Abi_PublicResolverV2 } from "generated/abis/PublicResolverV2.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_LockedMigrationController } from "generated/artifacts/LockedMigrationController.js";
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
    const verifiableFactory = get<Abi_IVerifiableFactory>("VerifiableFactory");
    const wrapperRegistryImpl = get<Abi_WrapperRegistry>("WrapperRegistryImpl");
    const publicResolverSet = get<Abi_IAddressSet>("PublicResolverSet");
    const publicResolverV2 = get<Abi_PublicResolverV2>("PublicResolverV2");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    const migrationController = await deploy("LockedMigrationController", {
      account: deployer,
      artifact: Artifact_LockedMigrationController,
      args: [
        nameWrapper.address,
        graveyard.address,
        ethRegistry.address,
        verifiableFactory.address,
        wrapperRegistryImpl.address,
        publicResolverSet.address,
        publicResolverV2.address,
        contractNamer.address,
      ],
    });

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
    tags: ["LockedMigrationController", "migration:phase1:deploy-v2", "v2"],
    dependencies: [
      "NameWrapper",
      "Graveyard",
      "ETHRegistry",
      "VerifiableFactory",
      "WrapperRegistryImpl",
      "PublicResolverSet",
      "PublicResolverV2",
      "ContractNamer",
    ],
  },
);
