import { execute } from "@rocketh";
import { Artifact_MockRegistrationIntentExecutor } from "generated/artifacts/MockRegistrationIntentExecutor.js";

import {
  shouldDeployMockIntentExecutor,
  shouldDeployStandaloneHCA,
} from "./_helpers.js";

export default execute(
  async ({ deploy, namedAccounts: { deployer }, tags }) => {
    if (!shouldDeployStandaloneHCA(tags)) return;
    if (process.env.HCA_INTENT_EXECUTOR) return;
    if (!shouldDeployMockIntentExecutor(tags)) return;

    await deploy("MockRegistrationIntentExecutor", {
      account: deployer,
      artifact: Artifact_MockRegistrationIntentExecutor,
    });
  },
  {
    tags: [
      "MockRegistrationIntentExecutor",
      "StandaloneHCA",
      "hca",
      "migration:phase1:deploy-v2",
      "v2",
    ],
  },
);
