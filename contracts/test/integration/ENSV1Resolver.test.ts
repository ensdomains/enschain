import { shouldSupportInterfaces } from "@ensdomains/hardhat-chai-matchers-viem/behaviour";
import hre from "hardhat";
import { describe, it } from "vitest";

import {
  type KnownProfile,
  bundleCalls,
  makeResolutions,
} from "../utils/resolutions.js";
import { shouldSupportFeatures } from "../utils/supportsFeatures.js";
import { dnsEncodeName, COIN_TYPE_ETH } from "../utils/utils.js";
import { deployV1Fixture } from "./fixtures/deployV1Fixture.js";
import { deployV2Fixture } from "./fixtures/deployV2Fixture.js";
import { expectVar } from "../utils/expectVar.js";

const network = await hre.network.connect();

async function fixture() {
  const v1 = await deployV1Fixture(network, true);
  const v2 = await deployV2Fixture(network, true);
  const ensV1Resolver = await network.viem.deployContract("ENSV1Resolver", [
    v1.batchGatewayProvider.address,
    v2.contractNamer.address,
    v1.ensRegistry.address,
  ]);
  return { v1, v2, ensV1Resolver };
}

describe("ENSV1Resolver", () => {
  shouldSupportInterfaces({
    contract: () =>
      network.networkHelpers.loadFixture(fixture).then((F) => F.ensV1Resolver),
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
      network.networkHelpers.loadFixture(fixture).then((F) => F.ensV1Resolver),
    features: {
      RESOLVER: ["RESOLVE_MULTICALL"],
    },
  });

  for (const name of [
    "test.eth",
    "sub.test.eth",
    "abc.sub.test.eth",
    "test.xyz",
  ]) {
    it(name, async () => {
      const F = await network.networkHelpers.loadFixture(fixture);
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
      await F.v1.setupName({ name });
      await F.v2.setupName({
        name,
        resolverAddress: F.ensV1Resolver.address,
      });
      await F.v1.publicResolver.write.multicall([
        res.resolutions.map((x) => x.writeV1),
      ]);
      {
        const [answer, resolver] = await F.v2.universalResolver.read.resolve([
          dnsEncodeName(kp.name),
          res.call,
        ]);
        expectVar({ resolver }).toEqualAddress(F.ensV1Resolver.address);
        res.expect(answer);
      }
      {
        const [resolver, offchain] = await F.ensV1Resolver.read.getResolver([
          dnsEncodeName(name),
        ]);
        expectVar({ resolver }).toEqualAddress(F.v1.publicResolver.address);
        expectVar({ offchain }).toStrictEqual(false);
      }
    });
  }
});
