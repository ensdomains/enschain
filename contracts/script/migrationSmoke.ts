/// The smoke actions a rehearsal performs against a live chain.
///
/// These are the operations a real user would take — register a name on v1, migrate
/// it, register on v2, renew — used to prove a phase did what it claimed rather than
/// to make the migration happen. They read as a script because that is what they are:
/// each one drives a contract the way a wallet would and asserts the state that must
/// follow.

import { resolve } from "node:path";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  namehash,
  stringToHex,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { Artifact_PermissionedRegistry } from "generated/artifacts/PermissionedRegistry.js";
import { ROLES, STATUS } from "./deploy-constants.js";
import { bufferedGas } from "./migrationFixture/config.js";
import {
  DEFAULT_DEPLOYMENTS_DIR,
  errorMessageChain,
  forkChain,
  labelId,
  loadV2Deployment,
  maybeLoadV2Deployment,
  NETWORKS,
  parseNumber,
  publicClient,
  requireRpcUrl,
  requireV1Deployment,
  V1_BASE_REGISTRAR_NAME,
  V1_REGISTRATION_DURATION,
  V2_REGISTRATION_DURATION,
  waitForCommitmentAge,
  waitForSuccessfulReceipt,
  type JsonDeployment,
  type MigrationNetwork,
  type RpcProvider,
} from "./migrationPlumbing.js";
import { impersonate, walletClient } from "./migrationRpc.js";
import { V1_GRACE_PERIOD_SECONDS } from "./preMigration.js";

const REGISTRAR_ROLES = ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW;

/// The tuple the migration controllers decode from a wrapped-name transfer.
const migrationDataComponents = [
  { name: "label", type: "string" },
  { name: "owner", type: "address" },
  { name: "subregistry", type: "address" },
  { name: "resolver", type: "address" },
] as const;

export async function registerViaV1Controller({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
  privateKey,
  account,
  useRpcStateControls = true,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  useRpcStateControls?: boolean;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  const wallet = walletClient({ rpcUrl, chain, privateKey, account, provider });
  const controller = requireV1Deployment(network, "ETHRegistrarController", {
    v1DeploymentsDir,
    v1DeploymentNetwork,
  });
  const registration = {
    label,
    owner,
    duration: V1_REGISTRATION_DURATION,
    secret: zeroHash,
    resolver: zeroAddress,
    data: [],
    reverseRecord: 0,
    referrer: zeroHash,
  };
  const commitment = (await client.readContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "makeCommitment",
    args: [registration],
  })) as `0x${string}`;
  let hash = await wallet.writeContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "commit",
    args: [commitment],
  });
  await waitForSuccessfulReceipt(client, hash, `v1 commit ${label}.eth`);
  const minCommitmentAge = (await client.readContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "minCommitmentAge",
  })) as bigint;
  await waitForCommitmentAge(
    client,
    minCommitmentAge + 1n,
    useRpcStateControls,
  );
  const price = (await client.readContract({
    address: controller.address,
    abi: controller.abi,
    functionName: "rentPrice",
    args: [label, V1_REGISTRATION_DURATION],
  })) as { base: bigint; premium: bigint };
  const registerRequest = {
    address: controller.address,
    abi: controller.abi,
    functionName: "register" as const,
    args: [registration],
    value: price.base + price.premium,
    account: wallet.account,
  };
  // The estimate is the exact gas the call needs in isolation, which a nested
  // call can exceed under EIP-150's 63/64 rule once it runs for real — the
  // transaction then burns the whole limit and reverts. A buffer absorbs that.
  hash = await wallet.writeContract({
    ...registerRequest,
    gas: await bufferedGas(client, registerRequest),
  } as never);
  await waitForSuccessfulReceipt(client, hash, `v1 register ${label}.eth`);
}

export async function assertV1Owner({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
}) {
  const actualOwner = await readV1Owner({
    network,
    rpcUrl,
    chain,
    provider,
    v1DeploymentsDir,
    v1DeploymentNetwork,
    label,
  });
  if (getAddress(actualOwner) !== getAddress(owner)) {
    throw new Error(`unexpected v1 owner for ${label}.eth: ${actualOwner}`);
  }
}

export async function readV1Owner({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  const baseRegistrar = requireV1Deployment(network, V1_BASE_REGISTRAR_NAME, {
    v1DeploymentsDir,
    v1DeploymentNetwork,
  });
  return (await client.readContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "ownerOf",
    args: [labelId(label)],
  })) as Address;
}

