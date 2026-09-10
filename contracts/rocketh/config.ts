import * as deployExtension from "@rocketh/deploy";
import { loadDeploymentsFromFiles } from "@rocketh/node";
import type { Environment } from "@rocketh/node";
import * as proxyExtension from "@rocketh/proxy";
import * as readExecuteExtension from "@rocketh/read-execute";
import * as viemExtension from "@rocketh/viem";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Deployment,
  EIP1193TransactionReceipt,
  PendingDeployment,
  UserConfig,
} from "rocketh/types";
import { encodeFunctionData, getAddress, type Address } from "viem";

export const config = {
  accounts: {
    deployer: {
      default: 0,
    },
    owner: {
      default: 0,
      // admin is DAO on mainnet
      mainnet: "0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7",
      1: "0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7",
    },
    securityCouncil: {
      // admin of ManagedUniversalResolverProxy; set per-network to the
      // security council multisig once one is designated
      default: "deployer",
      // admin of the long-lived intermediate URP that the top URP already fronts
      sepolia: "0xffFffFFfFF52D316B7Bd028358089bc8066b8f80",
      11155111: "0xffFffFFfFF52D316B7Bd028358089bc8066b8f80",
    },
    urManager: {
      default: "securityCouncil",
    },
    v1Owner: {
      default: "owner",
      sepolia: "0x0f32b753afc8abad9ca6fe589f707755f4df2353",
      11155111: "0x0f32b753afc8abad9ca6fe589f707755f4df2353",
    },
  },
  environments: {
    mainnet: {
      chain: 1,
      scripts: ["deploy"],
      overrides: {
        tags: ["hasDao"],
      },
    },
    sepolia: {
      chain: 11155111,
      scripts: ["deploy"],
      overrides: {
        tags: ["sepolia", "hca"],
      },
    },
    "sepolia-dev": {
      chain: 11155111,
      scripts: ["deploy"],
      overrides: {
        // Treat this Sepolia-derived environment as sepolia for the known top URP
        // and other sepolia-gated setup; getV1 applies the matching v1 normalization.
        tags: ["sepolia", "dev"],
      },
    },
    "sepolia-v1-dev": {
      chain: 11155111,
      scripts: ["lib/ens-contracts/deploy"],
    },
  },
  data: {},
} as const satisfies UserConfig;

type LoadedDeployments = Awaited<ReturnType<typeof loadDeploymentsFromFiles>>;

const rockethDir = dirname(fileURLToPath(import.meta.url));
const deploymentsCache = new Map<string, Promise<LoadedDeployments>>();

type V1DeploymentOverrides = {
  v1DeploymentsDir?: string;
  v1DeploymentNetwork?: string;
  deferV1OwnerTransactions?: boolean;
  deferredV1OwnerTransactionsFile?: string;
};

