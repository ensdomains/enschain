import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { parseMigrationNetwork } from "../../../script/migrations/plumbing.js";

import { runPreMigrationCommand } from "../../../script/migrate.js";
import {
  defaultHardhatSigner,
  nonEmptyString,
  requireHttpNetwork,
} from "./utils.js";

type PremigrationRunTaskArgs = {
  migrationNetwork: string;
  deploymentsDir: string;
  deploymentNetwork: string;
  v1DeploymentsDir: string;
  v1DeploymentNetwork: string;
  csvFile: string;
  mainnetRpcUrl: string;
  batchSize: string;
  limit: string;
  bonusPeriodDays: string;
  workDir: string;
  dryRun: boolean;
  resume: boolean;
};

const action: NewTaskActionFunction<PremigrationRunTaskArgs> = async (
  args,
  hre,
) => {
  const connection = await hre.network.connect();
  try {
    const networkConfig = requireHttpNetwork(
      connection.networkConfig,
      "migration premigration-run",
      connection.networkName,
    );
    const rpcUrl = await networkConfig.url.getUrl();
    const signer = await defaultHardhatSigner(
      networkConfig,
      connection.provider,
    );
    if (!signer.privateKey) {
      throw new Error(
        "migration premigration-run could not resolve a Hardhat private key; configure DEPLOYER_KEY",
      );
    }
    if (args.csvFile === "") {
      throw new Error("migration premigration-run requires --csv-file");
    }

    await runPreMigrationCommand(
      {
        network: parseMigrationNetwork(args.migrationNetwork),
        rpcUrl,
        mainnetRpcUrl: nonEmptyString(args.mainnetRpcUrl),
        deploymentsDir: args.deploymentsDir,
        deploymentNetwork: nonEmptyString(args.deploymentNetwork),
        v1DeploymentsDir: nonEmptyString(args.v1DeploymentsDir),
        v1DeploymentNetwork: nonEmptyString(args.v1DeploymentNetwork),
        privateKey: signer.privateKey,
        csvFile: args.csvFile,
        batchSize: nonEmptyString(args.batchSize),
        limit: nonEmptyString(args.limit),
        bonusPeriodDays: nonEmptyString(args.bonusPeriodDays),
        workDir: nonEmptyString(args.workDir),
        dryRun: args.dryRun,
      },
      args.resume,
    );
  } finally {
    await connection.close();
  }
};

export default action;
