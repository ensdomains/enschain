import { artifacts, execute } from "@rocketh";

export default execute(
  async ({ deploy, get, getV1, namedAccounts: { deployer } }) => {
    const rootRegistry =
      get<(typeof artifacts.PermissionedRegistry)["abi"]>("RootRegistry");

    const batchGatewayProvider = await getV1<
      (typeof artifacts.GatewayProvider)["abi"]
    >("BatchGatewayProvider");

    const contractNamer =
      get<(typeof artifacts.IContractNamer)["abi"]>("ContractNamer");

    await deploy("AliasResolver", {
      account: deployer,
      artifact: artifacts.AliasResolver,
      args: [
        rootRegistry.address,
        batchGatewayProvider.address,
        contractNamer.address,
      ],
    });
  },
  {
    tags: ["AliasResolver", "v2"],
    dependencies: ["RootRegistry", "BatchGatewayProvider", "ContractNamer"],
  },
);
