import { configVariable, type HardhatUserConfig } from "hardhat/config";

import HardhatChaiMatchersViemPlugin from "@ensdomains/hardhat-chai-matchers-viem";
import HardhatKeystore from "@nomicfoundation/hardhat-keystore";
import HardhatNetworkHelpersPlugin from "@nomicfoundation/hardhat-network-helpers";
import HardhatViem from "@nomicfoundation/hardhat-viem";
import HardhatDeploy from "hardhat-deploy";

import HardhatIgnoreWarningsPlugin from "./plugins/ignore-warnings/index.ts";
import HardhatClearRemappingsPlugin from "./plugins/clear-remappings/index.ts";
import HardhatMigrationPlugin from "./plugins/migration/index.ts";
import HardhatStorageLayoutPlugin from "./plugins/storage-layout/index.ts";

const version = "0.8.25";
const hcaVersion = "0.8.27";
const outputSelection = {
  "*": {
    "*": ["storageLayout"],
  },
};
// Keep exactly one general compiler so every non-overridden production root
// remains on the protocol compiler. New compiler versions must be scoped with
// explicit overrides and added to the compiler-policy regression.
const protocolCompiler = {
  version,
  settings: {
    optimizer: {
      enabled: true,
      runs: 1000,
    },
    evmVersion: "cancun",
    outputSelection,
  },
} as const;
const hcaCompiler = {
  version: hcaVersion,
  settings: {
    optimizer: {
      enabled: true,
      runs: 1000,
    },
    evmVersion: "cancun",
    outputSelection,
  },
} as const;
const hcaHotRuntimeCompiler = {
  version: hcaVersion,
  settings: {
    optimizer: {
      enabled: true,
      runs: 23_000,
    },
    evmVersion: "cancun",
    outputSelection,
  },
} as const;
const tenderlySepoliaRpcUrl =
  process.env.TENDERLY_SEPOLIA_RPC_URL ??
  configVariable("TENDERLY_SEPOLIA_RPC_URL");
const plugins = [
  HardhatNetworkHelpersPlugin,
  ...(process.env.HARDHAT_DISABLE_VIEM === "1"
    ? []
    : [HardhatChaiMatchersViemPlugin, HardhatViem]),
  HardhatStorageLayoutPlugin,
  HardhatIgnoreWarningsPlugin,
  HardhatDeploy,
  HardhatKeystore,
  HardhatClearRemappingsPlugin,
  HardhatMigrationPlugin,
];
const config = {
  solidity: {
    compilers: [protocolCompiler],
    overrides: {
      "src/hca/HCAValidatorBase.sol": hcaCompiler,
      "src/hca/HCAFundingSessionValidator.sol": hcaCompiler,
      "src/hca/HCAOwnerAndSessionValidator.sol": hcaHotRuntimeCompiler,
      "src/hca/StandaloneHCAFactory.sol": hcaCompiler,
      "src/hca/StandaloneSingleOwnerHCA.sol": hcaCompiler,
      "src/hca/libraries/HCAExecutionLib.sol": hcaCompiler,
      "src/hca/libraries/HCAOperationHashLib.sol": hcaCompiler,
      "src/hca/libraries/HCAPermit2Lib.sol": hcaCompiler,
      "src/hca/libraries/HCARegistrarPolicyLib.sol": hcaCompiler,
      "src/hca/libraries/HCAResolverPolicyLib.sol": hcaCompiler,
      "src/hca/libraries/HCASignatureLib.sol": hcaCompiler,
      "src/hca/libraries/HCASmartSessionLib.sol": hcaCompiler,
      "test/mocks/MockRegistrationIntentExecutor.sol": hcaCompiler,
      "test/mocks/MockStandaloneHCAStack.sol": hcaCompiler,
      "test/unit/hca/HCAFundingSessionValidator.t.sol": hcaCompiler,
      "test/unit/hca/HCAOwnerAndSessionValidator.t.sol": hcaCompiler,
      "test/unit/hca/StandaloneHCAFactory.t.sol": hcaCompiler,
      "test/unit/hca/StandaloneSingleOwnerHCA.t.sol": hcaCompiler,
      "lib/ens-contracts/contracts/wrapper/NameWrapper.sol": {
        version: "0.8.17",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1200,
          },
          evmVersion: "london",
          outputSelection,
        },
      },
      // 23k at 1
      // 25k at 1000
      "src/registry/WrapperRegistry.sol": {
        version,
        settings: {
          optimizer: {
            enabled: true,
            runs: 100,
          },
          evmVersion: "cancun",
          outputSelection,
        },
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_KEY")],
      chainId: 11155111,
    },
    "sepolia-dev": {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEV_DEPLOYER_KEY")],
      chainId: 11155111,
    },
    "tenderly-sepolia": {
      type: "http",
      url: tenderlySepoliaRpcUrl,
      accounts: [configVariable("DEPLOYER_KEY")],
    },
  },
  paths: {
    sources: {
      solidity: [
        "./src/",
        "./test/mocks/",
        "./lib/verifiable-factory/src/",
        "./lib/ens-contracts/contracts/",
        "./lib/openzeppelin-contracts/contracts/utils/introspection/",
        "./lib/openzeppelin-contracts/contracts/token/ERC721/",
        "./lib/openzeppelin-contracts/contracts/token/ERC1155/",
        "./lib/openzeppelin-contracts/contracts/proxy/ERC1967/",
        // note: this increases artifact size by 25MB+ for 1 interface
        // "./lib/unruggable-gateways/contracts/",
      ],
    },
  },
  generateTypedArtifacts: {
    destinations: [
      {
        mode: "typescript",
      },
    ],
  },
  shouldIgnoreWarnings: (path) => {
    return path.startsWith("./lib/");
  },
  plugins,
} satisfies HardhatUserConfig;

export default config;
