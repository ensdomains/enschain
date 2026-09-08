import { readFileSync, writeFileSync } from "node:fs";

import {
  RhinestoneSDK,
  type CallInput,
  type RhinestoneAccount,
  type RhinestoneAccountConfig,
  type Session,
  type SignerSet,
  type StandaloneHcaAccount,
  type Transaction,
} from "@rhinestone/sdk";
import { getPermissionId } from "@rhinestone/sdk/smart-sessions";
import {
  type Address,
  concat,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
  parseSignature,
  type PublicClient,
  recoverTypedDataAddress,
  size,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, baseSepolia, sepolia } from "viem/chains";

import {
  DefaultReverseRegistrar,
  DefaultReverseRegistrarAdapter,
  ENSRegistry,
  ETHRegistrar,
  HCAFundingSessionValidator,
  HCAOwnerAndSessionValidator,
  PermissionedRegistry,
  PermissionedResolver,
  ReverseRegistrar,
  ReverseRegistrarAdapter,
  StandaloneHCAFactory,
  StandaloneSingleOwnerHCA,
  StandardRentPriceOracle,
  test_mocks_MockERC20_sol_MockERC20 as MockERC20,
  UniversalResolverV2,
  VerifiableFactory,
} from "../generated/artifacts/index.js";
import {
  dnsEncodeName,
  getReverseName,
  namehash,
} from "../test/utils/utils.js";
import {
  RHINESTONE_GAS_REFUND_PAYMASTER,
  RHINESTONE_INTENT_EXECUTOR,
  ROLES,
  SEPOLIA_USDC,
} from "./deploy-constants.js";
import { ADDR_ABI, PROFILE_ABI } from "../test/utils/resolver-abis.ts";

const DEPLOYMENT_NETWORK = process.env.DEPLOYMENT_NETWORK ?? "sepolia";
const HCA_DEPLOYMENT_NETWORK =
  process.env.HCA_DEPLOYMENT_NETWORK ?? DEPLOYMENT_NETWORK;
const V1_DEPLOYMENT_NETWORK = process.env.V1_DEPLOYMENT_NETWORK ?? "sepolia";
const RPC_URL = process.env.SEPOLIA_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const RHINESTONE_API_KEY =
  process.env.RHINESTONE_API_KEY ??
  process.env.RHINESTONE_SDK_API_KEY ??
  process.env.VITE_RHINESTONE_API_KEY;
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const ARBITRUM_SEPOLIA_RPC_URL = process.env.ARBITRUM_SEPOLIA_RPC_URL;
const HCA_SOURCE_CHAIN = process.env.HCA_SOURCE_CHAIN ?? "base-sepolia";
const sourceChain = (() => {
  if (HCA_SOURCE_CHAIN === "base-sepolia") return baseSepolia;
  if (HCA_SOURCE_CHAIN === "arbitrum-sepolia") return arbitrumSepolia;
  throw new Error("HCA_SOURCE_CHAIN must be base-sepolia or arbitrum-sepolia");
})();
const SOURCE_RPC_URL =
  process.env.HCA_SOURCE_RPC_URL ??
  (sourceChain.id === baseSepolia.id
    ? BASE_SEPOLIA_RPC_URL
    : ARBITRUM_SEPOLIA_RPC_URL);
const CIRCLE_SOURCE_BLOCKCHAIN =
  sourceChain.id === baseSepolia.id ? "BASE-SEPOLIA" : "ARB-SEPOLIA";
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const HCA_CROSS_CHAIN = process.env.HCA_CROSS_CHAIN === "1";
const HCA_CROSS_CHAIN_SOURCE = process.env.HCA_CROSS_CHAIN_SOURCE ?? "nexus";
const HCA_CROSS_CHAIN_NEXUS_FUNDING =
  process.env.HCA_CROSS_CHAIN_NEXUS_FUNDING ?? "prefund";
const HCA_DEFER_CROSS_CHAIN_FUNDING =
  process.env.HCA_DEFER_CROSS_CHAIN_FUNDING === "1";
const HCA_RESUME_DEFERRED = process.env.HCA_RESUME_DEFERRED === "1";
const HCA_MULTI_CHAIN_SESSION_SIGNATURE = process.env
  .HCA_MULTI_CHAIN_SESSION_SIGNATURE as Hex | undefined;
const HCA_MULTI_CHAIN_SESSION_SIGNATURE_FILE =
  process.env.HCA_MULTI_CHAIN_SESSION_SIGNATURE_FILE;
const HCA_WAIT_FOR_SOURCE_USDC = process.env.HCA_WAIT_FOR_SOURCE_USDC === "1";
const HCA_SOURCE_APPROVAL_TRANSACTION_HASH = process.env
  .HCA_SOURCE_APPROVAL_TRANSACTION_HASH as Hex | undefined;
const HCA_GENERATE_OWNER = process.env.HCA_GENERATE_OWNER === "1";
const HCA_DRY_RUN_ONLY = process.env.HCA_DRY_RUN_ONLY === "1";
const HCA_SPONSORED = process.env.HCA_SPONSORED !== "0";
const HCA_USER_PAID_USDC = process.env.HCA_USER_PAID_USDC === "1";
const HCA_SAME_CHAIN_USER_PAID_USDC =
  process.env.HCA_SAME_CHAIN_USER_PAID_USDC === "1";
const HCA_USES_MULTI_CHAIN_SESSION =
  HCA_DEFER_CROSS_CHAIN_FUNDING || HCA_SAME_CHAIN_USER_PAID_USDC;
const HCA_USER_PAID_EXECUTION =
  HCA_USER_PAID_USDC || HCA_SAME_CHAIN_USER_PAID_USDC;
const HCA_FEE_ASSET = process.env.HCA_FEE_ASSET as
  | Transaction["feeAsset"]
  | undefined;
const HCA_ALLOW_TARGET_TEST_TOP_UP =
  process.env.HCA_ALLOW_TARGET_TEST_TOP_UP === "1";
const HCA_ALLOW_SOURCE_TEST_TOP_UP =
  process.env.HCA_ALLOW_SOURCE_TEST_TOP_UP === "1";
const HCA_EXPECT_INITIAL_STATE =
  process.env.HCA_EXPECT_INITIAL_STATE ?? "either";
const HCA_EXPECT_DEFAULT_REVERSE_FALLBACK =
  process.env.HCA_EXPECT_DEFAULT_REVERSE_FALLBACK === "1";
const HCA_USER_SALT = process.env.HCA_USER_SALT
  ? BigInt(process.env.HCA_USER_SALT)
  : 0n;

const REGISTRATION_DURATION = 28n * 86400n;
const SESSION_DURATION = 24n * 60n * 60n;
const COIN_TYPE_ETH = 60n;
const STATUS_REGISTERED = 2;
const NEXUS_FACTORY = "0x0000000000679A258c64d2F20F310e12B64b7375" as const;
const NEXUS_FACTORY_ABI = parseAbi([
  "function createAccount(bytes initData, bytes32 salt)",
]);
const NEXUS_BOOTSTRAP_ABI = parseAbi([
  "struct BootstrapConfig { address module; bytes initData; }",
  "struct BootstrapPreValidationHookConfig { uint256 hookType; address module; bytes data; }",
  "function initNexusWithDefaultValidatorAndOtherModulesNoRegistry(bytes defaultValidatorInitData, BootstrapConfig[] validators, BootstrapConfig[] executors, BootstrapConfig hook, BootstrapConfig[] fallbacks, BootstrapPreValidationHookConfig[] preValidationHooks)",
]);
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const RHINESTONE_ROUTER = "0x000000000004598D17aaD017bF0734a364c5588b" as const;
const BASE_SEPOLIA_HCA_FUNDING_SESSION_VALIDATOR = deployment(
  "HCAFundingSessionValidator",
  "base-sepolia",
);
const HCA_FUNDING_SESSION_VALIDATOR = (process.env
  .HCA_FUNDING_SESSION_VALIDATOR ??
  (sourceChain.id === baseSepolia.id
    ? BASE_SEPOLIA_HCA_FUNDING_SESSION_VALIDATOR
    : undefined)) as Address | undefined;
const SOURCE_PAYMENT_TOKEN = (process.env.HCA_SOURCE_PAYMENT_TOKEN ??
  (sourceChain.id === baseSepolia.id
    ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    : "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d")) as Address;
const TARGET_PAYMENT_TOKEN = (process.env.HCA_TARGET_PAYMENT_TOKEN ??
  SEPOLIA_USDC) as Address;
const CROSS_CHAIN_TARGET_AMOUNT = process.env.HCA_CROSS_CHAIN_TARGET_AMOUNT
  ? BigInt(process.env.HCA_CROSS_CHAIN_TARGET_AMOUNT)
  : 14_000_000n;
const CROSS_CHAIN_SOURCE_AMOUNT = process.env.HCA_CROSS_CHAIN_SOURCE_AMOUNT
  ? BigInt(process.env.HCA_CROSS_CHAIN_SOURCE_AMOUNT)
  : 20_000_000n;
const CROSS_CHAIN_COMMIT_TARGET_AMOUNT = process.env
  .HCA_CROSS_CHAIN_COMMIT_TARGET_AMOUNT
  ? BigInt(process.env.HCA_CROSS_CHAIN_COMMIT_TARGET_AMOUNT)
  : 2_000_000n;
const CROSS_CHAIN_COMMIT_SOURCE_AMOUNT = process.env
  .HCA_CROSS_CHAIN_COMMIT_SOURCE_AMOUNT
  ? BigInt(process.env.HCA_CROSS_CHAIN_COMMIT_SOURCE_AMOUNT)
  : 7_000_000n;
const CROSS_CHAIN_DESTINATION_GAS = process.env.HCA_CROSS_CHAIN_DESTINATION_GAS
  ? BigInt(process.env.HCA_CROSS_CHAIN_DESTINATION_GAS)
  : 1_200_000n;
const SAME_CHAIN_USDC_BUDGET = process.env.HCA_SAME_CHAIN_USDC_BUDGET
  ? BigInt(process.env.HCA_SAME_CHAIN_USDC_BUDGET)
  : 20_000_000n;
const SESSION_GAS_LIMIT = process.env.HCA_SESSION_GAS_LIMIT
  ? BigInt(process.env.HCA_SESSION_GAS_LIMIT)
  : undefined;
const MODE_ERC1271 = `0x0201${"00".repeat(30)}` as Hex;
const OPERATOR_MAX_FEE_PER_GAS = 500_000_000_000n;
const OPERATOR_MAX_PRIORITY_FEE_PER_GAS = 2_000_000_000n;
const MAX_REFUND_EXCHANGE_RATE = process.env.HCA_MAX_REFUND_EXCHANGE_RATE
  ? BigInt(process.env.HCA_MAX_REFUND_EXCHANGE_RATE)
  : 5_000_000_000n;
const MAX_REFUND_GAS_OVERHEAD = process.env.HCA_MAX_REFUND_GAS_OVERHEAD
  ? BigInt(process.env.HCA_MAX_REFUND_GAS_OVERHEAD)
  : 100_000n;
const MAX_REFUND_AMOUNT = process.env.HCA_MAX_REFUND_AMOUNT
  ? BigInt(process.env.HCA_MAX_REFUND_AMOUNT)
  : 25_000_000n;
const LEGACY_EIP2612_DOMAIN_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

if (!RPC_URL) throw new Error("SEPOLIA_RPC_URL is required");
if (!DEPLOYER_KEY) throw new Error("DEPLOYER_KEY is required");
if (!RHINESTONE_API_KEY) throw new Error("RHINESTONE_API_KEY is required");
if (HCA_USES_MULTI_CHAIN_SESSION && !SOURCE_RPC_URL) {
  throw new Error(
    `HCA_SOURCE_RPC_URL or the ${HCA_SOURCE_CHAIN} RPC variable is required for the multi-chain session`,
  );
}
if (!new Set(["new", "existing", "either"]).has(HCA_EXPECT_INITIAL_STATE)) {
  throw new Error("HCA_EXPECT_INITIAL_STATE must be new, existing, or either");
}
if (!new Set(["eoa", "nexus"]).has(HCA_CROSS_CHAIN_SOURCE)) {
  throw new Error("HCA_CROSS_CHAIN_SOURCE must be eoa or nexus");
}
if (
  !new Set(["prefund", "atomic-pull", "permit-pull"]).has(
    HCA_CROSS_CHAIN_NEXUS_FUNDING,
  )
) {
  throw new Error(
    "HCA_CROSS_CHAIN_NEXUS_FUNDING must be prefund, atomic-pull, or permit-pull",
  );
}
if (
  new Set(["atomic-pull", "permit-pull"]).has(HCA_CROSS_CHAIN_NEXUS_FUNDING) &&
  HCA_CROSS_CHAIN_SOURCE !== "nexus"
) {
  throw new Error("pull funding requires a Nexus source account");
}
if (
  HCA_USER_PAID_USDC &&
  (!HCA_CROSS_CHAIN ||
    HCA_CROSS_CHAIN_SOURCE !== "nexus" ||
    HCA_CROSS_CHAIN_NEXUS_FUNDING !== "permit-pull" ||
    HCA_SPONSORED)
) {
  throw new Error(
    "HCA_USER_PAID_USDC=1 requires cross-chain Nexus permit-pull routing with HCA_SPONSORED=0",
  );
}
if (
  HCA_DEFER_CROSS_CHAIN_FUNDING &&
  (!HCA_USER_PAID_USDC ||
    HCA_CROSS_CHAIN_SOURCE !== "nexus" ||
    HCA_CROSS_CHAIN_NEXUS_FUNDING !== "permit-pull" ||
    CROSS_CHAIN_COMMIT_SOURCE_AMOUNT >= CROSS_CHAIN_SOURCE_AMOUNT)
) {
  throw new Error(
    "deferred cross-chain funding requires the user-paid Nexus permit-pull route and a commit budget below the total source budget",
  );
}
if (HCA_RESUME_DEFERRED && !HCA_DEFER_CROSS_CHAIN_FUNDING) {
  throw new Error(
    "HCA_RESUME_DEFERRED=1 requires deferred cross-chain funding",
  );
}
if (
  HCA_SAME_CHAIN_USER_PAID_USDC &&
  (HCA_CROSS_CHAIN || HCA_SPONSORED || HCA_USER_PAID_USDC)
) {
  throw new Error(
    "HCA_SAME_CHAIN_USER_PAID_USDC=1 requires same-chain routing with HCA_SPONSORED=0",
  );
}
if (
  MAX_REFUND_EXCHANGE_RATE > (1n << 96n) - 1n ||
  MAX_REFUND_GAS_OVERHEAD > (1n << 48n) - 1n ||
  MAX_REFUND_AMOUNT > (1n << 96n) - 1n ||
  CROSS_CHAIN_SOURCE_AMOUNT > (1n << 96n) - 1n ||
  CROSS_CHAIN_TARGET_AMOUNT > (1n << 96n) - 1n
) {
  throw new Error("HCA session limits exceed the validator field widths");
}

type Deployment = { address: Address };
type ForgeArtifact = { bytecode: { object: Hex } };
type Call = { to: Address; value: bigint; data: Hex };
type HcaDeployments = {
  verifiableFactory: Address;
  permissionedResolverImpl: Address;
  ethRegistrar: Address;
  ethRegistry: Address;
  paymentToken: Address;
  standaloneHcaFactory: Address;
  standaloneHcaImplementation: Address;
  validator: Address;
  defaultReverseRegistrarAdapter: Address;
  reverseRegistrarAdapter: Address;
  universalResolver: Address;
  v1Registry: Address;
  defaultReverseRegistrar: Address;
  reverseRegistrar: Address;
  intentExecutor: Address;
  gasRefundPaymaster: Address;
};
type SameChainWalletFunding = {
  calls: Call[];
  paymentToken: Address;
  hca: Address;
  required: bigint;
  amountPulled: bigint;
  walletBalanceBeforeProvisioning: bigint;
  walletBalanceBeforePull: bigint;
  hcaBalanceBefore: bigint;
  provisionedAmount: bigint;
  provisioningTransactionHash?: Hex;
  provisioningGasUsed: bigint;
  permitSignatureCount: number;
};

type LiveSessionEnableData = {
  userSignature: Hex;
  hashesAndChainIds: { chainId: bigint; sessionDigest: Hex }[];
  sessionToEnableIndex: number;
  hcaSessionNonce?: bigint;
  hcaSessionConfig?: {
    sessionKey: Address;
    validUntil: number;
    resolver: Address;
    refundToken: Address;
    maxRefundExchangeRate: bigint;
    maxRefundGasOverhead: number;
    maxRefundAmount: bigint;
  };
};

function asPrivateKey(value: string): Hex {
  return value.startsWith("0x") ? (value as Hex) : (`0x${value}` as Hex);
}

const generatedOwnerKey = HCA_GENERATE_OWNER ? generatePrivateKey() : undefined;
const rpcUrl = RPC_URL;
const rhinestoneApiKey = RHINESTONE_API_KEY;
const owner = privateKeyToAccount(
  asPrivateKey(process.env.HCA_OWNER_KEY ?? generatedOwnerKey ?? DEPLOYER_KEY),
);
const session = privateKeyToAccount(
  asPrivateKey(process.env.HCA_SESSION_KEY ?? generatePrivateKey()),
);
const relayer = privateKeyToAccount(asPrivateKey(DEPLOYER_KEY));
const ownerKeySource =
  process.env.HCA_OWNER_KEY_SOURCE ??
  (generatedOwnerKey
    ? "generated"
    : process.env.HCA_OWNER_KEY
      ? "HCA_OWNER_KEY"
      : "DEPLOYER_KEY");

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});
const walletClient = createWalletClient({
  account: relayer,
  chain: sepolia,
  transport: http(RPC_URL),
});
const sourcePublicClient = HCA_USES_MULTI_CHAIN_SESSION
  ? createPublicClient({
      chain: sourceChain,
      transport: http(SOURCE_RPC_URL!),
    })
  : undefined;
const sourceWalletClient = HCA_CROSS_CHAIN
  ? createWalletClient({
      account: owner,
      chain: sourceChain,
      transport: http(SOURCE_RPC_URL!),
    })
  : undefined;
const sourceProvisionerWalletClient = HCA_USES_MULTI_CHAIN_SESSION
  ? createWalletClient({
      account: relayer,
      chain: sourceChain,
      transport: http(SOURCE_RPC_URL!),
    })
  : undefined;

function deployment(name: string, network = DEPLOYMENT_NETWORK): Address {
  const raw = readFileSync(
    new URL(`../deployments/${network}/${name}.json`, import.meta.url),
    "utf8",
  );
  return (JSON.parse(raw) as Deployment).address;
}

function forgeBytecode(name: string): Hex {
  const raw = readFileSync(
    new URL(`../out/${name}.sol/${name}.json`, import.meta.url),
    "utf8",
  );
  return (JSON.parse(raw) as ForgeArtifact).bytecode.object;
}

function deploymentFromEnv(
  envName: string | string[],
  names: string[],
  network = DEPLOYMENT_NETWORK,
): Address {
  const envNames = Array.isArray(envName) ? envName : [envName];
  for (const name of envNames) {
    if (process.env[name]) return process.env[name] as Address;
  }
  for (const name of names) {
    try {
      return deployment(name, network);
    } catch {}
  }
  throw new Error(
    `${envNames.join(" or ")} is not set and ${names.join(" or ")} is absent from deployments/${network}`,
  );
}

function v1Deployment(name: string): Address {
  const raw = readFileSync(
    new URL(
      `../lib/ens-contracts/deployments/${V1_DEPLOYMENT_NETWORK}/${name}.json`,
      import.meta.url,
    ),
    "utf8",
  );
  return (JSON.parse(raw) as Deployment).address;
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function eip2612Domain(
  client: PublicClient,
  token: Address,
  chainId: number,
) {
  try {
    const [, name, version, domainChainId, verifyingContract] =
      await client.readContract({
        address: token,
        abi: MockERC20.abi,
        functionName: "eip712Domain",
      });
    if (
      Number(domainChainId) !== chainId ||
      verifyingContract.toLowerCase() !== token.toLowerCase()
    ) {
      throw new Error("payment token returned an unexpected EIP-2612 domain");
    }
    return { name, version, chainId, verifyingContract: token } as const;
  } catch (error) {
    const [name, version, separator] = await Promise.all([
      client.readContract({
        address: token,
        abi: LEGACY_EIP2612_DOMAIN_ABI,
        functionName: "name",
      }),
      client.readContract({
        address: token,
        abi: LEGACY_EIP2612_DOMAIN_ABI,
        functionName: "version",
      }),
      client.readContract({
        address: token,
        abi: LEGACY_EIP2612_DOMAIN_ABI,
        functionName: "DOMAIN_SEPARATOR",
      }),
    ]);
    const expectedSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          keccak256(
            stringToHex(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
            ),
          ),
          keccak256(stringToHex(name)),
          keccak256(stringToHex(version)),
          BigInt(chainId),
          token,
        ],
      ),
    );
    if (separator.toLowerCase() !== expectedSeparator.toLowerCase()) {
      throw new Error(
        "payment token returned an unexpected legacy EIP-2612 domain",
        {
          cause: error,
        },
      );
    }
    return { name, version, chainId, verifyingContract: token } as const;
  }
}

