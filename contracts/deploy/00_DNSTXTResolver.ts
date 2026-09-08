import { execute } from "@rocketh";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_DNSTXTResolver } from "generated/artifacts/DNSTXTResolver.js";

export default execute(
  async ({ get, deploy, namedAccounts: { deployer } }) => {
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("DNSTXTResolver", {
      account: deployer,
      artifact: Artifact_DNSTXTResolver,
      args: [contractNamer.address],
    });
  },
  {
    tags: ["DNSTXTResolver", "v2", "migration:phase1:deploy-v2"],
    dependencies: ["ContractNamer"],
  },
);
