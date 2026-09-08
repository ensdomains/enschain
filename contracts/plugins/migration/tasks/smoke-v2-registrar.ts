import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { parseMigrationNetwork } from "../../../script/migrations/plumbing.js";

import { runV2RegistrarSmoke } from "../../../script/migrate.js";
import {
  addressForPrivateKey,
  defaultHardhatPrivateKey,
  optionalAddress,
  nonEmptyString,
  requireHttpNetwork,
} from "./utils.js";

type SmokeV2RegistrarTaskArgs = {
  migrationNetwork: string;
  chainId: string;
  deploymentsDir: string;
  deploymentNetwork: string;
  label: string;
  owner: string;
  rpcStateControls: boolean;
};

const action: NewTaskActionFunction<SmokeV2RegistrarTaskArgs> = async (
  args,
  hre,
) => {
  const connection = await hre.network.connect();
  try {
    const networkConfig = requireHttpNetwork(
      connection.networkConfig,
      "migration smoke-v2-registrar",
      connection.networkName,
    );
    const privateKey = await defaultHardhatPrivateKey(networkConfig);
    if (privateKey === undefined) {
      throw new Error(
        "migration smoke-v2-registrar could not resolve a Hardhat private key; configure DEPLOYER_KEY",
      );
    }
    const signer = addressForPrivateKey(privateKey);
    const owner = optionalAddress(args.owner) ?? signer;
    console.log(`migration signer: ${signer}`);
    console.log(`name owner: ${owner}`);

    await runV2RegistrarSmoke({
      network: parseMigrationNetwork(args.migrationNetwork),
      rpcUrl: await networkConfig.url.getUrl(),
      chainId: nonEmptyString(args.chainId),
      deploymentsDir: args.deploymentsDir,
      deploymentNetwork: nonEmptyString(args.deploymentNetwork),
      label: nonEmptyString(args.label),
      owner,
      privateKey,
      rpcStateControls: args.rpcStateControls,
    });
  } finally {
    await connection.close();
  }
};

export default action;
