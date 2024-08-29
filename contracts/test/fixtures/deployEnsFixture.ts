import hre from "hardhat";
import { Address, bytesToHex, keccak256, stringToHex } from "viem";
import { packetToBytes } from "../utils/utils.js";

export async function deployEnsFixture() {
  const publicClient = await hre.viem.getPublicClient();
  const accounts = await hre.viem
    .getWalletClients()
    .then((clients) => clients.map((c) => c.account));

  const datastore = await hre.viem.deployContract("RegistryDatastore", []);
  const rootRegistry = await hre.viem.deployContract("RootRegistry", [
    datastore.address,
  ]);
  const ethRegistry = await hre.viem.deployContract("ETHRegistry", [
    datastore.address,
  ]);
  const universalResolver = await hre.viem.deployContract("UniversalResolver", [
    rootRegistry.address,
  ]);
  await rootRegistry.write.grantRole([
    keccak256(stringToHex("TLD_ISSUER_ROLE")),
    accounts[0].address,
  ]);
  await ethRegistry.write.grantRole([
    keccak256(stringToHex("REGISTRAR_ROLE")),
    accounts[0].address,
  ]);
  await rootRegistry.write.mint([
    "eth",
    accounts[0].address,
    ethRegistry.address,
    1n,
  ]);

  return {
    publicClient,
    accounts,
    datastore,
    rootRegistry,
    ethRegistry,
    universalResolver,
  };
}

export type EnsFixture = Awaited<ReturnType<typeof deployEnsFixture>>;

export const deployUserRegistry = async ({
  name,
  parentRegistryAddress,
  datastoreAddress,
  ownerIndex = 0,
}: {
  name: string;
  parentRegistryAddress: Address;
  datastoreAddress: Address;
  ownerIndex?: number;
}) => {
  const wallet = (await hre.viem.getWalletClients())[ownerIndex];
  return await hre.viem.deployContract(
    "UserRegistry",
    [parentRegistryAddress, bytesToHex(packetToBytes(name)), datastoreAddress],
    {
      client: { wallet },
    }
  );
};

export const registerName = async ({
  ethRegistry,
  label,
  expiry = BigInt(Math.floor(Date.now() / 1000) + 1000000),
  owner: owner_,
  subregistry = "0x0000000000000000000000000000000000000000",
  subregistryLocked = false,
  resolverLocked = false,
}: Pick<EnsFixture, "ethRegistry"> & {
  label: string;
  expiry?: bigint;
  owner?: Address;
  subregistry?: Address;
  subregistryLocked?: boolean;
  resolverLocked?: boolean;
}) => {
  const owner =
    owner_ ?? (await hre.viem.getWalletClients())[0].account.address;
  const flags = (subregistryLocked ? 1n : 0n) | (resolverLocked ? 2n : 0n);
  return ethRegistry.write.register([label, owner, subregistry, flags, expiry]);
};
