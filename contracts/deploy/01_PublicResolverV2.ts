import { execute } from "@rocketh";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_PublicResolverV2 } from "generated/artifacts/PublicResolverV2.js";

export default execute(
  async ({ deploy, get, getV1, namedAccounts: { deployer } }) => {
    const nameWrapper = await getV1<Abi_INameWrapper>("NameWrapper");
    const rootRegistry = get<Abi_IPermissionedRegistry>("RootRegistry");
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("PublicResolverV2", {
      account: deployer,
      artifact: Artifact_PublicResolverV2,
      args: [nameWrapper.address, rootRegistry.address, contractNamer.address],
    });
  },
  {
    tags: ["PublicResolverV2", "v2"],
    dependencies: ["NameWrapper", "RootRegistry", "ContractNamer"],
  },
);
