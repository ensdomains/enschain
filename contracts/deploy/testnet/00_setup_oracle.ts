import { execute } from "@rocketh";
import type { Abi_StandardRentPriceOracle } from "generated/abis/StandardRentPriceOracle.js";
import {
  SEPOLIA_USDC,
  STANDARD_RENT_PRICE_ORACLE_PRICE_DECIMALS,
} from "../../script/deploy-constants.js";

const SEPOLIA_CHAIN_ID = 11155111;
const PRICE_DECIMALS = STANDARD_RENT_PRICE_ORACLE_PRICE_DECIMALS;
const SEPOLIA_USDC_DECIMALS = 6n;
const SEPOLIA_USDC_NUMER =
  10n **
  (SEPOLIA_USDC_DECIMALS > PRICE_DECIMALS
    ? SEPOLIA_USDC_DECIMALS - PRICE_DECIMALS
    : 0n);
const SEPOLIA_USDC_DENOM =
  10n **
  (PRICE_DECIMALS > SEPOLIA_USDC_DECIMALS
    ? PRICE_DECIMALS - SEPOLIA_USDC_DECIMALS
    : 0n);

export default execute(
  async ({
    execute: write,
    get,
    read,
    namedAccounts: { deployer, owner },
    network,
  }) => {
    if (network.chain.id !== SEPOLIA_CHAIN_ID) return;

    const oracle = get<Abi_StandardRentPriceOracle>("StandardRentPriceOracle");
    const oracleOwner = owner || deployer;

    const oracleHasSepoliaUsdc = await read(oracle, {
      functionName: "isPaymentToken",
      args: [SEPOLIA_USDC],
    });

    if (!oracleHasSepoliaUsdc) {
      await write(oracle, {
        account: oracleOwner,
        functionName: "updatePaymentToken",
        args: [SEPOLIA_USDC, SEPOLIA_USDC_NUMER, SEPOLIA_USDC_DENOM],
      });
    }
  },
  {
    tags: ["oracle:setup", "testnet", "v2"],
    dependencies: ["StandardRentPriceOracle"],
  },
);
