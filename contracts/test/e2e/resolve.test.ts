import { describe, it } from "bun:test";
import type { Address } from "viem";

import { expectVar } from "../utils/expectVar.js";
import {
  bundleCalls,
  type KnownProfile,
  makeResolutions,
} from "../utils/resolutions.js";
import {
  coinTypeFromChain,
  COIN_TYPE_DEFAULT,
  COIN_TYPE_ETH,
  dnsEncodeName,
  getReverseNamespace,
} from "../utils/utils.js";

const COIN_TYPE_OPTIMISM = coinTypeFromChain(10);

// Some DNS cases resolve real third-party domains through the live
// dnssec-oracle.ens.domains CCIP gateway, so they depend on external DNS state
// and gateway availability. They are opt-in to keep CI independent of those.
const itLiveDns = process.env.RUN_LIVE_DNS_TESTS === "1" ? it : it.skip;

describe("Resolve", () => {
  const { env, setupEnv } = process.TEST_GLOBALS!;

  setupEnv({ resetOnEach: true });

  async function expectResolve(kp: KnownProfile) {
    const bundle = bundleCalls(makeResolutions(kp));
    const [answer] = await env.v2.UniversalResolver.read.resolve([
      dnsEncodeName(kp.name),
      bundle.call,
    ]);
    bundle.expect(answer);
  }

  describe("Protocol", () => {
    function expectNamed(name: string, fn: () => Address) {
      it(name, async () => {
        const [resolver] = await env.v2.UniversalResolver.read.findResolver([
          dnsEncodeName(name),
        ]);
        expectVar({ resolver }).toEqualAddress(fn());
      });
    }

    expectNamed("reverse", () => env.v2.ENSV1Resolver.address);
    expectNamed(
      getReverseNamespace(COIN_TYPE_ETH),
      () => env.v2.ENSV1Resolver.address,
    );
    expectNamed(
      getReverseNamespace(COIN_TYPE_DEFAULT),
      () => env.v2.ENSV1Resolver.address,
    );
    expectNamed(
      getReverseNamespace(COIN_TYPE_OPTIMISM),
      () => env.v2.ENSV1Resolver.address,
    );
  });

  describe("DNS", () => {
    it("dnstxt.ens.eth + addr() => DNSTXTResolver", () =>
      expectResolve({
        name: "dnstxt.ens.eth",
        addresses: [
          {
            coinType: COIN_TYPE_ETH,
            value: env.v2.DNSTXTResolver.address,
          },
        ],
      }));

    it("dnsalias.ens.eth + addr() => DNSAliasResolver", () =>
      expectResolve({
        name: "dnsalias.ens.eth",
        addresses: [
          {
            coinType: COIN_TYPE_ETH,
            value: env.v2.DNSAliasResolver.address,
          },
        ],
      }));

    itLiveDns("onchain txt: taytems.xyz", () =>
      // Uses real DNS TXT record for taytems.xyz
      expectResolve({
        name: "taytems.xyz",
        addresses: [
          {
            coinType: COIN_TYPE_ETH,
            value: "0x8e8Db5CcEF88cca9d624701Db544989C996E3216",
          },
        ],
      }),
    );

    itLiveDns("onchain txt: dnstxt.raffy.xyz", () =>
      // `dnstxt.ens.eth t[avatar]=https://raffy.xyz/ens.jpg a[e0]=0x51050ec063d393217B436747617aD1C2285Aeeee`
      expectResolve({
        name: "dnstxt.raffy.xyz",
        addresses: [
          {
            coinType: COIN_TYPE_ETH,
            value: "0x51050ec063d393217B436747617aD1C2285Aeeee",
          },
        ],
        texts: [{ key: "avatar", value: "https://raffy.xyz/ens.jpg" }],
      }),
    );

    itLiveDns("alias rewrite: dnsalias[.raffy.xyz] => dnsalias[.ens.eth]", () =>
      // `dnsalias.ens.eth raffy.xyz ens.eth`
      expectResolve({
        name: "dnsalias.raffy.xyz",
        addresses: [
          {
            coinType: COIN_TYPE_ETH,
            value: env.v2.DNSAliasResolver.address,
          },
        ],
      }),
    );
  });
});
