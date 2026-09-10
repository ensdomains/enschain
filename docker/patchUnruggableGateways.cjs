const fs = require("node:fs");

const packagePath =
  "/app/contracts/lib/ens-contracts/node_modules/@unruggable/gateways/package.json";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

if (packageJson.version !== "1.3.0") {
  throw new Error(
    `Expected @unruggable/gateways 1.3.0, found ${packageJson.version}`,
  );
}

packageJson.exports = {
  ".": packageJson.exports,
  "./GatewayFetchTarget.sol": "./contracts/GatewayFetchTarget.sol",
  "./GatewayFetcher.sol": "./contracts/GatewayFetcher.sol",
};

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