function assertAddress(name: string, actual: Address, expected: Address) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function assertFundingValidatorSetup(
  account: RhinestoneAccount,
  validator: Address,
  expectedInitData: Hex,
) {
  const init = account.getInitData();
  assertAddress("source Nexus factory", init.factory, NEXUS_FACTORY);

  const factoryCall = decodeFunctionData({
    abi: NEXUS_FACTORY_ABI,
    data: init.factoryData,
  });
  const [, bootstrapData] = decodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    factoryCall.args[0],
  );
  const bootstrapCall = decodeFunctionData({
    abi: NEXUS_BOOTSTRAP_ABI,
    data: bootstrapData,
  });
  const matches = bootstrapCall.args[1].filter(
    ({ module }) => module.toLowerCase() === validator.toLowerCase(),
  );
  if (
    matches.length !== 1 ||
    matches[0].initData.toLowerCase() !== expectedInitData.toLowerCase()
  ) {
    throw new Error("source Nexus funding-validator setup data mismatch");
  }
}

async function assertCode(
  name: string,
  address: Address,
  client: PublicClient = publicClient,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = await client.getCode({ address });
    if (code && code !== "0x") return;
    if (attempt < 9) await Bun.sleep(1_000);
  }
  throw new Error(`${name} has no code at ${address}`);
}

async function ensureFundingSessionValidator() {
  if (!HCA_USES_MULTI_CHAIN_SESSION) {
    return undefined;
  }

  let address = HCA_FUNDING_SESSION_VALIDATOR;
  let deploymentTransactionHash: Hex | undefined;
  if (!address) {
    deploymentTransactionHash =
      await sourceProvisionerWalletClient!.deployContract({
        abi: HCAFundingSessionValidator.abi,
        bytecode: forgeBytecode("HCAFundingSessionValidator"),
        args: [RHINESTONE_INTENT_EXECUTOR, PERMIT2, RHINESTONE_ROUTER],
      });
    const receipt = await sourcePublicClient!.waitForTransactionReceipt({
      hash: deploymentTransactionHash,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(
        `funding-session validator deployment reverted: ${deploymentTransactionHash}`,
      );
    }
    address = receipt.contractAddress;
  }

  await assertCode(
    "HCA funding-session validator",
    address,
    sourcePublicClient! as unknown as PublicClient,
  );
  let bindings: readonly [Address, Address, Address];
  try {
    bindings = await Promise.all([
      sourcePublicClient!.readContract({
        address,
        abi: HCAFundingSessionValidator.abi,
        functionName: "INTENT_EXECUTOR",
      }),
      sourcePublicClient!.readContract({
        address,
        abi: HCAFundingSessionValidator.abi,
        functionName: "PERMIT2",
      }),
      sourcePublicClient!.readContract({
        address,
        abi: HCAFundingSessionValidator.abi,
        functionName: "ROUTER",
      }),
    ]);
  } catch {
    throw new Error(
      `funding-session validator ${address} is incompatible with the stateless HCA source; set HCA_FUNDING_SESSION_VALIDATOR to a compatible deployment`,
    );
  }
  const [intentExecutor, permit2, router] = bindings;
  assertAddress(
    "funding-session validator IntentExecutor",
    intentExecutor,
    RHINESTONE_INTENT_EXECUTOR,
  );
  assertAddress("funding-session validator Permit2", permit2, PERMIT2);
  assertAddress("funding-session validator Router", router, RHINESTONE_ROUTER);
  return { address, deploymentTransactionHash };
}

function ownedResolverSalt(ownerAddress: Address) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { name: "id", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "version", type: "uint256" },
        ],
        [keccak256(stringToHex("OwnedResolver")), ownerAddress, 0n],
      ),
    ),
  );
}

function verifiableProxyAddress({
  factory,
  proxyLogic,
  deployer,
  salt,
}: {
  factory: Address;
  proxyLogic: Address;
  deployer: Address;
  salt: bigint;
}) {
  const outerSalt = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [deployer, salt],
    ),
  );
  const bytecode = concat([
    "0x3d604d80600a3d3981f3363d3d373d3d3d363d73",
    proxyLogic,
    "0x5af43d82803e903d91602b57fd5bf3",
    outerSalt,
  ]);
  return getContractAddress({
    bytecode,
    from: factory,
    opcode: "CREATE2",
    salt: outerSalt,
  });
}

