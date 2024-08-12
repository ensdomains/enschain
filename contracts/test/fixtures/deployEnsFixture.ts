import hre from "hardhat";
import { Address, bytesToHex, keccak256, stringToHex, zeroAddress } from "viem";
import { packetToBytes } from "../utils/utils";

export async function deployEnsFixture() {
  const walletClients = await hre.viem.getWalletClients();
  const datastore = await hre.viem.deployContract("RegistryDatastore", []);
  const rootRegistry = await hre.viem.deployContract("RootRegistry", [datastore.address]);
  const ethRegistry = await hre.viem.deployContract("ETHRegistry", [datastore.address]);
  const universalResolver = await hre.viem.deployContract("UniversalResolver", [
    rootRegistry.address,
  ]);
  await rootRegistry.write.grantRole([
    keccak256(stringToHex("SUBDOMAIN_ISSUER_ROLE")),
    walletClients[0].account.address,
  ]);
  await ethRegistry.write.grantRole([
    keccak256(stringToHex("REGISTRAR_ROLE")),
    walletClients[0].account.address,
  ]);
  await rootRegistry.write.mint([
    "eth",
    walletClients[0].account.address,
    ethRegistry.address,
    true,
  ]);

  return { datastore, rootRegistry, ethRegistry, universalResolver };
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
  locked?: boolean;
}) => {
  const owner =
    owner_ ?? (await hre.viem.getWalletClients())[0].account.address;
  const flags = (subregistryLocked ? 1n : 0n) | (resolverLocked ? 2n : 0n);
  return await ethRegistry.write.register([label, owner, subregistry, flags, expiry]);
};
