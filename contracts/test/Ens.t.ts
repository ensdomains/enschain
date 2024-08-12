import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { getAddress, keccak256, parseEventLogs, fromHex } from "viem";
import { deployEnsFixture, registerName } from "./fixtures/deployEnsFixture";
import { dnsEncodeName } from "./utils/utils";

describe("ETHRegistry", function () {
  it("registers names", async () => {
    const client = await hre.viem.getPublicClient();
    const walletClients = await hre.viem.getWalletClients();
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    const tx = await registerName({ ethRegistry, label: "test2" });
    const receipt = await client.waitForTransactionReceipt({hash: tx});
    const logs = parseEventLogs({abi: ethRegistry.abi, logs: receipt.logs })
    const id = logs[0].args.id;
    const expectedId = fromHex(keccak256("test2"), "bigint") & 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n;
    expect(id).to.equal(expectedId);
    expect((await ethRegistry.read.ownerOf([id])).toLowerCase()).to.equal(walletClients[0].account.address);
  });

  it("registers locked names", async () => {
    const client = await hre.viem.getPublicClient();
    const walletClients = await hre.viem.getWalletClients();
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    const tx = await registerName({ ethRegistry, label: "test", subregistryLocked: true, resolverLocked: true });
    const receipt = await client.waitForTransactionReceipt({hash: tx});
    const logs = parseEventLogs({abi: ethRegistry.abi, logs: receipt.logs })
    const id = logs[0].args.id;
    const expectedId = (fromHex(keccak256("test"), "bigint") & 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n) | 3n;
    expect(id).to.equal(expectedId);
    expect((await ethRegistry.read.ownerOf([id])).toLowerCase()).to.equal(walletClients[0].account.address);
  });

  it("supports locking names", async () => {
    const client = await hre.viem.getPublicClient();
    const walletClients = await hre.viem.getWalletClients();
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    const id = fromHex(keccak256("test2"), "bigint") & 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n;
    await registerName({ ethRegistry, label: "test2" });
    expect((await ethRegistry.read.ownerOf([id])).toLowerCase()).to.equal(walletClients[0].account.address);
    expect((await ethRegistry.read.ownerOf([id | 3n])).toLowerCase()).to.equal("0x0000000000000000000000000000000000000000");
    await ethRegistry.write.lock([id, 0x3]);
    expect((await ethRegistry.read.ownerOf([id | 3n])).toLowerCase()).to.equal(walletClients[0].account.address);
    expect((await ethRegistry.read.ownerOf([id])).toLowerCase()).to.equal("0x0000000000000000000000000000000000000000");
  });

  it("cannot unlock names", async () => {
    const client = await hre.viem.getPublicClient();
    const walletClients = await hre.viem.getWalletClients();
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    const id = fromHex(keccak256("test2"), "bigint") & 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n | 3n;
    await registerName({ ethRegistry, label: "test2", subregistryLocked: true, resolverLocked: true });
    expect((await ethRegistry.read.ownerOf([id])).toLowerCase()).to.equal(walletClients[0].account.address);
    expect((await ethRegistry.read.ownerOf([id ^ 3n])).toLowerCase()).to.equal("0x0000000000000000000000000000000000000000");
    await ethRegistry.write.lock([id, 0x0]);
    expect((await ethRegistry.read.ownerOf([id])).toLowerCase()).to.equal(walletClients[0].account.address);
    expect((await ethRegistry.read.ownerOf([id ^ 3n])).toLowerCase()).to.equal("0x0000000000000000000000000000000000000000");
  });
});

describe("Ens", function () {
  it("returns eth registry for eth", async () => {
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    const [fetchedEthRegistry, isExact] =
      await universalResolver.read.getRegistry([dnsEncodeName("eth")]);
    expect(isExact).to.be.true;
    expect(fetchedEthRegistry).to.equal(getAddress(ethRegistry.address));
  });

  it("returns eth registry for test.eth without user registry", async () => {
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    await registerName({ ethRegistry, label: "test" });
    const [registry, isExact] = await universalResolver.read.getRegistry([
      dnsEncodeName("test.eth"),
    ]);
    expect(isExact).to.be.false;
    expect(registry).to.equal(getAddress(ethRegistry.address));
  });
});