async function main() {
  if ((await publicClient.getChainId()) !== sepolia.id) {
    throw new Error(`RPC is not Sepolia (${sepolia.id})`);
  }
  if (
    HCA_CROSS_CHAIN &&
    (await sourcePublicClient!.getChainId()) !== sourceChain.id
  ) {
    throw new Error(
      `source RPC is not ${sourceChain.name} (${sourceChain.id})`,
    );
  }

  const deployments = {
    verifiableFactory: deploymentFromEnv("HCA_VERIFIABLE_FACTORY", [
      "VerifiableFactory",
    ]),
    permissionedResolverImpl: deploymentFromEnv(
      "HCA_PERMISSIONED_RESOLVER_IMPL",
      ["PermissionedResolverImpl"],
    ),
    ethRegistrar: deploymentFromEnv("HCA_ETH_REGISTRAR", ["ETHRegistrar"]),
    ethRegistry: deploymentFromEnv("HCA_ETH_REGISTRY", ["ETHRegistry"]),
    paymentToken: deploymentFromEnv("HCA_TEST_PAYMENT_TOKEN", ["MockUSDC"]),
    standaloneHcaFactory: deploymentFromEnv(
      "HCA_STANDALONE_HCA_FACTORY",
      ["StandaloneHCAFactory"],
      HCA_DEPLOYMENT_NETWORK,
    ),
    standaloneHcaImplementation: deploymentFromEnv(
      "HCA_STANDALONE_HCA_IMPLEMENTATION",
      ["StandaloneHCAImplementation"],
      HCA_DEPLOYMENT_NETWORK,
    ),
    validator: deploymentFromEnv(
      "HCA_OWNER_AND_SESSION_VALIDATOR",
      ["HCAOwnerAndSessionValidator"],
      HCA_DEPLOYMENT_NETWORK,
    ),
    defaultReverseRegistrarAdapter: deploymentFromEnv(
      "HCA_DEFAULT_REVERSE_REGISTRAR_ADAPTER",
      ["DefaultReverseRegistrarAdapter"],
      HCA_DEPLOYMENT_NETWORK,
    ),
    reverseRegistrarAdapter: deploymentFromEnv(
      "HCA_REVERSE_REGISTRAR_ADAPTER",
      ["ReverseRegistrarAdapter"],
      HCA_DEPLOYMENT_NETWORK,
    ),
    universalResolver: deploymentFromEnv("UNIVERSAL_RESOLVER", [
      "UniversalResolverV2",
      "UniversalResolver",
    ]),
    v1Registry:
      (process.env.HCA_V1_REGISTRY as Address | undefined) ??
      v1Deployment("ENSRegistry"),
    defaultReverseRegistrar:
      (process.env.HCA_V1_DEFAULT_REVERSE_REGISTRAR as Address | undefined) ??
      v1Deployment("DefaultReverseRegistrar"),
    reverseRegistrar:
      (process.env.HCA_V1_REVERSE_REGISTRAR as Address | undefined) ??
      v1Deployment("ReverseRegistrar"),
    intentExecutor: RHINESTONE_INTENT_EXECUTOR,
    gasRefundPaymaster: RHINESTONE_GAS_REFUND_PAYMASTER,
  };

  await Promise.all(
    Object.entries(deployments).map(([name, address]) =>
      assertCode(name, address),
    ),
  );
  if (
    HCA_CROSS_CHAIN &&
    deployments.paymentToken.toLowerCase() !==
      TARGET_PAYMENT_TOKEN.toLowerCase()
  ) {
    throw new Error(
      `cross-chain test payment token must be Circle Sepolia USDC ${TARGET_PAYMENT_TOKEN}`,
    );
  }

  const proxyLogic = (await publicClient.readContract({
    address: deployments.verifiableFactory,
    abi: VerifiableFactory.abi,
    functionName: "proxyLogic",
  })) as Address;
  const configuredFactory = (await publicClient.readContract({
    address: deployments.standaloneHcaFactory,
    abi: StandaloneHCAFactory.abi,
    functionName: "VERIFIABLE_FACTORY",
  })) as Address;
  assertAddress(
    "StandaloneHCAFactory.VERIFIABLE_FACTORY",
    configuredFactory,
    deployments.verifiableFactory,
  );
  const adapterFactory = (await publicClient.readContract({
    address: deployments.defaultReverseRegistrarAdapter,
    abi: DefaultReverseRegistrarAdapter.abi,
    functionName: "STANDALONE_HCA_FACTORY",
  })) as Address;
  assertAddress(
    "reverse adapter StandaloneHCAFactory",
    adapterFactory,
    deployments.standaloneHcaFactory,
  );
  const v1AdapterFactory = (await publicClient.readContract({
    address: deployments.reverseRegistrarAdapter,
    abi: ReverseRegistrarAdapter.abi,
    functionName: "STANDALONE_HCA_FACTORY",
  })) as Address;
  assertAddress(
    "addr.reverse adapter StandaloneHCAFactory",
    v1AdapterFactory,
    deployments.standaloneHcaFactory,
  );

  let validatorBindings: Address[];
  try {
    validatorBindings = await Promise.all(
      [
        "DEFAULT_REVERSE_REGISTRAR_HCA_ADAPTER",
        "REVERSE_REGISTRAR_HCA_ADAPTER",
        "PERMITTED_RESOLVER_IMPL",
        "ETH_REGISTRY",
        "VERIFIABLE_FACTORY",
        "INTENT_EXECUTOR",
        "GAS_REFUND_PAYMASTER",
      ].map(
        (functionName) =>
          publicClient.readContract({
            address: deployments.validator,
            abi: HCAOwnerAndSessionValidator.abi,
            functionName: functionName as never,
          }) as Promise<Address>,
      ),
    );
  } catch {
    throw new Error(
      `destination validator ${deployments.validator} is incompatible with the stateless HCA source; set HCA_OWNER_AND_SESSION_VALIDATOR and HCA_STANDALONE_HCA_IMPLEMENTATION to a compatible deployment`,
    );
  }
  const [
    boundReverseAdapter,
    boundV1ReverseAdapter,
    boundResolverImpl,
    boundRegistry,
    boundFactory,
    boundIntentExecutor,
    boundGasRefundPaymaster,
  ] = validatorBindings;
  assertAddress(
    "validator reverse adapter",
    boundReverseAdapter,
    deployments.defaultReverseRegistrarAdapter,
  );
  assertAddress(
    "validator addr.reverse adapter",
    boundV1ReverseAdapter,
    deployments.reverseRegistrarAdapter,
  );
  assertAddress(
    "validator resolver implementation",
    boundResolverImpl,
    deployments.permissionedResolverImpl,
  );
  assertAddress(
    "validator ETH registry",
    boundRegistry,
    deployments.ethRegistry,
  );
  const registrarAuthorized = (await publicClient.readContract({
    address: deployments.ethRegistry,
    abi: PermissionedRegistry.abi,
    functionName: "hasRootRoles",
    args: [ROLES.REGISTRY.REGISTRAR, deployments.ethRegistrar],
  })) as boolean;
  if (!registrarAuthorized) {
    throw new Error(
      `selected registrar ${deployments.ethRegistrar} does not hold ETHRegistry ROLE_REGISTRAR`,
    );
  }
  assertAddress(
    "validator factory",
    boundFactory,
    deployments.verifiableFactory,
  );
  assertAddress(
    "validator IntentExecutor",
    boundIntentExecutor,
    deployments.intentExecutor,
  );
  assertAddress(
    "validator gas-refund paymaster",
    boundGasRefundPaymaster,
    deployments.gasRefundPaymaster,
  );
  const paymasterIntentExecutor = (await publicClient.readContract({
    address: deployments.gasRefundPaymaster,
    abi: [
      {
        type: "function",
        name: "INTENT_EXECUTOR",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
      },
    ],
    functionName: "INTENT_EXECUTOR",
  })) as Address;
  assertAddress(
    "gas-refund paymaster IntentExecutor",
    paymasterIntentExecutor,
    deployments.intentExecutor,
  );
  const registrarRentPriceOracle = (await publicClient.readContract({
    address: deployments.ethRegistrar,
    abi: ETHRegistrar.abi,
    functionName: "rentPriceOracle",
  })) as Address;
  const paymentTokenSupported = (await publicClient.readContract({
    address: registrarRentPriceOracle,
    abi: StandardRentPriceOracle.abi,
    functionName: "isPaymentToken",
    args: [deployments.paymentToken],
  })) as boolean;
  if (!paymentTokenSupported) {
    throw new Error(
      `registrar oracle ${registrarRentPriceOracle} does not accept test payment token ${deployments.paymentToken}`,
    );
  }

  const adapterIsController = await publicClient.readContract({
    address: deployments.defaultReverseRegistrar,
    abi: DefaultReverseRegistrar.abi,
    functionName: "controllers",
    args: [deployments.defaultReverseRegistrarAdapter],
  });
  if (!adapterIsController) {
    throw new Error("HCA reverse adapter is not a default.reverse controller");
  }
  const v1AdapterIsController = await publicClient.readContract({
    address: deployments.reverseRegistrar,
    abi: ReverseRegistrar.abi,
    functionName: "controllers",
    args: [deployments.reverseRegistrarAdapter],
  });
  if (!v1AdapterIsController) {
    throw new Error(
      "HCA addr.reverse adapter is not an addr.reverse controller",
    );
  }
  const implementationIsApproved = await publicClient.readContract({
    address: deployments.standaloneHcaFactory,
    abi: StandaloneHCAFactory.abi,
    functionName: "approvedImplementations",
    args: [deployments.standaloneHcaImplementation],
  });
  if (!implementationIsApproved) {
    throw new Error(
      "StandaloneHCAFactory does not approve the HCA implementation",
    );
  }

  const providerUrls: Record<number, string> = { [sepolia.id]: rpcUrl };
  if (HCA_USES_MULTI_CHAIN_SESSION) {
    providerUrls[sourceChain.id] = SOURCE_RPC_URL!;
  }
  const sdk = new RhinestoneSDK({
    auth: { mode: "apiKey", apiKey: rhinestoneApiKey },
    provider: {
      type: "custom",
      urls: providerUrls,
    },
    ...(process.env.RHINESTONE_ENDPOINT_URL
      ? { endpointUrl: process.env.RHINESTONE_ENDPOINT_URL }
      : {}),
  });
  const standalone: StandaloneHcaAccount = {
    type: "hca",
    version: "ens-standalone-1.1.0",
    factory: deployments.standaloneHcaFactory,
    implementation: deployments.standaloneHcaImplementation,
    validator: deployments.validator,
    verifiableFactory: deployments.verifiableFactory,
    proxyLogic,
    userSalt: HCA_USER_SALT,
  };
  let hcaOwnerSignatureCount = HCA_RESUME_DEFERRED ? 1 : 0;
  const trackedHcaOwner = {
    ...owner,
    signTypedData: (async (parameters: unknown) => {
      hcaOwnerSignatureCount += 1;
      return owner.signTypedData(parameters as never);
    }) as typeof owner.signTypedData,
  };
  const baseAccountConfig: RhinestoneAccountConfig = {
    account: standalone,
    owners: {
      type: "ecdsa",
      accounts: [trackedHcaOwner],
      module: deployments.validator,
    },
    experimental_sessions: {
      enabled: true,
      module: deployments.validator,
    },
  };
  let sourceWalletSignatureCount = HCA_RESUME_DEFERRED ? 1 : 0;
  const countSourceWalletSignature = () => {
    sourceWalletSignatureCount += 1;
  };
  const trackedSignTypedData = (async (parameters: unknown) => {
    countSourceWalletSignature();
    return owner.signTypedData(parameters as never);
  }) as typeof owner.signTypedData;
  const trackedSignMessage = (async (parameters: unknown) => {
    countSourceWalletSignature();
    return owner.signMessage(parameters as never);
  }) as typeof owner.signMessage;
  const trackedSourceOwner = {
    ...owner,
    signTypedData: trackedSignTypedData,
    signMessage: trackedSignMessage,
  };
  const candidateAccount = await sdk.createAccount(baseAccountConfig);
  const hca = candidateAccount.getAddress();
  const codeBefore = await publicClient.getCode({ address: hca });
  const initiallyDeployed = Boolean(codeBefore && codeBefore !== "0x");
  if (
    HCA_USER_PAID_USDC &&
    initiallyDeployed &&
    !HCA_RESUME_DEFERRED &&
    !HCA_MULTI_CHAIN_SESSION_SIGNATURE
  ) {
    throw new Error("USDC-only proof requires a fresh destination HCA");
  }
  if (
    HCA_MULTI_CHAIN_SESSION_SIGNATURE &&
    (size(HCA_MULTI_CHAIN_SESSION_SIGNATURE) !== 85 ||
      !HCA_MULTI_CHAIN_SESSION_SIGNATURE.toLowerCase().startsWith(zeroAddress))
  ) {
    throw new Error(
      "HCA_MULTI_CHAIN_SESSION_SIGNATURE must contain a valid multi-chain session authorization",
    );
  }
  if (HCA_RESUME_DEFERRED && !HCA_MULTI_CHAIN_SESSION_SIGNATURE) {
    throw new Error(
      "HCA_MULTI_CHAIN_SESSION_SIGNATURE is required to resume deferred funding",
    );
  }
  if (
    (HCA_EXPECT_INITIAL_STATE === "new" && initiallyDeployed) ||
    (HCA_EXPECT_INITIAL_STATE === "existing" && !initiallyDeployed)
  ) {
    throw new Error(
      `expected ${HCA_EXPECT_INITIAL_STATE} HCA, got ${initiallyDeployed ? "existing" : "new"} at ${hca}`,
    );
  }
  if (initiallyDeployed) await verifyHca(hca, deployments, owner.address);

  const resolverSalt = ownedResolverSalt(hca);
  const resolver = verifiableProxyAddress({
    factory: deployments.verifiableFactory,
    proxyLogic,
    deployer: hca,
    salt: resolverSalt,
  });
  const latestBlock = await publicClient.getBlock();
  const validUntil = process.env.HCA_SESSION_VALID_UNTIL
    ? BigInt(process.env.HCA_SESSION_VALID_UNTIL)
    : latestBlock.timestamp + SESSION_DURATION;
  const hcaSessionNonce = initiallyDeployed
    ? (
        await publicClient.readContract({
          address: hca,
          abi: StandaloneSingleOwnerHCA.abi,
          functionName: "ownerAndSessionNonce",
        })
      )[1]
    : 0n;
  const sessionSalt = keccak256(
    encodeAbiParameters(
      [
        { type: "uint96" },
        { type: "uint48" },
        { type: "address" },
        { type: "address" },
        { type: "uint96" },
        { type: "uint48" },
        { type: "uint96" },
      ],
      [
        hcaSessionNonce,
        Number(validUntil),
        resolver,
        deployments.paymentToken,
        MAX_REFUND_EXCHANGE_RATE,
        Number(MAX_REFUND_GAS_OVERHEAD),
        MAX_REFUND_AMOUNT,
      ],
    ),
  );
  const sessionConfig: Session = {
    chain: sepolia,
    account: hca,
    salt: sessionSalt,
    owners: { type: "ecdsa", accounts: [session] },
  };
  const permissionId = getPermissionId(sessionConfig);
  const fundingValidatorDeployment = await ensureFundingSessionValidator();

  let sourceSession: Session | undefined;
  let sourcePermissionId: Hex | undefined;
  let sourceEnableData: LiveSessionEnableData | undefined;
  let destinationEnableData: LiveSessionEnableData | undefined;
  let sourceAccount: RhinestoneAccount | undefined;
  if (HCA_CROSS_CHAIN || HCA_SAME_CHAIN_USER_PAID_USDC) {
    if (HCA_CROSS_CHAIN_SOURCE === "eoa") {
      sourceAccount = await sdk.createAccount({
        account: { type: "eoa" },
        eoa: trackedSourceOwner,
      });
    } else if (HCA_USES_MULTI_CHAIN_SESSION) {
      if (!fundingValidatorDeployment) {
        throw new Error(
          "the multi-chain session requires its source validator",
        );
      }
      const sourceSessionSalt = keccak256(
        encodeAbiParameters(
          [
            { type: "address" },
            { type: "uint48" },
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: "uint64" },
            { type: "uint96" },
            { type: "uint96" },
          ],
          [
            owner.address,
            Number(validUntil),
            SOURCE_PAYMENT_TOKEN,
            hca,
            deployments.paymentToken,
            BigInt(sepolia.id),
            CROSS_CHAIN_SOURCE_AMOUNT,
            CROSS_CHAIN_TARGET_AMOUNT,
          ],
        ),
      );
      const sourceSessionWithoutAccount: Session = {
        chain: sourceChain,
        salt: sourceSessionSalt,
        owners: { type: "ecdsa", accounts: [session] },
      };
      sourcePermissionId = getPermissionId(sourceSessionWithoutAccount);
      if (sourcePermissionId === permissionId) {
        throw new Error(
          "source and destination sessions must use distinct policy salts",
        );
      }
      const fundingValidatorInitData = encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "permissionId", type: "bytes32" },
              { name: "owner", type: "address" },
              { name: "validUntil", type: "uint48" },
              { name: "sessionKey", type: "address" },
              { name: "sourceToken", type: "address" },
              { name: "destinationRecipient", type: "address" },
              { name: "destinationToken", type: "address" },
              { name: "destinationChainId", type: "uint64" },
              { name: "maxSourceAmount", type: "uint96" },
              { name: "maxDestinationAmount", type: "uint96" },
            ],
          },
        ],
        [
          {
            permissionId: sourcePermissionId,
            owner: owner.address,
            validUntil: Number(validUntil),
            sessionKey: session.address,
            sourceToken: SOURCE_PAYMENT_TOKEN,
            destinationRecipient: hca,
            destinationToken: deployments.paymentToken,
            destinationChainId: BigInt(sepolia.id),
            maxSourceAmount: CROSS_CHAIN_SOURCE_AMOUNT,
            maxDestinationAmount: CROSS_CHAIN_TARGET_AMOUNT,
          },
        ],
      );
      sourceAccount = await sdk.createAccount({
        account: { type: "nexus" },
        owners: {
          type: "ecdsa",
          accounts: [trackedSourceOwner],
        },
        experimental_sessions: {
          enabled: true,
          module: fundingValidatorDeployment.address,
          initData: fundingValidatorInitData,
        },
      });
      assertFundingValidatorSetup(
        sourceAccount,
        fundingValidatorDeployment.address,
        fundingValidatorInitData,
      );
      const sourceAddress = sourceAccount.getAddress();
      sourceSession = {
        ...sourceSessionWithoutAccount,
        account: sourceAddress,
      };

      const sessionDetails =
        await candidateAccount.experimental_getSessionDetails([
          sessionConfig,
          sourceSession!,
        ]);
      const authorizedAccounts =
        sessionDetails.data.message.sessionsAndChainIds.map(
          ({ session: signedSession }) => signedSession.account.toLowerCase(),
        );
      if (
        sessionDetails.nonces.some((nonce) => nonce !== 0n) ||
        authorizedAccounts[0] !== hca.toLowerCase() ||
        authorizedAccounts[1] !== sourceAccount.getAddress().toLowerCase()
      ) {
        throw new Error(
          "multi-chain session authorization does not bind the HCA and source Nexus",
        );
      }
      const multiChainSignature =
        HCA_MULTI_CHAIN_SESSION_SIGNATURE ??
        (await candidateAccount.experimental_signEnableSession(sessionDetails));
      if (
        HCA_MULTI_CHAIN_SESSION_SIGNATURE_FILE &&
        !HCA_MULTI_CHAIN_SESSION_SIGNATURE
      ) {
        writeFileSync(
          HCA_MULTI_CHAIN_SESSION_SIGNATURE_FILE,
          `${multiChainSignature}\n`,
          { mode: 0o600 },
        );
      }
      const expectedHcaOwnerSignatures = HCA_RESUME_DEFERRED
        ? 1
        : HCA_MULTI_CHAIN_SESSION_SIGNATURE
          ? 0
          : 1;
      if (
        hcaOwnerSignatureCount !== expectedHcaOwnerSignatures ||
        sourceWalletSignatureCount !== (HCA_RESUME_DEFERRED ? 1 : 0)
      ) {
        throw new Error(
          "multi-chain session authorization used the wrong wallet signer",
        );
      }
      destinationEnableData = {
        userSignature: multiChainSignature,
        hashesAndChainIds: sessionDetails.hashesAndChainIds,
        sessionToEnableIndex: 0,
        hcaSessionNonce,
        hcaSessionConfig: {
          sessionKey: session.address,
          validUntil: Number(validUntil),
          resolver,
          refundToken: deployments.paymentToken,
          maxRefundExchangeRate: MAX_REFUND_EXCHANGE_RATE,
          maxRefundGasOverhead: Number(MAX_REFUND_GAS_OVERHEAD),
          maxRefundAmount: MAX_REFUND_AMOUNT,
        },
      };
      sourceEnableData = {
        userSignature: multiChainSignature,
        hashesAndChainIds: sessionDetails.hashesAndChainIds,
        sessionToEnableIndex: 1,
      };
    } else {
      sourceAccount = await sdk.createAccount({
        account: { type: "nexus" },
        owners: {
          type: "ecdsa",
          accounts: [trackedSourceOwner],
        },
      });
    }
  }

  if (!destinationEnableData) {
    const sessionDetails =
      await candidateAccount.experimental_getSessionDetails([sessionConfig]);
    const sessionAuthorization =
      HCA_MULTI_CHAIN_SESSION_SIGNATURE ??
      (await candidateAccount.experimental_signEnableSession(sessionDetails));
    destinationEnableData = {
      userSignature: sessionAuthorization,
      hashesAndChainIds: sessionDetails.hashesAndChainIds,
      sessionToEnableIndex: 0,
      hcaSessionNonce,
      hcaSessionConfig: {
        sessionKey: session.address,
        validUntil: Number(validUntil),
        resolver,
        refundToken: deployments.paymentToken,
        maxRefundExchangeRate: MAX_REFUND_EXCHANGE_RATE,
        maxRefundGasOverhead: Number(MAX_REFUND_GAS_OVERHEAD),
        maxRefundAmount: MAX_REFUND_AMOUNT,
      },
    };
  }

  const firstAccount = initiallyDeployed
    ? await sdk.createAccount({
        ...baseAccountConfig,
        initData: { address: hca },
      })
    : candidateAccount;

  const runId = Date.now().toString(36).toLowerCase();
  const labels = process.env.HCA_LABELS?.split(",") ?? [
    `hca${runId}a`,
    `hca${runId}b`,
  ];
  const configuredSecrets = process.env.HCA_SECRETS?.split(",");
  const secrets: [Hex, Hex] = configuredSecrets
    ? (configuredSecrets as [Hex, Hex])
    : [generatePrivateKey(), generatePrivateKey()];
  if (
    labels.length !== 2 ||
    labels.some((label) => !/^[a-z0-9-]+$/.test(label)) ||
    secrets.length !== 2 ||
    secrets.some((secret) => !/^0x[0-9a-fA-F]{64}$/.test(secret))
  ) {
    throw new Error(
      "HCA_LABELS and HCA_SECRETS must contain two valid comma-separated values",
    );
  }
  await Promise.all(
    labels.map(async (label) => {
      const state = (await publicClient.readContract({
        address: deployments.ethRegistry,
        abi: PermissionedRegistry.abi,
        functionName: "getState",
        args: [BigInt(keccak256(stringToHex(label)))],
      })) as { status: number | bigint };
      if (Number(state.status) !== 0)
        throw new Error(`${label}.eth is unavailable`);
    }),
  );

  const prices = await Promise.all(
    labels.map((label) => registrationPrice(label, deployments)),
  );
  const sameChainWalletStateBefore = HCA_CROSS_CHAIN
    ? undefined
    : await readWalletState(owner.address);
  if (
    HCA_SAME_CHAIN_USER_PAID_USDC &&
    (sameChainWalletStateBefore!.nativeBalance !== 0n ||
      sameChainWalletStateBefore!.transactionCount !== 0)
  ) {
    throw new Error(
      "user-paid same-chain proof requires a fresh wallet with no ETH or transactions",
    );
  }
  const sameChainFunding = HCA_CROSS_CHAIN
    ? undefined
    : await prepareSameChainWalletFunding({
        hca,
        required: HCA_SAME_CHAIN_USER_PAID_USDC
          ? SAME_CHAIN_USDC_BUDGET
          : prices[0] + prices[1],
        paymentToken: deployments.paymentToken,
      });

  const commitments = await Promise.all(
    labels.map((label, index) =>
      makeCommitment(
        label,
        resolver,
        deployments,
        owner.address,
        secrets[index]!,
      ),
    ),
  );

  if (HCA_CROSS_CHAIN) {
    if (HCA_DEFER_CROSS_CHAIN_FUNDING) {
      await runDeferredCrossChainRegistration({
        sdk,
        sourceAccount: sourceAccount!,
        destinationAccount: firstAccount,
        deployments,
        hca,
        resolver,
        resolverSalt,
        label: labels[0]!,
        secret: secrets[0],
        price: prices[0],
        commitment: commitments[0],
        destinationSession: sessionConfig,
        destinationPermissionId: permissionId,
        validUntil,
        initiallyDeployed,
        sourceWalletSignatureCount: () => sourceWalletSignatureCount,
        hcaOwnerSignatureCount: () => hcaOwnerSignatureCount,
        recordSourceWalletSignature: countSourceWalletSignature,
        sourceSession: sourceSession!,
        sourcePermissionId: sourcePermissionId!,
        sourceEnableData: sourceEnableData!,
        destinationEnableData: destinationEnableData!,
      });
      return;
    }
    const preparation = HCA_USER_PAID_USDC
      ? undefined
      : HCA_DRY_RUN_ONLY
        ? {
            phase: "permissionless deploy and commit",
            deploymentTransactionHash: undefined,
            commitTransactionHash: undefined,
            deploymentGasUsed: 0n,
            commitGasUsed: 0n,
            gasUsed: 0n,
            dryRun: true as const,
          }
        : await preparePermissionlessCrossChainRegistration({
            hca,
            initiallyDeployed,
            commitment: commitments[0],
            deployments,
          });

    const recipientAccount = HCA_USER_PAID_USDC
      ? firstAccount
      : await sdk.createAccount({
          ...baseAccountConfig,
          initData: { address: hca },
        });
    if (!HCA_USER_PAID_USDC && !HCA_DRY_RUN_ONLY) {
      await verifyHca(hca, deployments, owner.address);
      await waitForCommitment(commitments[0], deployments.ethRegistrar);
    }

    const crossChainSource = await fundCrossChainSourceAccount({
      wallet: owner.address,
      sourceAccount: sourceAccount!.getAddress(),
      sourceType: HCA_CROSS_CHAIN_SOURCE as "eoa" | "nexus",
      nexusFundingMode: HCA_CROSS_CHAIN_NEXUS_FUNDING as
        | "prefund"
        | "atomic-pull"
        | "permit-pull",
    });
    const firstRegistrationCalls: Call[] = [];
    if (HCA_USER_PAID_USDC) {
      firstRegistrationCalls.push({
        to: deployments.ethRegistrar,
        value: 0n,
        data: encodeFunctionData({
          abi: ETHRegistrar.abi,
          functionName: "commit",
          args: [commitments[0]],
        }),
      });
    } else {
      firstRegistrationCalls.push(
        ...(await registrationCalls({
          label: labels[0],
          price: prices[0],
          hca,
          resolver,
          resolverSalt,
          secret: secrets[0],
          deployments,
        })),
      );
    }

    const hcaOwnerSignaturesBeforeFirstRegistration = hcaOwnerSignatureCount;
    const firstRegistration = await executeCrossChainRegistration({
      account: sourceAccount!,
      recipient: recipientAccount.config,
      recipientAddress: hca,
      calls: firstRegistrationCalls,
      sourceAmount: crossChainSource.routeSourceAmount,
      sourceCalls: crossChainSource.sourceCalls,
      expectedSourcePull: new Set(["atomic-pull", "permit-pull"]).has(
        HCA_CROSS_CHAIN_NEXUS_FUNDING,
      )
        ? {
            owner: owner.address,
            recipient: crossChainSource.sourceAccount,
            amount: crossChainSource.routeSourceAmount,
          }
        : undefined,
      expectedSourcePermit: HCA_CROSS_CHAIN_NEXUS_FUNDING === "permit-pull",
      expectedSourceSetupOps: HCA_CROSS_CHAIN_SOURCE === "eoa" ? 0 : 1,
      expectedRecipientSetupOps:
        HCA_USER_PAID_USDC && !initiallyDeployed ? 1 : 0,
      expectedSourcePermit2Approval: HCA_CROSS_CHAIN_SOURCE === "nexus",
      sourceType: HCA_CROSS_CHAIN_SOURCE as "eoa" | "nexus",
      signatureCount: () => sourceWalletSignatureCount,
      phase: HCA_USER_PAID_USDC
        ? "new-user cross-chain deploy and commit"
        : "new-user cross-chain registration",
    });
    if (hcaOwnerSignatureCount !== hcaOwnerSignaturesBeforeFirstRegistration) {
      throw new Error(
        "cross-chain registration requested an additional HCA owner signature",
      );
    }

    if (!HCA_DRY_RUN_ONLY) {
      if (!("claimTransactionHash" in firstRegistration)) {
        throw new Error("live cross-chain route returned no claim checkpoint");
      }
      console.error(
        JSON.stringify(
          {
            checkpoint: "cross-chain claim and fill confirmed",
            intentId: firstRegistration.intentId,
            claimTransactionHash: firstRegistration.claimTransactionHash,
            fillTransactionHash: firstRegistration.fillTransactionHash,
          },
          jsonReplacer,
        ),
      );
    }

    if (HCA_DRY_RUN_ONLY) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            initialState: initiallyDeployed ? "existing" : "new",
            owner: owner.address,
            hca,
            resolver,
            permissionId,
            routes: {
              ...(preparation && { preparation }),
              firstRegistration,
            },
            crossChainSource,
            walletInteractions: {
              sourceFundingTransactions: crossChainSource.walletTransactions,
              sourcePermitSignatures:
                crossChainSource.permitSignatureCount ?? 0,
              permit2Signatures: sourceWalletSignatureCount,
              additionalHcaOwnerSignatures: hcaOwnerSignatureCount,
              total:
                crossChainSource.walletTransactions +
                (crossChainSource.permitSignatureCount ?? 0) +
                sourceWalletSignatureCount +
                hcaOwnerSignatureCount,
            },
          },
          jsonReplacer,
          2,
        ),
      );
      return;
    }

    const [
      walletBalanceAfterClaim,
      sourceAccountBalanceAfterClaim,
      walletNativeBalanceAfterClaim,
      permitNonceAfterClaim,
      walletToSourceAllowanceAfterClaim,
    ] = (await Promise.all([
      sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [owner.address],
      }),
      sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [crossChainSource.sourceAccount],
      }),
      sourcePublicClient!.getBalance({ address: owner.address }),
      sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "nonces",
        args: [owner.address],
      }),
      sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "allowance",
        args: [owner.address, crossChainSource.sourceAccount],
      }),
    ])) as [bigint, bigint, bigint, bigint, bigint];
    const sourceClaimState = {
      walletBalanceAfterClaim,
      sourceAccountBalanceAfterClaim,
      walletNativeBalanceAfterClaim,
      permitNonceAfterClaim,
      walletToSourceAllowanceAfterClaim,
    };
    if (
      new Set(["atomic-pull", "permit-pull"]).has(HCA_CROSS_CHAIN_NEXUS_FUNDING)
    ) {
      const expectedWalletBalanceAfterClaim =
        crossChainSource.walletBalanceBefore -
        crossChainSource.routeSourceAmount;
      if (walletBalanceAfterClaim !== expectedWalletBalanceAfterClaim) {
        throw new Error(
          `atomic Nexus pull left ${walletBalanceAfterClaim} source tokens in the wallet; expected ${expectedWalletBalanceAfterClaim}`,
        );
      }
      const expectedSourceResidual =
        crossChainSource.routeSourceAmount -
        firstRegistration.sourcePermit2Amount;
      if (sourceAccountBalanceAfterClaim !== expectedSourceResidual) {
        throw new Error(
          `source Nexus retained ${sourceAccountBalanceAfterClaim} tokens; expected unused budget ${expectedSourceResidual}`,
        );
      }
    }
    if (HCA_CROSS_CHAIN_NEXUS_FUNDING === "permit-pull") {
      if (permitNonceAfterClaim !== crossChainSource.permitNonceBefore! + 1n) {
        throw new Error("source claim did not consume the EIP-2612 permit");
      }
      if (walletToSourceAllowanceAfterClaim !== 0n) {
        throw new Error("source claim did not consume the Nexus allowance");
      }
      if (
        crossChainSource.walletNativeBalance !== 0n ||
        walletNativeBalanceAfterClaim !== 0n
      ) {
        throw new Error("USDC-only source wallet used native gas");
      }
    }

    const sourceAccountCode = await sourcePublicClient!.getCode({
      address: crossChainSource.sourceAccount,
    });
    if (!sourceAccountCode || sourceAccountCode === "0x") {
      throw new Error("cross-chain claim did not deploy the source Nexus");
    }
    if (HCA_USER_PAID_USDC) {
      await verifyHca(hca, deployments, owner.address);
      await waitForCommitment(commitments[0], deployments.ethRegistrar);
    }
    const sessionAccount = await sdk.createAccount({
      ...baseAccountConfig,
      initData: { address: hca },
    });
    const hcaBalanceAfterCrossChain = (await publicClient.readContract({
      address: deployments.paymentToken,
      abi: MockERC20.abi,
      functionName: "balanceOf",
      args: [hca],
    })) as bigint;
    if (
      HCA_USER_PAID_USDC &&
      hcaBalanceAfterCrossChain !== CROSS_CHAIN_TARGET_AMOUNT
    ) {
      throw new Error(
        `cross-chain route funded the HCA with ${hcaBalanceAfterCrossChain}; expected ${CROSS_CHAIN_TARGET_AMOUNT}`,
      );
    }
    const firstReveal = HCA_USER_PAID_USDC
      ? await executeIntent({
          account: sessionAccount,
          calls: await registrationCalls({
            label: labels[0],
            price: prices[0],
            hca,
            resolver,
            resolverSalt,
            secret: secrets[0],
            deployments,
          }),
          signers: {
            type: "experimental_session",
            session: sessionConfig,
            enableData: destinationEnableData,
            verifyExecutions: true,
          },
          permissionId,
          expectedMode: MODE_ERC1271,
          expectedSessionMode: "05",
          expectedSetupOps: 0,
          feeToken: deployments.paymentToken,
          protocolTokenSpend: prices[0],
          phase: "new-user reveal",
        })
      : undefined;
    const funding = HCA_USER_PAID_USDC
      ? {
          source: "cross-chain USDC" as const,
          hcaBalanceAfterCrossChain,
          operatorTopUp: 0n,
        }
      : await ensurePaymentTokenFunding(
          hca,
          prices[1],
          deployments.paymentToken,
        );
    await verifyRegistration(
      labels[0],
      hca,
      resolver,
      deployments,
      owner.address,
    );

    const secondCommit = await executeIntent({
      account: sessionAccount,
      calls: [
        {
          to: deployments.ethRegistrar,
          value: 0n,
          data: encodeFunctionData({
            abi: ETHRegistrar.abi,
            functionName: "commit",
            args: [commitments[1]],
          }),
        },
      ],
      signers: {
        type: "experimental_session",
        session: sessionConfig,
        enableData: destinationEnableData,
        verifyExecutions: true,
      },
      permissionId,
      expectedMode: MODE_ERC1271,
      expectedSessionMode: "05",
      expectedSetupOps: 0,
      ...(HCA_USER_PAID_USDC && {
        feeToken: deployments.paymentToken,
        protocolTokenSpend: 0n,
      }),
      phase: "existing-user commit",
    });

    await waitForCommitment(commitments[1], deployments.ethRegistrar);
    const secondReveal = await executeIntent({
      account: sessionAccount,
      calls: await registrationCalls({
        label: labels[1],
        price: prices[1],
        hca,
        resolver,
        resolverSalt,
        secret: secrets[1],
        deployments,
      }),
      signers: {
        type: "experimental_session",
        session: sessionConfig,
        enableData: destinationEnableData,
        verifyExecutions: true,
      },
      permissionId,
      expectedMode: MODE_ERC1271,
      expectedSessionMode: "05",
      expectedSetupOps: 0,
      ...(HCA_USER_PAID_USDC && {
        feeToken: deployments.paymentToken,
        protocolTokenSpend: prices[1],
      }),
      phase: "existing-user reveal",
    });
    const verified = await verifyRegistration(
      labels[1],
      hca,
      resolver,
      deployments,
      owner.address,
    );

    console.log(
      JSON.stringify(
        {
          initialState: initiallyDeployed ? "existing" : "new",
          names: labels.map((label) => `${label}.eth`),
          owner: owner.address,
          ownerKeySource,
          hca,
          resolver,
          permissionId,
          sdk: "@rhinestone/sdk@1.8.0 (Bun patch)",
          crossChain: {
            sourceChain: sourceChain.id,
            targetChain: sepolia.id,
            sourceToken: SOURCE_PAYMENT_TOKEN,
            targetToken: deployments.paymentToken,
            targetAmount: CROSS_CHAIN_TARGET_AMOUNT,
            source: { ...crossChainSource, ...sourceClaimState },
          },
          walletInteractions: {
            sourceFundingTransactions: crossChainSource.walletTransactions,
            sourcePermitSignatures: crossChainSource.permitSignatureCount ?? 0,
            permit2Signatures: sourceWalletSignatureCount,
            additionalHcaOwnerSignatures: hcaOwnerSignatureCount,
            total:
              crossChainSource.walletTransactions +
              (crossChainSource.permitSignatureCount ?? 0) +
              sourceWalletSignatureCount +
              hcaOwnerSignatureCount,
          },
          flows: {
            newUser: HCA_USER_PAID_USDC
              ? [firstRegistration, firstReveal!]
              : [preparation!, firstRegistration],
            existingUser: [secondCommit, secondReveal],
          },
          gas: {
            newUserRoundTrip: HCA_USER_PAID_USDC
              ? firstRegistration.gasUsed + firstReveal!.gasUsed
              : preparation!.gasUsed + firstRegistration.gasUsed,
            existingUserRoundTrip: secondCommit.gasUsed + secondReveal.gasUsed,
            testWalletTokenProvisioning: 0n,
          },
          funding,
          verified,
        },
        jsonReplacer,
        2,
      ),
    );
    return;
  }

  const firstCommit = await executeIntent({
    account: firstAccount,
    calls: [
      ...(HCA_SAME_CHAIN_USER_PAID_USDC ? [] : (sameChainFunding?.calls ?? [])),
      {
        to: deployments.ethRegistrar,
        value: 0n,
        data: encodeFunctionData({
          abi: ETHRegistrar.abi,
          functionName: "commit",
          args: [commitments[0]],
        }),
      },
    ],
    signers: {
      type: "experimental_session",
      session: sessionConfig,
      enableData: destinationEnableData,
      verifyExecutions: true,
    },
    permissionId,
    expectedSessionMode: "05",
    expectedMode: MODE_ERC1271,
    expectedSetupOps: initiallyDeployed ? 0 : 1,
    ...(HCA_SAME_CHAIN_USER_PAID_USDC && {
      feeToken: deployments.paymentToken,
      preClaimFunding: {
        token: deployments.paymentToken,
        amount: sameChainFunding!.amountPulled,
        calls: sameChainFunding!.calls,
      },
    }),
    phase: "new-user commit",
  });
  const expectedSessionAuthorizationSignatures =
    HCA_MULTI_CHAIN_SESSION_SIGNATURE ? 0 : 1;
  if (hcaOwnerSignatureCount !== expectedSessionAuthorizationSignatures) {
    throw new Error(
      `same-chain route: expected ${expectedSessionAuthorizationSignatures} session authorization signatures, got ${hcaOwnerSignatureCount}`,
    );
  }
  if (HCA_DRY_RUN_ONLY) {
    if (HCA_SAME_CHAIN_USER_PAID_USDC) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            initialState: initiallyDeployed ? "existing" : "new",
            owner: owner.address,
            hca,
            resolver,
            permissionId,
            routes: { firstCommit },
            sameChainFunding,
            hcaOwnerSignatureCount,
          },
          jsonReplacer,
          2,
        ),
      );
      return;
    }
    const sessionReveal = await executeIntent({
      account: firstAccount,
      calls: await registrationCalls({
        label: labels[0],
        price: prices[0],
        hca,
        resolver,
        resolverSalt,
        secret: secrets[0],
        deployments,
      }),
      signers: {
        type: "experimental_session",
        session: sessionConfig,
        enableData: destinationEnableData,
        verifyExecutions: true,
      },
      permissionId,
      expectedMode: MODE_ERC1271,
      expectedSessionMode: "05",
      expectedSetupOps: initiallyDeployed ? 0 : 1,
      phase: "new-user reveal",
    });
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          initialState: initiallyDeployed ? "existing" : "new",
          owner: owner.address,
          hca,
          resolver,
          permissionId,
          routes: { firstCommit, sessionReveal },
          sameChainFunding,
          hcaOwnerSignatureCount,
        },
        jsonReplacer,
        2,
      ),
    );
    return;
  }

  await verifyHca(hca, deployments, owner.address);
  const existingAccount = await sdk.createAccount({
    ...baseAccountConfig,
    initData: { address: hca },
  });
  if (await existingAccount.experimental_isSessionEnabled(sessionConfig)) {
    throw new Error(
      "stateless HCA session unexpectedly wrote enablement state",
    );
  }
  const funding = await verifySameChainWalletFunding(
    sameChainFunding!,
    HCA_SAME_CHAIN_USER_PAID_USDC ? firstCommit.feePayment!.totalCharge : 0n,
  );

  await waitForCommitment(commitments[0], deployments.ethRegistrar);
  const firstReveal = await executeIntent({
    account: existingAccount,
    calls: await registrationCalls({
      label: labels[0],
      price: prices[0],
      hca,
      resolver,
      resolverSalt,
      secret: secrets[0],
      deployments,
    }),
    signers: {
      type: "experimental_session",
      session: sessionConfig,
      enableData: destinationEnableData,
      verifyExecutions: true,
    },
    permissionId,
    expectedMode: MODE_ERC1271,
    expectedSessionMode: "05",
    expectedSetupOps: 0,
    ...(HCA_SAME_CHAIN_USER_PAID_USDC && {
      feeToken: deployments.paymentToken,
      protocolTokenSpend: prices[0],
    }),
    phase: "new-user reveal",
  });
  await verifyRegistration(
    labels[0],
    hca,
    resolver,
    deployments,
    owner.address,
  );
  console.error(
    JSON.stringify(
      {
        checkpoint: "new-user registration confirmed",
        name: `${labels[0]}.eth`,
        owner: owner.address,
        hca,
        resolver,
        commitTransactionHash: firstCommit.transactionHash,
        revealTransactionHash: firstReveal.transactionHash,
        commitGasUsed: firstCommit.gasUsed,
        revealGasUsed: firstReveal.gasUsed,
        roundTripGasUsed: firstCommit.gasUsed + firstReveal.gasUsed,
      },
      jsonReplacer,
    ),
  );

  const secondCommit = await executeIntent({
    account: existingAccount,
    calls: [
      {
        to: deployments.ethRegistrar,
        value: 0n,
        data: encodeFunctionData({
          abi: ETHRegistrar.abi,
          functionName: "commit",
          args: [commitments[1]],
        }),
      },
    ],
    signers: {
      type: "experimental_session",
      session: sessionConfig,
      enableData: destinationEnableData,
      verifyExecutions: true,
    },
    permissionId,
    expectedMode: MODE_ERC1271,
    expectedSessionMode: "05",
    expectedSetupOps: 0,
    ...(HCA_SAME_CHAIN_USER_PAID_USDC && {
      feeToken: deployments.paymentToken,
    }),
    phase: "existing-user commit",
  });

  await waitForCommitment(commitments[1], deployments.ethRegistrar);
  const secondReveal = await executeIntent({
    account: existingAccount,
    calls: await registrationCalls({
      label: labels[1],
      price: prices[1],
      hca,
      resolver,
      resolverSalt,
      secret: secrets[1],
      deployments,
    }),
    signers: {
      type: "experimental_session",
      session: sessionConfig,
      enableData: destinationEnableData,
      verifyExecutions: true,
    },
    permissionId,
    expectedMode: MODE_ERC1271,
    expectedSessionMode: "05",
    expectedSetupOps: 0,
    ...(HCA_SAME_CHAIN_USER_PAID_USDC && {
      feeToken: deployments.paymentToken,
      protocolTokenSpend: prices[1],
    }),
    phase: "existing-user reveal",
  });
  const verified = await verifyRegistration(
    labels[1],
    hca,
    resolver,
    deployments,
    owner.address,
  );
  const sameChainWalletStateAfter = await readWalletState(owner.address);
  if (
    HCA_SAME_CHAIN_USER_PAID_USDC &&
    (sameChainWalletStateAfter.nativeBalance !== 0n ||
      sameChainWalletStateAfter.transactionCount !== 0)
  ) {
    throw new Error(
      "user-paid same-chain proof used wallet ETH or sent a wallet transaction",
    );
  }

  console.log(
    JSON.stringify(
      {
        initialState: initiallyDeployed ? "existing" : "new",
        names: labels.map((label) => `${label}.eth`),
        owner: owner.address,
        ownerKeySource,
        hca,
        resolver,
        permissionId,
        sdk: "@rhinestone/sdk@1.8.0 (Bun patch)",
        wallet: {
          address: owner.address,
          nativeBalanceBefore: sameChainWalletStateBefore!.nativeBalance,
          nativeBalanceAfter: sameChainWalletStateAfter.nativeBalance,
          transactionCountBefore: sameChainWalletStateBefore!.transactionCount,
          transactionCountAfter: sameChainWalletStateAfter.transactionCount,
        },
        sameChainFunding: funding,
        walletInteractions: {
          paymentPermitSignatures: sameChainFunding!.permitSignatureCount,
          ...(HCA_SAME_CHAIN_USER_PAID_USDC
            ? { multiChainSessionSignatures: hcaOwnerSignatureCount }
            : { ownerIntentSignatures: hcaOwnerSignatureCount }),
          postCommitWalletInteractions: 0,
          total:
            sameChainFunding!.permitSignatureCount + hcaOwnerSignatureCount,
        },
        flows: {
          newUser: [firstCommit, firstReveal],
          existingUser: [secondCommit, secondReveal],
        },
        gas: {
          newUserRoundTrip: firstCommit.gasUsed + firstReveal.gasUsed,
          existingUserRoundTrip: secondCommit.gasUsed + secondReveal.gasUsed,
          testWalletTokenProvisioning: funding.gasUsed,
        },
        verified,
      },
      jsonReplacer,
      2,
    ),
  );
}

