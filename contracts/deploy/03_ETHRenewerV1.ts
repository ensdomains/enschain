import { execute } from "@rocketh";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IRentPriceOracle } from "generated/abis/IRentPriceOracle.js";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_IWrappedETHRegistrarController } from "generated/abis/IWrappedETHRegistrarController.js";
import { Artifact_ETHRenewerV1 } from "generated/artifacts/ETHRenewerV1.js";
import {
  DEPLOYMENT_ROLES,
  GRACE_PERIOD_V2,
  PREMIGRATION_BONUS_PERIOD,
} from "../script/deploy-constants.js";

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    getV1,
    namedAccounts: { deployer, owner },
  }) => {
    const ethRegistry = get<Abi_IPermissionedRegistry>("ETHRegistry");
    const rentPriceOracle = get<Abi_IRentPriceOracle>(
      "StandardRentPriceOracle",
    );
    const nameWrapper = await getV1<Abi_INameWrapper>("NameWrapper");
    const wrappedController = await getV1<Abi_IWrappedETHRegistrarController>(
      "WrappedETHRegistrarController",
    );

    const ethRenewerV1 = await deploy("ETHRenewerV1", {
      account: deployer,
      artifact: Artifact_ETHRenewerV1,
      args: [
        owner,
        ethRegistry.address,
        owner, // TODO: beneficiary,
        rentPriceOracle.address,
        GRACE_PERIOD_V2,
        PREMIGRATION_BONUS_PERIOD,
        nameWrapper.address,
        wrappedController.address,
      ],
    });

    await write(ethRegistry, {
      functionName: "grantRootRoles",
      args: [DEPLOYMENT_ROLES.ETH_RENEWER_V1_ROOT, ethRenewerV1.address],
      account: deployer,
    });
  },
  {
    tags: ["ETHRenewerV1", "migration:phase1:deploy-v2", "v2"],
    dependencies: [
      "ETHRegistry",
      "StandardRentPriceOracle",
      "NameWrapper",
      "WrappedETHRegistrarController",
    ],
  },
);
