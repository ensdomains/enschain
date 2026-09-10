import { execute } from "@rocketh";
import { Artifact_PermissionedResolver } from "generated/artifacts/PermissionedResolver.js";

export default execute(
  async ({ deploy, namedAccounts: { deployer, owner } }) => {
    await deploy("PermissionedResolverImpl", {
      account: deployer,
      artifact: Artifact_PermissionedResolver,
      args: [owner],
    });
  },
  {
    tags: ["PermissionedResolverImpl", "migration:phase1:deploy-v2", "v2"],
  },
);
