import { execute } from "@rocketh";
import type { Abi_IPermissionedResolver } from "generated/abis/IPermissionedResolver.js";
import type { Abi_IGatewayProvider } from "generated/abis/IGatewayProvider.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_UniversalResolverV2 } from "generated/artifacts/UniversalResolverV2.js";

export default execute(
  async ({ deploy, get, getV1, namedAccounts: { deployer } }) => {
    const rootRegistry = get<Abi_IPermissionedResolver>("RootRegistry");
    const batchGatewayProvider = await getV1<Abi_IGatewayProvider>(
      "BatchGatewayProvider",
    );
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    await deploy("UniversalResolverV2", {
      account: deployer,
      artifact: Artifact_UniversalResolverV2,
      args: [
        rootRegistry.address,
        batchGatewayProvider.address,
        contractNamer.address,
      ],
    });
    return true;
  },
  {
    id: "universal-resolver:deploy-universal-resolver-implementation:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:phase1:deploy-v2",
      "UniversalResolverImplementation",
      "UniversalResolverV2",
      "v2",
    ],
    dependencies: [
      "RootRegistry",
      "BatchGatewayProvider",
      "ContractNamer",
      "ManagedUniversalResolverProxy",
    ],
  },
);
