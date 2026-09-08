import { execute } from "@rocketh";
import { Artifact_GatewayProvider } from "generated/artifacts/GatewayProvider.js";

export default execute(
  async ({ deploy, namedAccounts: { deployer, owner } }) => {
    await deploy("DNSSECGatewayProvider", {
      account: deployer,
      artifact: Artifact_GatewayProvider,
      args: [owner, ["https://dnssec-oracle.ens.domains/"]],
    });
  },
  {
    tags: ["DNSSECGatewayProvider", "v2", "migration:phase1:deploy-v2"],
  },
);