async function readWalletState(address: Address) {
  const [nativeBalance, transactionCount] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.getTransactionCount({ address }),
  ]);
  return { nativeBalance, transactionCount };
}

async function fundCrossChainSourceAccount({
  wallet,
  sourceAccount,
  sourceType,
  nexusFundingMode,
}: {
  wallet: Address;
  sourceAccount: Address;
  sourceType: "eoa" | "nexus";
  nexusFundingMode: "prefund" | "atomic-pull" | "permit-pull";
}) {
  const walletBalances = async () =>
    Promise.all([
      sourcePublicClient!.getBalance({ address: wallet }),
      sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [wallet],
      }) as Promise<bigint>,
    ]);

  let [walletNativeBalance, walletUsdcBalance] = await walletBalances();
  let circleFaucetRequested = false;
  let provisioningSource = "existing" as "existing" | "circle" | "operator";
  const provisioningTransactionHashes: Hex[] = [];
  let provisioningGasUsed = 0n;
  const requiredSourceAmount =
    nexusFundingMode === "permit-pull"
      ? CROSS_CHAIN_SOURCE_AMOUNT
      : CROSS_CHAIN_TARGET_AMOUNT;
  if (
    (!HCA_USER_PAID_USDC && walletNativeBalance === 0n) ||
    walletUsdcBalance < requiredSourceAmount
  ) {
    if (!CIRCLE_API_KEY) {
      throw new Error(
        "CIRCLE_API_KEY is required to fund the fresh source wallet",
      );
    }
    const response = await fetch("https://api.circle.com/v1/faucet/drips", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CIRCLE_API_KEY}`,
        "Content-Type": "application/json",
        "X-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        address: wallet,
        blockchain: CIRCLE_SOURCE_BLOCKCHAIN,
        native: !HCA_USER_PAID_USDC,
        usdc: true,
        eurc: false,
      }),
    });
    if (response.status === 204) {
      provisioningSource = "circle";
    } else if (response.status === 429) {
      if (!HCA_ALLOW_SOURCE_TEST_TOP_UP) {
        throw new Error(
          "Circle faucet is rate-limited; set HCA_ALLOW_SOURCE_TEST_TOP_UP=1 to fund the test wallet from DEPLOYER_KEY",
        );
      }
      provisioningSource = "operator";
      if (!HCA_USER_PAID_USDC && walletNativeBalance === 0n) {
        const hash = await sourceProvisionerWalletClient!.sendTransaction({
          to: wallet,
          value: 1_000_000_000_000_000n,
        });
        const receipt = await sourcePublicClient!.waitForTransactionReceipt({
          hash,
        });
        if (receipt.status !== "success") {
          throw new Error(`test-wallet native provisioning reverted: ${hash}`);
        }
        provisioningTransactionHashes.push(hash);
        provisioningGasUsed += receipt.gasUsed;
      }
      if (walletUsdcBalance < requiredSourceAmount) {
        const operatorBalance = (await sourcePublicClient!.readContract({
          address: SOURCE_PAYMENT_TOKEN,
          abi: MockERC20.abi,
          functionName: "balanceOf",
          args: [relayer.address],
        })) as bigint;
        const desired = requiredSourceAmount;
        const amount = operatorBalance < desired ? operatorBalance : desired;
        if (amount < requiredSourceAmount) {
          throw new Error(
            `Circle is rate-limited and the operator has ${operatorBalance} USDC units; ${requiredSourceAmount} required`,
          );
        }
        const simulation = await sourcePublicClient!.simulateContract({
          account: relayer,
          address: SOURCE_PAYMENT_TOKEN,
          abi: MockERC20.abi,
          functionName: "transfer",
          args: [wallet, amount],
        });
        const hash = await sourceProvisionerWalletClient!.writeContract(
          simulation.request,
        );
        const receipt = await sourcePublicClient!.waitForTransactionReceipt({
          hash,
        });
        if (receipt.status !== "success") {
          throw new Error(`test-wallet USDC provisioning reverted: ${hash}`);
        }
        provisioningTransactionHashes.push(hash);
        provisioningGasUsed += receipt.gasUsed;
      }
    } else {
      throw new Error(
        `Circle faucet returned ${response.status}: ${await response.text()}`,
      );
    }
    circleFaucetRequested = true;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      [walletNativeBalance, walletUsdcBalance] = await walletBalances();
      if (
        (HCA_USER_PAID_USDC || walletNativeBalance > 0n) &&
        walletUsdcBalance >= requiredSourceAmount
      ) {
        break;
      }
      await Bun.sleep(5_000);
    }
  }
  if (!HCA_USER_PAID_USDC && walletNativeBalance === 0n) {
    throw new Error(
      `fresh source wallet has no ${sourceChain.name} ETH for funding`,
    );
  }
  if (HCA_USER_PAID_USDC && walletNativeBalance !== 0n) {
    throw new Error(
      `USDC-only proof wallet unexpectedly has ${walletNativeBalance} wei on ${sourceChain.name}`,
    );
  }
  if (walletUsdcBalance < requiredSourceAmount) {
    throw new Error(
      `fresh source wallet has ${walletUsdcBalance} USDC units; ${requiredSourceAmount} required`,
    );
  }

  const sourceAccountBalanceBefore = (await sourcePublicClient!.readContract({
    address: SOURCE_PAYMENT_TOKEN,
    abi: MockERC20.abi,
    functionName: "balanceOf",
    args: [sourceAccount],
  })) as bigint;
  const permit2AllowanceBefore = (await sourcePublicClient!.readContract({
    address: SOURCE_PAYMENT_TOKEN,
    abi: MockERC20.abi,
    functionName: "allowance",
    args: [sourceAccount, PERMIT2],
  })) as bigint;
  if (
    sourceType === "nexus" &&
    (sourceAccountBalanceBefore !== 0n || permit2AllowanceBefore !== 0n)
  ) {
    throw new Error(
      "fresh source account already has funds or Permit2 allowance",
    );
  }

  if (sourceType === "eoa") {
    assertAddress("EOA source account", sourceAccount, wallet);
    let fundingTransactionHash: Hex | undefined;
    let fundingGasUsed = 0n;
    let walletTransactions = 0;
    if (permit2AllowanceBefore < walletUsdcBalance) {
      const simulation = await sourcePublicClient!.simulateContract({
        account: owner,
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "approve",
        args: [PERMIT2, walletUsdcBalance],
      });
      fundingTransactionHash = await sourceWalletClient!.writeContract(
        simulation.request,
      );
      const receipt = await sourcePublicClient!.waitForTransactionReceipt({
        hash: fundingTransactionHash,
      });
      if (receipt.status !== "success") {
        throw new Error(`Permit2 approval reverted: ${fundingTransactionHash}`);
      }
      assertAddress("Permit2 approval sender", receipt.from, wallet);
      fundingGasUsed = receipt.gasUsed;
      walletTransactions = 1;
    }
    const permit2AllowanceAfter = (await sourcePublicClient!.readContract({
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "allowance",
      args: [wallet, PERMIT2],
    })) as bigint;
    if (permit2AllowanceAfter < walletUsdcBalance) {
      throw new Error("EOA Permit2 allowance does not cover the source amount");
    }
    return {
      sourceType,
      wallet,
      sourceAccount,
      circleFaucetRequested,
      provisioningSource,
      provisioningTransactionHashes,
      provisioningGasUsed,
      walletNativeBalance,
      walletBalanceBefore: walletUsdcBalance,
      walletBalanceAfter: walletUsdcBalance,
      sourceAccountBalanceBefore,
      sourceAccountBalanceAfter: walletUsdcBalance,
      routeSourceAmount: walletUsdcBalance,
      sourceCalls: [] as Call[],
      permit2AllowanceBefore,
      permit2AllowanceAfter,
      fundingTransactionHash,
      fundingGasUsed,
      walletTransactions,
      fundingAction: fundingTransactionHash ? "permit2 approval" : "none",
    };
  }

  if (nexusFundingMode === "permit-pull") {
    const permitPullAmount = requiredSourceAmount;
    const [walletToSourceAllowanceBefore, permitNonceBefore, latestBlock] =
      await Promise.all([
        sourcePublicClient!.readContract({
          address: SOURCE_PAYMENT_TOKEN,
          abi: MockERC20.abi,
          functionName: "allowance",
          args: [wallet, sourceAccount],
        }) as Promise<bigint>,
        sourcePublicClient!.readContract({
          address: SOURCE_PAYMENT_TOKEN,
          abi: MockERC20.abi,
          functionName: "nonces",
          args: [wallet],
        }) as Promise<bigint>,
        sourcePublicClient!.getBlock(),
      ]);
    if (walletToSourceAllowanceBefore !== 0n) {
      throw new Error(
        "fresh wallet already has an allowance for the source Nexus",
      );
    }
    const domain = await eip2612Domain(
      sourcePublicClient! as unknown as PublicClient,
      SOURCE_PAYMENT_TOKEN,
      sourceChain.id,
    );
    const permitDeadline = latestBlock.timestamp + SESSION_DURATION;
    const permitSignature = await owner.signTypedData({
      domain,
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: wallet,
        spender: sourceAccount,
        value: permitPullAmount,
        nonce: permitNonceBefore,
        deadline: permitDeadline,
      },
    });
    const { r, s, v, yParity } = parseSignature(permitSignature);
    const permitV = Number(v ?? BigInt(27 + (yParity ?? 0)));
    const permitArgs = [
      wallet,
      sourceAccount,
      permitPullAmount,
      permitDeadline,
      permitV,
      r,
      s,
    ] as const;
    await sourcePublicClient!.simulateContract({
      account: relayer,
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "permit",
      args: permitArgs,
    });
    return {
      sourceType,
      wallet,
      sourceAccount,
      nexusFundingMode,
      circleFaucetRequested,
      provisioningSource,
      provisioningTransactionHashes,
      provisioningGasUsed,
      walletNativeBalance,
      walletBalanceBefore: walletUsdcBalance,
      walletBalanceAfter: walletUsdcBalance,
      sourceAccountBalanceBefore,
      sourceAccountBalanceAfter: sourceAccountBalanceBefore,
      routeSourceAmount: permitPullAmount,
      sourceCalls: [
        {
          to: SOURCE_PAYMENT_TOKEN,
          value: 0n,
          data: encodeFunctionData({
            abi: MockERC20.abi,
            functionName: "permit",
            args: permitArgs,
          }),
        },
        {
          to: SOURCE_PAYMENT_TOKEN,
          value: 0n,
          data: encodeFunctionData({
            abi: MockERC20.abi,
            functionName: "transferFrom",
            args: [wallet, sourceAccount, permitPullAmount],
          }),
        },
      ] as Call[],
      permit2AllowanceBefore,
      permit2AllowanceAfter: permit2AllowanceBefore,
      walletToSourceAllowanceBefore,
      walletToSourceAllowanceAfter: walletToSourceAllowanceBefore,
      permitNonceBefore,
      permitDeadline,
      permitSignatureCount: 1,
      fundingTransactionHash: undefined,
      fundingGasUsed: 0n,
      walletTransactions: 0,
      fundingAction: "EIP-2612 permit",
    };
  }

  if (nexusFundingMode === "atomic-pull") {
    const atomicPullAmount = CROSS_CHAIN_TARGET_AMOUNT;
    const walletToSourceAllowanceBefore =
      (await sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "allowance",
        args: [wallet, sourceAccount],
      })) as bigint;
    let fundingTransactionHash = HCA_SOURCE_APPROVAL_TRANSACTION_HASH;
    let fundingGasUsed = 0n;
    let walletTransactions = fundingTransactionHash ? 1 : 0;
    if (walletToSourceAllowanceBefore < atomicPullAmount) {
      if (fundingTransactionHash) {
        throw new Error(
          "recorded source Nexus approval does not cover the atomic pull",
        );
      }
      const simulation = await sourcePublicClient!.simulateContract({
        account: owner,
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "approve",
        args: [sourceAccount, atomicPullAmount],
      });
      fundingTransactionHash = await sourceWalletClient!.writeContract(
        simulation.request,
      );
      const receipt = await sourcePublicClient!.waitForTransactionReceipt({
        hash: fundingTransactionHash,
      });
      if (receipt.status !== "success") {
        throw new Error(
          `source Nexus approval reverted: ${fundingTransactionHash}`,
        );
      }
      assertAddress("source Nexus approval sender", receipt.from, wallet);
      fundingGasUsed = receipt.gasUsed;
      walletTransactions = 1;
    } else if (fundingTransactionHash) {
      const [receipt, transaction] = await Promise.all([
        sourcePublicClient!.getTransactionReceipt({
          hash: fundingTransactionHash,
        }),
        sourcePublicClient!.getTransaction({ hash: fundingTransactionHash }),
      ]);
      if (receipt.status !== "success") {
        throw new Error(
          `recorded source Nexus approval reverted: ${fundingTransactionHash}`,
        );
      }
      assertAddress(
        "recorded source Nexus approval sender",
        receipt.from,
        wallet,
      );
      assertAddress(
        "recorded source Nexus approval token",
        transaction.to!,
        SOURCE_PAYMENT_TOKEN,
      );
      const decoded = decodeFunctionData({
        abi: MockERC20.abi,
        data: transaction.input,
      });
      if (
        decoded.functionName !== "approve" ||
        decoded.args[0].toLowerCase() !== sourceAccount.toLowerCase() ||
        decoded.args[1] < atomicPullAmount
      ) {
        throw new Error(
          "recorded transaction is not the required source Nexus approval",
        );
      }
      fundingGasUsed = receipt.gasUsed;
    }
    let walletToSourceAllowanceAfter = walletToSourceAllowanceBefore;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      walletToSourceAllowanceAfter = (await sourcePublicClient!.readContract({
        address: SOURCE_PAYMENT_TOKEN,
        abi: MockERC20.abi,
        functionName: "allowance",
        args: [wallet, sourceAccount],
      })) as bigint;
      if (walletToSourceAllowanceAfter >= atomicPullAmount) break;
      await Bun.sleep(1_000);
    }
    if (walletToSourceAllowanceAfter < atomicPullAmount) {
      throw new Error("wallet allowance does not cover the atomic Nexus pull");
    }
    return {
      sourceType,
      wallet,
      sourceAccount,
      nexusFundingMode,
      circleFaucetRequested,
      provisioningSource,
      provisioningTransactionHashes,
      provisioningGasUsed,
      walletNativeBalance,
      walletBalanceBefore: walletUsdcBalance,
      walletBalanceAfter: walletUsdcBalance,
      sourceAccountBalanceBefore,
      sourceAccountBalanceAfter: sourceAccountBalanceBefore,
      routeSourceAmount: atomicPullAmount,
      sourceCalls: [
        {
          to: SOURCE_PAYMENT_TOKEN,
          value: 0n,
          data: encodeFunctionData({
            abi: MockERC20.abi,
            functionName: "transferFrom",
            args: [wallet, sourceAccount, atomicPullAmount],
          }),
        },
      ] as Call[],
      permit2AllowanceBefore,
      permit2AllowanceAfter: permit2AllowanceBefore,
      walletToSourceAllowanceBefore,
      walletToSourceAllowanceAfter,
      fundingTransactionHash,
      fundingGasUsed,
      walletTransactions,
      resumedAfterApproval: HCA_SOURCE_APPROVAL_TRANSACTION_HASH !== undefined,
      fundingAction: fundingTransactionHash
        ? "source account approval"
        : "none",
    };
  }

  const simulation = await sourcePublicClient!.simulateContract({
    account: owner,
    address: SOURCE_PAYMENT_TOKEN,
    abi: MockERC20.abi,
    functionName: "transfer",
    args: [sourceAccount, walletUsdcBalance],
  });
  const fundingTransactionHash = await sourceWalletClient!.writeContract(
    simulation.request,
  );
  const receipt = await sourcePublicClient!.waitForTransactionReceipt({
    hash: fundingTransactionHash,
  });
  if (receipt.status !== "success") {
    throw new Error(
      `source-account funding reverted: ${fundingTransactionHash}`,
    );
  }
  assertAddress("source-account funding sender", receipt.from, wallet);

  let walletBalanceAfter = walletUsdcBalance;
  let sourceAccountBalanceAfter = sourceAccountBalanceBefore;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    [, walletBalanceAfter] = await walletBalances();
    sourceAccountBalanceAfter = (await sourcePublicClient!.readContract({
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "balanceOf",
      args: [sourceAccount],
    })) as bigint;
    if (
      walletBalanceAfter === 0n &&
      sourceAccountBalanceAfter - sourceAccountBalanceBefore ===
        walletUsdcBalance
    ) {
      break;
    }
    await Bun.sleep(1_000);
  }
  if (
    walletBalanceAfter !== 0n ||
    sourceAccountBalanceAfter - sourceAccountBalanceBefore !== walletUsdcBalance
  ) {
    throw new Error(
      "source-account funding balances do not match the wallet transfer",
    );
  }

  return {
    sourceType,
    wallet,
    sourceAccount,
    circleFaucetRequested,
    provisioningSource,
    provisioningTransactionHashes,
    provisioningGasUsed,
    walletNativeBalance,
    walletBalanceBefore: walletUsdcBalance,
    walletBalanceAfter,
    sourceAccountBalanceBefore,
    sourceAccountBalanceAfter,
    routeSourceAmount: sourceAccountBalanceAfter,
    sourceCalls: [] as Call[],
    permit2AllowanceBefore,
    permit2AllowanceAfter: permit2AllowanceBefore,
    fundingTransactionHash,
    fundingGasUsed: receipt.gasUsed,
    walletTransactions: 1,
    fundingAction: "source account transfer",
  };
}

async function runDeferredCrossChainRegistration({
  sdk,
  sourceAccount,
  destinationAccount,
  deployments,
  hca,
  resolver,
  resolverSalt,
  label,
  secret,
  price,
  commitment,
  destinationSession,
  destinationPermissionId,
  validUntil,
  initiallyDeployed,
  sourceWalletSignatureCount,
  hcaOwnerSignatureCount,
  recordSourceWalletSignature,
  sourceSession,
  sourcePermissionId,
  sourceEnableData,
  destinationEnableData,
}: {
  sdk: RhinestoneSDK;
  sourceAccount: RhinestoneAccount;
  destinationAccount: RhinestoneAccount;
  deployments: HcaDeployments;
  hca: Address;
  resolver: Address;
  resolverSalt: bigint;
  label: string;
  secret: Hex;
  price: bigint;
  commitment: Hex;
  destinationSession: Session;
  destinationPermissionId: Hex;
  validUntil: bigint;
  initiallyDeployed: boolean;
  sourceWalletSignatureCount: () => number;
  hcaOwnerSignatureCount: () => number;
  recordSourceWalletSignature: () => void;
  sourceSession: Session;
  sourcePermissionId: Hex;
  sourceEnableData: LiveSessionEnableData;
  destinationEnableData: LiveSessionEnableData;
}) {
  if (HCA_RESUME_DEFERRED && !initiallyDeployed) {
    throw new Error("deferred-funding resume requires an existing HCA");
  }
  if (CROSS_CHAIN_COMMIT_TARGET_AMOUNT >= price) {
    throw new Error(
      "the commit delivery must not cover the registration price",
    );
  }

  const sourceAddress = sourceAccount.getAddress();
  const hcaBalanceBefore = await publicClient.readContract({
    address: deployments.paymentToken,
    abi: MockERC20.abi,
    functionName: "balanceOf",
    args: [hca],
  });
  const funding = HCA_RESUME_DEFERRED
    ? await resumeDeferredSourceFunding({
        sourceAddress,
        totalAmount: CROSS_CHAIN_SOURCE_AMOUNT,
      })
    : await prepareDeferredSourceFunding({
        sourceAddress,
        totalAmount: CROSS_CHAIN_SOURCE_AMOUNT,
        commitAmount: CROSS_CHAIN_COMMIT_SOURCE_AMOUNT,
        validUntil,
        recordWalletSignature: recordSourceWalletSignature,
      });

  let firstRoute:
    | Awaited<ReturnType<typeof executeSessionCrossChainRegistration>>
    | {
        phase: string;
        resumed: true;
        sourcePullAmount: bigint;
        sourceSignedBySession: true;
        destinationSignedBySession: true;
        walletSignatures: 0;
      };
  if (HCA_RESUME_DEFERRED) {
    firstRoute = {
      phase: "deferred-funding deploy and commit",
      resumed: true,
      sourcePullAmount: funding.pulledAtCommit,
      sourceSignedBySession: true,
      destinationSignedBySession: true,
      walletSignatures: 0,
    };
  } else {
    const firstCalls: Call[] = [
      {
        to: deployments.ethRegistrar,
        value: 0n,
        data: encodeFunctionData({
          abi: ETHRegistrar.abi,
          functionName: "commit",
          args: [commitment],
        }),
      },
    ];
    firstRoute = await executeSessionCrossChainRegistration({
      account: sourceAccount,
      recipient: destinationAccount.config,
      calls: firstCalls,
      sourceAmount: CROSS_CHAIN_COMMIT_SOURCE_AMOUNT,
      sourceCalls: funding.commitCalls,
      expectedSourcePull: CROSS_CHAIN_COMMIT_SOURCE_AMOUNT,
      targetAmount: CROSS_CHAIN_COMMIT_TARGET_AMOUNT,
      signers: {
        type: "experimental_session",
        sessions: {
          [sourceChain.id]: {
            session: sourceSession,
            enableData: sourceEnableData,
            verifyExecutions: false,
          },
          [sepolia.id]: {
            session: destinationSession,
            enableData: destinationEnableData,
            verifyExecutions: true,
          },
        },
        verifyExecutions: true,
      },
      sourcePermissionId,
      destinationPermissionId,
      expectedDestinationSessionMode: "04",
      expectedSourceSetupOps: 1,
      expectedRecipientSetupOps: initiallyDeployed ? 0 : 1,
      sourceWalletSignatureCount,
      hcaOwnerSignatureCount,
      phase: "deferred-funding deploy and commit",
    });
  }
  if (HCA_DRY_RUN_ONLY && !HCA_RESUME_DEFERRED) {
    console.log(
      JSON.stringify(
        {
          flow: "cross-chain deferred registration funding commit dry run",
          owner: owner.address,
          sourceNexus: sourceAddress,
          hca,
          walletInteractions: {
            eip2612PermitSignatures: 1,
            multiChainSessionSignatures: 1,
            permit2OwnerSignatures: 0,
            walletTransactions: 0,
            total: 2,
          },
          registrationFundsAvailableAtCommit: false,
          route: firstRoute,
        },
        jsonReplacer,
        2,
      ),
    );
    return;
  }

  await verifyHca(hca, deployments, owner.address);
  const sourceSessionAccount = await sdk.createAccount({
    ...sourceAccount.config,
    initData: { address: sourceAddress },
  });
  const destinationSessionAccount = await sdk.createAccount({
    ...destinationAccount.config,
    initData: { address: hca },
  });
  const sourceValidator = sourceAccount.config.experimental_sessions?.module;
  if (!sourceValidator) {
    throw new Error("source account has no fixed funding validator");
  }
  const sourcePolicyEnabled = await sourcePublicClient!.readContract({
    address: sourceValidator,
    abi: HCAFundingSessionValidator.abi,
    functionName: "isInitialized",
    args: [sourceAddress],
  });
  if (!sourcePolicyEnabled) {
    throw new Error("the commit route did not install the source policy");
  }

  const afterCommit = await readDeferredFundingState({
    sourceAddress,
    hca,
    deployments,
  });
  const pulledAtCommit = firstRoute.sourcePullAmount;
  const revealSourceBudget = CROSS_CHAIN_SOURCE_AMOUNT - pulledAtCommit;
  if (
    afterCommit.walletTokenBalance !==
      funding.walletTokenBalanceBefore - pulledAtCommit ||
    afterCommit.walletToNexusAllowance !== revealSourceBudget ||
    afterCommit.sourceTokenBalance !== 0n ||
    afterCommit.hcaTokenBalance !==
      hcaBalanceBefore + CROSS_CHAIN_COMMIT_TARGET_AMOUNT ||
    afterCommit.walletNativeBalance !== 0n ||
    afterCommit.walletTransactionCount !== 0
  ) {
    throw new Error(
      "commit route did not charge only its own cost and leave the registration funds in the wallet",
    );
  }
  if (
    !HCA_RESUME_DEFERRED &&
    afterCommit.permitNonce !== funding.permitNonceBefore + 1n
  ) {
    throw new Error("commit route did not consume the EIP-2612 permit nonce");
  }

  await waitForCommitment(commitment, deployments.ethRegistrar);
  const refreshedPrice = await registrationPrice(label, deployments);
  if (CROSS_CHAIN_TARGET_AMOUNT <= refreshedPrice) {
    throw new Error(
      `reveal target ${CROSS_CHAIN_TARGET_AMOUNT} does not cover registration price ${refreshedPrice}`,
    );
  }
  const revealCalls = await registrationCalls({
    label,
    price: refreshedPrice,
    hca,
    resolver,
    resolverSalt,
    secret,
    deployments,
  });
  const revealRoute = await executeSessionCrossChainRegistration({
    account: sourceSessionAccount,
    recipient: destinationSessionAccount.config,
    calls: revealCalls,
    sourceCalls: funding.revealCalls,
    sourceAmount: revealSourceBudget,
    expectedSourcePull: revealSourceBudget,
    targetAmount: CROSS_CHAIN_TARGET_AMOUNT,
    signers: {
      type: "experimental_session",
      sessions: {
        [sourceChain.id]: {
          session: sourceSession,
          enableData: sourceEnableData,
          verifyExecutions: false,
        },
        [sepolia.id]: {
          session: destinationSession,
          enableData: destinationEnableData,
          verifyExecutions: true,
        },
      },
      verifyExecutions: true,
    },
    sourcePermissionId,
    destinationPermissionId,
    expectedDestinationSessionMode: "04",
    expectedSourceSetupOps: 0,
    expectedRecipientSetupOps: 0,
    sourceWalletSignatureCount,
    hcaOwnerSignatureCount,
    phase: "deferred-funding reveal",
  });
  if (HCA_DRY_RUN_ONLY) {
    console.log(
      JSON.stringify(
        {
          flow: "cross-chain deferred registration funding reveal dry run",
          owner: owner.address,
          sourceNexus: sourceAddress,
          hca,
          walletInteractions: {
            eip2612PermitSignatures: 1,
            multiChainSessionSignatures: 1,
            permit2OwnerSignatures: 0,
            walletTransactions: 0,
            postCommitWalletInteractions: 0,
            total: 2,
          },
          registrationFundsPulledAtCommit: false,
          funds: {
            pulledAtCommit,
            leftInWalletAfterCommit: afterCommit.walletTokenBalance,
            permitAllowanceAfterCommit: afterCommit.walletToNexusAllowance,
          },
          route: revealRoute,
        },
        jsonReplacer,
        2,
      ),
    );
    return;
  }

  const afterReveal = await readDeferredFundingState({
    sourceAddress,
    hca,
    deployments,
  });
  const pulledAtReveal = revealRoute.sourcePullAmount;
  const totalPulled = pulledAtCommit + pulledAtReveal;
  if (
    afterReveal.walletTokenBalance !==
      funding.walletTokenBalanceBefore - totalPulled ||
    afterReveal.walletToNexusAllowance !==
      CROSS_CHAIN_SOURCE_AMOUNT - totalPulled ||
    afterReveal.sourceTokenBalance !== 0n ||
    afterReveal.walletNativeBalance !== 0n ||
    afterReveal.walletTransactionCount !== 0
  ) {
    throw new Error("reveal route did not pull only its quoted cost");
  }
  const expectedHcaOwnerSignatures = HCA_RESUME_DEFERRED
    ? 1
    : HCA_MULTI_CHAIN_SESSION_SIGNATURE
      ? 0
      : 1;
  if (
    sourceWalletSignatureCount() !== 1 ||
    hcaOwnerSignatureCount() !== expectedHcaOwnerSignatures
  ) {
    throw new Error("session reveal requested another wallet signature");
  }
  const verified = await verifyRegistration(
    label,
    hca,
    resolver,
    deployments,
    owner.address,
  );

  console.log(
    JSON.stringify(
      {
        flow: "cross-chain deferred registration funding",
        name: `${label}.eth`,
        owner: owner.address,
        sourceNexus: sourceAddress,
        hca,
        walletInteractions: {
          eip2612PermitSignatures: 1,
          multiChainSessionSignatures: 1,
          permit2OwnerSignatures: 0,
          walletTransactions: 0,
          postCommitWalletInteractions: 0,
          total: 2,
        },
        funds: {
          totalPermit: CROSS_CHAIN_SOURCE_AMOUNT,
          pulledAtCommit,
          leftInWalletAfterCommit: afterCommit.walletTokenBalance,
          permitAllowanceAfterCommit: afterCommit.walletToNexusAllowance,
          pulledAtReveal,
          leftInWalletAfterReveal: afterReveal.walletTokenBalance,
          permitAllowanceAfterReveal: afterReveal.walletToNexusAllowance,
          deliveredAtCommit: CROSS_CHAIN_COMMIT_TARGET_AMOUNT,
          deliveredAtReveal: CROSS_CHAIN_TARGET_AMOUNT,
        },
        sessions: {
          sourcePermissionId,
          destinationPermissionId,
          ownerAuthorizationReused: Boolean(
            HCA_MULTI_CHAIN_SESSION_SIGNATURE && !HCA_RESUME_DEFERRED,
          ),
          sourcePolicyInstalledAtCommit: sourcePolicyEnabled,
          destinationAuthorizationStateless: true,
        },
        routes: { commit: firstRoute, reveal: revealRoute },
        registrationPriceBeforeCommit: price,
        registrationPriceAtReveal: refreshedPrice,
        verified,
      },
      jsonReplacer,
      2,
    ),
  );
}

async function prepareDeferredSourceFunding({
  sourceAddress,
  totalAmount,
  commitAmount,
  validUntil,
  recordWalletSignature,
}: {
  sourceAddress: Address;
  totalAmount: bigint;
  commitAmount: bigint;
  validUntil: bigint;
  recordWalletSignature: () => void;
}) {
  let state = await readDeferredFundingState({ sourceAddress });
  if (state.walletTokenBalance < totalAmount && HCA_WAIT_FOR_SOURCE_USDC) {
    console.error(
      JSON.stringify(
        {
          checkpoint: "source USDC required",
          chain: sourceChain.name,
          chainId: sourceChain.id,
          token: SOURCE_PAYMENT_TOKEN,
          address: owner.address,
          required: totalAmount,
        },
        jsonReplacer,
      ),
    );
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await Bun.sleep(5_000);
      state = await readDeferredFundingState({ sourceAddress });
      if (state.walletTokenBalance >= totalAmount) break;
    }
  }
  if (state.walletTokenBalance < totalAmount) {
    throw new Error(
      `fresh source wallet has ${state.walletTokenBalance} USDC units; ${totalAmount} required`,
    );
  }
  if (
    state.walletNativeBalance !== 0n ||
    state.walletTransactionCount !== 0 ||
    state.sourceTokenBalance !== 0n ||
    state.walletToNexusAllowance !== 0n
  ) {
    throw new Error(
      "deferred-funding proof requires fresh wallet and Nexus state",
    );
  }

  const permitDeadline = validUntil;
  const domain = await eip2612Domain(
    sourcePublicClient! as unknown as PublicClient,
    SOURCE_PAYMENT_TOKEN,
    sourceChain.id,
  );
  recordWalletSignature();
  const permitSignature = await owner.signTypedData({
    domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: owner.address,
      spender: sourceAddress,
      value: totalAmount,
      nonce: state.permitNonce,
      deadline: permitDeadline,
    },
  });
  const { r, s, v, yParity } = parseSignature(permitSignature);
  const permitV = Number(v ?? BigInt(27 + (yParity ?? 0)));
  const permitArgs = [
    owner.address,
    sourceAddress,
    totalAmount,
    permitDeadline,
    permitV,
    r,
    s,
  ] as const;

  return {
    walletTokenBalanceBefore: state.walletTokenBalance,
    permitNonceBefore: state.permitNonce,
    pulledAtCommit: 0n,
    commitCalls: [
      {
        to: SOURCE_PAYMENT_TOKEN,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "permit",
          args: permitArgs,
        }),
      },
      {
        to: SOURCE_PAYMENT_TOKEN,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "transferFrom",
          args: [owner.address, sourceAddress, commitAmount],
        }),
      },
    ] satisfies CallInput[],
    revealCalls: [
      {
        to: SOURCE_PAYMENT_TOKEN,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "transferFrom",
          args: [owner.address, sourceAddress, totalAmount - commitAmount],
        }),
      },
    ] satisfies CallInput[],
  };
}

async function resumeDeferredSourceFunding({
  sourceAddress,
  totalAmount,
}: {
  sourceAddress: Address;
  totalAmount: bigint;
}) {
  const state = await readDeferredFundingState({ sourceAddress });
  const pulledAtCommit = totalAmount - state.walletToNexusAllowance;
  if (
    pulledAtCommit <= 0n ||
    state.walletToNexusAllowance <= 0n ||
    state.walletTokenBalance !== state.walletToNexusAllowance ||
    state.sourceTokenBalance !== 0n ||
    state.walletNativeBalance !== 0n ||
    state.walletTransactionCount !== 0 ||
    state.permitNonce === 0n
  ) {
    throw new Error(
      `deferred-funding resume state is invalid: ${JSON.stringify(
        { sourceAddress, ...state },
        jsonReplacer,
      )}`,
    );
  }
  return {
    walletTokenBalanceBefore: state.walletTokenBalance + pulledAtCommit,
    permitNonceBefore: state.permitNonce - 1n,
    pulledAtCommit,
    commitCalls: [] satisfies CallInput[],
    revealCalls: [
      {
        to: SOURCE_PAYMENT_TOKEN,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "approve",
          args: [PERMIT2, (1n << 256n) - 1n],
        }),
      },
      {
        to: SOURCE_PAYMENT_TOKEN,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "transferFrom",
          args: [owner.address, sourceAddress, state.walletToNexusAllowance],
        }),
      },
    ] satisfies CallInput[],
  };
}

async function readDeferredFundingState({
  sourceAddress,
  hca,
  deployments,
}: {
  sourceAddress: Address;
  hca?: Address;
  deployments?: HcaDeployments;
}) {
  const [
    walletNativeBalance,
    walletTransactionCount,
    walletTokenBalance,
    sourceTokenBalance,
    walletToNexusAllowance,
    permitNonce,
    hcaTokenBalance,
  ] = await Promise.all([
    sourcePublicClient!.getBalance({ address: owner.address }),
    sourcePublicClient!.getTransactionCount({ address: owner.address }),
    sourcePublicClient!.readContract({
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "balanceOf",
      args: [owner.address],
    }) as Promise<bigint>,
    sourcePublicClient!.readContract({
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "balanceOf",
      args: [sourceAddress],
    }) as Promise<bigint>,
    sourcePublicClient!.readContract({
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "allowance",
      args: [owner.address, sourceAddress],
    }) as Promise<bigint>,
    sourcePublicClient!.readContract({
      address: SOURCE_PAYMENT_TOKEN,
      abi: MockERC20.abi,
      functionName: "nonces",
      args: [owner.address],
    }) as Promise<bigint>,
    hca && deployments
      ? (publicClient.readContract({
          address: deployments.paymentToken,
          abi: MockERC20.abi,
          functionName: "balanceOf",
          args: [hca],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
  ]);
  return {
    walletNativeBalance,
    walletTransactionCount,
    walletTokenBalance,
    sourceTokenBalance,
    walletToNexusAllowance,
    permitNonce,
    hcaTokenBalance,
  };
}

async function debugFillFailure(context: unknown) {
  type StateOverride = {
    address: Address;
    balance?: string;
    stateDiff?: { slot: Hex; value: Hex }[];
  };
  type FillSimulation = {
    success?: boolean;
    action: string;
    chainId?: number;
    call?: { to: Address; data: Hex; value: string };
    details?: {
      blockNumber: string;
      relayer: Address;
      stateOverride: StateOverride[];
    };
  };
  type TraceNode = {
    to?: Address;
    input?: Hex;
    output?: Hex;
    error?: string;
    revertReason?: string;
    type?: string;
    calls?: TraceNode[];
  };

  const simulations = (context as { simulations?: FillSimulation[] })
    .simulations;
  const simulation =
    simulations?.find(({ success }) => success === false) ??
    simulations?.find(({ action }) => action === "fill");
  if (!simulation?.call || !simulation.details) return undefined;
  const stateOverrides = Object.fromEntries(
    simulation.details.stateOverride.map(({ address, balance, stateDiff }) => [
      address,
      {
        ...(balance && { balance: `0x${BigInt(balance).toString(16)}` }),
        ...(stateDiff && {
          stateDiff: Object.fromEntries(
            stateDiff.map(({ slot, value }) => [slot, value]),
          ),
        }),
      },
    ]),
  );
  const traceRpcUrl =
    simulation.chainId === sourceChain.id ? SOURCE_RPC_URL! : rpcUrl;
  const response = await fetch(traceRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "debug_traceCall",
      params: [
        {
          from: simulation.details.relayer,
          to: simulation.call.to,
          data: simulation.call.data,
          value: `0x${BigInt(simulation.call.value).toString(16)}`,
        },
        `0x${BigInt(simulation.details.blockNumber).toString(16)}`,
        { tracer: "callTracer", stateOverrides },
      ],
    }),
  });
  const body = (await response.json()) as {
    result?: TraceNode;
    error?: unknown;
  };
  if (!body.result) return body.error;

  const failurePath = [];
  let node: TraceNode | undefined = body.result;
  while (node) {
    failurePath.push({
      type: node.type,
      to: node.to,
      selector: node.input?.slice(0, 10),
      error: node.error,
      revertReason: node.revertReason,
      output: node.output?.slice(0, 10),
    });
    node = node.calls?.find((call) => call.error || call.revertReason);
  }
  const validationCalls: Array<{
    to?: Address;
    selector?: string;
    input?: string;
    error?: string;
    output?: string;
  }> = [];
  const inspect = (current: TraceNode) => {
    const selector = current.input?.slice(0, 10);
    if (
      selector === "0x1626ba7e" ||
      selector === "0xf551e2ee" ||
      current.to?.toLowerCase() === HCA_FUNDING_SESSION_VALIDATOR?.toLowerCase()
    ) {
      validationCalls.push({
        to: current.to,
        selector,
        input: current.input?.slice(0, 74),
        error: current.error ?? current.revertReason,
        output: current.output?.slice(0, 74),
      });
    }
    current.calls?.forEach(inspect);
  };
  inspect(body.result);
  return { failurePath, validationCalls };
}

async function executeCrossChainRegistration({
  account,
  recipient,
  recipientAddress,
  calls,
  sourceAmount,
  sourceCalls,
  expectedSourcePull,
  expectedSourcePermit,
  expectedSourceSetupOps,
  expectedRecipientSetupOps,
  expectedSourcePermit2Approval,
  sourceType,
  signatureCount,
  phase,
  targetAmount = CROSS_CHAIN_TARGET_AMOUNT,
  expectedSourcePermitValue,
}: {
  account: RhinestoneAccount;
  recipient: RhinestoneAccountConfig;
  recipientAddress: Address;
  calls: Call[];
  sourceAmount: bigint;
  sourceCalls: CallInput[];
  expectedSourcePull?: {
    owner: Address;
    recipient: Address;
    amount: bigint;
  };
  expectedSourcePermit: boolean;
  expectedSourceSetupOps: number;
  expectedRecipientSetupOps: number;
  expectedSourcePermit2Approval: boolean;
  sourceType: "eoa" | "nexus";
  signatureCount: () => number;
  phase: string;
  targetAmount?: bigint;
  expectedSourcePermitValue?: bigint;
}) {
  const transaction: Transaction = {
    sourceChains: [sourceChain],
    targetChain: sepolia,
    recipient,
    calls,
    gasLimit: CROSS_CHAIN_DESTINATION_GAS,
    tokenRequests: [{ address: TARGET_PAYMENT_TOKEN, amount: targetAmount }],
    sourceAssets: [
      {
        chain: sourceChain,
        address: SOURCE_PAYMENT_TOKEN,
        amount: sourceAmount,
      },
    ],
    auxiliaryFunds: {
      [sourceChain.id]: { [SOURCE_PAYMENT_TOKEN]: sourceAmount },
    },
    ...(sourceCalls.length > 0 && {
      sourceCalls: { [sourceChain.id]: sourceCalls },
    }),
    settlementLayers: ["ACROSS"],
    ...(!HCA_SPONSORED && { feeAsset: HCA_FEE_ASSET ?? "USDC" }),
    sponsored: HCA_SPONSORED
      ? { gas: true, bridging: true, swaps: true }
      : { gas: false, bridging: false, swaps: false },
  };
  const prepared = await account.prepareTransaction(transaction);
  const metadata = prepared.intentRoute.intentOp.signedMetadata;
  let sourcePermit2Amount = 0n;
  if (metadata.account.setupOps.length !== expectedSourceSetupOps) {
    throw new Error(
      `${phase}: expected ${expectedSourceSetupOps} source setup ops, got ${metadata.account.setupOps.length}`,
    );
  }
  if (
    expectedSourceSetupOps === 1 &&
    metadata.account.setupOps[0]?.to.toLowerCase() !==
      NEXUS_FACTORY.toLowerCase()
  ) {
    throw new Error(`${phase}: source setup does not call the Nexus factory`);
  }
  if (!metadata.recipient) {
    throw new Error(`${phase}: HCA recipient metadata is missing`);
  }
  if (metadata.recipient.setupOps.length !== expectedRecipientSetupOps) {
    throw new Error(
      `${phase}: expected ${expectedRecipientSetupOps} recipient setup ops, got ${metadata.recipient.setupOps.length}`,
    );
  }
  if (
    expectedRecipientSetupOps === 1 &&
    metadata.recipient.setupOps[0]?.to.toLowerCase() !==
      (recipient.account as StandaloneHcaAccount).factory.toLowerCase()
  ) {
    throw new Error(
      `${phase}: recipient setup does not call StandaloneHCAFactory`,
    );
  }
  let targetMode: Hex | undefined;
  for (const element of prepared.intentRoute.intentOp.elements) {
    const context = element.mandate.qualifier.settlementContext;
    if (
      context.settlementLayer !== "ACROSS" ||
      context.fundingMethod !== "PERMIT2" ||
      context.using7579 !== true
    ) {
      throw new Error(
        `${phase}: expected ACROSS + PERMIT2 through ERC-7579, got ${context.settlementLayer} + ${context.fundingMethod} (using7579=${context.using7579})`,
      );
    }
    if (
      element.mandate.recipient.toLowerCase() !== recipientAddress.toLowerCase()
    ) {
      throw new Error(`${phase}: target recipient is not the standalone HCA`);
    }
    const mode = element.mandate.destinationOps.vt;
    if (mode.toLowerCase() !== MODE_ERC1271.toLowerCase()) {
      throw new Error(
        `${phase}: target HCA does not use ERC-1271 mode (${mode})`,
      );
    }
    const permit2Approval = element.mandate.preClaimOps.ops.find((op) => {
      if (op.to.toLowerCase() !== SOURCE_PAYMENT_TOKEN.toLowerCase())
        return false;
      try {
        const decoded = decodeFunctionData({
          abi: MockERC20.abi,
          data: op.data,
        });
        return (
          decoded.functionName === "approve" &&
          decoded.args[0].toLowerCase() === PERMIT2.toLowerCase() &&
          decoded.args[1] > 0n
        );
      } catch {
        return false;
      }
    });
    if (Boolean(permit2Approval) !== expectedSourcePermit2Approval) {
      throw new Error(
        `${phase}: source Permit2 approval presence does not match ${sourceType} routing`,
      );
    }
    const sourcePull = element.mandate.preClaimOps.ops.find((op) => {
      if (op.to.toLowerCase() !== SOURCE_PAYMENT_TOKEN.toLowerCase())
        return false;
      try {
        const decoded = decodeFunctionData({
          abi: MockERC20.abi,
          data: op.data,
        });
        return (
          decoded.functionName === "transferFrom" &&
          expectedSourcePull !== undefined &&
          decoded.args[0].toLowerCase() ===
            expectedSourcePull.owner.toLowerCase() &&
          decoded.args[1].toLowerCase() ===
            expectedSourcePull.recipient.toLowerCase() &&
          decoded.args[2] === expectedSourcePull.amount
        );
      } catch {
        return false;
      }
    });
    const sourcePermit = element.mandate.preClaimOps.ops.find((op) => {
      if (op.to.toLowerCase() !== SOURCE_PAYMENT_TOKEN.toLowerCase())
        return false;
      try {
        const decoded = decodeFunctionData({
          abi: MockERC20.abi,
          data: op.data,
        });
        return (
          decoded.functionName === "permit" &&
          expectedSourcePull !== undefined &&
          decoded.args[0].toLowerCase() ===
            expectedSourcePull.owner.toLowerCase() &&
          decoded.args[1].toLowerCase() ===
            expectedSourcePull.recipient.toLowerCase() &&
          decoded.args[2] ===
            (expectedSourcePermitValue ?? expectedSourcePull.amount)
        );
      } catch {
        return false;
      }
    });
    if (Boolean(sourcePermit) !== expectedSourcePermit) {
      throw new Error(
        `${phase}: EIP-2612 source permit presence does not match the requested route`,
      );
    }
    if (Boolean(sourcePull) !== Boolean(expectedSourcePull)) {
      throw new Error(
        `${phase}: atomic wallet-to-Nexus pull is missing from the signed pre-claim operations`,
      );
    }
    if (expectedSourcePull) {
      const tokenMask = (1n << 160n) - 1n;
      const elementPermit2Amount = element.idsAndAmounts.reduce(
        (total, [id, amount]) => {
          const token = `0x${(BigInt(id) & tokenMask)
            .toString(16)
            .padStart(40, "0")}`;
          return token.toLowerCase() === SOURCE_PAYMENT_TOKEN.toLowerCase()
            ? total + BigInt(amount)
            : total;
        },
        0n,
      );
      sourcePermit2Amount += elementPermit2Amount;
      if (elementPermit2Amount > expectedSourcePull.amount) {
        throw new Error(
          `${phase}: signed Permit2 amount ${elementPermit2Amount} exceeds source budget ${expectedSourcePull.amount}`,
        );
      }
    }
    targetMode ??= mode;
    const routedCalls = element.mandate.destinationOps.ops;
    if (routedCalls.length !== calls.length) {
      throw new Error(
        `${phase}: wallet mandate contains ${routedCalls.length} target calls, expected ${calls.length}`,
      );
    }
    for (const [index, call] of calls.entries()) {
      const routed = routedCalls[index]!;
      if (
        routed.to.toLowerCase() !== call.to.toLowerCase() ||
        BigInt(routed.value) !== call.value ||
        routed.data.toLowerCase() !== call.data.toLowerCase()
      ) {
        throw new Error(
          `${phase}: target call ${index} changed during routing`,
        );
      }
    }
  }
  if (
    expectedSourcePull &&
    (sourcePermit2Amount === 0n ||
      sourcePermit2Amount > expectedSourcePull.amount)
  ) {
    throw new Error(
      `${phase}: signed Permit2 amount ${sourcePermit2Amount} is outside source budget ${expectedSourcePull.amount}`,
    );
  }

  const signaturesBefore = signatureCount();
  const signed = await account.signTransaction(prepared);
  const signaturesUsed = signatureCount() - signaturesBefore;
  if (signaturesUsed !== 1 || signed.originSignatures.length !== 1) {
    throw new Error(
      `${phase}: expected one wallet signature, used ${signaturesUsed} for ${signed.originSignatures.length} origin signatures`,
    );
  }
  const originSignature = signed.originSignatures[0];
  if (typeof originSignature !== "string") {
    throw new Error(`${phase}: Permit2 signature is not a byte string`);
  }
  const ownerSignature =
    sourceType === "eoa"
      ? originSignature
      : (`0x${originSignature.slice(42)}` as Hex);
  const expectedDestinationSignature = concat([zeroAddress, ownerSignature]);
  if (
    size(ownerSignature) !== 65 ||
    (sourceType === "nexus" &&
      (size(originSignature) !== 85 ||
        !originSignature.toLowerCase().startsWith(zeroAddress))) ||
    size(signed.destinationSignature) !== 85 ||
    signed.destinationSignature.toLowerCase() !==
      expectedDestinationSignature.toLowerCase()
  ) {
    throw new Error(`${phase}: target HCA did not reuse the Permit2 signature`);
  }
  if (signed.targetExecutionSignature) {
    throw new Error(`${phase}: SDK requested a second target signature`);
  }
  const messages = account.getTransactionMessages(prepared);
  if (messages.origin.length !== 1) {
    throw new Error(`${phase}: expected one Permit2 typed-data message`);
  }
  const recovered = await recoverTypedDataAddress({
    ...messages.origin[0]!,
    signature: ownerSignature,
  });
  assertAddress(`${phase} Permit2 signer`, recovered, owner.address);

  const route = {
    phase,
    intentId: prepared.intentRoute.intentOp.nonce,
    sourceSetupOps: metadata.account.setupOps.length,
    recipientSetupOps: metadata.recipient.setupOps.length,
    sourceWalletSignatures: signaturesUsed,
    destinationReusesPermit2Signature: true,
    sourcePullViaNexus: expectedSourcePull !== undefined,
    sourcePermitViaEip2612: expectedSourcePermit,
    targetAmount,
    sourcePullAmount: expectedSourcePull?.amount ?? 0n,
    sourcePermit2Amount,
    using7579: true,
    mode: targetMode!,
    settlementLayer: "ACROSS" as const,
    fundingMethod: "PERMIT2" as const,
    sponsored: HCA_SPONSORED,
    feeAsset: HCA_FEE_ASSET ?? "USDC",
    fees: metadata.fees,
    sourceSpends: prepared.intentRoute.intentOp.elements.map((element) => ({
      spendTokens: element.spendTokens,
      idsAndAmounts: element.idsAndAmounts,
    })),
  };
  if (HCA_DRY_RUN_ONLY) {
    return {
      ...route,
      dryRun: true as const,
      gasUsed: 0n,
    };
  }

  let result;
  try {
    result = await account.submitTransaction(signed, []);
  } catch (error) {
    const context = (
      error as {
        _context?: unknown;
        _traceId?: string;
      }
    )._context;
    const traceId = (error as { _traceId?: string })._traceId;
    const trace = await debugFillFailure(context).catch((traceError) => ({
      traceError: String(traceError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ simulationContext: context }, jsonReplacer));
    throw new Error(
      `${phase}: submit simulation failed${traceId ? ` (${traceId})` : ""}: ${message}${trace ? `: ${JSON.stringify(trace)}` : ""}`,
    );
  }
  const status = await account.waitForExecution(result, false);
  if (!status.fill.hash || status.fill.chainId !== sepolia.id) {
    throw new Error(`${phase}: target fill is missing or on the wrong chain`);
  }
  if (
    status.claims.length !== 1 ||
    !status.claims[0]?.hash ||
    status.claims[0].chainId !== sourceChain.id
  ) {
    throw new Error(`${phase}: expected one ${sourceChain.name} claim`);
  }
  const [claimReceipt, fillReceipt] = await Promise.all([
    sourcePublicClient!.waitForTransactionReceipt({
      hash: status.claims[0].hash,
    }),
    publicClient.waitForTransactionReceipt({ hash: status.fill.hash }),
  ]);
  if (claimReceipt.status !== "success" || fillReceipt.status !== "success") {
    throw new Error(`${phase}: claim or fill reverted`);
  }
  return {
    ...route,
    intentId: result.id,
    claimTransactionHash: status.claims[0].hash,
    fillTransactionHash: status.fill.hash,
    claimGasUsed: claimReceipt.gasUsed,
    fillGasUsed: fillReceipt.gasUsed,
    gasUsed: claimReceipt.gasUsed + fillReceipt.gasUsed,
  };
}

async function executeSessionCrossChainRegistration({
  account,
  recipient,
  calls,
  sourceCalls,
  sourceAmount,
  expectedSourcePull,
  targetAmount,
  signers,
  sourcePermissionId,
  destinationPermissionId,
  expectedDestinationSessionMode,
  expectedSourceSetupOps,
  expectedRecipientSetupOps,
  sourceWalletSignatureCount,
  hcaOwnerSignatureCount,
  phase,
}: {
  account: RhinestoneAccount;
  recipient: RhinestoneAccountConfig;
  calls: Call[];
  sourceCalls: CallInput[];
  sourceAmount: bigint;
  expectedSourcePull: bigint;
  targetAmount: bigint;
  signers: SignerSet;
  sourcePermissionId: Hex;
  destinationPermissionId: Hex;
  expectedDestinationSessionMode: "03" | "04";
  expectedSourceSetupOps: number;
  expectedRecipientSetupOps: number;
  sourceWalletSignatureCount: () => number;
  hcaOwnerSignatureCount: () => number;
  phase: string;
}) {
  if (sourceAmount !== expectedSourcePull) {
    throw new Error(`${phase}: source budget and pull cap differ`);
  }
  const sourceAddress = account.getAddress();
  const callsForPull = (pullAmount: bigint) => {
    let pullCount = 0;
    const adjusted = sourceCalls.map((call) => {
      if (
        !("to" in call) ||
        !("data" in call) ||
        !call.data ||
        call.to.toLowerCase() !== SOURCE_PAYMENT_TOKEN.toLowerCase()
      ) {
        return call;
      }
      try {
        const decoded = decodeFunctionData({
          abi: MockERC20.abi,
          data: call.data,
        });
        if (
          decoded.functionName !== "transferFrom" ||
          decoded.args[0].toLowerCase() !== owner.address.toLowerCase() ||
          decoded.args[1].toLowerCase() !== sourceAddress.toLowerCase()
        ) {
          return call;
        }
        pullCount += 1;
        return {
          ...call,
          data: encodeFunctionData({
            abi: MockERC20.abi,
            functionName: "transferFrom",
            args: [owner.address, sourceAddress, pullAmount],
          }),
        };
      } catch {
        return call;
      }
    });
    if (pullCount !== 1) {
      throw new Error(`${phase}: expected one wallet-to-Nexus pull`);
    }
    return adjusted;
  };
  const transactionForPull = (pullAmount: bigint): Transaction => ({
    sourceChains: [sourceChain],
    targetChain: sepolia,
    recipient,
    calls,
    gasLimit: CROSS_CHAIN_DESTINATION_GAS,
    tokenRequests: [{ address: TARGET_PAYMENT_TOKEN, amount: targetAmount }],
    sourceAssets: [
      {
        chain: sourceChain,
        address: SOURCE_PAYMENT_TOKEN,
        amount: sourceAmount,
      },
    ],
    auxiliaryFunds: {
      [sourceChain.id]: { [SOURCE_PAYMENT_TOKEN]: sourceAmount },
    },
    sourceCalls: { [sourceChain.id]: callsForPull(pullAmount) },
    signers,
    settlementLayers: ["ACROSS"],
    feeAsset: HCA_FEE_ASSET ?? "USDC",
    sponsored: { gas: false, bridging: false, swaps: false },
  });
  const quotedSourceAmount = (
    preparedRoute: Awaited<ReturnType<typeof account.prepareTransaction>>,
  ) => {
    const elements = preparedRoute.intentRoute.intentOp.elements;
    if (elements.length !== 1) {
      throw new Error(`${phase}: expected one Across route element`);
    }
    const tokenMask = (1n << 160n) - 1n;
    return elements[0]!.idsAndAmounts.reduce((total, [id, amount]) => {
      const token = `0x${(BigInt(id) & tokenMask)
        .toString(16)
        .padStart(40, "0")}`;
      return token.toLowerCase() === SOURCE_PAYMENT_TOKEN.toLowerCase()
        ? total + BigInt(amount)
        : total;
    }, 0n);
  };

  let routedSourcePull = expectedSourcePull;
  const quotedSourcePulls: bigint[] = [];
  let prepared = await account.prepareTransaction(
    transactionForPull(routedSourcePull),
  );
  const maxQuoteAttempts = 12;
  for (let attempt = 0; attempt < maxQuoteAttempts; attempt += 1) {
    const quoted = quotedSourceAmount(prepared);
    quotedSourcePulls.push(quoted);
    if (quoted === routedSourcePull) break;
    if (quoted === 0n || quoted > expectedSourcePull) {
      throw new Error(
        `${phase}: quoted source cost ${quoted} is outside the ${expectedSourcePull} budget`,
      );
    }
    if (attempt === maxQuoteAttempts - 1) {
      throw new Error(
        `${phase}: source cost did not settle after re-quoting: ${quotedSourcePulls.join(", ")}`,
      );
    }
    routedSourcePull = quoted;
    prepared = await account.prepareTransaction(
      transactionForPull(routedSourcePull),
    );
  }
  const signatureMode = (
    prepared.intentInput as { options?: { signatureMode?: number } }
  ).options?.signatureMode;
  const expectedSignatureMode = 6;
  if (signatureMode !== expectedSignatureMode) {
    throw new Error(
      `${phase}: expected signature mode ${expectedSignatureMode}, got ${signatureMode}`,
    );
  }
  const metadata = prepared.intentRoute.intentOp.signedMetadata;
  const gasRefunds = prepared.intentRoute.intentOp.elements.map(
    (element) =>
      element.mandate.qualifier.settlementContext.gasRefund ?? {
        token: zeroAddress,
        exchangeRate: 0n,
        overhead: 0n,
      },
  );
  if (metadata.account.setupOps.length !== expectedSourceSetupOps) {
    throw new Error(`${phase}: source Nexus setup count changed`);
  }
  if (
    !metadata.recipient ||
    metadata.recipient.setupOps.length !== expectedRecipientSetupOps
  ) {
    throw new Error(`${phase}: destination HCA setup count changed`);
  }

  let sourcePullFound = false;
  let sourcePermitFound = false;
  let signedSourceAmount = 0n;
  for (const element of prepared.intentRoute.intentOp.elements) {
    const context = element.mandate.qualifier.settlementContext;
    if (
      context.settlementLayer !== "ACROSS" ||
      context.fundingMethod !== "PERMIT2" ||
      context.using7579 !== true
    ) {
      throw new Error(`${phase}: route is not ERC-7579 Permit2 + Across`);
    }
    const sourcePull = element.mandate.preClaimOps.ops.some((op) => {
      if (op.to.toLowerCase() !== SOURCE_PAYMENT_TOKEN.toLowerCase()) {
        return false;
      }
      try {
        const decoded = decodeFunctionData({
          abi: MockERC20.abi,
          data: op.data,
        });
        return (
          decoded.functionName === "transferFrom" &&
          decoded.args[0].toLowerCase() === owner.address.toLowerCase() &&
          decoded.args[1].toLowerCase() ===
            account.getAddress().toLowerCase() &&
          decoded.args[2] === routedSourcePull
        );
      } catch {
        return false;
      }
    });
    sourcePullFound ||= sourcePull;
    sourcePermitFound ||= element.mandate.preClaimOps.ops.some((op) => {
      if (op.to.toLowerCase() !== SOURCE_PAYMENT_TOKEN.toLowerCase()) {
        return false;
      }
      try {
        const decoded = decodeFunctionData({
          abi: MockERC20.abi,
          data: op.data,
        });
        return (
          decoded.functionName === "permit" &&
          decoded.args[0].toLowerCase() === owner.address.toLowerCase() &&
          decoded.args[1].toLowerCase() ===
            account.getAddress().toLowerCase() &&
          decoded.args[2] === CROSS_CHAIN_SOURCE_AMOUNT
        );
      } catch {
        return false;
      }
    });
    const tokenMask = (1n << 160n) - 1n;
    signedSourceAmount += element.idsAndAmounts.reduce(
      (total, [id, amount]) => {
        const token = `0x${(BigInt(id) & tokenMask)
          .toString(16)
          .padStart(40, "0")}`;
        return token.toLowerCase() === SOURCE_PAYMENT_TOKEN.toLowerCase()
          ? total + BigInt(amount)
          : total;
      },
      0n,
    );
    const routedCalls = element.mandate.destinationOps.ops;
    if (routedCalls.length !== calls.length) {
      throw new Error(`${phase}: destination call count changed`);
    }
    for (const [index, call] of calls.entries()) {
      const routed = routedCalls[index]!;
      if (
        routed.to.toLowerCase() !== call.to.toLowerCase() ||
        BigInt(routed.value) !== call.value ||
        routed.data.toLowerCase() !== call.data.toLowerCase()
      ) {
        throw new Error(`${phase}: destination call ${index} changed`);
      }
    }
  }
  if (!sourcePullFound) {
    throw new Error(`${phase}: wallet-to-Nexus pull is missing`);
  }
  if (signedSourceAmount !== routedSourcePull) {
    throw new Error(
      `${phase}: Permit2 claim ${signedSourceAmount} does not equal the wallet pull ${routedSourcePull}`,
    );
  }
  if (sourcePermitFound !== (expectedSourceSetupOps === 1)) {
    throw new Error(`${phase}: EIP-2612 permit presence is wrong for this leg`);
  }

  const sourceWalletSignaturesBefore = sourceWalletSignatureCount();
  const hcaOwnerSignaturesBefore = hcaOwnerSignatureCount();
  const signed = await account.signTransaction(prepared);
  if (
    sourceWalletSignatureCount() !== sourceWalletSignaturesBefore ||
    hcaOwnerSignatureCount() !== hcaOwnerSignaturesBefore
  ) {
    throw new Error(`${phase}: session route requested a wallet signature`);
  }
  if (signed.originSignatures.length !== 1) {
    throw new Error(`${phase}: expected one source-chain signature`);
  }
  const originSignature = signed.originSignatures[0];
  const sourceValidator = account.config.experimental_sessions?.module;
  if (
    !sourceValidator ||
    typeof originSignature !== "string" ||
    size(originSignature) <= 560 ||
    !originSignature
      .toLowerCase()
      .startsWith(
        `${sourceValidator}04${sourcePermissionId.slice(2)}`.toLowerCase(),
      )
  ) {
    throw new Error(`${phase}: fixed source-session signature is malformed`);
  }
  const destinationSignature = signed.destinationSignature;
  const destinationSessionMode = destinationSignature?.slice(42, 44);
  if (
    !destinationSignature ||
    size(destinationSignature) <= 560 ||
    destinationSessionMode !== expectedDestinationSessionMode ||
    !destinationSignature
      .toLowerCase()
      .startsWith(
        `${zeroAddress}${expectedDestinationSessionMode}${destinationPermissionId.slice(2)}`.toLowerCase(),
      )
  ) {
    throw new Error(
      `${phase}: destination HCA session signature is malformed: ${JSON.stringify(
        {
          size: destinationSignature ? size(destinationSignature) : 0,
          prefix: destinationSignature?.slice(0, 112),
          destinationSessionMode,
          destinationPermissionId,
        },
      )}`,
    );
  }
  if (signed.targetExecutionSignature) {
    throw new Error(`${phase}: SDK requested a second destination signature`);
  }

  if (HCA_DRY_RUN_ONLY) {
    return {
      phase,
      intentId: prepared.intentRoute.intentOp.nonce,
      sourcePermissionId,
      destinationPermissionId,
      sourcePullAmount: routedSourcePull,
      sourceAmount: routedSourcePull,
      targetAmount,
      gasRefunds,
      sourceSignedBySession: true,
      destinationSignedBySession: true,
      walletSignatures: 0,
      dryRun: true as const,
      gasUsed: 0n,
    };
  }

  let result;
  try {
    result = await account.submitTransaction(signed, []);
  } catch (error) {
    if (process.env.HCA_DEBUG === "1") {
      console.error(
        JSON.stringify(
          {
            sourceTypedData: account.getTransactionMessages(prepared).origin[0],
            sourceSignature: {
              size:
                typeof originSignature === "string"
                  ? size(originSignature)
                  : undefined,
              prefix:
                typeof originSignature === "string"
                  ? originSignature.slice(0, 118)
                  : undefined,
            },
          },
          jsonReplacer,
        ),
      );
    }
    const context = (error as { _context?: unknown })._context;
    const traceId = (error as { _traceId?: string })._traceId;
    const trace = await debugFillFailure(context).catch((traceError) => ({
      traceError: String(traceError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${phase}: submit simulation failed${traceId ? ` (${traceId})` : ""}: ${message}${trace ? `: ${JSON.stringify(trace)}` : ""}`,
    );
  }
  const status = await account.waitForExecution(result, false);
  if (!status.fill.hash || status.fill.chainId !== sepolia.id) {
    throw new Error(`${phase}: target fill is missing or on the wrong chain`);
  }
  if (
    status.claims.length !== 1 ||
    !status.claims[0]?.hash ||
    status.claims[0].chainId !== sourceChain.id
  ) {
    throw new Error(`${phase}: source claim is missing or on the wrong chain`);
  }
  const [claimReceipt, fillReceipt] = await Promise.all([
    sourcePublicClient!.waitForTransactionReceipt({
      hash: status.claims[0].hash,
    }),
    publicClient.waitForTransactionReceipt({ hash: status.fill.hash }),
  ]);
  if (claimReceipt.status !== "success" || fillReceipt.status !== "success") {
    throw new Error(`${phase}: claim or fill reverted`);
  }
  return {
    phase,
    intentId: result.id,
    claimTransactionHash: status.claims[0].hash,
    fillTransactionHash: status.fill.hash,
    sourcePermissionId,
    destinationPermissionId,
    sourcePullAmount: routedSourcePull,
    sourceAmount: routedSourcePull,
    targetAmount,
    gasRefunds,
    sourceSignedBySession: true,
    destinationSignedBySession: true,
    walletSignatures: 0,
    claimGasUsed: claimReceipt.gasUsed,
    fillGasUsed: fillReceipt.gasUsed,
    gasUsed: claimReceipt.gasUsed + fillReceipt.gasUsed,
  };
}

