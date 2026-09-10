import { execute } from "@rocketh";
import { Artifact_MockERC20 } from "generated/artifacts/test/mocks/MockERC20.sol/MockERC20.js";

export default execute(
  async ({ deploy, namedAccounts: { deployer }, tags }) => {
    // Free-mint mock payment tokens must never ship to mainnet; the price
    // oracle wires real tokens there instead.
    if (tags.hasDao) return;

    await deploy("MockUSDC", {
      account: deployer,
      artifact: Artifact_MockERC20,
      args: ["USDC", 6],
    });

    await deploy("MockDAI", {
      account: deployer,
      artifact: Artifact_MockERC20,
      args: ["DAI", 18],
    });
  },
  {
    tags: ["MockTokens", "migration:phase1:deploy-v2", "v2"],
  },
);
