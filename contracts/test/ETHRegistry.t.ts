import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers.js";
import { expect } from "chai";
import { fromHex, getAddress, labelhash, zeroAddress } from "viem";
import { deployEnsFixture, registerName } from "./fixtures/deployEnsFixture.js";

describe("ETHRegistry", function () {
  it("registers names", async () => {
    const { accounts, ethRegistry } = await loadFixture(deployEnsFixture);

    const tx = await registerName({ ethRegistry, label: "test2" });
    const expectedId =
      fromHex(labelhash("test2"), "bigint") &
      0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n;

    await expect(ethRegistry)
      .transaction(tx)
      .toEmitEvent("TransferSingle")
      .withArgs(
        getAddress(accounts[0].address),
        zeroAddress,
        accounts[0].address,
        expectedId,
        1n
      );
    await expect(
      ethRegistry.read.ownerOf([expectedId])
    ).resolves.toEqualAddress(accounts[0].address);
  });

  it("registers locked names", async () => {
    const { accounts, ethRegistry } = await loadFixture(deployEnsFixture);

    const tx = await registerName({
      ethRegistry,
      label: "test2",
      subregistryLocked: true,
      resolverLocked: true,
    });
    const expectedId =
      (fromHex(labelhash("test2"), "bigint") &
        0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n) |
      3n;

    await expect(ethRegistry)
      .transaction(tx)
      .toEmitEvent("TransferSingle")
      .withArgs(
        getAddress(accounts[0].address),
        zeroAddress,
        accounts[0].address,
        expectedId,
        1n
      );
    await expect(
      ethRegistry.read.ownerOf([expectedId])
    ).resolves.toEqualAddress(accounts[0].address);
  });

  it("supports locking names", async () => {
    const { accounts, ethRegistry } = await loadFixture(deployEnsFixture);

    await registerName({ ethRegistry, label: "test2" });
    const expectedId =
      fromHex(labelhash("test2"), "bigint") &
      0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n;

    await expect(
      ethRegistry.read.ownerOf([expectedId])
    ).resolves.toEqualAddress(accounts[0].address);
    await expect(
      ethRegistry.read.ownerOf([expectedId | 3n])
    ).resolves.toEqualAddress(zeroAddress);
    await ethRegistry.write.lock([expectedId, 0x3]);
    await expect(
      ethRegistry.read.ownerOf([expectedId | 3n])
    ).resolves.toEqualAddress(accounts[0].address);
    await expect(
      ethRegistry.read.ownerOf([expectedId])
    ).resolves.toEqualAddress(zeroAddress);
  });

  it("cannot unlock names", async () => {
    const { accounts, ethRegistry } = await loadFixture(deployEnsFixture);

    await registerName({
      ethRegistry,
      label: "test2",
      subregistryLocked: true,
      resolverLocked: true,
    });
    const expectedId =
      (fromHex(labelhash("test2"), "bigint") &
        0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n) |
      3n;

    await expect(
      ethRegistry.read.ownerOf([expectedId])
    ).resolves.toEqualAddress(accounts[0].address);
    await expect(
      ethRegistry.read.ownerOf([expectedId ^ 3n])
    ).resolves.toEqualAddress(zeroAddress);

    await ethRegistry.write.lock([expectedId, 0x0]);

    await expect(
      ethRegistry.read.ownerOf([expectedId])
    ).resolves.toEqualAddress(accounts[0].address);
    await expect(
      ethRegistry.read.ownerOf([expectedId ^ 3n])
    ).resolves.toEqualAddress(zeroAddress);
  });
});
