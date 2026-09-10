import { execute } from "@rocketh";
import type { Abi_ILabelStore } from "generated/abis/ILabelStore.js";
import { Artifact_PermissionedRegistry } from "generated/artifacts/PermissionedRegistry.js";
import { DEPLOYMENT_ROLES, ROLES } from "../script/deploy-constants.js";

export default execute(
  async ({
    deploy,
    get,
    execute: write,
    namedAccounts: { deployer, owner },
  }) => {
    const labelStore = get<Abi_ILabelStore>("LabelStore");

    const rootRegistry = await deploy("RootRegistry", {
      account: deployer,
      artifact: Artifact_PermissionedRegistry,
      args: [labelStore.address, deployer, DEPLOYMENT_ROLES.ROOT_REGISTRY_ROOT],
    });

    console.log("  - Granting CAN_NAME to owner");
    await write(rootRegistry, {
      functionName: "grantRootRoles",
      args: [ROLES.REGISTRY.CAN_NAME, owner],
      account: deployer,
    });
  },
  {
    tags: ["RootRegistry", "migration:phase1:deploy-v2", "v2"],
    dependencies: ["LabelStore"],
  },
);