/**
 * Asserts that `promise` rejects. When `expectedError` is given, the rejection's
 * message/cause chain must match it; otherwise unrelated failures (RPC outages,
 * wrong signer, ...) would make a negative test "pass" for the wrong reason.
 */
export async function assertRejected(
  promise: Promise<unknown>,
  message: string,
  expectedError?: string | RegExp,
) {
  let rejection: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejection = error;
    rejected = true;
  }
  if (!rejected) {
    throw new Error(message.replace("rejected", "did not reject"));
  }
  const chain = errorMessageChain(rejection);
  if (expectedError !== undefined) {
    const matches = chain.some((candidate) =>
      typeof expectedError === "string"
        ? candidate.includes(expectedError)
        : expectedError.test(candidate),
    );
    if (!matches) {
      console.error(`unexpected rejection: ${chain.join(" <- ")}`);
      throw new Error(
        `${message.replace("rejected", "rejected for an unexpected reason")}; expected ${expectedError}, got: ${chain[0] ?? String(rejection)}`,
      );
    }
  }
  console.log(message);
  console.log(`  rejection: ${chain[0] ?? String(rejection)}`);
}

export async function assertV2State({
  rpcUrl,
  chain,
  ethRegistry,
  label,
  status,
  owner,
}: {
  rpcUrl: string;
  chain: Chain;
  ethRegistry: JsonDeployment;
  label: string;
  status: number;
  owner?: Address;
}) {
  const client = publicClient(rpcUrl, chain);
  const state = (await client.readContract({
    address: ethRegistry.address,
    abi: ethRegistry.abi,
    functionName: "getState",
    args: [labelId(label)],
  })) as { status: number; latestOwner: Address };
  if (Number(state.status) !== status) {
    throw new Error(`unexpected v2 status for ${label}.eth: ${state.status}`);
  }
  if (owner && getAddress(state.latestOwner) !== getAddress(owner)) {
    throw new Error(
      `unexpected v2 owner for ${label}.eth: ${state.latestOwner}`,
    );
  }
}

export async function migrateUnwrappedV1Name({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
  privateKey,
  account,
  impersonateAccount,
  migrationController,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  impersonateAccount?: Address;
  migrationController: JsonDeployment;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  if (impersonateAccount) await impersonate(client, impersonateAccount);
  const wallet = walletClient({
    rpcUrl,
    chain,
    privateKey,
    account: account ?? impersonateAccount,
    provider,
  });
  const v1Deployments = { v1DeploymentsDir, v1DeploymentNetwork };
  const registry = requireV1Deployment(network, "ENSRegistry", v1Deployments);
  const baseRegistrar = requireV1Deployment(
    network,
    V1_BASE_REGISTRAR_NAME,
    v1Deployments,
  );
  const resolver = (await client.readContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "resolver",
    args: [namehash(`${label}.eth`)],
  })) as Address;
  const data = encodeAbiParameters(
    [{ type: "tuple", components: migrationDataComponents }],
    [{ label, owner, subregistry: zeroAddress, resolver }],
  );
  const hash = await wallet.writeContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "safeTransferFrom",
    args: [owner, migrationController.address, labelId(label), data],
  });
  await waitForSuccessfulReceipt(client, hash, `v2 commit ${label}.eth`);
}

