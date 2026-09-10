import { execute } from "@rocketh";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_Graveyard } from "generated/artifacts/Graveyard.js";

export default execute(
  async ({ get, getV1, deploy, namedAccounts: { deployer } }) => {
    const nameWrapper = await getV1<Abi_INameWrapper>("NameWrapper");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("Graveyard", {
      account: deployer,
      artifact: Artifact_Graveyard,
      args: [nameWrapper.address, contractNamer.address],
    });
  },
  {
    tags: ["Graveyard", "v2"],
    dependencies: ["NameWrapper", "ContractNamer"],
  },
);
