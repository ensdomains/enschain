import { execute } from "@rocketh";
import { Artifact_VerifiableFactory } from "generated/artifacts/VerifiableFactory.js";

export default execute(
  async ({ deploy, namedAccounts: { deployer } }) => {
    await deploy("VerifiableFactory", {
      account: deployer,
      artifact: Artifact_VerifiableFactory,
    });
  },
  {
    tags: ["VerifiableFactory", "migration:phase1:deploy-v2", "v2"],
  },
);