// Wraps a v1 name, then migrates the resulting ERC-1155 to a migration controller.
//
// Wrapped names are a large share of `.eth` and travel a different path: the token
// is a NameWrapper 1155 keyed by namehash rather than a registrar 721 keyed by
// labelhash, and it lands on the unlocked or locked controller depending on its
// fuses. The rehearsal migrates only an unwrapped name, so nothing here is exercised
// against real chain state.
export async function migrateWrappedV1Name({
  network,
  rpcUrl,
  chain,
  provider,
  v1DeploymentsDir,
  v1DeploymentNetwork,
  label,
  owner,
  privateKey,
  account,
  impersonateAccount,
  migrationController,
  fuses = 0,
}: {
  network: MigrationNetwork;
  rpcUrl: string;
  chain: Chain;
  provider?: RpcProvider;
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  label: string;
  owner: Address;
  privateKey?: `0x${string}`;
  account?: Address;
  impersonateAccount?: Address;
  migrationController: JsonDeployment;
  fuses?: number;
}) {
  const client = publicClient(rpcUrl, chain, provider);
  if (impersonateAccount) await impersonate(client, impersonateAccount);
  const wallet = walletClient({
    rpcUrl,
    chain,
    privateKey,
    account: account ?? impersonateAccount,
    provider,
  });
  const v1Deployments = { v1DeploymentsDir, v1DeploymentNetwork };
  const registry = requireV1Deployment(network, "ENSRegistry", v1Deployments);
  const baseRegistrar = requireV1Deployment(
    network,
    V1_BASE_REGISTRAR_NAME,
    v1Deployments,
  );
  const nameWrapper = requireV1Deployment(
    network,
    "NameWrapper",
    v1Deployments,
  );

  // Wrapping is a 721 transfer into the wrapper with the wrap parameters as data.
  let hash = await wallet.writeContract({
    address: baseRegistrar.address,
    abi: baseRegistrar.abi,
    functionName: "safeTransferFrom",
    args: [
      owner,
      nameWrapper.address,
      labelId(label),
      encodeAbiParameters(
        [
          { name: "label", type: "string" },
          { name: "owner", type: "address" },
          { name: "fuses", type: "uint16" },
          { name: "resolver", type: "address" },
        ],
        [label, owner, fuses, zeroAddress],
      ),
    ],
  });
  await waitForSuccessfulReceipt(client, hash, `wrap ${label}.eth`);

  const resolver = (await client.readContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "resolver",
    args: [namehash(`${label}.eth`)],
  })) as Address;
  const data = encodeAbiParameters(
    [{ type: "tuple", components: migrationDataComponents }],
    [{ label, owner, subregistry: zeroAddress, resolver }],
  );

  // NameWrapper ids are namehashes, unlike the registrar's labelhash ids.
  hash = await wallet.writeContract({
    address: nameWrapper.address,
    abi: nameWrapper.abi,
    functionName: "safeTransferFrom",
    args: [
      owner,
      migrationController.address,
      BigInt(namehash(`${label}.eth`)),
      1n,
      data,
    ],
  });
  await waitForSuccessfulReceipt(client, hash, `migrate wrapped ${label}.eth`);
}

export async function registerViaV2Registrar({
  rpcUrl,
  chain,
  label,
  owner,
  privateKey,
  ethRegistrar,
  mockUsdc,
  useRpcStateControls = true,
  preFunded = false,
}: {
  rpcUrl: string;
  chain: Chain;
  label: string;
  owner: Address;
  privateKey: `0x${string}`;
  ethRegistrar: JsonDeployment;
  mockUsdc: JsonDeployment;
  useRpcStateControls?: boolean;
  // The payment token is a real one whose balance was set directly, so it has no
  // free-mint entrypoint to call.
  preFunded?: boolean;
}) {
  const client = publicClient(rpcUrl, chain);
  const wallet = walletClient({ rpcUrl, chain, privateKey });
  const payer = privateKeyToAccount(privateKey).address;
  // A registration that the registry rejects reverts with one of the registry's own
  // custom errors, which the registrar ABI does not declare — leaving the failure as
  // an undecodable selector. Merging the registry ABI in makes those errors readable,
  // so a rejection can be asserted by name instead of by "something reverted".
  const registrarAbi = [
    ...ethRegistrar.abi,
    ...Artifact_PermissionedRegistry.abi,
  ];
  const commitment = (await client.readContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "makeCommitment",
    args: [
      label,
      owner,
      zeroHash,
      zeroAddress,
      zeroAddress,
      V2_REGISTRATION_DURATION,
      zeroHash,
    ],
  })) as `0x${string}`;
  let hash = await wallet.writeContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "commit",
    args: [commitment],
  });
  await waitForSuccessfulReceipt(client, hash, `v2 commit ${label}.eth`);
  const minCommitmentAge = (await client.readContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "MIN_COMMITMENT_AGE",
  })) as bigint;
  await waitForCommitmentAge(
    client,
    minCommitmentAge + 1n,
    useRpcStateControls,
  );
  const [base, premium] = (await client.readContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "getRegisterPrice",
    args: [label, V2_REGISTRATION_DURATION, mockUsdc.address],
  })) as [bigint, bigint];
  if (!preFunded) {
    hash = await wallet.writeContract({
      address: mockUsdc.address,
      abi: mockUsdc.abi,
      functionName: "mint",
      args: [payer, base + premium],
    });
    await waitForSuccessfulReceipt(
      client,
      hash,
      `mint payment token for ${label}.eth`,
    );
  }
  hash = await wallet.writeContract({
    address: mockUsdc.address,
    abi: mockUsdc.abi,
    functionName: "approve",
    args: [ethRegistrar.address, base + premium],
  });
  await waitForSuccessfulReceipt(
    client,
    hash,
    `approve payment token for ${label}.eth`,
  );
  hash = await wallet.writeContract({
    address: ethRegistrar.address,
    abi: registrarAbi,
    functionName: "register",
    args: [
      label,
      owner,
      zeroHash,
      zeroAddress,
      zeroAddress,
      V2_REGISTRATION_DURATION,
      mockUsdc.address,
      zeroHash,
    ],
  });
  await waitForSuccessfulReceipt(client, hash, `v2 register ${label}.eth`);
}