async function executeIntent({
  account,
  calls,
  signers,
  permissionId,
  expectedMode,
  expectedSessionMode,
  expectedSetupOps,
  feeToken,
  protocolTokenSpend = 0n,
  preClaimFunding,
  phase,
}: {
  account: RhinestoneAccount;
  calls: Call[];
  signers?: SignerSet;
  permissionId?: Hex;
  expectedMode: Hex;
  expectedSessionMode?: "01" | "02" | "05";
  expectedSetupOps: number;
  feeToken?: Address;
  protocolTokenSpend?: bigint;
  preClaimFunding?: {
    token: Address;
    amount: bigint;
    calls: Call[];
  };
  phase: string;
}) {
  const transaction: Transaction = {
    chain: sepolia,
    calls,
    signers,
    ...(SESSION_GAS_LIMIT !== undefined && { gasLimit: SESSION_GAS_LIMIT }),
    ...(preClaimFunding && {
      sourceAssets: [
        {
          chain: sepolia,
          address: preClaimFunding.token,
          amount: preClaimFunding.amount,
        },
      ],
      auxiliaryFunds: {
        [sepolia.id]: {
          [preClaimFunding.token]: preClaimFunding.amount,
        },
      },
      sourceCalls: { [sepolia.id]: preClaimFunding.calls },
    }),
    ...(!HCA_SPONSORED && { feeAsset: HCA_FEE_ASSET ?? "USDC" }),
    sponsored: HCA_SPONSORED
      ? { gas: true, bridging: true, swaps: true }
      : { gas: false, bridging: false, swaps: false },
  };
  const prepared = await account.prepareTransaction(transaction);
  const setupOps =
    prepared.intentRoute.intentOp.signedMetadata.account.setupOps;
  const gasRefunds = prepared.intentRoute.intentOp.elements.map(
    (element) =>
      element.mandate.qualifier.settlementContext.gasRefund ?? {
        token: zeroAddress,
        exchangeRate: 0n,
        overhead: 0n,
      },
  );
  const hasGasRefund = gasRefunds.some(
    ({ token, exchangeRate, overhead }) =>
      token.toLowerCase() !== zeroAddress ||
      BigInt(exchangeRate) !== 0n ||
      BigInt(overhead) !== 0n,
  );
  if (HCA_USER_PAID_EXECUTION) {
    if (!feeToken || !hasGasRefund) {
      throw new Error(`${phase}: unsponsored session route has no USDC refund`);
    }
    for (const refund of gasRefunds) {
      const exchangeRate = BigInt(refund.exchangeRate);
      const packedOverhead = BigInt(refund.overhead);
      const refundAmount = packedOverhead >> 128n;
      const gasOverhead = packedOverhead & ((1n << 128n) - 1n);
      if (
        refund.token.toLowerCase() !== feeToken.toLowerCase() ||
        exchangeRate === 0n ||
        exchangeRate > MAX_REFUND_EXCHANGE_RATE ||
        refundAmount === 0n ||
        refundAmount > MAX_REFUND_AMOUNT ||
        gasOverhead > MAX_REFUND_GAS_OVERHEAD
      ) {
        throw new Error(
          `${phase}: refund ${JSON.stringify(
            {
              token: refund.token,
              exchangeRate,
              refundAmount,
              gasOverhead,
            },
            jsonReplacer,
          )} exceeds limits ${JSON.stringify(
            {
              token: feeToken,
              maxExchangeRate: MAX_REFUND_EXCHANGE_RATE,
              maxRefundAmount: MAX_REFUND_AMOUNT,
              maxGasOverhead: MAX_REFUND_GAS_OVERHEAD,
            },
            jsonReplacer,
          )}`,
        );
      }
    }
  }
  const paymentMetadata = {
    sponsor: prepared.intentRoute.intentOp.sponsor,
    fees: prepared.intentRoute.intentOp.signedMetadata.fees,
    elements: prepared.intentRoute.intentOp.elements.map((element) => ({
      fundingMethod: element.mandate.qualifier.settlementContext.fundingMethod,
      subsidizedAmount:
        element.mandate.qualifier.settlementContext.subsidizedAmount,
      spendTokens: element.spendTokens,
      idsAndAmounts: element.idsAndAmounts,
    })),
  };
  if (setupOps.length !== expectedSetupOps) {
    throw new Error(
      `${phase}: expected ${expectedSetupOps} setup ops, got ${setupOps.length}`,
    );
  }
  if (
    expectedSetupOps === 1 &&
    setupOps[0].to.toLowerCase() !==
      (account.config.account as StandaloneHcaAccount).factory.toLowerCase()
  ) {
    throw new Error(`${phase}: setup op does not call StandaloneHCAFactory`);
  }
  for (const element of prepared.intentRoute.intentOp.elements) {
    if (element.mandate.destinationOps.vt.toLowerCase() !== expectedMode) {
      throw new Error(
        `${phase}: expected operation mode ${expectedMode}, got ${element.mandate.destinationOps.vt}`,
      );
    }
  }

  const signed = await account.signTransaction(prepared);
  const originSignatures = signed.originSignatures.map((signature) => {
    if (typeof signature !== "string") {
      throw new Error(`${phase}: SDK emitted a hybrid signature`);
    }
    return signature;
  });
  if (expectedMode === MODE_ERC1271 && !permissionId) {
    if (signed.targetExecutionSignature) {
      throw new Error(
        `${phase}: owner route unexpectedly has a target execution signature`,
      );
    }
    const messages = account.getTransactionMessages(prepared);
    if (messages.origin.length !== originSignatures.length) {
      throw new Error(`${phase}: route message and signature counts differ`);
    }
    const routeSignatures = [
      ...originSignatures.map((signature, index) => ({
        label: `origin ${index}`,
        message: messages.origin[index]!,
        signature,
      })),
      {
        label: "destination",
        message: messages.destination,
        signature: signed.destinationSignature,
      },
    ];
    for (const { label, message, signature } of routeSignatures) {
      if (!signature.toLowerCase().startsWith(zeroAddress)) {
        throw new Error(
          `${phase}: ${label} does not select the default validator`,
        );
      }
      if (size(signature) !== 85) {
        throw new Error(
          `${phase}: ${label} signature is ${size(signature)} bytes`,
        );
      }
      const signatureV = Number.parseInt(signature.slice(-2), 16);
      if (signatureV !== 27 && signatureV !== 28) {
        throw new Error(`${phase}: ${label} signature v is ${signatureV}`);
      }
      const recovered = await recoverTypedDataAddress({
        ...message,
        signature: `0x${signature.slice(42)}`,
      });
      if (recovered.toLowerCase() !== owner.address.toLowerCase()) {
        throw new Error(
          `${phase}: ${label} signature does not recover the HCA owner`,
        );
      }
    }
  } else if (expectedMode === MODE_ERC1271) {
    if (!permissionId) throw new Error(`${phase}: permission ID is required`);
    const signature = signed.targetExecutionSignature;
    if (!signature) {
      throw new Error(
        `${phase}: fixed session has no target execution signature`,
      );
    }
    const sessionMode = expectedSessionMode ?? (hasGasRefund ? "02" : "01");
    const expectedPrefix =
      `${zeroAddress}${sessionMode}${permissionId.slice(2)}`.toLowerCase();
    if (!signature.toLowerCase().startsWith(expectedPrefix)) {
      throw new Error(
        `${phase}: fixed session does not select the HCA validator; signature=${signature.slice(0, 108)}, refunds=${JSON.stringify(gasRefunds, jsonReplacer)}`,
      );
    }
    if (size(signature) <= 150) {
      throw new Error(
        `${phase}: fixed session does not carry an operation preimage`,
      );
    }
    const signatureV = Number.parseInt(signature.slice(-2), 16);
    if (signatureV !== 31 && signatureV !== 32) {
      throw new Error(`${phase}: fixed session signature v is ${signatureV}`);
    }
  } else {
    throw new Error(
      `${phase}: unsupported session operation mode ${expectedMode}`,
    );
  }

  if (HCA_DRY_RUN_ONLY) {
    return {
      phase,
      intentId: prepared.intentRoute.intentOp.nonce,
      setupOps: setupOps.length,
      mode: expectedMode,
      settlementLayers: prepared.intentRoute.intentOp.elements.map(
        (element) =>
          element.mandate.qualifier.settlementContext.settlementLayer,
      ),
      gasRefunds,
      paymentMetadata,
      dryRun: true as const,
      gasUsed: 0n,
    };
  }
  const feeTokenBalanceBefore = feeToken
    ? ((await publicClient.readContract({
        address: feeToken,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [account.getAddress()],
      })) as bigint)
    : undefined;
  let result;
  try {
    result = await account.submitTransaction(signed, []);
  } catch (error) {
    const context = (
      error as {
        _context?: unknown;
        _traceId?: string;
      }
    )._context;
    const traceId = (error as { _traceId?: string })._traceId;
    const trace = await debugFillFailure(context).catch((traceError) => ({
      traceError: String(traceError),
    }));
    throw new Error(
      `${phase}: submit simulation failed${traceId ? ` (${traceId})` : ""}${trace ? `: ${JSON.stringify(trace)}` : ""}`,
    );
  }
  const status = await account.waitForExecution(result, false);
  if (!status.fill.hash)
    throw new Error(`${phase}: fill has no transaction hash`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: status.fill.hash,
  });
  if (receipt.status !== "success") {
    throw new Error(`${phase}: fill reverted (${status.fill.hash})`);
  }
  const feePayment = feeToken
    ? await (async () => {
        const balanceAfter = (await publicClient.readContract({
          address: feeToken,
          abi: MockERC20.abi,
          functionName: "balanceOf",
          args: [account.getAddress()],
        })) as bigint;
        const balanceAvailable =
          (feeTokenBalanceBefore ?? 0n) + (preClaimFunding?.amount ?? 0n);
        if (
          feeTokenBalanceBefore === undefined ||
          balanceAvailable < balanceAfter
        ) {
          throw new Error(`${phase}: invalid USDC balance change`);
        }
        const totalCharge = balanceAvailable - balanceAfter;
        if (totalCharge < protocolTokenSpend) {
          throw new Error(
            `${phase}: USDC charge is smaller than protocol spend`,
          );
        }
        const executionFee = totalCharge - protocolTokenSpend;
        if (HCA_USER_PAID_EXECUTION && executionFee === 0n) {
          throw new Error(`${phase}: executor took no USDC fee`);
        }
        return {
          token: feeToken,
          balanceBefore: feeTokenBalanceBefore,
          fundedBeforeExecution: preClaimFunding?.amount ?? 0n,
          balanceAfter,
          totalCharge,
          protocolSpend: protocolTokenSpend,
          executionFee,
        };
      })()
    : undefined;
  return {
    phase,
    intentId: result.id,
    transactionHash: status.fill.hash,
    setupOps: setupOps.length,
    mode: expectedMode,
    gasRefunds,
    paymentMetadata,
    feePayment,
    gasUsed: receipt.gasUsed,
  };
}

