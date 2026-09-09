import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { parseMigrationNetwork } from "../../../script/migrations/plumbing.js";

import { runCleanTestnetFull } from "../../../script/migrate.js";
import {
  isTenderlyVirtualRpc,
  logMigrationSigners,
  nonEmptyString,
  requireHttpNetwork,
  resolveMigrationSigners,
} from "./utils.js";

type CleanTestnetTaskArgs = {
  migrationNetwork: string;
  chainId: string;
  csvFile: string;
  batchSize: string;
  initialLimit: string;
  finishLimit: string;
  workDir: string;
  deploymentsDir: string;
  deploymentNetwork: string;
  v1DeploymentsDir: string;
  v1DeploymentNetwork: string;
  snapshotFile: string;
  deployer: string;
  owner: string;
  v1Owner: string;
  urManager: string;
  resumeExistingDeployments: boolean;
  debugRpc: boolean;
};

const action: NewTaskActionFunction<CleanTestnetTaskArgs> = async (
  args,
  hre,
) => {
  const connection = await hre.network.connect();
  try {
    const networkConfig = requireHttpNetwork(
      connection.networkConfig,
      "migration clean-testnet",
      connection.networkName,
    );
    const rpcUrl = await networkConfig.url.getUrl();
    const signers = await resolveMigrationSigners({
      args,
      networkConfig,
      provider: connection.provider,
      ownerFallback: "deployer",
      taskName: "migration clean-testnet",
    });
    logMigrationSigners(signers);

    await runCleanTestnetFull({
      network: parseMigrationNetwork(args.migrationNetwork),
      rpcUrl,
      provider: connection.provider,
      chainId: nonEmptyString(args.chainId),
      csvFile: nonEmptyString(args.csvFile),
      batchSize: nonEmptyString(args.batchSize),
      initialLimit: nonEmptyString(args.initialLimit),
      finishLimit: nonEmptyString(args.finishLimit),
      workDir: nonEmptyString(args.workDir),
      deploymentsDir: args.deploymentsDir,
      deploymentNetwork: nonEmptyString(args.deploymentNetwork),
      v1DeploymentsDir: nonEmptyString(args.v1DeploymentsDir),
      v1DeploymentNetwork: nonEmptyString(args.v1DeploymentNetwork),
      tenderly: isTenderlyVirtualRpc(rpcUrl),
      snapshotFile: nonEmptyString(args.snapshotFile),
      ...signers,
      resumeExistingDeployments: args.resumeExistingDeployments,
      debugRpc: args.debugRpc,
    });
  } finally {
    await connection.close();
  }
};

export default action;
