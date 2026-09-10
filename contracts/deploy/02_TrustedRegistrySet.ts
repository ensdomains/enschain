import { execute } from "@rocketh";
import { Artifact_PermissionedAddressSet } from "generated/artifacts/PermissionedAddressSet.js";

const NAMES = ["RootRegistry", "ETHRegistry", "UserRegistryImpl"];
export default execute(
  async ({
    deploy,
    get,
    execute: write,
    namedAccounts: { deployer, owner },
  }) => {
    const set = await deploy("TrustedRegistrySet", {
      account: deployer,
      artifact: Artifact_PermissionedAddressSet,
      args: [owner],
    });

    for (const name of NAMES) {
      console.log(`  - Adding ${name}`);
      await write(set, {
        functionName: "approve",
        args: [get(name).address, true],
        account: owner,
      });
    }
  },
  {
    tags: ["TrustedRegistrySet", "migration:phase1:deploy-v2", "v2"],
    dependencies: [...NAMES],
  },
);
