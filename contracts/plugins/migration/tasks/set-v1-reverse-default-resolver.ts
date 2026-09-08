import type { NewTaskActionFunction } from "hardhat/types/tasks";

import { parseMigrationNetwork } from "../../../script/migrationPlumbing.js";

import { setV1ReverseDefaultResolver } from "../../../script/migration.js";
import {
  defaultHardhatPrivateKey,
  nonEmptyString,
  requireHttpNetwork,
} from "./utils.js";

type SetV1ReverseDefaultResolverTaskArgs = {
  migrationNetwork: string;
  chainId: string;
  v1DeploymentsDir: string;
  v1DeploymentNetwork: string;
  privateKey: string;
};

const action: NewTaskActionFunction<
  SetV1ReverseDefaultResolverTaskArgs
> = async (args, hre) => {
  const connection = await hre.network.connect();
  try {
    const networkConfig = requireHttpNetwork(
      connection.networkConfig,
      "migration set-v1-reverse-default-resolver",
      connection.networkName,
    );
    // setDefaultResolver is owner-gated on the v1 ReverseRegistrar, whose owner is
    // the v1 owner rather than the deployer. Prefer an explicitly supplied v1-owner
    // key, then the configured v1-owner env key, and only fall back to the Hardhat
    // account for the clean-testnet case where the deployer owns the fresh v1.
    const privateKey =
      (nonEmptyString(args.privateKey) as `0x${string}` | undefined) ??
      (process.env.SEPOLIA_V1_OWNER_KEY as `0x${string}` | undefined) ??
      (process.env.V1_OWNER_KEY as `0x${string}` | undefined) ??
      (await defaultHardhatPrivateKey(networkConfig));
    if (privateKey === undefined) {
      throw new Error(
        "migration set-v1-reverse-default-resolver could not resolve a signer; pass --private-key, configure SEPOLIA_V1_OWNER_KEY/V1_OWNER_KEY, or DEPLOYER_KEY",
      );
    }
    await setV1ReverseDefaultResolver({
      network: parseMigrationNetwork(args.migrationNetwork),
      rpcUrl: await networkConfig.url.getUrl(),
      chainId: nonEmptyString(args.chainId),
      v1DeploymentsDir: nonEmptyString(args.v1DeploymentsDir),
      v1DeploymentNetwork: nonEmptyString(args.v1DeploymentNetwork),
      privateKey,
    });
  } finally {
    await connection.close();
  }
};

export default action;
