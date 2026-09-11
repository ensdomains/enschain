import { execute } from "@rocketh";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_PermissionedRegistry } from "generated/abis/PermissionedRegistry.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_ETHHelper } from "generated/artifacts/ETHHelper.js";
import { GRACE_PERIOD_V2 } from "../script/deploy-constants.js";

export default execute(
  async ({ get, getV1, deploy, namedAccounts: { deployer } }) => {
    const nameWrapper = await getV1<Abi_INameWrapper>("NameWrapper");
    const rootRegistry = get<Abi_PermissionedRegistry>("RootRegistry");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("ETHHelper", {
      account: deployer,
      artifact: Artifact_ETHHelper,
      args: [
        nameWrapper.address,
        rootRegistry.address,
        contractNamer.address,
        GRACE_PERIOD_V2,
      ],
    });
  },
  {
    tags: ["ETHHelper", "v2", "migration:phase1:deploy-v2"],
    dependencies: [
      "NameWrapper",
      "RootRegistry",
      "ETHRegistry", // referenced internally
      "ContractNamer",
    ],
  },
);