async function verifyHca(
  hca: Address,
  deployments: {
    verifiableFactory: Address;
    standaloneHcaImplementation: Address;
  },
  expectedOwner: Address,
) {
  await assertCode("HCA", hca);
  const implementation = (await publicClient.readContract({
    address: deployments.verifiableFactory,
    abi: VerifiableFactory.abi,
    functionName: "verifyContract",
    args: [hca],
  })) as Address;
  assertAddress(
    "HCA implementation",
    implementation,
    deployments.standaloneHcaImplementation,
  );
  const [actualOwner] = (await publicClient.readContract({
    address: hca,
    abi: StandaloneSingleOwnerHCA.abi,
    functionName: "ownerAndSessionNonce",
  })) as [Address, bigint];
  assertAddress("HCA owner", actualOwner, expectedOwner);
}

async function preparePermissionlessCrossChainRegistration({
  hca,
  initiallyDeployed,
  commitment,
  deployments,
}: {
  hca: Address;
  initiallyDeployed: boolean;
  commitment: Hex;
  deployments: {
    standaloneHcaFactory: Address;
    standaloneHcaImplementation: Address;
    ethRegistrar: Address;
  };
}) {
  let deploymentTransactionHash: Hex | undefined;
  let deploymentGasUsed = 0n;
  if (!initiallyDeployed) {
    await publicClient.simulateContract({
      account: relayer,
      address: deployments.standaloneHcaFactory,
      abi: StandaloneHCAFactory.abi,
      functionName: "deploy",
      args: [
        owner.address,
        deployments.standaloneHcaImplementation,
        HCA_USER_SALT,
      ],
    });
    deploymentTransactionHash = await walletClient.writeContract({
      account: relayer,
      chain: sepolia,
      address: deployments.standaloneHcaFactory,
      abi: StandaloneHCAFactory.abi,
      functionName: "deploy",
      args: [
        owner.address,
        deployments.standaloneHcaImplementation,
        HCA_USER_SALT,
      ],
      maxFeePerGas: OPERATOR_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: OPERATOR_MAX_PRIORITY_FEE_PER_GAS,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: deploymentTransactionHash,
    });
    if (receipt.status !== "success") {
      throw new Error(
        `permissionless HCA deployment reverted: ${deploymentTransactionHash}`,
      );
    }
    deploymentGasUsed = receipt.gasUsed;
    await assertCode("permissionlessly deployed HCA", hca);
  }

  const commit = await executePermissionlessCommit({
    commitment,
    ethRegistrar: deployments.ethRegistrar,
    phase: "permissionless cross-chain commit",
  });

  return {
    phase: "permissionless deploy and commit",
    deploymentTransactionHash,
    commitTransactionHash: commit.transactionHash,
    deploymentGasUsed,
    commitGasUsed: commit.gasUsed,
    gasUsed: deploymentGasUsed + commit.gasUsed,
  };
}

