import type { Address } from "viem";
import type { DevnetEnvironment } from "../../script/setup.js";
import { idFromLabel } from "./utils.js";

// Pre-migration helpers shared with the devnet runner live in script/ so
// production code doesn't import from test/. Re-exported here for tests.
export {
  DEPLOYER_PRIVATE_KEY,
  createCSVFile,
  buildMainArgs,
  verifyV2State,
} from "../../script/preMigrationUtils.js";

export async function setupBaseRegistrarController(env: DevnetEnvironment) {
  const { deployer, owner } = env.namedAccounts;
  // v1.7.0: BaseRegistrar is now owned by RegistrarSecurityController
  await env.v1.RegistrarSecurityController.write.addRegistrarController(
    [deployer.address],
    { account: owner },
  );
}

export async function registerV1Name(
  env: DevnetEnvironment,
  label: string,
  ownerAddress: Address,
  durationSeconds: number,
) {
  const tokenId = idFromLabel(label);
  await env.v1.BaseRegistrar.write.register([
    tokenId,
    ownerAddress,
    BigInt(durationSeconds),
  ]);
  const expiry = await env.v1.BaseRegistrar.read.nameExpires([tokenId]);
  return expiry;
}

export async function renewV1Name(
  env: DevnetEnvironment,
  label: string,
  additionalDuration: number,
) {
  const tokenId = idFromLabel(label);
  await env.v1.BaseRegistrar.write.renew([tokenId, BigInt(additionalDuration)]);
  const expiry = await env.v1.BaseRegistrar.read.nameExpires([tokenId]);
  return expiry;
}
