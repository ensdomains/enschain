import { shouldSupportInterfaces } from "@ensdomains/hardhat-chai-matchers-viem/behaviour";
import hre from "hardhat";
import { describe, it } from "vitest";

import {
  type KnownProfile,
  bundleCalls,
  makeResolutions,
} from "../utils/resolutions.js";
import { shouldSupportFeatures } from "../utils/supportsFeatures.js";
import { dnsEncodeName, idFromLabel, COIN_TYPE_ETH } from "../utils/utils.js";
import { deployV1Fixture } from "./fixtures/deployV1Fixture.js";
import { deployV2Fixture } from "./fixtures/deployV2Fixture.js";
import { expectVar } from "../utils/expectVar.js";

const network = await hre.network.connect();

async function fixture() {
  const v1 = await deployV1Fixture(network, true, false);
  const v2 = await deployV2Fixture(network, true);
  const ethResolver = v1.ownedResolver.address;
  const ensV2Resolver = await network.viem.deployContract("ENSV2Resolver", [
    v2.batchGatewayProvider.address,
    v2.contractNamer.address,
    v2.rootRegistry.address,
    ethResolver,
  ]);
  // setup fallback resolver
  await v1.setupName({
    name: "eth",
    resolverAddress: ensV2Resolver.address,
  });
  return { v1, v2, ensV2Resolver, ethResolver };
}

describe("ENSV2Resolver", () => {
  shouldSupportInterfaces({
    contract: () =>
      network.networkHelpers.loadFixture(fixture).then((F) => F.ensV2Resolver),
    interfaces: [
      "IERC165",
      "IERC7996",
      "IExtendedResolver",
      "ICompositeResolver",
      "IContractNamer",
    ],
  });

  shouldSupportFeatures({
    contract: () =>
      network.networkHelpers.loadFixture(fixture).then((F) => F.ensV2Resolver),
    features: {
      RESOLVER: ["RESOLVE_MULTICALL"],
    },
  });

  it("eth override", async () => {
    const F = await network.networkHelpers.loadFixture(fixture);
    // setup invalid resolver in v2
    await F.v2.rootRegistry.write.setResolver([
      idFromLabel("eth"),
      "0x1111111111111111111111111111111111111111",
    ]);
    // resolve in v1
    {
      const res = bundleCalls(
        makeResolutions({
          name: "eth",
          addresses: [
            {
              coinType: COIN_TYPE_ETH,
              value: F.v1.baseRegistrar.address,
            },
          ],
        }),
      );
      const [answer, resolver] = await F.v1.universalResolver.read.resolve([
        dnsEncodeName("eth"),
        res.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ensV2Resolver.address);
      res.expect(answer);
    }
    // check getResolver
    {
      const [resolver, offchain] = await F.ensV2Resolver.read.getResolver([
        dnsEncodeName("eth"),
      ]);
      expectVar({ resolver }).toEqualAddress(F.ethResolver);
      expectVar({ offchain }).toStrictEqual(false);
    }
  });

  for (const name of ["test.eth", "sub.test.eth", "abc.sub.test.eth"]) {
    it(name, async () => {
      const F = await network.networkHelpers.loadFixture(fixture);
      // setup profile in v2
      const kp: KnownProfile = {
        name,
        addresses: [
          {
            coinType: COIN_TYPE_ETH,
            value: "0x8000000000000000000000000000000000000001",
          },
        ],
        texts: [{ key: "url", value: "https://ens.domains" }],
        contenthash: { value: "0xabcdef" },
      };
      const res = bundleCalls(makeResolutions(kp));
      const myResolver = await F.v2.deployPermissionedResolver();
      await F.v2.setupName({
        name,
        resolverAddress: myResolver.address,
      });
      await myResolver.write.multicall([res.resolutions.map((x) => x.writeV2)]);
      // resolve in v1
      {
        const [answer, resolver] = await F.v1.universalResolver.read.resolve([
          dnsEncodeName(kp.name),
          res.call,
        ]);
        expectVar({ resolver }).toEqualAddress(F.ensV2Resolver.address);
        res.expect(answer);
      }
      // check getResolver
      {
        const [resolver, offchain] = await F.ensV2Resolver.read.getResolver([
          dnsEncodeName(name),
        ]);
        expectVar({ resolver }).toEqualAddress(myResolver.address);
        expectVar({ offchain }).toStrictEqual(false);
      }
    });
  }
});
