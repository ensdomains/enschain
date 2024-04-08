import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { Address, bytesToHex, getAddress } from "viem";
import { labelhashUint256, namehashUint256, packetToBytes } from "./utils";

describe("Ens", function () {
  async function deployEnsFixture() {
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

  type EnsFixture = Awaited<ReturnType<typeof deployEnsFixture>>;

  const oneifyName = async ({
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

  it("returns tld registry for eth", async () => {
    const { ensRootRegistry, ensEthRegistry } = await loadFixture(
      deployEnsFixture
    );
    const tldRegistry = await ensRootRegistry.read.getTldRegistry([
      labelhashUint256("eth"),
    ]);
    expect(tldRegistry).to.equal(getAddress(ensEthRegistry.address));
  });

  it("returns correct registry for test.eth", async () => {
    const { ensRootRegistry, ensEthRegistry } = await loadFixture(
      deployEnsFixture
    );
    await oneifyName({ ensEthRegistry, name: "test.eth" });
    const registry = await ensRootRegistry.read.getRegistry([
      bytesToHex(packetToBytes("test.eth")),
    ]);
    expect(registry).to.equal(getAddress(ensEthRegistry.address));
  });

  it("returns owner when oneified", async () => {
    const { ensRootRegistry, ensEthRegistry } = await loadFixture(
      deployEnsFixture
    );
    const walletClients = await hre.viem.getWalletClients();
    await oneifyName({ ensEthRegistry, name: "test.eth" });
    const owner = await ensRootRegistry.read.ownerOf([
      bytesToHex(packetToBytes("test.eth")),
    ]);
    expect(owner).to.equal(getAddress(walletClients[0].account.address));
  });

  it("returns resolver when oneified", async () => {
    const { ensRootRegistry, ensEthRegistry } = await loadFixture(
      deployEnsFixture
    );
    const walletClients = await hre.viem.getWalletClients();
    await oneifyName({
      ensEthRegistry,
      name: "test.eth",
      resolver: walletClients[1].account.address,
    });
    const resolver = await ensRootRegistry.read.resolver([
      bytesToHex(packetToBytes("test.eth")),
    ]);
    expect(resolver).to.equal(getAddress(walletClients[1].account.address));
  });

  it("returns recordExists as true when tld exists", async () => {
    const { ensRootRegistry } = await loadFixture(deployEnsFixture);
    const recordExists = await ensRootRegistry.read.recordExists([
      labelhashUint256("eth"),
    ]);
    expect(recordExists).to.equal(true);
  });

  it("returns recordExists as false when tld does not exist", async () => {
    const { ensRootRegistry } = await loadFixture(deployEnsFixture);
    const recordExists = await ensRootRegistry.read.recordExists([
      labelhashUint256("test"),
    ]);
    expect(recordExists).to.equal(false);
  });

  it("returns owner as 0 when expired", async () => {
    const { ensRootRegistry, ensEthRegistry } = await loadFixture(
      deployEnsFixture
    );
    const walletClients = await hre.viem.getWalletClients();
    await oneifyName({ ensEthRegistry, name: "test.eth" });
    const owner = await ensRootRegistry.read.ownerOf([
      bytesToHex(packetToBytes("test.eth")),
    ]);
    expect(owner).to.equal(getAddress(walletClients[0].account.address));

    await time.increase(2000000);

    const ownerAfterExpiry = await ensRootRegistry.read.ownerOf([
      bytesToHex(packetToBytes("test.eth")),
    ]);
    expect(ownerAfterExpiry).to.equal(
      "0x0000000000000000000000000000000000000000"
    );
  });
});