async function executePermissionlessCommit({
  commitment,
  ethRegistrar,
  phase,
}: {
  commitment: Hex;
  ethRegistrar: Address;
  phase: string;
}) {
  await publicClient.simulateContract({
    account: relayer,
    address: ethRegistrar,
    abi: ETHRegistrar.abi,
    functionName: "commit",
    args: [commitment],
  });
  const transactionHash = await walletClient.writeContract({
    account: relayer,
    chain: sepolia,
    address: ethRegistrar,
    abi: ETHRegistrar.abi,
    functionName: "commit",
    args: [commitment],
    maxFeePerGas: OPERATOR_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: OPERATOR_MAX_PRIORITY_FEE_PER_GAS,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`permissionless commitment reverted: ${transactionHash}`);
  }

  return {
    phase,
    transactionHash,
    setupOps: 0,
    mode: "permissionless",
    gasUsed: receipt.gasUsed,
    gasRefunds: [],
    feePayment: undefined,
  };
}

async function makeCommitment(
  label: string,
  resolver: Address,
  deployments: { ethRegistrar: Address },
  expectedOwner: Address,
  secret: Hex,
) {
  return (await publicClient.readContract({
    address: deployments.ethRegistrar,
    abi: ETHRegistrar.abi,
    functionName: "makeCommitment",
    args: [
      label,
      expectedOwner,
      secret,
      zeroAddress,
      resolver,
      REGISTRATION_DURATION,
      zeroHash,
    ],
  })) as Hex;
}

