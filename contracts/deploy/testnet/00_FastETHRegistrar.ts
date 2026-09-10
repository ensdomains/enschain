import { execute } from "@rocketh";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IRentPriceOracle } from "generated/abis/IRentPriceOracle.js";
import { Artifact_ETHRegistrar } from "generated/artifacts/ETHRegistrar.js";
import {
  DEPLOYMENT_ROLES,
  GRACE_PERIOD_V2,
  MIN_REGISTER_DURATION,
} from "../../script/deploy-constants.js";

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    namedAccounts: { deployer, owner },
    network,
  }) => {
    if (network.chain.id === 1) return;

    const ethRegistry = get<Abi_IPermissionedRegistry>("ETHRegistry");
    const rentPriceOracle = get<Abi_IRentPriceOracle>(
      "StandardRentPriceOracle",
    );

    const SEC_PER_DAY = 86400n;
    const ethRegistrar = await deploy("FastETHRegistrar", {
      account: deployer,
      artifact: Artifact_ETHRegistrar,
      args: [
        owner,
        ethRegistry.address,
        owner, // beneficiary
        rentPriceOracle.address,
        GRACE_PERIOD_V2,
        0n, // minCommitmentAge
        SEC_PER_DAY, // maxCommitmentAge
        MIN_REGISTER_DURATION,
      ],
    });

    await write(ethRegistry, {
      functionName: "grantRootRoles",
      args: [DEPLOYMENT_ROLES.ETH_REGISTRAR_ROOT, ethRegistrar.address],
      account: deployer,
    });
  },
  {
    tags: ["FastETHRegistrar", "v2", "testnet"],
    dependencies: ["ETHRegistry", "StandardRentPriceOracle"],
  },
);