// Renews an unmigrated v1 name through ETHRenewerV1 and asserts the whole invariant.
//
// Between the phase 3 freeze and migration opening, renewal is the only thing a name
// owner can still do, and it has to extend three places at once: the v2 reservation,
// the v1 registration, and the NameWrapper's copy of the expiry. Phase 4 currently
// proves only that the renewer is an authorized controller, which says nothing about
// whether a renewal actually works or keeps the three in step.
export async function renewViaEthRenewerV1({
  rpcUrl,
  chain,
  label,
  privateKey,
  ethRenewerV1,
  ethRegistry,
  v1BaseRegistrar,
  nameWrapper,
  mockUsdc,
  duration = V2_REGISTRATION_DURATION,
  preFunded = false,
}: {
  rpcUrl: string;
  chain: Chain;
  label: string;
  privateKey: `0x${string}`;
  ethRenewerV1: JsonDeployment;
  ethRegistry: JsonDeployment;
  v1BaseRegistrar: JsonDeployment;
  nameWrapper: JsonDeployment | null;
  mockUsdc: JsonDeployment;
  duration?: bigint;
  // See registerViaV2Registrar: a real payment token cannot be minted.
  preFunded?: boolean;
}) {
  const client = publicClient(rpcUrl, chain);
  const wallet = walletClient({ rpcUrl, chain, privateKey });
  const payer = privateKeyToAccount(privateKey).address;
  const id = labelId(label);

  const readV1Expiry = () =>
    client.readContract({
      address: v1BaseRegistrar.address,
      abi: v1BaseRegistrar.abi,
      functionName: "nameExpires",
      args: [id],
    }) as Promise<bigint>;
  const readV2Expiry = async () =>
    BigInt(
      (
        (await client.readContract({
          address: ethRegistry.address,
          abi: ethRegistry.abi,
          functionName: "getState",
          args: [id],
        })) as { expiry: bigint | number }
      ).expiry,
    );
  // NameWrapper keys its ERC-1155 ids by namehash, not by the registrar's labelhash.
  // Reading it with the registrar id returns an empty record, which would look like
  // an unwrapped name.
  const wrapperId = BigInt(namehash(`${label}.eth`));
  const readWrapperExpiry = async () => {
    if (!nameWrapper) return null;
    const [, , expiry] = (await client.readContract({
      address: nameWrapper.address,
      abi: nameWrapper.abi,
      functionName: "getData",
      args: [wrapperId],
    })) as [Address, number, bigint];
    return BigInt(expiry);
  };

  const before = {
    v1: await readV1Expiry(),
    v2: await readV2Expiry(),
    wrapper: await readWrapperExpiry(),
  };

  // Unlike registration, renewal carries no premium, so this is a single total.
  const price = (await client.readContract({
    address: ethRenewerV1.address,
    abi: ethRenewerV1.abi,
    functionName: "getRenewPrice",
    args: [label, duration, mockUsdc.address],
  })) as bigint;

  let hash: `0x${string}`;
  if (!preFunded) {
    hash = await wallet.writeContract({
      address: mockUsdc.address,
      abi: mockUsdc.abi,
      functionName: "mint",
      args: [payer, price],
    });
    await waitForSuccessfulReceipt(client, hash, `mint renewal payment`);
  }
  hash = await wallet.writeContract({
    address: mockUsdc.address,
    abi: mockUsdc.abi,
    functionName: "approve",
    args: [ethRenewerV1.address, price],
  });
  await waitForSuccessfulReceipt(client, hash, `approve renewal payment`);

  hash = await wallet.writeContract({
    address: ethRenewerV1.address,
    abi: ethRenewerV1.abi,
    functionName: "renew",
    args: [{ label, duration, referrer: zeroHash }, mockUsdc.address],
  });
  await waitForSuccessfulReceipt(client, hash, `v1 renew ${label}.eth`);

  const after = {
    v1: await readV1Expiry(),
    v2: await readV2Expiry(),
    wrapper: await readWrapperExpiry(),
  };

  // Both sides must move by the same amount. A renewal that extended only one of
  // them would leave the name renewable on v1 but expiring on v2, or the reverse.
  const v1Delta = after.v1 - before.v1;
  const v2Delta = after.v2 - before.v2;
  if (v1Delta !== duration) {
    throw new Error(
      `renewal did not extend v1 by ${duration}: ${before.v1} -> ${after.v1}`,
    );
  }
  if (v2Delta !== duration) {
    throw new Error(
      `renewal did not extend v2 by ${duration}: ${before.v2} -> ${after.v2}`,
    );
  }
  // A wrapper expiry of zero means the name is not wrapped, and `NameWrapper.renew`
  // deliberately returns early for those — there is nothing to sync. Only a wrapped
  // name carries the third copy of the expiry, and only then must it move.
  //
  // The wrapper stores the registrar expiry plus the grace period, not the registrar
  // expiry itself (`NameWrapper.renew`), so the synced value is checked against that
  // exact figure. Asserting merely that it increased would accept a sync that left
  // the wrapper a second past where it started and still report it as synchronised.
  const wrapped = before.wrapper !== null && before.wrapper > 0n;
  if (wrapped && after.wrapper !== null) {
    const expected = after.v1 + V1_GRACE_PERIOD_SECONDS;
    if (after.wrapper !== expected) {
      throw new Error(
        `renewal did not sync the NameWrapper expiry to the v1 expiry plus the grace period: wrapper ${before.wrapper} -> ${after.wrapper}, expected ${expected} (v1 ${after.v1})`,
      );
    }
  }

  const state = (await client.readContract({
    address: ethRegistry.address,
    abi: ethRegistry.abi,
    functionName: "getState",
    args: [id],
  })) as { status: number };
  if (Number(state.status) !== STATUS.RESERVED) {
    throw new Error(
      `renewal changed ${label}.eth status to ${state.status}; expected it to stay RESERVED`,
    );
  }

  console.log(
    `smoke renewal extended ${label}.eth by ${duration}s on v1 and v2${wrapped ? " and synced NameWrapper" : " (name is unwrapped)"}, still RESERVED`,
  );
}

