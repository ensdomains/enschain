import type { NetworkConnection } from "hardhat/types/network";
import { type Address, encodeFunctionData, type Hex, zeroAddress } from "viem";
import {
  DEPLOYMENT_ROLES,
  LOCAL_BATCH_GATEWAY_URL,
  MAX_EXPIRY,
  ROLES,
} from "../../../script/deploy-constants.js";
import { splitName, idFromLabel } from "../../utils/utils.js";
import { deployVerifiableProxy } from "./deployVerifiableProxy.js";

export async function deployV2Fixture(
  network: NetworkConnection,
  enableCcipRead = false,
) {
  const publicClient = await network.viem.getPublicClient({
    ccipRead: enableCcipRead ? undefined : false,
  });
  const [walletClient] = await network.viem.getWalletClients();
  const contractNamerImpl = await network.viem.deployContract("ContractNamer");
  const contractNamerProxy = await network.viem.deployContract("ERC1967Proxy", [
    contractNamerImpl.address,
    encodeFunctionData({
      abi: contractNamerImpl.abi,
      functionName: "initialize",
      args: [walletClient.account.address],
    }),
  ]);
  const contractNamer = await network.viem.getContractAt(
    "ContractNamer",
    contractNamerProxy.address,
  );
  const labelStore = await network.viem.deployContract("LabelStore", [
    contractNamer.address,
  ]);
  const rootRegistry = await network.viem.deployContract(
    "PermissionedRegistry",
    [
      labelStore.address,
      walletClient.account.address,
      DEPLOYMENT_ROLES.ROOT_REGISTRY_ROOT,
    ],
  );
  const ethRegistry = await network.viem.deployContract(
    "PermissionedRegistry",
    [
      labelStore.address,
      walletClient.account.address,
      DEPLOYMENT_ROLES.ETH_REGISTRY_ROOT,
    ],
  );
  const batchGatewayProvider = await network.viem.deployContract(
    "GatewayProvider",
    [walletClient.account.address, [LOCAL_BATCH_GATEWAY_URL]],
  );
  const universalResolver = await network.viem.deployContract(
    "UniversalResolverV2",
    [rootRegistry.address, batchGatewayProvider.address, contractNamer.address],
    { client: { public: publicClient } },
  );
  const universalHelper = await network.viem.deployContract("UniversalHelper", [
    rootRegistry.address,
    contractNamer.address,
  ]);
  await rootRegistry.write.register([
    "eth",
    walletClient.account.address,
    ethRegistry.address,
    zeroAddress,
    DEPLOYMENT_ROLES.ETH_TOKEN,
    MAX_EXPIRY,
  ]);
  await ethRegistry.write.setParent([rootRegistry.address, "eth"]);

  // Grant REGISTRAR so setupName can register subdomains under .eth
  await ethRegistry.write.grantRootRoles([
    ROLES.REGISTRY.REGISTRAR,
    walletClient.account.address,
  ]);
  const verifiableFactory =
    await network.viem.deployContract("VerifiableFactory");
  const PermissionedResolverImpl = await network.viem.deployContract(
    "PermissionedResolver",
    [contractNamer.address],
  );
  return {
    network,
    publicClient,
    walletClient,
    contractNamer,
    labelStore,
    rootRegistry,
    ethRegistry,
    batchGatewayProvider,
    universalResolver,
    universalHelper,
    deployPermissionedResolver,
    setupName,
  };
  async function deployPermissionedResolver({
    owner = walletClient.account.address,
    roles = ROLES.ALL,
    setters = [],
    salt = idFromLabel(new Date().toISOString()),
  }: {
    owner?: Address;
    roles?: bigint;
    setters?: Hex[];
    salt?: bigint;
  } = {}) {
    return deployVerifiableProxy({
      walletClient: await network.viem.getWalletClient(owner),
      factoryAddress: verifiableFactory.address,
      implAddress: PermissionedResolverImpl.address,
      abi: PermissionedResolverImpl.abi,
      functionName: "initialize",
      args: [[[walletClient.account.address, roles]], setters],
      salt,
    });
  }
  // creates registries up to the parent name
  // if exact, exactRegistry is setup
  async function setupName<exact_ extends boolean = false>({
    name,
    owner = walletClient.account.address,
    expiry = MAX_EXPIRY,
    roles = ROLES.ALL,
    resolverAddress,
    exact,
  }: {
    name: string;
    owner?: Address;
    expiry?: bigint;
    roles?: bigint;
    resolverAddress?: Address;
    exact?: exact_;
  }) {
    const labels = splitName(name);
    if (!labels.length) throw new Error("expected name");
    const registries = [rootRegistry];
    while (true) {
      const parentRegistry = registries[0];
      const label = labels[labels.length - registries.length];
      const state = await parentRegistry.read.getState([idFromLabel(label)]);
      const exists = state.latestOwner !== zeroAddress;
      const leaf = registries.length == labels.length;
      let registryAddress = await parentRegistry.read.getSubregistry([label]);
      if (!leaf || exact) {
        if (registryAddress === zeroAddress) {
          // registry does not exist, create it
          const registry = await network.viem.deployContract(
            "PermissionedRegistry",
            [labelStore.address, walletClient.account.address, roles],
          );
          registryAddress = registry.address;
          if (exists) {
            // label exists but registry does not exist, set it
            await parentRegistry.write.setSubregistry([
              state.tokenId,
              registryAddress,
            ]);
          }
          registries.unshift(registry);
        } else {
          registries.unshift(
            await network.viem.getContractAt(
              "PermissionedRegistry",
              registryAddress,
            ),
          );
        }
      }
      if (!exists) {
        // child does not exist, register it
        await parentRegistry.write.register([
          label,
          owner,
          registryAddress,
          (leaf && resolverAddress) || zeroAddress,
          roles,
          expiry,
        ]);
      } else if (leaf) {
        const currentResolver = await parentRegistry.read.getResolver([label]);
        if (resolverAddress && currentResolver !== resolverAddress) {
          // leaf node exists but resolver is different, set it
          await parentRegistry.write.setResolver([
            state.tokenId,
            resolverAddress,
          ]);
        }
      }
      if (leaf) {
        // invariants:
        //             labels == splitName(name) // note: opposite order of registries[]
        //            tokenId == parentRegistry.getTokenId(idFromLabel(labels[-1]))
        //  registries.length == labels.length
        //     exactRegistry? == registries[0]
        //     parentRegistry == registries[1]
        return {
          name,
          labels,
          tokenId: state.tokenId,
          parentRegistry,
          exactRegistry: (exact
            ? registries[0]
            : undefined) as exact_ extends true
            ? (typeof registries)[number]
            : undefined,
          registries: (exact
            ? registries
            : [undefined, ...registries]) as exact_ extends true
            ? typeof registries
            : [undefined, ...typeof registries],
        };
      }
    }
  }
}
