import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { Hex, bytesToHex, getAddress, namehash } from "viem";
import {
  EnsFixture,
  deployEnsFixture,
  oneifyName,
} from "./fixtures/deployEnsFixture";
import { createHttpServer } from "./utils/createHttpServer";
import { packetToBytes } from "./utils/utils";

describe("BackwardsCompatibleEns", function () {
  const deployBackwardsCompatibleEns = async ({
    ensRootRegistry,
    url,
  }: Pick<EnsFixture, "ensRootRegistry"> & { url: string }) => {
    const backwardsCompatibleEns = await hre.viem.deployContract(
      "BackwardsCompatibleEns",
      [ensRootRegistry.address, [`${url}/{sender}/{data}`]]
    );
    return { backwardsCompatibleEns };
  };

  it("gets resolver via legacy method", async () => {
    const server = await createHttpServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      const data = req.url?.split("/")[2]! as Hex;

      // database lookup

      res.end(
        JSON.stringify({
          data: bytesToHex(packetToBytes("test.eth")),
        })
      );
    });

    const { ensRootRegistry, ensEthRegistry } = await loadFixture(
      deployEnsFixture
    );
    const { backwardsCompatibleEns } = await deployBackwardsCompatibleEns({
      ensRootRegistry,
      url: server.url,
    });
    const walletClients = await hre.viem.getWalletClients();
    await oneifyName({
      ensEthRegistry,
      name: "test.eth",
      resolver: walletClients[1].account.address,
    });
    const resolver = await backwardsCompatibleEns.read.resolver([
      namehash("test.eth"),
    ]);
    expect(resolver).to.equal(getAddress(walletClients[1].account.address));
  });
});
