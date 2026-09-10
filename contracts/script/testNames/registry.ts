import {
  type Account,
  type Address,
  type TransactionReceipt,
  zeroAddress,
} from "viem";

import type { DevnetAccount, DevnetEnvironment } from "../setup.js";
import { MAX_EXPIRY, ROLES, STATUS } from "../deploy-constants.js";
import {
  splitName,
  dnsEncodeName,
  idFromLabel,
  getLabelAt,
} from "../../test/utils/utils.js";
import { setupResolver } from "./resolver.js";
import { formatStatus } from "./display.js";

/**
 * Traverse the registry hierarchy to find data for a name.
 * Uses UniversalResolverV2.findRegistries() to locate the parent registry,
 * then reads state directly from it.
 */
export async function getNameData(
  env: DevnetEnvironment,
  name: string,
  account: Account = env.namedAccounts.deployer,
) {
  const regs = await env.v2.UniversalHelper.read.findRegistries([
    dnsEncodeName(name),
  ]);
  if (regs.length < 2 || regs[1] === zeroAddress) return; // no parent
  const parentRegistry = env.castUserRegistry(regs[1], account);
  const exactRegistry =
    regs[0] === zeroAddress
      ? undefined
      : env.castUserRegistry(regs[0], account);
  const label = getLabelAt(name);
  const [state, resolver] = await Promise.all([
    parentRegistry.read.getState([idFromLabel(label)]),
    parentRegistry.read.getResolver([label]),
  ]);
  return {
    ...state,
    owner: state.status == STATUS.REGISTERED ? state.latestOwner : zeroAddress,
    name,
    label,
    resolver,
    exactRegistry,
    parentRegistry,
  };
}

/**
 * Create a subname (and all parent registries if they don't exist)
 */
export async function createSubname(
  env: DevnetEnvironment,
  fullName: string,
  options: {
    account?: DevnetAccount;
    expiry?: bigint;
  } = {},
): Promise<string[]> {
  const account = options.account ?? env.namedAccounts.owner;
  const myResolver = account.resolver.address;
  const expiry = options.expiry ?? MAX_EXPIRY;
  const registeredNames: string[] = [];

  console.log(`\nCreating name: ${fullName}`);
  const labels = splitName(fullName);
  if (labels.length < 3) throw new Error(`expected 3LD+: ${fullName}`);
  let name = labels.pop()!;
  if (name !== "eth") throw new Error(`expected .eth: ${fullName}`);

  while (labels.length) {
    const label = labels.pop()!;
    name = `${label}.${name}`;
    const data = await getNameData(env, name, account);
    if (!data) throw new Error("bug");
    if (!data.exactRegistry) {
      console.log(`Deploying UserRegistry for ${name}...`);
      const registry = await env.deployUserRegistry({
        account,
        salt: { name },
      });
      console.log(`✓ UserRegistry deployed at ${registry.address}`);
      if (data.status === STATUS.REGISTERED) {
        await data.parentRegistry.write.setSubregistry([
          data.tokenId,
          registry.address,
        ]);
        await data.parentRegistry.write.setResolver([data.tokenId, myResolver]);
        console.log(`✓ Updated ${name} subregistry and resolver`);
      } else {
        await data.parentRegistry.write.register([
          label,
          account.address,
          registry.address,
          myResolver,
          ROLES.ALL,
          expiry,
        ]);
        console.log(`✓ Registered ${name}`);
        registeredNames.push(name);
      }
      await registry.write.setParent([data.parentRegistry.address, label]);
      console.log(`✓ Set ${name} canonical parent`);
    } else if (data.resolver !== myResolver) {
      await data.parentRegistry.write.setResolver([data.tokenId, myResolver]);
      console.log(`✓ Updated ${name} resolver`);
    }
    await setupResolver(env, account, name, {
      description: name,
      address: account.address,
    });
    console.log(`✓ Setup resolver for ${name}`);
  }
  return registeredNames;
}

/**
 * Link a name to appear under a different parent by pointing to the same subregistry.
 * This creates multiple "entry points" into the same child namespace.
 *
 * @param sourceName - The existing name whose subregistry we want to link (e.g., "sub1.sub2.parent.eth")
 * @param targetName - The created linked name whos subregistry is matches sourceName.
 *
 * Example:
 *   linkName(env, "sub1.sub2.parent.eth", "linked.parent.eth")
 *   Creates "linked.parent.eth" that shares children with "sub1.sub2.parent.eth"
 */
