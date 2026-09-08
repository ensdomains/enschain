import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { parseMigrationNetwork } from "../../../script/migrations/plumbing.js";

import { checkBatchRegistrarOwner } from "../../../script/migrate.js";
import {
  optionalAddress,
  nonEmptyString,
  requireHttpNetwork,
} from "./utils.js";

type BatchRegistrarOwnerTaskArgs = {
  migrationNetwork: string;
  deploymentNetwork: string;
  deploymentsDir: string;
  batchRegistrar: string;
  expectedOwner: string;
  chainId: string;
};

const action: NewTaskActionFunction<BatchRegistrarOwnerTaskArgs> = async (
  args,
  hre,
) => {
  const connection = await hre.network.connect();
  try {
    const networkConfig = requireHttpNetwork(
      connection.networkConfig,
      "migration batch-registrar-owner",
      connection.networkName,
    );

    await checkBatchRegistrarOwner({
      network: parseMigrationNetwork(args.migrationNetwork),
      rpcUrl: await networkConfig.url.getUrl(),
      chainId: nonEmptyString(args.chainId),
      deploymentNetwork: nonEmptyString(args.deploymentNetwork),
      deploymentsDir: args.deploymentsDir,
      batchRegistrar: optionalAddress(args.batchRegistrar),
      expectedOwner: optionalAddress(args.expectedOwner),
    });
  } finally {
    await connection.close();
  }
};

export default action;
