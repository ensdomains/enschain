import { shouldSupportInterfaces } from "@ensdomains/hardhat-chai-matchers-viem/behaviour";
import hre from "hardhat";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import {
  type KnownProfile,
  bundleCalls,
  makeResolutions,
} from "../utils/resolutions.js";
import { dnsEncodeName, COIN_TYPE_ETH } from "../utils/utils.js";
import { deployV1Fixture } from "./fixtures/deployV1Fixture.js";
import { deployV2Fixture } from "./fixtures/deployV2Fixture.js";
import { expectVar } from "../utils/expectVar.js";
import { getAddress } from "viem/utils";
import { V2_SETTER_ABI } from "../utils/resolver-abis.ts";

const network = await hre.network.connect();

const V1: KnownProfile = {
  name: "v1.eth",
  addresses: [
    {
      coinType: COIN_TYPE_ETH,
      value: "0x1111111111111111111111111111111111111111",
    },
  ],
};

async function fixture() {
  const v1 = await deployV1Fixture(network, true);
  const v2 = await deployV2Fixture(network, true);
  const ensV1Resolver = await network.viem.deployContract("ENSV1Resolver", [
    v1.batchGatewayProvider.address,
    v2.contractNamer.address,
    v1.ensRegistry.address,
  ]);
  const helper = await network.viem.deployContract("CompositeHelper", [
    v2.rootRegistry.address,
    v2.contractNamer.address,
  ]);
  await v1.setupName({ name: V1.name });
  await v2.setupName({
    name: V1.name,
    resolverAddress: ensV1Resolver.address,
  });
  await v1.publicResolver.write.multicall([
    makeResolutions(V1).map((x) => x.writeV1),
  ]);
  return { v1, v2, ensV1Resolver, helper };
}

describe("CompositeHelper", () => {
  it("test", async () => {
    const F = await network.networkHelpers.loadFixture(fixture);
    await expect(
      F.helper.read.getResolvers([dnsEncodeName(V1.name)]),
    ).resolves.toStrictEqual([
      {
        resolver: getAddress(F.ensV1Resolver.address),
        offchain: false,
      },
      {
        resolver: getAddress(F.v1.publicResolver.address),
        offchain: false,
      },
    ]);
  });

  for (let n = 0; n < 5; n++) {
    it(`chain of ${n}`, async () => {
      const F = await network.networkHelpers.loadFixture(fixture);
      const name = "test.eth";
      const resolvers: Address[] = [F.v1.publicResolver.address];
      for (let i = 0; i < n; i++) {
        const resolver = await network.viem.deployContract(
          "MockCompositeResolver",
          [resolvers[0], false],
        );
        resolvers.unshift(resolver.address);
      }
      await F.v2.setupName({
        name,
        resolverAddress: resolvers[0],
      });
      await expect(
        F.helper.read.getResolvers([dnsEncodeName(name)]),
      ).resolves.toStrictEqual(
        resolvers.map((x) => ({
          resolver: getAddress(x),
          offchain: false,
        })),
      );
    });
  }
});
