import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { getAddress } from "viem";
import { deployEnsFixture, registerName } from "./fixtures/deployEnsFixture";
import { dnsEncodeName } from "./utils/utils";

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
