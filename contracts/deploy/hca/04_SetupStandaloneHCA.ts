import { execute } from "@rocketh";
import type { Abi_StandaloneSingleOwnerHCA } from "generated/abis/StandaloneSingleOwnerHCA.js";
import type { Abi_StandaloneHCAFactory } from "generated/abis/StandaloneHCAFactory.js";
import { shouldDeployStandaloneHCA } from "./_helpers.js";

export default execute(
  async ({
    execute: write,
    get,
    namedAccounts: { owner, deployer },
    read,
    tags,
  }) => {
    if (!shouldDeployStandaloneHCA(tags)) return;

    const account = owner ?? deployer;
    const implementation = get<Abi_StandaloneSingleOwnerHCA>(
      "StandaloneHCAImplementation",
    );
    const hcaFactory = get<Abi_StandaloneHCAFactory>("StandaloneHCAFactory");

    const isApproved = await read(hcaFactory, {
      functionName: "approvedImplementations",
      args: [implementation.address],
    });
    if (isApproved) return;

    await write(hcaFactory, {
      account,
      functionName: "setImplementationApproval",
      args: [implementation.address, true],
    });
  },
  {
    tags: [
      "setup:StandaloneHCA",
      "StandaloneHCA",
      "hca",
      "migration:phase1:deploy-v2",
      "v2",
    ],
    dependencies: ["StandaloneHCAFactory", "StandaloneHCAImplementation"],
  },
);