type V2RegistrarSmokeOptions = {
  network: MigrationNetwork;
  rpcUrl?: string;
  chainId?: string;
  deploymentsDir?: string;
  deploymentNetwork?: string;
  label?: string;
  owner?: Address;
  privateKey: `0x${string}`;
  rpcStateControls?: boolean;
};

export async function runV2RegistrarSmoke(opts: V2RegistrarSmokeOptions) {
  const network = NETWORKS[opts.network];
  const rpcUrl = requireRpcUrl(opts, opts.network);
  const chainId = parseNumber(opts.chainId, network.chain.id);
  const chain = forkChain(opts.network, chainId, rpcUrl);
  const deploymentsDir = resolve(
    opts.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR,
  );
  const deploymentNetwork = opts.deploymentNetwork ?? network.environment;
  const client = publicClient(rpcUrl, chain);
  const owner = opts.owner ?? privateKeyToAccount(opts.privateKey).address;
  const label =
    opts.label ??
    `${opts.network === "mainnet" ? "mf" : "sf"}${Date.now().toString(36)}v2ok`;
  const ethRegistry = loadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistry",
  );
  const ethRegistrar = loadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "ETHRegistrar",
  );
  const mockUsdc = maybeLoadV2Deployment(
    deploymentsDir,
    deploymentNetwork,
    "MockUSDC",
  );
  if (!mockUsdc) {
    throw new Error(
      `v2 registrar smoke needs a mintable mock payment token, which is not deployed for ${deploymentNetwork}; on networks with real payment tokens, fund a whitelisted token and register directly`,
    );
  }

  const enabled = (await client.readContract({
    address: ethRegistry.address,
    abi: ethRegistry.abi,
    functionName: "hasRootRoles",
    args: [REGISTRAR_ROLES, ethRegistrar.address],
  })) as boolean;
  if (!enabled) {
    throw new Error(`ETHRegistrar is not enabled for ${deploymentNetwork}`);
  }

  const available = (await client.readContract({
    address: ethRegistrar.address,
    abi: ethRegistrar.abi,
    functionName: "isAvailable",
    args: [label],
  })) as boolean;
  if (!available) {
    throw new Error(`${label}.eth is not available for v2 registration smoke`);
  }

  console.log(
    `smoke: registering ${label}.eth via ETHRegistrar ${ethRegistrar.address}`,
  );
  await registerViaV2Registrar({
    rpcUrl,
    chain,
    label,
    owner,
    privateKey: opts.privateKey,
    ethRegistrar,
    mockUsdc,
    useRpcStateControls: opts.rpcStateControls ?? false,
  });
  await assertV2State({
    rpcUrl,
    chain,
    ethRegistry,
    label,
    status: STATUS.REGISTERED,
    owner,
  });
  console.log(`v2 registrar registered ${label}.eth for ${owner}`);
}
