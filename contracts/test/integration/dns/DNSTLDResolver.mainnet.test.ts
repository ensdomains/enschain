import hre from "hardhat";
import { describe, it } from "vitest";
import { expectVar } from "../../utils/expectVar.js";
import { bundleCalls, makeResolutions } from "../../utils/resolutions.js";
import { dnsEncodeName, getLabelAt, namehash } from "../../utils/utils.js";
import { deployV2Fixture } from "../fixtures/deployV2Fixture.js";
import { KNOWN_DNS } from "./mainnet.js";

const url = await (async (config) => {
  return config.type === "http" && config.url.get();
})(hre.config.networks.mainnet).catch(() => {});

let tests = () => {};
if (url) {
  const chain = await hre.network.connect({
    override: { forking: { enabled: true, url } },
  });

  async function fixture() {
    await chain.networkHelpers.mine(); // https://github.com/NomicFoundation/hardhat/issues/5511#issuecomment-2288072104
    const v2 = await deployV2Fixture(chain, true); // CCIP on UR
    const ensRegistry = await chain.viem.getContractAt(
      "ENSRegistry",
      "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
    );
    const dnsTLDResolverV1 = await chain.viem.getContractAt(
      "OffchainDNSResolver",
      await ensRegistry.read.resolver([namehash("com")]),
    );
    const DNSSEC = await chain.viem.getContractAt(
      "DNSSEC",
      await dnsTLDResolverV1.read.oracle(),
    );
    const oracleGatewayProvider = await chain.viem.deployContract(
      "GatewayProvider",
      [
        v2.walletClient.account.address,
        [await dnsTLDResolverV1.read.gatewayURL()],
      ],
    );
    const dnsTLDResolver = await chain.viem.deployContract("DNSTLDResolver", [
      ensRegistry.address,
      dnsTLDResolverV1.address,
      v2.rootRegistry.address,
      DNSSEC.address,
      oracleGatewayProvider.address,
      v2.batchGatewayProvider.address,
      v2.contractNamer.address,
    ]);
    for (const name of ["dnsname.ens.eth"]) {
      await v2.setupName({
        name,
        resolverAddress: await ensRegistry.read.resolver([namehash(name)]),
      });
    }
    return {
      v2,
      ensRegistry,
      dnsTLDResolverV1,
      DNSSEC,
      dnsTLDResolver,
    };
  }

  tests = () => {
    const timeout = 15000;
    describe("v1", () => {
      for (const kp of KNOWN_DNS) {
        it(kp.name, { timeout }, async () => {
          const F = await chain.networkHelpers.loadFixture(fixture);
          await F.v2.setupName({
            name: getLabelAt(kp.name, -1),
            resolverAddress: F.dnsTLDResolverV1.address,
          });
          const bundle = bundleCalls(makeResolutions(kp));
          const [answer, resolver] = await F.v2.universalResolver.read.resolve([
            dnsEncodeName(kp.name),
            bundle.call,
          ]);
          expectVar({ resolver }).toEqualAddress(F.dnsTLDResolverV1.address);
          bundle.expect(answer);
        });
      }
    });
    describe("v2", () => {
      for (const kp of KNOWN_DNS) {
        it(kp.name, { timeout }, async () => {
          const F = await chain.networkHelpers.loadFixture(fixture);
          await F.v2.setupName({
            name: getLabelAt(kp.name, -1),
            resolverAddress: F.dnsTLDResolver.address,
          });
          const bundle = bundleCalls(makeResolutions(kp));
          const [answer, resolver] = await F.v2.universalResolver.read.resolve([
            dnsEncodeName(kp.name),
            bundle.call,
          ]);
          expectVar({ resolver }).toEqualAddress(F.dnsTLDResolver.address);
          bundle.expect(answer);
        });
      }
    });
  };
}

describe.skipIf(!url)("DNSTLDResolver (mainnet)", tests);
