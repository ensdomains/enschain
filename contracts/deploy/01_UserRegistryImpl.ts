import { execute } from "@rocketh";
import type { Abi_ILabelStore } from "generated/abis/ILabelStore.js";
import { Artifact_UserRegistry } from "generated/artifacts/UserRegistry.js";

export default execute(
  async ({ deploy, get, namedAccounts: { deployer, owner } }) => {
    const labelStore = get<Abi_ILabelStore>("LabelStore");

    await deploy("UserRegistryImpl", {
      account: deployer,
      artifact: Artifact_UserRegistry,
      args: [labelStore.address, owner],
    });
  },
  {
    tags: ["UserRegistryImpl", "migration:phase1:deploy-v2", "v2"],
    dependencies: ["LabelStore"],
  },
);
