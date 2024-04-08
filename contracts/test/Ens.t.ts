import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { bytesToHex, getAddress } from "viem";
import { deployEnsFixture, oneifyName } from "./fixtures/deployEnsFixture";
import { labelhashUint256, packetToBytes } from "./utils/utils";

describe("Ens", function () {
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
