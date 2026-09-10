import { Artifact_DNSAliasResolver } from "generated/artifacts/DNSAliasResolver.js";
import { Artifact_DNSTLDResolver } from "generated/artifacts/DNSTLDResolver.js";
import { Artifact_DNSTXTResolver } from "generated/artifacts/DNSTXTResolver.js";
import { Artifact_ENSV1Resolver } from "generated/artifacts/ENSV1Resolver.js";
import { Artifact_ENSV2Resolver } from "generated/artifacts/ENSV2Resolver.js";
// shared
import { Abi_GatewayProvider } from "generated/abis/GatewayProvider.js";
import { Abi_DefaultReverseRegistrar } from "generated/abis/DefaultReverseRegistrar.js";
import { Abi_DefaultReverseResolver } from "generated/abis/DefaultReverseResolver.js";
import { Abi_ReverseRegistrar } from "generated/abis/ReverseRegistrar.js";
import { Abi_ReverseRegistrarAdapter } from "generated/abis/ReverseRegistrarAdapter.js";
import { Abi_DefaultReverseRegistrarAdapter } from "generated/abis/DefaultReverseRegistrarAdapter.js";
import { Abi_NameCoder } from "generated/abis/NameCoder.js";
// v1
import { Abi_Root } from "generated/abis/Root.js";
import { Abi_ENSRegistry } from "generated/abis/ENSRegistry.js";
import { Abi_BaseRegistrarImplementation } from "generated/abis/BaseRegistrarImplementation.js";
import { Abi_NameWrapper } from "generated/abis/NameWrapper.js";
import { Abi_RegistrarSecurityController } from "generated/abis/RegistrarSecurityController.js";
import { Abi_PublicResolver } from "generated/abis/PublicResolver.js";
import { Abi_UniversalResolver } from "generated/abis/UniversalResolver.js";
// v2
import { Abi_ContractNamer } from "generated/abis/ContractNamer.js";
import { Abi_LabelStore } from "generated/abis/LabelStore.js";
import { Abi_VerifiableFactory } from "generated/abis/VerifiableFactory.js";
import { Abi_PermissionedRegistry } from "generated/abis/PermissionedRegistry.js";
import { Abi_StandardRentPriceOracle } from "generated/abis/StandardRentPriceOracle.js";
import { Abi_ETHRegistrar } from "generated/abis/ETHRegistrar.js";
import { Abi_ETHRenewerV1 } from "generated/abis/ETHRenewerV1.js";
import { Abi_PermissionedResolver } from "generated/abis/PermissionedResolver.js";
import { Abi_UserRegistry } from "generated/abis/UserRegistry.js";
import { Abi_WrapperRegistry } from "generated/abis/WrapperRegistry.js";
import { Abi_UnlockedMigrationController } from "generated/abis/UnlockedMigrationController.js";
import { Abi_LockedMigrationController } from "generated/abis/LockedMigrationController.js";
import { Abi_Graveyard } from "generated/abis/Graveyard.js";
import { Abi_PermissionedAddressSet } from "generated/abis/PermissionedAddressSet.js";
import { Abi_UniversalHelper } from "generated/abis/UniversalHelper.js";
import { Abi_UniversalResolverV2 } from "generated/abis/UniversalResolverV2.js";
import { Abi_PublicResolverV2 } from "generated/abis/PublicResolverV2.js";
import { Abi_MigrationHelper } from "generated/abis/src/migration/MigrationHelper.sol/MigrationHelper.js";
// erc20
import { Abi_MockERC20 } from "generated/abis/test/mocks/MockERC20.sol/MockERC20.js";
// hca
import { Abi_MockRegistrationIntentExecutor } from "generated/abis/MockRegistrationIntentExecutor.js";
import { Abi_HCAOwnerAndSessionValidator } from "generated/abis/HCAOwnerAndSessionValidator.js";
import { Abi_StandaloneSingleOwnerHCA } from "generated/abis/StandaloneSingleOwnerHCA.js";
import { Abi_StandaloneHCAFactory } from "generated/abis/StandaloneHCAFactory.js";
//
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { anvil as createAnvil } from "prool/instances";
import type {
  UnresolvedNetworkSpecificData,
  UnresolvedUnknownNamedAccounts,
  UserConfig,
} from "rocketh/types";
import {
  type Account,
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  getContract,
  type Hex,
  hexToString,
  keccak256,
  namehash,
  publicActions,
  slice,
  stringToHex,
  testActions,
  http,
  zeroAddress,
  defineChain,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { loadAndExecuteDeploymentsFromFilesWithConfig } from "../rocketh/environment.js";
import {
  computeVerifiableProxyAddress as computeVerifiableProxyAddress_,
  deployVerifiableProxy,
} from "../test/integration/fixtures/deployVerifiableProxy.js";
import {
  COIN_TYPE_ETH,
  dnsEncodeName,
  getReverseName,
  splitName,
} from "../test/utils/utils.js";
import { waitForSuccessfulTransactionReceipt } from "../test/utils/waitForSuccessfulTransactionReceipt.js";
import {
  LOCAL_BATCH_GATEWAY_URL,
  MAX_EXPIRY,
  ROLES,
} from "./deploy-constants.js";
import { patchArtifactsV1 } from "./patchArtifactsV1.js";
import { bootstrapForkDeployments, ENS_DAO_MULTISIG } from "./forkBootstrap.js";

const NAMED_ACCOUNTS = ["deployer", "owner", "user", "user2"] as const;

export type StateSnapshot = () => Promise<void>;
export type DevnetEnvironment = Awaited<ReturnType<typeof setupDevnet>>;
export type DevnetAccount =
  DevnetEnvironment["namedAccounts"][(typeof NAMED_ACCOUNTS)[number]];

function ansi(c: unknown, s: unknown) {
  return `\x1b[${c}m${s}\x1b[0m`;
}

export async function setupDevnet({
  port = 0,
  chainId = 31337,
  mnemonic = "test test test test test test test test test test test junk",
  saveDeployments = false,
  quiet = !saveDeployments,
  procLog = false,
  extraTime = 0,
  forkUrl,
  forkBlockNumber,
}: {
  port?: number;
  chainId?: number;
  mnemonic?: string;
  saveDeployments?: boolean;
  quiet?: boolean;
  procLog?: boolean; // show anvil process logs
  extraTime?: number; // extra time to subtract from genesis timestamp
  forkUrl?: string; // when set, anvil forks from this RPC URL
  forkBlockNumber?: bigint; // optional fork block; defaults to latest
} = {}) {
  const isFork = !!forkUrl;
  // shutdown functions for partial initialization
  const finalizers: (() => unknown | Promise<unknown>)[] = [];
  async function shutdown() {
    await Promise.allSettled(finalizers.map((f) => f()));
  }
  let unquiet = () => {};
  if (quiet) {
    const { log, table } = console;
    console.log = () => {};
    console.table = () => {};
    unquiet = () => {
      console.log = log;
      console.table = table;
    };
  }
  try {
    console.log("Deploying ENSv2...");
    await patchArtifactsV1();

    process.env.RUST_LOG = "info"; // required to capture console.log()
    const anvilInstance = createAnvil({
      accounts: NAMED_ACCOUNTS.length,
      mnemonic,
      // when forking, anvil derives chainId from the upstream RPC; the bare
      // `chainId` flag is omitted so anvil takes the upstream value
      ...(isFork ? {} : { chainId }),
      port,
      // autoImpersonate lets the deploy flow sign as any address (e.g. the DAO
      // multisig mapped to `owner` on chainId 1) without explicit unlocking.
      // omitted in non-fork mode — prool encodes `false` as a positional arg
      // rather than dropping the flag, which trips anvil's subcommand parser.
      ...(isFork ? { autoImpersonate: true, forkUrl, forkBlockNumber } : {}),
      ...(extraTime && !isFork
        ? { timestamp: Math.floor(Date.now() / 1000) - extraTime }
        : {}),
    });

    const accounts = NAMED_ACCOUNTS.map((name, i) =>
      Object.assign(mnemonicToAccount(mnemonic, { addressIndex: i }), {
        name,
      }),
    );

    console.log("Launching devnet");
    await anvilInstance.start();
    finalizers.push(() => anvilInstance.stop());

    let showConsole = true;
    const log = (chunk: string) => {
      // ref: https://github.com/adraffy/blocksmith.js/blob/main/src/Foundry.js#L991
      const lines = chunk.split("\n").flatMap((line) => {
        if (!line) return [];
        // "2025-10-08T18:08:32.755539Z  INFO node::console: hello world"
        // "2025-10-09T16:21:27.441327Z  INFO node::user: eth_estimateGas"
        // "2025-10-09T16:24:09.289838Z  INFO node::user:     Block Number: 17"
        // "2025-10-09T16:31:48.449325Z  INFO node::user:"
        // "2025-10-09T16:31:48.451639Z  WARN backend: Skipping..."
        const match = line.match(
          /^.{27} {2}([A-Z]+) (\w+(?:|::\w+)):(?:$| (.*)$)/,
        );
        if (match) {
          const [, , kind, action] = match;
          if (/^\s*$/.test(action)) return []; // collapse whitespace
          if (kind === "node::user" && /^\w+$/.test(action)) {
            showConsole = action !== "eth_estimateGas"; // detect if inside gas estimation
          }
          if (kind === "node::console") {
            return showConsole ? line : []; // ignore console during gas estimation
          }
        }
        if (!procLog) return [];
        return ansi(36, line);
      });
      if (!lines.length) return;
      console.log(lines.join("\n"));
    };
    anvilInstance.on("message", log);
    finalizers.push(() => anvilInstance.off("message", log));

    // parse `host:port` from the anvil boot message
    const hostPort = (() => {
      const message = anvilInstance.messages.get().join("\n").trim();
      const match = message.match(/Listening on (.*)$/);
      if (!match) throw new Error(`expected host: ${message}`);
      return match[1];
    })();

    const httpURL = `http://${hostPort}`;

    // when forking, anvil reports the upstream chainId — pull it from the live
    // node so downstream chain definition + deployments dir name reflect reality
    const activeChainId = isFork
      ? await createPublicClient({ transport: http(httpURL) }).getChainId()
      : chainId;

    const chain = defineChain({
      id: activeChainId,
      name: "ENSv2",
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: "ETH",
      },
      rpcUrls: {
        default: {
          http: [httpURL],
          webSocket: [`ws://${hostPort}`],
        },
      },
    });

    const transport = http(httpURL, {
      retryCount: 1,
      timeout: 10000,
    });

    function createClient(account: Account) {
      return createWalletClient({
        transport,
        chain,
        account,
        pollingInterval: 50,
        cacheTime: 0, // must be 0 due to client caching
      })
        .extend(publicActions)
        .extend(testActions({ mode: "anvil" }));
    }

    const client = createClient(accounts[0]);

    // Mock the EIP-7951 P-256 precompile at address 0x100.
    // ens-contracts v1.7.0 replaced the pure-Solidity EllipticCurve library with
    // a call to this precompile for DNSSEC P256SHA256 signature verification.
    // Anvil does not yet support EIP-7951 (requires Osaka/Fusaka hardfork), so we
    // deploy minimal bytecode that always returns 0x00...01 (valid signature).
    // Bytecode: PUSH1 0x01, PUSH0, MSTORE, PUSH1 0x20, PUSH0, RETURN
    await client.request({
      method: "anvil_setCode" as any,
      params: [
        "0x0000000000000000000000000000000000000100",
        "0x60015f5260205ff3",
      ],
    });

    console.log("Deploying contracts");
    const deploymentName = `devnet-${activeChainId}`;
    const deploymentsDirURL = new URL(
      `../deployments/${deploymentName}`,
      import.meta.url,
    );
    if (saveDeployments) {
      await rm(deploymentsDirURL, {
        recursive: true,
        force: true,
      });
    }
    if (isFork) {
      await bootstrapForkDeployments({
        client,
        deploymentsDir: fileURLToPath(deploymentsDirURL),
        canonicalDir: fileURLToPath(
          new URL("../lib/ens-contracts/deployments/mainnet", import.meta.url),
        ),
        chainId: activeChainId,
      });
    }
    process.env.BATCH_GATEWAY_URLS = JSON.stringify([LOCAL_BATCH_GATEWAY_URL]);
    const rocketh = await loadAndExecuteDeploymentsFromFilesWithConfig(
      {
        environment: deploymentName,
        askBeforeProceeding: false,
        saveDeployments,
        defaultPollingInterval: 0.001, // cannot be zero
      },
      {
        accounts: Object.fromEntries(
          accounts.map((x) => [x.name, x.address]),
        ) as never,
        chains: {
          [activeChainId]: {
            info: chain,
            rpcUrl: httpURL,
            pollingInterval: 0.001,
            tags: [
              "v2",
              "local",
              "use_root", // deploy root contracts
              "allow_unsafe", // state hacks
              "legacy", // legacy registry
              "tenderly", // let ENS deploy scripts run full setup on chain id 1 forks
            ],
          },
        },
        environments: {
          [deploymentName]: {
            chain: activeChainId,
            // on fork, v1 contracts come from the live mainnet state we just
            // pre-populated; only the v2 deploy scripts run on top
            scripts: isFork
              ? ["deploy"]
              : ["lib/ens-contracts/deploy", "deploy"],
          },
        },
      } satisfies UserConfig<
        UnresolvedUnknownNamedAccounts,
        UnresolvedNetworkSpecificData
      >,
    );
    console.log("Deployed contracts");

    // note: TypeScript is too slow when the following is generalized
    const shared = {
      BatchGatewayProvider: getContract({
        abi: Abi_GatewayProvider,
        address: rocketh.get("BatchGatewayProvider").address,
        client,
      }),
      DNSSECGatewayProvider: getContract({
        abi: Abi_GatewayProvider,
        address: rocketh.get("DNSSECGatewayProvider").address,
        client,
      }),
      DefaultReverseRegistrar: getContract({
        abi: Abi_DefaultReverseRegistrar,
        address: rocketh.get("DefaultReverseRegistrar").address,
        client,
      }),
      DefaultReverseResolver: getContract({
        abi: Abi_DefaultReverseResolver,
        address: rocketh.get("DefaultReverseResolver").address,
        client,
      }),
      ReverseRegistrar: getContract({
        abi: Abi_ReverseRegistrar,
        address: rocketh.get("ReverseRegistrar").address,
        client,
      }),
      ReverseRegistrarAdapter: getContract({
        abi: Abi_ReverseRegistrarAdapter,
        address: rocketh.get("ReverseRegistrarAdapter").address,
        client,
      }),
      DefaultReverseRegistrarAdapter: getContract({
        abi: Abi_DefaultReverseRegistrarAdapter,
        address: rocketh.get("DefaultReverseRegistrarAdapter").address,
        client,
      }),
    };

    const v1 = {
      Root: getContract({
        abi: Abi_Root,
        address: rocketh.get("Root").address,
        client,
      }),
      ENSRegistry: getContract({
        abi: Abi_ENSRegistry,
        address: rocketh.get("ENSRegistry").address,
        client,
      }),
      BaseRegistrar: getContract({
        abi: Abi_BaseRegistrarImplementation,
        address: rocketh.get("BaseRegistrarImplementation").address,
        client,
      }),
      NameWrapper: getContract({
        abi: Abi_NameWrapper,
        address: rocketh.get("NameWrapper").address,
        client,
      }),
      RegistrarSecurityController: getContract({
        abi: Abi_RegistrarSecurityController,
        address: rocketh.get("RegistrarSecurityController").address,
        client,
      }),
      // resolvers
      PublicResolver: getContract({
        abi: Abi_PublicResolver,
        address: rocketh.get("PublicResolver").address,
        client,
      }),
      UniversalResolver: getContract({
        abi: Abi_UniversalResolver,
        address: rocketh.get("UniversalResolver").address,
        client,
      }),
    };

    const Abi_NameCoderErrors = Abi_NameCoder.filter((x) => x.type === "error");
    const v2 = {
      ContractNamer: getContract({
        abi: Abi_ContractNamer,
        address: rocketh.get("ContractNamer").address,
        client,
      }),
      LabelStore: getContract({
        abi: Abi_LabelStore,
        address: rocketh.get("LabelStore").address,
        client,
      }),
      VerifiableFactory: getContract({
        abi: Abi_VerifiableFactory,
        address: rocketh.get("VerifiableFactory").address,
        client,
      }),
      RootRegistry: getContract({
        abi: [...Abi_PermissionedRegistry, ...Abi_NameCoderErrors],
        address: rocketh.get("RootRegistry").address,
        client,
      }),
      ETHRegistry: getContract({
        abi: [...Abi_PermissionedRegistry, ...Abi_NameCoderErrors],
        address: rocketh.get("ETHRegistry").address,
        client,
      }),
      // eth registrar
      StandardRentPriceOracle: getContract({
        abi: Abi_StandardRentPriceOracle,
        address: rocketh.get("StandardRentPriceOracle").address,
        client,
      }),
      ETHRegistrar: getContract({
        abi: Abi_ETHRegistrar,
        address: rocketh.get("ETHRegistrar").address,
        client,
      }),
      ETHRenewerV1: getContract({
        abi: Abi_ETHRenewerV1,
        address: rocketh.get("ETHRenewerV1").address,
        client,
      }),
      // VerifiableFactory implementations
      PermissionedResolverImpl: getContract({
        abi: Abi_PermissionedResolver,
        address: rocketh.get("PermissionedResolverImpl").address,
        client,
      }),
      UserRegistryImpl: getContract({
        abi: [...Abi_UserRegistry, ...Abi_NameCoderErrors],
        address: rocketh.get("UserRegistryImpl").address,
        client,
      }),
      WrapperRegistryImpl: getContract({
        abi: Abi_WrapperRegistry,
        address: rocketh.get("WrapperRegistryImpl").address,
        client,
      }),
      // migration
      UnlockedMigrationController: getContract({
        abi: [...Abi_UnlockedMigrationController, ...Abi_NameCoderErrors],
        address: rocketh.get("UnlockedMigrationController").address,
        client,
      }),
      LockedMigrationController: getContract({
        abi: [...Abi_LockedMigrationController, ...Abi_NameCoderErrors],
        address: rocketh.get("LockedMigrationController").address,
        client,
      }),
      MigrationHelper: getContract({
        abi: Abi_MigrationHelper,
        address: rocketh.get("MigrationHelper").address,
        client,
      }),
      Graveyard: getContract({
        abi: Abi_Graveyard,
        address: rocketh.get("Graveyard").address,
        client,
      }),
      PublicResolverSet: getContract({
        abi: Abi_PermissionedAddressSet,
        address: rocketh.get("PublicResolverSet").address,
        client,
      }),
      RegistryUpgradeSet: getContract({
        abi: Abi_PermissionedAddressSet,
        address: rocketh.get("RegistryUpgradeSet").address,
        client,
      }),
      // universal
      UniversalResolver: getContract({
        abi: Abi_UniversalResolverV2,
        address: rocketh.get("UniversalResolverV2").address,
        client,
      }),
      UniversalHelper: getContract({
        abi: Abi_UniversalHelper,
        address: rocketh.get("UniversalHelper").address,
        client,
      }),
      // resolvers
      DNSTLDResolver: getContract({
        abi: Artifact_DNSTLDResolver.abi,
        address: rocketh.get("DNSTLDResolver").address,
        client,
      }),
      DNSTXTResolver: getContract({
        abi: Artifact_DNSTXTResolver.abi,
        address: rocketh.get("DNSTXTResolver").address,
        client,
      }),
      DNSAliasResolver: getContract({
        abi: Artifact_DNSAliasResolver.abi,
        address: rocketh.get("DNSAliasResolver").address,
        client,
      }),
      ENSV1Resolver: getContract({
        abi: Artifact_ENSV1Resolver.abi,
        address: rocketh.get("ENSV1Resolver").address,
        client,
      }),
      ENSV2Resolver: getContract({
        abi: Artifact_ENSV2Resolver.abi,
        address: rocketh.get("ENSV2Resolver").address,
        client,
      }),
      PublicResolver: getContract({
        abi: Abi_PublicResolverV2,
        address: rocketh.get("PublicResolverV2").address,
        client,
      }),
    };

    const erc20 = {
      MockUSDC: getContract({
        abi: Abi_MockERC20,
        address: rocketh.get("MockUSDC").address,
        client,
      }),
      MockDAI: getContract({
        abi: Abi_MockERC20,
        address: rocketh.get("MockDAI").address,
        client,
      }),
    };

    const hca = {
      MockRegistrationIntentExecutor: getContract({
        abi: Abi_MockRegistrationIntentExecutor,
        address: rocketh.get("MockRegistrationIntentExecutor").address,
        client,
      }),
      HCAOwnerAndSessionValidator: getContract({
        abi: Abi_HCAOwnerAndSessionValidator,
        address: rocketh.get("HCAOwnerAndSessionValidator").address,
        client,
      }),
      StandaloneHCAImplementation: getContract({
        abi: Abi_StandaloneSingleOwnerHCA,
        address: rocketh.get("StandaloneHCAImplementation").address,
        client,
      }),
      StandaloneHCAFactory: getContract({
        abi: Abi_StandaloneHCAFactory,
        address: rocketh.get("StandaloneHCAFactory").address,
        client,
      }),
      HCAUpgradeSet: getContract({
        abi: Abi_PermissionedAddressSet,
        address: rocketh.get("HCAUpgradeSet").address,
        client,
      }),
    };

    const verifiableProxyLogic = await v2.VerifiableFactory.read.proxyLogic();

    [shared, v1, v2, erc20, hca]
      .flatMap((x) => Object.values(x))
      .forEach(patchContractWrite);
    console.log("Linked contracts");

    const namedAccounts = Object.fromEntries(
      await Promise.all(
        accounts.map(async (account) => {
          const resolver = await deployPermissionedResolver({
            account,
            salt: { ownedVersion: 0n },
          });
          return [account.name, Object.assign(account, { resolver })];
        }),
      ),
    ) as Record<
      (typeof NAMED_ACCOUNTS)[number],
      (typeof accounts)[number] & {
        resolver: Awaited<ReturnType<typeof deployPermissionedResolver>>;
      }
    >;
    console.log("Created PermissionedResolver for each account");

    // on fork, ens.eth already exists on canonical v1 with real subdomains;
    // skip the synthetic register-and-seed step to avoid colliding with state
    if (!isFork) {
      await setupEnsDotEth();
      console.log("Setup ens.eth");
    }

    console.log("Deployed ENSv2");
    return {
      client,
      hostPort,
      accounts,
      namedAccounts,
      rocketh,
      shared,
      v1,
      v2,
      erc20,
      hca,
      sync,
      waitFor,
      saveState,
      shutdown,
      createClient,
      computeVerifiableProxyAddress,
      computeUserRegistrySalt,
      computeOwnedResolverSalt,
      castUserRegistry,
      castPermissionedResolver,
      deployUserRegistry,
      deployPermissionedResolver,
      findPermissionedRegistry,
      findWrapperRegistry,
      patchContractWrite,
      activateV2,
    };

    async function waitFor(hash: Hex | Promise<Hex>) {
      return waitForSuccessfulTransactionReceipt(client, {
        hash: await hash,
      });
    }

    // inject waitForSuccessfulTransactionReceipt into viem contract wrapper
    function patchContractWrite<T extends object>(contract: T): T {
      if ("write" in contract) {
        const write0 = contract.write as Record<
          string,
          (...parameters: unknown[]) => Promise<Hex>
        >;
        contract.write = new Proxy(
          {},
          {
            get(_, functionName: string) {
              return async (...parameters: unknown[]) => {
                const promise = write0[functionName](...parameters);
                const receipt = await waitFor(
                  functionName === "safeTransferFrom" ||
                    functionName === "safeBatchTransferFrom"
                    ? promise.catch(handleTransferError) // v1 abi lacks v2 errors
                    : promise,
                );
                return receipt.transactionHash;
              };
            },
          },
        );
      }
      return contract;
    }

    async function saveState(): Promise<StateSnapshot> {
      let state = await client.request({ method: "evm_snapshot" } as any);
      let block0 = await client.getBlock();
      return async () => {
        const block1 = await client.getBlock();
        if (block0.stateRoot === block1.stateRoot) return; // noop, assuming no setStorageAt
        const ok = await client.request({
          method: "evm_revert",
          params: [state],
        } as any);
        if (!ok) throw new Error("revert failed");
        // apparently the snapshots cannot be reused
        state = await client.request({ method: "evm_snapshot" } as any);
        block0 = await client.getBlock();
      };
    }

    async function sync({
      blocks = 1,
      warpSec = "local",
    }: {
      blocks?: number;
      warpSec?: number | "local";
    } = {}) {
      const block = await client.getBlock();
      let timestamp = Number(block.timestamp);
      if (warpSec === "local") {
        timestamp = Math.max(timestamp, (Date.now() / 1000) | 0);
      } else {
        timestamp += warpSec;
      }
      await client.mine({
        blocks,
        interval: timestamp - Number(block.timestamp),
      });
      return BigInt(timestamp);
    }

    function computeVerifiableProxyAddress(deployer: Address, salt: bigint) {
      return computeVerifiableProxyAddress_({
        factoryAddress: v2.VerifiableFactory.address,
        proxyLogic: verifiableProxyLogic as Address,
        deployer,
        salt,
      });
    }

    function computeOwnedResolverSalt(owner: Address, version = 0n) {
      return BigInt(
        keccak256(
          encodeAbiParameters(
            [
              { name: "id", type: "bytes32" },
              { name: "owner", type: "address" },
              { name: "version", type: "uint256" },
            ],
            [keccak256(stringToHex("OwnedResolver")), owner, version],
          ),
        ),
      );
    }

    function computeUserRegistrySalt(name: string, version = 0n) {
      return BigInt(
        keccak256(
          encodeAbiParameters(
            [
              { name: "id", type: "bytes32" },
              { name: "node", type: "bytes32" },
              { name: "version", type: "uint256" },
            ],
            [keccak256(stringToHex("UserRegistry")), namehash(name), version],
          ),
        ),
      );
    }

    async function deployPermissionedResolver({
      account, // deployer
      admin = account.address,
      roles = ROLES.ALL,
      calls = [],
      salt,
    }: {
      account: Account;
      admin?: Address;
      roles?: bigint;
      calls?: Hex[];
      salt?: bigint | { ownedVersion: bigint };
    }) {
      if (typeof salt === "object") {
        salt = computeOwnedResolverSalt(admin, salt.ownedVersion);
      }
      return patchContractWrite(
        await deployVerifiableProxy({
          walletClient: createClient(account),
          factoryAddress: v2.VerifiableFactory.address,
          implAddress: v2.PermissionedResolverImpl.address,
          abi: v2.PermissionedResolverImpl.abi,
          functionName: "initialize",
          args: [[[admin, roles]], calls],
          salt,
        }),
      );
    }

    async function deployUserRegistry({
      account,
      admin = account.address,
      roles = ROLES.ALL,
      salt,
    }: {
      account: Account;
      admin?: Address;
      roles?: bigint;
      salt?: bigint | { name: string; version?: bigint };
    }) {
      const implAddress = v2.UserRegistryImpl.address;
      if (typeof salt === "object") {
        salt = computeUserRegistrySalt(salt.name, salt.version);
      }
      return patchContractWrite(
        await deployVerifiableProxy({
          walletClient: createClient(account),
          factoryAddress: v2.VerifiableFactory.address,
          implAddress,
          abi: v2.UserRegistryImpl.abi,
          functionName: "initialize",
          args: [[[admin, roles]]],
          salt,
        }),
      );
    }

    function castUserRegistry(
      address: Address,
      account: Account = namedAccounts.deployer,
    ) {
      return patchContractWrite(
        getContract({
          abi: v2.UserRegistryImpl.abi,
          address,
          client: createClient(account),
        }),
      );
    }

    function castPermissionedResolver(
      address: Address,
      account: Account = namedAccounts.deployer,
    ) {
      return patchContractWrite(
        getContract({
          abi: v2.PermissionedResolverImpl.abi,
          address,
          client: createClient(account),
        }),
      );
    }

    // note: casts to UserRegistry even if PermissionRegistry
    // note: TypeScript is too slow when the following is generalized to any resolver type
    async function findPermissionedRegistry(name: string, account?: Account) {
      const address = await v2.UniversalHelper.read.findExactRegistry([
        dnsEncodeName(name),
      ]);
      if (address === zeroAddress) {
        throw new Error(`expected PermissionedRegistry: ${name}`);
      }
      // TODO: do a supportsInterface check?
      return castUserRegistry(address, account);
    }

    function computeWrapperRegistryAddress(name: string) {
      const labels = splitName(name);
      let currentName = labels.pop();
      if (currentName !== "eth" || !labels.length) {
        throw new Error(`expected .eth 2LD+: ${name}`);
      }
      let address = v2.LockedMigrationController.address;
      while (labels.length) {
        currentName = `${labels.pop()}.${currentName}`;
        address = computeVerifiableProxyAddress(
          address,
          BigInt(namehash(currentName)),
        );
      }
      return address;
    }

    function findWrapperRegistry(
      name: string,
      account: Account = namedAccounts.deployer,
    ) {
      const address = computeWrapperRegistryAddress(name);
      // this may not be deployed yet
      // this is equivalent to `findExactRegistry()` when deployed
      return patchContractWrite(
        getContract({
          abi: v2.WrapperRegistryImpl.abi,
          address,
          client: createClient(account),
        }),
      );
    }

    async function activateV2() {
      // on fork the canonical v1 contracts are owned by the DAO multisig, not
      // by the mnemonic-derived `owner` account — anvil autoImpersonate lets us
      // call onlyOwner functions by passing the DAO address as a JSON-RPC
      // account directly.
      const account: Account | Address = isFork
        ? ENS_DAO_MULTISIG
        : namedAccounts.owner;
      // lock NameWrapper if still owned (idempotent across fork + synthetic)

      if ((await v1.NameWrapper.read.owner()) !== zeroAddress) {
        await v1.NameWrapper.write.renounceOwnership({ account });
      }
      // disable every v1 path that can register .eth 2LDs by revoking it as
      // a BaseRegistrarImplementation controller (routed via
      // RegistrarSecurityController, which is BaseRegistrar's owner):
      //   - ETHRegistrarController / LegacyETHRegistrarController: direct
      //     controllers of BaseRegistrar.
      //   - NameWrapper: BaseRegistrar controller through which the
      //     WrappedETHRegistrarController registers wrapped 2LDs.
      //   - WrappedETHRegistrarController: not actually a BaseRegistrar
      //     controller on canonical mainnet (it routes through NameWrapper),
      //     but is on the synthetic devnet; included for parity.
      // BaseRegistrarImplementation.removeController is idempotent (sets
      // controllers[x]=false and emits an event), so revoking an address
      // that isn't currently registered is a harmless no-op. The
      // LegacyETHRegistrarController rocketh artifact is pre-populated by
      // `bootstrapForkDeployments` in fork mode and by the v1 deploy scripts
      // in synthetic-devnet mode.
      const v1ControllerNames = [
        "ETHRegistrarController",
        "LegacyETHRegistrarController",
        "NameWrapper",
      ] as const;
      for (const name of v1ControllerNames) {
        await v1.RegistrarSecurityController.write.removeRegistrarController(
          [rocketh.get(name).address],
          { account },
        );
      }
      // add v2 eth controllers
      await v1.RegistrarSecurityController.write.addRegistrarController(
        [v2.Graveyard.address],
        { account },
      );
      await v1.RegistrarSecurityController.write.addRegistrarController(
        [v2.ETHRenewerV1.address],
        { account },
      );
      // on fork, also grant deployer registrar-controller rights so morticia's
      // e2e harness can call into v1.BaseRegistrar from the test mnemonic
      // (matches the synthetic devnet's implicit "deployer can register" stance)
      if (isFork) {
        await v1.RegistrarSecurityController.write.addRegistrarController(
          [namedAccounts.deployer.address],
          { account },
        );
      }
      // transfer to syncer for juggling
      await v1.RegistrarSecurityController.write.transferRegistrarOwnership(
        [v2.ETHRenewerV1.address],
        { account },
      );
      // TODO: delay grant of registar/renewer-related roles until here?
    }

    async function setupEnsDotEth() {
      const { resolver } = namedAccounts.owner;

      // temporary registration of "ens.eth" by deployer
      // (normally would be migrated by current ens.eth owner)
      // Deployer has REGISTRAR_ADMIN but not REGISTRAR; grant self REGISTRAR for setup
      await v2.ETHRegistry.write.grantRootRoles([
        ROLES.REGISTRY.REGISTRAR,
        namedAccounts.deployer.address,
      ]);
      // create "ens.eth" (owner gets full roles for devnet setup)
      await v2.ETHRegistry.write.register([
        "ens",
        namedAccounts.owner.address,
        zeroAddress,
        resolver.address,
        ROLES.ALL,
        MAX_EXPIRY,
      ]);

      await setName("namer", v2.ContractNamer.address);

      await setName("root", v2.RootRegistry.address);
      await setName("registry", v2.ETHRegistry.address);
      await setName("impl.registry", v2.UserRegistryImpl.address);
      await setName("impl.wrapper-registry", v2.WrapperRegistryImpl.address);

      await setName("2to1.resolver", v2.ENSV1Resolver.address);
      await setName("1to2.resolver", v2.ENSV2Resolver.address);
      await setName("impl.resolver", v2.PermissionedResolverImpl.address);
      await setName("universal", v2.UniversalResolver.address);
      await setName("impl.universal", v2.UniversalResolver.address); // devnet doesn't deploy a proxy
      await setName("helper", v2.UniversalHelper.address);
      await setName("public.resolver", v2.PublicResolver.address);
      await setName("dns.resolver", v2.DNSTLDResolver.address);

      await setName("dnsname", v2.DNSTXTResolver.address); // remap v1 ExtendedDNSResolver
      await setName("dnstxt", v2.DNSTXTResolver.address); // TODO: could just use "dnsname"?
      await setName("dnsalias", v2.DNSAliasResolver.address);

      await setName("registrar", v2.ETHRegistrar.address);
      await setName("renewer", v2.ETHRenewerV1.address);
      await setName("oracle", v2.StandardRentPriceOracle.address);
      // await setName("batch.migration", v2.BatchRegistrar.address); // this is only used internally for premigration
      await setName("addr.reverse", shared.ReverseRegistrarAdapter.address);
      await setName(
        "default.reverse",
        shared.DefaultReverseRegistrarAdapter.address,
      );

      await setName(
        "unlocked.migration",
        v2.UnlockedMigrationController.address,
      );
      await setName("locked.migration", v2.LockedMigrationController.address);
      await setName("graveyard", v2.Graveyard.address);
      await setName("helper.migration", v2.MigrationHelper.address);
      await setName("upgradeset.registry", v2.RegistryUpgradeSet.address);
      await setName("prset.migration", v2.PublicResolverSet.address);

      await setName("batch.gateways", shared.BatchGatewayProvider.address);
      await setName("dnssec.gateways", shared.DNSSECGatewayProvider.address);
      await setName("labelstore", v2.LabelStore.address);
      await setName("verifiable-factory", v2.VerifiableFactory.address);

      async function setName(
        prefix: string,
        address: Address,
        namer = namedAccounts.owner,
      ) {
        const name = `${prefix}.ens.eth`;
        try {
          await shared.ReverseRegistrarAdapter.write.claim(
            [address, resolver.address],
            { account: namer },
          );
          await resolver.write.setName([
            dnsEncodeName(getReverseName(address)),
            name,
          ]);
        } catch (err) {
          console.log(`Cannot name: ${name}`);
        }
        await resolver.write.setAddress([
          dnsEncodeName(name),
          COIN_TYPE_ETH,
          address,
        ]);
      }
    }

    function handleTransferError(err: unknown): never {
      // see: WrappedErrorLib.sol
      const ERROR_STRING_SELECTOR = "0x08c379a0";
      const WRAPPED_ERROR_PREFIX = stringToHex("WrappedError::0x");
      if (err instanceof ContractFunctionExecutionError) {
        if (err.cause instanceof ContractFunctionRevertedError) {
          let { raw } = err.cause;
          if (raw?.startsWith(ERROR_STRING_SELECTOR)) {
            [raw] = decodeAbiParameters([{ type: "bytes" }], slice(raw, 4));
            if (raw.startsWith(WRAPPED_ERROR_PREFIX)) {
              raw = `0x${hexToString(slice(raw, 16))}`;
            }
          }
          const abi = [
            ...v2.UnlockedMigrationController.abi,
            ...v2.LockedMigrationController.abi,
            ...v2.WrapperRegistryImpl.abi,
          ];
          const newErr = new ContractFunctionRevertedError({
            abi,
            data: raw,
            functionName: err.functionName,
          });
          if (newErr.data) {
            throw new ContractFunctionExecutionError(newErr, err);
          }
        }
      }
      throw err;
    }
  } catch (err) {
    await shutdown();
    throw err;
  } finally {
    unquiet();
  }
}
