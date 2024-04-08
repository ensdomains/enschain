import hre from "hardhat";
import { Address } from "viem";
import { labelhashUint256, namehashUint256 } from "../utils/utils";

export async function deployEnsFixture() {
  const walletClients = await hre.viem.getWalletClients();
  const ensRootRegistry = await hre.viem.deployContract("EnsRootRegistry", [
    walletClients[0].account.address,
  ]);
  const ensEthRegistry = await hre.viem.deployContract("EnsEthRegistry", [
    walletClients[0].account.address,
  ]);
  await ensRootRegistry.write.setTldRegistry([
    labelhashUint256("eth"),
    ensEthRegistry.address,
  ]);

  return { ensRootRegistry, ensEthRegistry };
}

export type EnsFixture = Awaited<ReturnType<typeof deployEnsFixture>>;

export const oneifyName = async ({
  ensEthRegistry,
  name,
  expiry = BigInt(Math.floor(Date.now() / 1000) + 1000000),
  owner: owner_,
  resolver = "0x0000000000000000000000000000000000000000",
  registry = "0x0000000000000000000000000000000000000000",
}: Pick<EnsFixture, "ensEthRegistry"> & {
  name: string;
  expiry?: bigint;
  owner?: Address;
  resolver?: Address;
  registry?: Address;
}) => {
  const owner =
    owner_ ?? (await hre.viem.getWalletClients())[0].account.address;
  await ensEthRegistry.write.oneifyName([
    namehashUint256(name),
    expiry,
    owner,
    resolver,
    registry,
  ]);
};