export async function linkName(
  env: DevnetEnvironment,
  sourceName: string,
  targetName: string,
  account = env.namedAccounts.owner,
) {
  console.log(`\nLinking name: ${sourceName} to ${targetName}`);

  if (splitName(sourceName).length < 3) {
    throw new Error(
      `Cannot link second-level names directly. Source must be a subname.`,
    );
  }

  const sourceData = await getNameData(env, sourceName);
  if (sourceData?.status !== STATUS.REGISTERED) {
    throw new Error(`Source name ${sourceName} not registered`);
  }
  if (!sourceData.exactRegistry) {
    throw new Error(`Source name ${sourceName} has no subregistry to link`);
  }
  console.log(`Source subregistry: ${sourceData.exactRegistry.address}`);

  // Get target data
  const targetData = await getNameData(env, targetName, account);
  if (!targetData) {
    throw new Error(`Target name ${targetName} has no parent registry`);
  }

  console.log(`Creating linked name: ${targetName}`);

  // Check if the label already exists in the target registry
  if (targetData.status === STATUS.AVAILABLE) {
    await targetData.parentRegistry.write.register([
      targetData.label,
      account.address,
      sourceData.exactRegistry.address,
      account.resolver.address,
      ROLES.ALL,
      MAX_EXPIRY,
    ]);

    console.log(`✓ Registered ${targetName} with shared subregistry`);
  } else {
    console.log(`Warning: ${targetName} already exists. Updating...`);
    await targetData.parentRegistry.write.setSubregistry([
      idFromLabel(targetData.label),
      sourceData.exactRegistry.address,
    ]);
    await targetData.parentRegistry.write.setResolver([
      idFromLabel(targetData.label),
      account.resolver.address,
    ]);
    console.log(`✓ Updated ${targetName} to point to shared subregistry`);
  }

  await setupResolver(env, account, targetName, {
    description: `Linked to ${sourceName}`,
    address: account.address,
  });

  console.log(`\n✓ Link complete!`);
  console.log(
    `Children of ${sourceName} and ${targetName} now resolve to the same place.`,
  );
  console.log(
    `Example: wallet.${sourceName} and wallet.${targetName} are the same token.`,
  );
}

/**
 * Transfer a name to a new owner
 */
export async function transferName(
  env: DevnetEnvironment,
  name: string,
  newOwner: Address,
  account = env.namedAccounts.owner,
) {
  const data = await getNameData(env, name, account);
  if (data?.status !== STATUS.REGISTERED) throw new Error(`expected ${name}`);

  console.log(`\nTransferring ${name}...`);
  console.log(`TokenId: ${data.tokenId}`);
  console.log(`From: ${account.address}`);
  console.log(`To: ${newOwner}`);

  const receipt = await env.waitFor(
    data.parentRegistry.write.safeTransferFrom([
      account.address,
      newOwner,
      data.tokenId,
      1n,
      "0x",
    ]),
  );

  console.log(`✓ Transfer completed`);

  return receipt;
}

/**
 * Change roles for a name
 */
export async function changeRole(
  env: DevnetEnvironment,
  name: string,
  targetAccount: Address,
  rolesToGrant: bigint,
  rolesToRevoke: bigint,
  account = env.namedAccounts.owner,
) {
  const data = await getNameData(env, name, account);
  if (data?.status !== STATUS.REGISTERED) throw new Error(`expected ${name}`);

  console.log(
    `\nChanging roles for ${name} (TokenId: ${data.tokenId}, Target: ${targetAccount}, Grant: ${rolesToGrant}, Revoke: ${rolesToRevoke})`,
  );

  const receipts: TransactionReceipt[] = [];

  if (rolesToGrant) {
    const receipt = await env.waitFor(
      data.parentRegistry.write.grantRoles([
        data.tokenId,
        rolesToGrant,
        targetAccount,
      ]),
    );
    receipts.push(receipt);
  }

  if (rolesToRevoke) {
    const receipt = await env.waitFor(
      data.parentRegistry.write.revokeRoles([
        data.tokenId,
        rolesToRevoke,
        targetAccount,
      ]),
    );
    receipts.push(receipt);
  }

  const newTokenId = await data.parentRegistry.read.getTokenId([data.tokenId]);
  console.log(`TokenId changed from ${data.tokenId} to ${newTokenId}`);

  return receipts;
}

/**
 * Reserve a name (registers with owner = address(0) and roleBitmap = 0, no token minted)
 */
export async function reserveName(
  env: DevnetEnvironment,
  name: string,
  options: {
    expiry?: bigint;
    account?: Account;
  } = {},
) {
  const data = await getNameData(env, name);
  if (data?.status !== STATUS.AVAILABLE) {
    throw new Error(`already exists: ${name}`);
  }

  const expiry: bigint =
    options.expiry ??
    (await env.client.getBlock().then((b) => b.timestamp + 86400n));

  console.log(`\nReserving ${name}...`);

  const receipt = await env.waitFor(
    data.parentRegistry.write.register([
      data.label,
      zeroAddress, // owner = address(0) triggers reservation
      zeroAddress, // no subregistry
      zeroAddress, // no resolver
      0n, // roleBitmap must be 0 for reservations
      expiry,
    ]),
  );

  const state = await data.parentRegistry.read.getState([data.tokenId]);
  console.log(
    `✓ Reserved ${name} (status: ${formatStatus(state.status)}, tokenId: ${state.tokenId})`,
  );

  return receipt;
}

/**
 * Unregister a name (deletes it from the registry)
 */
export async function unregisterName(
  env: DevnetEnvironment,
  name: string,
  account: Account,
) {
  const data = await getNameData(env, name, account);
  if (!data || data.status === STATUS.AVAILABLE) {
    throw new Error(`does not exist: ${name}`);
  }

  console.log(`\nUnregistering ${name}...`);
  console.log(`TokenId: ${data.tokenId}`);

  const receipt = await env.waitFor(
    data.parentRegistry.write.unregister([data.tokenId]),
  );

  const state = await data.parentRegistry.read.getState([data.tokenId]);
  console.log(`✓ Unregistered ${name} (status: ${formatStatus(state.status)})`);

  return receipt;
}
