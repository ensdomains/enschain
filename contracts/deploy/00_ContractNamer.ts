import { execute } from "@rocketh";
import { Artifact_ContractNamer } from "generated/artifacts/ContractNamer.js";

export default execute(
  async ({ deployViaProxy, namedAccounts: { deployer, owner } }) => {
    await deployViaProxy(
      "ContractNamer",
      {
        account: deployer,
        artifact: Artifact_ContractNamer,
      },
      {
        proxyContract: "UUPS",
        execute: {
          methodName: "initialize",
          args: [owner],
        },
      },
    );
  },
  {
    tags: ["ContractNamer", "v2"],
  },
);
