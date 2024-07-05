import "@nomicfoundation/hardhat-foundry";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-viem";
import type { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  solidity:  {
    version: "0.8.25",
    settings: {
      evmVersion: "cancun"
    }
  }
};

export default config;
