import { execute } from "@rocketh";
import { Artifact_PermissionedAddressSet } from "generated/artifacts/PermissionedAddressSet.js";

export default execute(
  async ({ deploy, namedAccounts: { deployer, owner } }) => {
    await deploy("RegistryUpgradeSet", {
      account: deployer,
      artifact: Artifact_PermissionedAddressSet,
      args: [owner, false],
    });
  },
  {
    tags: ["RegistryUpgradeSet", "v2"],
  },
);