const extensions = {
  ...deployExtension,
  ...proxyExtension,
  ...readExecuteExtension,
  ...viemExtension,
  execute: (env: Environment) => {
    const execute = readExecuteExtension.execute(env);
    return async (deployment: any, args: any) => {
      const extra = (env.extra ?? {}) as V1DeploymentOverrides;
      if (!extra.deferV1OwnerTransactions) return execute(deployment, args);

      const from = getAddress(env.resolveAccount(args.account));
      const v1Owner = env.namedAccounts?.v1Owner;
      const owner = env.namedAccounts?.owner;
      const deployer = env.namedAccounts?.deployer;
      // Defer writes whose signer cannot sign during a live phase-1 deploy and
      // must instead be replayed via execute-owner-txs (or a Safe): the v1 owner,
      // and the admin owner when it is a distinct account (the DAO on mainnet)
      // rather than the deployer itself.
      const role =
        v1Owner && from === getAddress(v1Owner)
          ? "v1Owner"
          : owner &&
              deployer &&
              getAddress(owner) !== getAddress(deployer) &&
              from === getAddress(owner)
            ? "owner"
            : undefined;
      if (!role) {
        return execute(deployment, args);
      }

      const data = encodeFunctionData({
        abi: deployment.abi,
        functionName: args.functionName,
        args: args.args,
      } as any);
      const deferred = {
        account: role,
        from,
        to: getAddress(deployment.address),
        value: args.value?.toString() ?? "0",
        data,
        functionName: String(args.functionName),
        args: args.args ?? [],
        message: args.message,
        deployment: deploymentNameFor(env, deployment),
      };

      env.showMessage(
        `  - Deferred ${role} tx: ${deferred.functionName} -> ${deferred.to}`,
      );
      if (extra.deferredV1OwnerTransactionsFile) {
        const file = resolve(extra.deferredV1OwnerTransactionsFile);
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(deferred, jsonReplacer)}\n`);
      }

      return deferredReceipt(deferred.from as Address, deferred.to as Address);
    };
  },
  getV1: (env: Environment) => {
    const extra = (env.extra ?? {}) as V1DeploymentOverrides;
    // Sepolia-derived environments (e.g. sepolia-dev) share the canonical sepolia v1
    // deployment set rather than one keyed by the literal environment name.
    const environment =
      extra.v1DeploymentNetwork ??
      (env.name.startsWith("sepolia") ? "sepolia" : env.name);
    const paths = extra.v1DeploymentsDir
      ? [resolve(extra.v1DeploymentsDir)]
      : [
          resolve(rockethDir, "..", "deployments", "v1"),
          resolve(rockethDir, "..", "lib", "ens-contracts", "deployments"),
        ];
    const load = (path: string) => {
      const key = `${path}:${environment}`;
      if (deploymentsCache.has(key)) return deploymentsCache.get(key)!;
      const result = loadDeploymentsFromFiles(path, environment, false);
      deploymentsCache.set(key, result);
      return result;
    };
    return async <TAbi extends deployExtension.Abi>(
      name: string,
    ): Promise<Deployment<TAbi>> => {
      for (const path of paths) {
        const { deployments } = await load(path);
        const deployment = deployments[name];
        if (deployment) return deployment as Deployment<TAbi>;
      }
      const current = env.deployments[name];
      if (current) return current as Deployment<TAbi>;
      throw new Error(`V1 deployment ${name} not found`);
    };
  },
  savePendingDeployment:
    (env: Environment) => async (pendingDeployment: PendingDeployment) => {
      const receipt = await waitForReceipt(
        env,
        pendingDeployment.transaction.hash,
      );
      const contractAddress =
        pendingDeployment.expectedAddress ?? receipt.contractAddress;
      if (!contractAddress) {
        throw new Error(
          `no contract address found for ${pendingDeployment.name}`,
        );
      }

      const { abi, ...artifactObjectWithoutABI } =
        pendingDeployment.partialDeployment;
      return env.save(pendingDeployment.name, {
        address: contractAddress,
        abi,
        ...artifactObjectWithoutABI,
        transaction: pendingDeployment.transaction,
        receipt: {
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.transactionIndex,
        },
      });
    },
};
export { extensions };

function deploymentNameFor(env: Environment, deployment: { address: Address }) {
  const target = getAddress(deployment.address);
  const found = Object.entries(env.deployments).find(([name, candidate]) => {
    // env.deployments can contain address-less entries: rocketh loads the
    // `.deployment.json` metadata file as a deployment named '.deployment'.
    // The file only exists once a deploy has completed, so this bites resume
    // runs — getAddress(undefined) would throw and abort the deploy.
    if (typeof candidate?.address !== "string") {
      console.warn(
        `  - deployment '${name}' has no address; skipping in name lookup`,
      );
      return false;
    }
    return getAddress(candidate.address) === target;
  });
  return found?.[0];
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function deferredReceipt(
  from: Address,
  to: Address,
): EIP1193TransactionReceipt {
  return {
    blockHash: `0x${"0".repeat(64)}`,
    blockNumber: "0x0",
    contractAddress: null,
    cumulativeGasUsed: "0x0",
    effectiveGasPrice: "0x0",
    from,
    gasUsed: "0x0",
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    root: `0x${"0".repeat(64)}`,
    status: "0x1",
    to,
    transactionHash: `0x${"0".repeat(64)}`,
    transactionIndex: "0x0",
    type: "0x2",
  } as unknown as EIP1193TransactionReceipt;
}

async function waitForReceipt(
  env: Environment,
  hash: `0x${string}`,
): Promise<EIP1193TransactionReceipt> {
  for (;;) {
    let receipt: EIP1193TransactionReceipt | null = null;
    try {
      receipt = (await env.network.provider.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })) as EIP1193TransactionReceipt | null;
    } catch {}
    if (receipt?.blockHash) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type HookFunctions = {
  createLegacyRegistryNames?: (env: Environment) => () => Promise<void>;
  registerLegacyNames?: (env: Environment) => () => Promise<void>;
  registerWrappedNames?: (env: Environment) => () => Promise<void>;
  registerUnwrappedNames?: (env: Environment) => () => Promise<void>;
  savePendingDeployment?: (
    env: Environment,
  ) => (
    pendingDeployment: PendingDeployment,
  ) => Promise<Deployment<deployExtension.Abi>>;
};

type Extensions = typeof extensions & HookFunctions;
type Accounts = typeof config.accounts;
type Data = typeof config.data;

export type { Accounts, Data, Extensions };
