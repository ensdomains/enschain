import { execute } from "@rocketh";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IRentPriceOracle } from "generated/abis/IRentPriceOracle.js";
import { Artifact_ETHRegistrar } from "generated/artifacts/ETHRegistrar.js";
import {
  DEPLOYMENT_ROLES,
  GRACE_PERIOD_V2,
  MIN_COMMITMENT_AGE,
  MAX_COMMITMENT_AGE,
  MIN_REGISTER_DURATION,
} from "../script/deploy-constants.js";

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    namedAccounts: { deployer, owner },
    tags,
  }) => {
    const ethRegistry = get<Abi_IPermissionedRegistry>("ETHRegistry");
    const rentPriceOracle = get<Abi_IRentPriceOracle>(
      "StandardRentPriceOracle",
    );

    const ethRegistrar = await deploy("ETHRegistrar", {
      account: deployer,
      artifact: Artifact_ETHRegistrar,
      args: [
        owner,
        ethRegistry.address,
        owner, // TODO: beneficiary,
        rentPriceOracle.address,
        GRACE_PERIOD_V2,
        MIN_COMMITMENT_AGE,
        MAX_COMMITMENT_AGE,
        MIN_REGISTER_DURATION,
      ],
    });

    if (!tags.deferV2Registrar) {
      await write(ethRegistry, {
        functionName: "grantRootRoles",
        args: [DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT, ethRegistrar.address],
        account: deployer,
      });
    }
  },
  {
    tags: ["ETHRegistrar", "migration:phase1:deploy-v2", "v2"],
    dependencies: ["ETHRegistry", "StandardRentPriceOracle"],
  },
);
