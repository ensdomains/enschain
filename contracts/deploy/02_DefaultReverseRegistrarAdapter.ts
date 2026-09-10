import { execute } from "@rocketh";
import type { Abi_DefaultReverseRegistrar } from "generated/abis/DefaultReverseRegistrar.js";
import type { Abi_StandaloneHCAFactory } from "generated/abis/StandaloneHCAFactory.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_DefaultReverseRegistrarAdapter } from "generated/artifacts/DefaultReverseRegistrarAdapter.js";
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
    const defaultReverseRegistrar = await getV1<Abi_DefaultReverseRegistrar>(
      "DefaultReverseRegistrar",
    );
    const standaloneHCAFactory = get<Abi_StandaloneHCAFactory>(
      "StandaloneHCAFactory",
    );
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    const previousAdapter = getOrNull("DefaultReverseRegistrarAdapter");
    const legacyHCAAdapter = getOrNull("DefaultReverseRegistrarHCAAdapter");
    const priorControllers = [previousAdapter, legacyHCAAdapter];
    const adapter = await deploy(
      "DefaultReverseRegistrarAdapter",
      {
        account: deployer,
        artifact: Artifact_DefaultReverseRegistrarAdapter,
        args: [
          defaultReverseRegistrar.address,
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

    const adapterIsDefaultController = await read(defaultReverseRegistrar, {
      functionName: "controllers",
      args: [adapter.address],
    });

    if (!adapterIsDefaultController) {
      // The v1 DefaultReverseRegistrar is owned by the v1 owner, not the v2
      // admin, so route the controller grant through v1Owner (honouring the
      // deferred v1-owner transaction flow, which only captures v1Owner sends).
      await write(defaultReverseRegistrar, {
        account: v1Owner ?? owner,
        functionName: "setController",
        args: [adapter.address, true],
      });
    }

    for (const previousAddress of replacedDeploymentAddresses(
      adapter,
      priorControllers,
    )) {
      const previousIsController = await read(defaultReverseRegistrar, {
        functionName: "controllers",
        args: [previousAddress],
      });
      if (previousIsController) {
        await write(defaultReverseRegistrar, {
          account: v1Owner ?? owner,
          functionName: "setController",
          args: [previousAddress, false],
        });
      }
    }
  },
  {
    tags: [
      "DefaultReverseRegistrarAdapter",
      "migration:phase1:deploy-v2",
      "v2",
      "hca",
    ],
    dependencies: ["ContractNamer", "StandaloneHCAFactory"],
  },
);
