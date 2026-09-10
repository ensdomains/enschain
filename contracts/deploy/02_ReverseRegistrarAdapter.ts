import { execute } from "@rocketh";
import type { Abi_ReverseRegistrar } from "generated/abis/ReverseRegistrar.js";
import type { Abi_StandaloneHCAFactory } from "generated/abis/StandaloneHCAFactory.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_ReverseRegistrarAdapter } from "generated/artifacts/ReverseRegistrarAdapter.js";
import {
  controllerAddressHistory,
  replacedDeploymentAddresses,
  SUPERSEDED_CONTROLLER_ADDRESSES,
} from "./hca/_helpers.js";

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    getOrNull,
    getV1,
    read,
    namedAccounts: { deployer, owner, v1Owner },
  }) => {
    const reverseRegistrar =
      await getV1<Abi_ReverseRegistrar>("ReverseRegistrar");
    const standaloneHCAFactory = get<Abi_StandaloneHCAFactory>(
      "StandaloneHCAFactory",
    );
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    const previousAdapter = getOrNull("ReverseRegistrarAdapter");
    const priorControllers = [previousAdapter];
    const adapter = await deploy(
      "ReverseRegistrarAdapter",
      {
        account: deployer,
        artifact: Artifact_ReverseRegistrarAdapter,
        args: [
          reverseRegistrar.address,
          standaloneHCAFactory.address,
          contractNamer.address,
        ],
      },
      {
        linkedData: {
          [SUPERSEDED_CONTROLLER_ADDRESSES]:
            controllerAddressHistory(priorControllers),
        },
      },
    );

    const adapterIsReverseController = await read(reverseRegistrar, {
      functionName: "controllers",
      args: [adapter.address],
    });

    if (!adapterIsReverseController) {
      // The v1 ReverseRegistrar is owned by the v1 owner, not the v2 admin, so
      // route the controller grant through v1Owner (honouring the deferred
      // v1-owner transaction flow, which only captures v1Owner sends).
      await write(reverseRegistrar, {
        account: v1Owner ?? owner,
        functionName: "setController",
        args: [adapter.address, true],
      });
    }

    for (const previousAddress of replacedDeploymentAddresses(
      adapter,
      priorControllers,
    )) {
      const previousIsController = await read(reverseRegistrar, {
        functionName: "controllers",
        args: [previousAddress],
      });
      if (previousIsController) {
        await write(reverseRegistrar, {
          account: v1Owner ?? owner,
          functionName: "setController",
          args: [previousAddress, false],
        });
      }
    }
  },
  {
    tags: [
      "ReverseRegistrarAdapter",
      "migration:phase1:deploy-v2",
      "v2",
      "hca",
    ],
    dependencies: ["ContractNamer", "StandaloneHCAFactory"],
  },
);
