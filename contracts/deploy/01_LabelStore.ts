import { execute } from "@rocketh";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_LabelStore } from "generated/artifacts/LabelStore.js";

export default execute(
  async ({ get, deploy, namedAccounts: { deployer } }) => {
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("LabelStore", {
      account: deployer,
      artifact: Artifact_LabelStore,
      args: [contractNamer.address],
    });
  },
  {
    tags: ["LabelStore", "v2"],
    dependencies: ["ContractNamer"],
  },
);