async function registrationPrice(
  label: string,
  deployments: { ethRegistrar: Address; paymentToken: Address },
) {
  const [base, premium] = (await publicClient.readContract({
    address: deployments.ethRegistrar,
    abi: ETHRegistrar.abi,
    functionName: "getRegisterPrice",
    args: [label, REGISTRATION_DURATION, deployments.paymentToken],
  })) as [bigint, bigint];
  return base + premium;
}

async function prepareSameChainWalletFunding({
  hca,
  required,
  paymentToken,
}: {
  hca: Address;
  required: bigint;
  paymentToken: Address;
}): Promise<SameChainWalletFunding> {
  const [walletBalanceBeforeProvisioning, hcaBalanceBefore] = await Promise.all(
    [
      publicClient.readContract({
        address: paymentToken,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [owner.address],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: paymentToken,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [hca],
      }) as Promise<bigint>,
    ],
  );
  const amountPulled =
    required > hcaBalanceBefore ? required - hcaBalanceBefore : 0n;
  const provisionedAmount =
    amountPulled > walletBalanceBeforeProvisioning
      ? amountPulled - walletBalanceBeforeProvisioning
      : 0n;
  let provisioningTransactionHash: Hex | undefined;
  let provisioningGasUsed = 0n;
  if (provisionedAmount > 0n) {
    if (paymentToken.toLowerCase() === TARGET_PAYMENT_TOKEN.toLowerCase()) {
      throw new Error(
        `wallet has ${walletBalanceBeforeProvisioning} Sepolia USDC units; ${amountPulled} required. Fund HCA_OWNER_KEY before the live proof`,
      );
    }
    const simulation = await publicClient.simulateContract({
      account: relayer,
      address: paymentToken,
      abi: MockERC20.abi,
      functionName: "mint",
      args: [owner.address, provisionedAmount],
    });
    provisioningTransactionHash = await walletClient.writeContract(
      simulation.request,
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: provisioningTransactionHash,
    });
    if (receipt.status !== "success") {
      throw new Error(
        `test wallet token provisioning reverted: ${provisioningTransactionHash}`,
      );
    }
    provisioningGasUsed = receipt.gasUsed;
  }

  const walletBalanceBeforePull = (await publicClient.readContract({
    address: paymentToken,
    abi: MockERC20.abi,
    functionName: "balanceOf",
    args: [owner.address],
  })) as bigint;
  if (walletBalanceBeforePull < amountPulled) {
    throw new Error(
      `wallet has ${walletBalanceBeforePull} payment-token units; ${amountPulled} required`,
    );
  }
  if (amountPulled === 0n) {
    return {
      calls: [],
      paymentToken,
      hca,
      required,
      amountPulled,
      walletBalanceBeforeProvisioning,
      walletBalanceBeforePull,
      hcaBalanceBefore,
      provisionedAmount,
      provisioningTransactionHash,
      provisioningGasUsed,
      permitSignatureCount: 0,
    };
  }

  const [domain, nonce, latestBlock] = await Promise.all([
    eip2612Domain(publicClient, paymentToken, sepolia.id),
    publicClient.readContract({
      address: paymentToken,
      abi: MockERC20.abi,
      functionName: "nonces",
      args: [owner.address],
    }) as Promise<bigint>,
    publicClient.getBlock(),
  ]);
  const deadline = latestBlock.timestamp + SESSION_DURATION;
  const permitSignature = await owner.signTypedData({
    domain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner: owner.address,
      spender: hca,
      value: amountPulled,
      nonce,
      deadline,
    },
  });
  const { r, s, v, yParity } = parseSignature(permitSignature);
  const permitV = Number(v ?? BigInt(27 + (yParity ?? 0)));
  const permitArgs = [
    owner.address,
    hca,
    amountPulled,
    deadline,
    permitV,
    r,
    s,
  ] as const;
  await publicClient.simulateContract({
    account: relayer,
    address: paymentToken,
    abi: MockERC20.abi,
    functionName: "permit",
    args: permitArgs,
  });

  return {
    calls: [
      {
        to: paymentToken,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "permit",
          args: permitArgs,
        }),
      },
      {
        to: paymentToken,
        value: 0n,
        data: encodeFunctionData({
          abi: MockERC20.abi,
          functionName: "transferFrom",
          args: [owner.address, hca, amountPulled],
        }),
      },
    ],
    paymentToken,
    hca,
    required,
    amountPulled,
    walletBalanceBeforeProvisioning,
    walletBalanceBeforePull,
    hcaBalanceBefore,
    provisionedAmount,
    provisioningTransactionHash,
    provisioningGasUsed,
    permitSignatureCount: 1,
  };
}

async function verifySameChainWalletFunding(
  plan: SameChainWalletFunding,
  executionCharge = 0n,
) {
  const [walletBalanceAfter, hcaBalanceAfter, allowanceAfter] =
    await Promise.all([
      publicClient.readContract({
        address: plan.paymentToken,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [owner.address],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: plan.paymentToken,
        abi: MockERC20.abi,
        functionName: "balanceOf",
        args: [plan.hca],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: plan.paymentToken,
        abi: MockERC20.abi,
        functionName: "allowance",
        args: [owner.address, plan.hca],
      }) as Promise<bigint>,
    ]);
  if (walletBalanceAfter !== plan.walletBalanceBeforePull - plan.amountPulled) {
    throw new Error(
      "first HCA intent did not pull payment tokens from the wallet",
    );
  }
  if (
    hcaBalanceAfter !==
    plan.hcaBalanceBefore + plan.amountPulled - executionCharge
  ) {
    throw new Error("first HCA intent did not fund the HCA from the wallet");
  }
  if (hcaBalanceAfter + executionCharge < plan.required) {
    throw new Error(
      `HCA has ${hcaBalanceAfter} payment-token units; ${plan.required} required`,
    );
  }
  if (plan.amountPulled > 0n && allowanceAfter !== 0n) {
    throw new Error(
      `HCA payment-token allowance was not consumed: ${allowanceAfter}`,
    );
  }
  return {
    source: "wallet EIP-2612 permit" as const,
    amountPulled: plan.amountPulled,
    walletBalanceBeforePull: plan.walletBalanceBeforePull,
    walletBalanceAfter,
    hcaBalanceBefore: plan.hcaBalanceBefore,
    hcaBalanceAfter,
    executionCharge,
    allowanceAfter,
    provisionedAmount: plan.provisionedAmount,
    provisioningTransactionHash: plan.provisioningTransactionHash,
    provisioningGasUsed: plan.provisioningGasUsed,
    permitSignatureCount: plan.permitSignatureCount,
    gasUsed: plan.provisioningGasUsed,
  };
}

async function ensurePaymentTokenFunding(
  hca: Address,
  required: bigint,
  paymentToken: Address,
) {
  const balanceBeforeProvisioning = (await publicClient.readContract({
    address: paymentToken,
    abi: MockERC20.abi,
    functionName: "balanceOf",
    args: [hca],
  })) as bigint;
  const provisionedAmount =
    balanceBeforeProvisioning < required
      ? required - balanceBeforeProvisioning
      : 0n;
  if (provisionedAmount > 0n && !HCA_ALLOW_TARGET_TEST_TOP_UP) {
    throw new Error(
      `cross-chain fill left ${balanceBeforeProvisioning} token units; ${required} required for the session follow-up`,
    );
  }
  let provisioningTransactionHash: Hex | undefined;
  let provisioningGasUsed = 0n;
  if (provisionedAmount > 0n) {
    const simulation = await publicClient.simulateContract({
      account: relayer,
      address: paymentToken,
      abi: MockERC20.abi,
      functionName: "transfer",
      args: [hca, provisionedAmount],
    });
    provisioningTransactionHash = await walletClient.writeContract(
      simulation.request,
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: provisioningTransactionHash,
    });
    if (receipt.status !== "success") {
      throw new Error(
        `existing-user test funding reverted: ${provisioningTransactionHash}`,
      );
    }
    provisioningGasUsed = receipt.gasUsed;
  }
  const balance = balanceBeforeProvisioning + provisionedAmount;
  return {
    source: "Base Sepolia Permit2 + Across" as const,
    amount: balance,
    crossChainBalance: balanceBeforeProvisioning,
    testProvisionedAmount: provisionedAmount,
    provisioningTransactionHash,
    gasUsed: provisioningGasUsed,
  };
}

async function waitForCommitment(commitment: Hex, ethRegistrar: Address) {
  const [committedAt, minAge] = await Promise.all([
    publicClient.readContract({
      address: ethRegistrar,
      abi: ETHRegistrar.abi,
      functionName: "commitmentAt",
      args: [commitment],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: ethRegistrar,
      abi: ETHRegistrar.abi,
      functionName: "MIN_COMMITMENT_AGE",
    }) as Promise<bigint>,
  ]);
  const validAt = committedAt + minAge;
  let latest = await publicClient.getBlock();
  while (latest.timestamp <= validAt) {
    const remaining = validAt - latest.timestamp + 1n;
    await Bun.sleep(Number(remaining > 2n ? remaining : 2n) * 1000);
    latest = await publicClient.getBlock();
  }
}

async function registrationCalls({
  label,
  price,
  hca,
  resolver,
  resolverSalt,
  secret,
  deployments,
}: {
  label: string;
  price: bigint;
  hca: Address;
  resolver: Address;
  resolverSalt: bigint;
  secret: Hex;
  deployments: {
    verifiableFactory: Address;
    permissionedResolverImpl: Address;
    paymentToken: Address;
    ethRegistrar: Address;
    defaultReverseRegistrarAdapter: Address;
  };
}) {
  const name = `${label}.eth`;
  const calls: Call[] = [];
  const resolverCode = await publicClient.getCode({ address: resolver });
  const deploysResolver = !resolverCode || resolverCode === "0x";
  if (deploysResolver) {
    const encodedName = dnsEncodeName(name);
    const resolverCalls = [
      encodeFunctionData({
        abi: PermissionedResolver.abi,
        functionName: "setAddress",
        args: [encodedName, COIN_TYPE_ETH, owner.address],
      }),
      encodeFunctionData({
        abi: PermissionedResolver.abi,
        functionName: "setText",
        args: [encodedName, "avatar", `https://euc.li/${name}`],
      }),
    ];
    calls.push({
      to: deployments.verifiableFactory,
      value: 0n,
      data: encodeFunctionData({
        abi: VerifiableFactory.abi,
        functionName: "deployProxy",
        args: [
          deployments.permissionedResolverImpl,
          resolverSalt,
          encodeFunctionData({
            abi: PermissionedResolver.abi,
            functionName: "initialize",
            args: [
              [
                { account: hca, roleBitmap: ROLES.ALL },
                { account: owner.address, roleBitmap: ROLES.ALL },
              ],
              resolverCalls,
            ],
          }),
        ],
      }),
    });
  }
  calls.push(
    {
      to: deployments.paymentToken,
      value: 0n,
      data: encodeFunctionData({
        abi: MockERC20.abi,
        functionName: "approve",
        args: [deployments.ethRegistrar, price],
      }),
    },
    {
      to: deployments.ethRegistrar,
      value: 0n,
      data: encodeFunctionData({
        abi: ETHRegistrar.abi,
        functionName: "register",
        args: [
          label,
          owner.address,
          secret,
          zeroAddress,
          resolver,
          REGISTRATION_DURATION,
          deployments.paymentToken,
          zeroHash,
        ],
      }),
    },
    ...(!deploysResolver
      ? [
          {
            to: resolver,
            value: 0n,
            data: encodeFunctionData({
              abi: PermissionedResolver.abi,
              functionName: "setAddress",
              args: [dnsEncodeName(name), COIN_TYPE_ETH, owner.address],
            }),
          },
          {
            to: resolver,
            value: 0n,
            data: encodeFunctionData({
              abi: PermissionedResolver.abi,
              functionName: "setText",
              args: [dnsEncodeName(name), "avatar", `https://euc.li/${name}`],
            }),
          },
        ]
      : []),
    {
      to: deployments.defaultReverseRegistrarAdapter,
      value: 0n,
      data: encodeFunctionData({
        abi: DefaultReverseRegistrarAdapter.abi,
        functionName: "setNameWithHCA",
        args: [owner.address, name],
      }),
    },
  );
  return calls;
}

async function verifyRegistration(
  label: string,
  hca: Address,
  resolver: Address,
  deployments: {
    ethRegistry: Address;
    verifiableFactory: Address;
    permissionedResolverImpl: Address;
    defaultReverseRegistrar: Address;
    v1Registry: Address;
    universalResolver: Address;
  },
  expectedOwner: Address,
) {
  const name = `${label}.eth`;
  const node = namehash(name);
  const reverseNode = namehash(getReverseName(expectedOwner));
  const state = (await publicClient.readContract({
    address: deployments.ethRegistry,
    abi: PermissionedRegistry.abi,
    functionName: "getState",
    args: [BigInt(keccak256(stringToHex(label)))],
  })) as { status: number | bigint; latestOwner: Address };
  if (Number(state.status) !== STATUS_REGISTERED) {
    throw new Error(`${name} status=${state.status}`);
  }
  assertAddress("registered owner", state.latestOwner, expectedOwner);

  const registryResolver = (await publicClient.readContract({
    address: deployments.ethRegistry,
    abi: PermissionedRegistry.abi,
    functionName: "getResolver",
    args: [label],
  })) as Address;
  assertAddress("registry resolver", registryResolver, resolver);
  const resolverImplementation = (await publicClient.readContract({
    address: deployments.verifiableFactory,
    abi: VerifiableFactory.abi,
    functionName: "verifyContract",
    args: [resolver],
  })) as Address;
  assertAddress(
    "resolver implementation",
    resolverImplementation,
    deployments.permissionedResolverImpl,
  );
  const [ownerHasRoles, hcaHasRoles] = await Promise.all(
    [expectedOwner, hca].map((account) =>
      publicClient.readContract({
        address: resolver,
        abi: PermissionedResolver.abi,
        functionName: "hasRootRoles",
        args: [ROLES.ALL, account],
      }),
    ),
  );
  if (!ownerHasRoles || !hcaHasRoles) {
    throw new Error("resolver roles were not retained for both wallet and HCA");
  }

  const forwardCall = encodeFunctionData({
    abi: ADDR_ABI,
    functionName: "addr",
    args: [node],
  });
  const resolvedAddressData = (await publicClient.readContract({
    address: resolver,
    abi: PermissionedResolver.abi,
    functionName: "resolve",
    args: [dnsEncodeName(name), forwardCall],
  })) as Hex;
  const resolvedAddress = decodeFunctionResult({
    abi: ADDR_ABI,
    functionName: "addr",
    data: resolvedAddressData,
  }) as Address;
  assertAddress("resolver address", resolvedAddress, expectedOwner);
  const avatarCall = encodeFunctionData({
    abi: PROFILE_ABI,
    functionName: "text",
    args: [node, "avatar"],
  });
  const avatarData = (await publicClient.readContract({
    address: resolver,
    abi: PermissionedResolver.abi,
    functionName: "resolve",
    args: [dnsEncodeName(name), avatarCall],
  })) as Hex;
  const avatar = decodeFunctionResult({
    abi: PROFILE_ABI,
    functionName: "text",
    data: avatarData,
  }) as string;
  if (avatar !== `https://euc.li/${name}`) {
    throw new Error(`resolver avatar=${avatar}`);
  }
  const defaultPrimary = (await publicClient.readContract({
    address: deployments.defaultReverseRegistrar,
    abi: DefaultReverseRegistrar.abi,
    functionName: "nameForAddr",
    args: [expectedOwner],
  })) as string;
  if (defaultPrimary !== name)
    throw new Error(`default primary=${defaultPrimary}`);
  const exactReverseResolver = (await publicClient.readContract({
    address: deployments.v1Registry,
    abi: ENSRegistry.abi,
    functionName: "resolver",
    args: [reverseNode],
  })) as Address;
  if (
    HCA_EXPECT_DEFAULT_REVERSE_FALLBACK &&
    exactReverseResolver !== zeroAddress
  ) {
    throw new Error(
      `expected default.reverse fallback, got ${exactReverseResolver}`,
    );
  }

  const [reversePrimary] = (await publicClient.readContract({
    address: deployments.universalResolver,
    abi: UniversalResolverV2.abi,
    functionName: "reverse",
    args: [expectedOwner, COIN_TYPE_ETH],
  })) as [string, Address, Address];
  if (reversePrimary !== name) throw new Error(`UR reverse=${reversePrimary}`);
  const [answer] = (await publicClient.readContract({
    address: deployments.universalResolver,
    abi: UniversalResolverV2.abi,
    functionName: "resolve",
    args: [dnsEncodeName(name), forwardCall],
  })) as [Hex, Address];
  const universalAddress = decodeFunctionResult({
    abi: ADDR_ABI,
    functionName: "addr",
    data: answer,
  }) as Address;
  assertAddress("UR forward address", universalAddress, expectedOwner);
  return {
    name,
    registeredOwner: state.latestOwner,
    resolver,
    ownerHasResolverRoles: ownerHasRoles,
    hcaHasResolverRoles: hcaHasRoles,
    defaultPrimary,
    universalAddress,
  };
}

await main();
