import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { isTenderlyVirtualRpc } from "../../../script/migration.js";

export { isTenderlyVirtualRpc };

type HttpNetworkConfig = {
  type: "http";
  url: { getUrl(): Promise<string> };
  accounts?: unknown;
};

type RpcAccountProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type MigrationSignerArgs = {
  deployer: string;
  owner: string;
  v1Owner: string;
  urManager: string;
};

export type MigrationSigners = {
  deployer: Address;
  owner: Address;
  v1Owner?: Address;
  urManager: Address;
  deployerPrivateKey?: `0x${string}`;
  ownerPrivateKey?: `0x${string}`;
  v1OwnerPrivateKey?: `0x${string}`;
  urManagerPrivateKey?: `0x${string}`;
};

/** Returns the value unless it is the empty string (Hardhat's "unset" default). */
export function nonEmptyString(value: string): string | undefined {
  return value === "" ? undefined : value;
}

export function optionalAddress(value: string): Address | undefined {
  return value === "" ? undefined : (getAddress(value) as Address);
}

export function requireHttpNetwork(
  networkConfig: { type: string },
  taskName: string,
  networkName: string,
): HttpNetworkConfig {
  if (networkConfig.type !== "http") {
    throw new Error(`${taskName} requires an HTTP network; got ${networkName}`);
  }
  return networkConfig as HttpNetworkConfig;
}

export async function defaultHardhatAccount(
  provider: RpcAccountProvider,
): Promise<Address | undefined> {
  const accounts = await provider.request({
    method: "eth_accounts",
    params: [],
  });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
    return undefined;
  return getAddress(accounts[0]) as Address;
}

export async function defaultHardhatPrivateKey(networkConfig: {
  accounts?: unknown;
}): Promise<`0x${string}` | undefined> {
  const accounts = networkConfig.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return undefined;
  const first = accounts[0] as { getHexString?: () => Promise<string> };
  const value = await first.getHexString?.();
  return value === undefined ? undefined : (value as `0x${string}`);
}

export function addressForPrivateKey(privateKey: `0x${string}`): Address {
  return privateKeyToAccount(privateKey).address as Address;
}

export function maybeAddressForPrivateKey(
  privateKey: `0x${string}` | undefined,
): Address | undefined {
  return privateKey === undefined
    ? undefined
    : addressForPrivateKey(privateKey);
}

/** Returns `privateKey` only when `address` is the same account as `signerAddress`. */
export function privateKeyIfAddressMatches(
  address: Address | undefined,
  signerAddress: Address | undefined,
  privateKey: `0x${string}` | undefined,
): `0x${string}` | undefined {
  if (address === undefined || signerAddress === undefined) return undefined;
  return getAddress(address) === getAddress(signerAddress)
    ? privateKey
    : undefined;
}

export async function defaultHardhatSigner(
  networkConfig: { accounts?: unknown },
  provider?: RpcAccountProvider,
): Promise<{ address?: Address; privateKey?: `0x${string}` }> {
  const privateKey = await defaultHardhatPrivateKey(networkConfig);
  if (privateKey !== undefined) {
    return {
      address: addressForPrivateKey(privateKey),
      privateKey,
    };
  }
  return {
    address: provider ? await defaultHardhatAccount(provider) : undefined,
    privateKey: undefined,
  };
}

export async function resolveMigrationSigners({
  args,
  networkConfig,
  provider,
  ownerFallback,
  taskName,
}: {
  args: MigrationSignerArgs;
  networkConfig: { accounts?: unknown };
  provider?: RpcAccountProvider;
  ownerFallback: "deployer" | "hardhat";
  taskName: string;
}): Promise<MigrationSigners> {
  const hardhatSigner = await defaultHardhatSigner(networkConfig, provider);
  const deployer = optionalAddress(args.deployer) ?? hardhatSigner.address;
  if (deployer === undefined) {
    throw new Error(
      `${taskName} could not resolve a Hardhat deployer account; configure DEPLOYER_KEY or pass --deployer`,
    );
  }

  const defaultOwner =
    ownerFallback === "deployer" ? deployer : hardhatSigner.address;
  const owner = optionalAddress(args.owner) ?? defaultOwner;
  if (owner === undefined) {
    throw new Error(
      `${taskName} could not resolve a Hardhat owner account; configure DEPLOYER_KEY or pass --owner`,
    );
  }

  const urManager =
    optionalAddress(args.urManager) ??
    (ownerFallback === "deployer" ? deployer : hardhatSigner.address);
  if (urManager === undefined) {
    throw new Error(
      `${taskName} could not resolve a Hardhat account; configure DEPLOYER_KEY or pass --ur-manager`,
    );
  }

  // Leave unset when no override is supplied so downstream deploy logic uses the
  // network-configured v1 owner rather than overriding it with the migration owner.
  const v1Owner = optionalAddress(args.v1Owner);
  const hardhatPrivateKey = hardhatSigner.privateKey;
  const hardhatAddress = hardhatSigner.address;
  return {
    deployer,
    deployerPrivateKey: privateKeyIfAddressMatches(
      deployer,
      hardhatAddress,
      hardhatPrivateKey,
    ),
    owner,
    ownerPrivateKey: privateKeyIfAddressMatches(
      owner,
      hardhatAddress,
      hardhatPrivateKey,
    ),
    v1Owner,
    v1OwnerPrivateKey: privateKeyIfAddressMatches(
      v1Owner,
      hardhatAddress,
      hardhatPrivateKey,
    ),
    urManager,
    urManagerPrivateKey: privateKeyIfAddressMatches(
      urManager,
      hardhatAddress,
      hardhatPrivateKey,
    ),
  };
}

export function logMigrationSigners(
  signers: Pick<
    MigrationSigners,
    "deployer" | "owner" | "v1Owner" | "urManager"
  >,
) {
  console.log(`migration deployer: ${signers.deployer}`);
  console.log(`migration owner: ${signers.owner}`);
  console.log(`v1 owner: ${signers.v1Owner ?? "(network default)"}`);
  console.log(`managed URP admin: ${signers.urManager}`);
}
