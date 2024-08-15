import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers.js";
import { expect } from "chai";
import { deployEnsFixture, registerName } from "./fixtures/deployEnsFixture.js";
import { dnsEncodeName } from "./utils/utils.js";

describe("Ens", function () {
  it("returns eth registry for eth", async () => {
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    const [fetchedEthRegistry, isExact] =
      await universalResolver.read.getRegistry([dnsEncodeName("eth")]);
    expect(isExact).toBe(true);
    expect(fetchedEthRegistry).toEqualAddress(ethRegistry.address);
  });

  it("returns eth registry for test.eth without user registry", async () => {
    const { universalResolver, ethRegistry } = await loadFixture(
      deployEnsFixture
    );
    await registerName({ ethRegistry, label: "test" });
    const [registry, isExact] = await universalResolver.read.getRegistry([
      dnsEncodeName("test.eth"),
    ]);
    expect(isExact).toBe(false);
    expect(registry).toEqualAddress(ethRegistry.address);
  });
});
