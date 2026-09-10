import { shouldSupportInterfaces } from "@ensdomains/hardhat-chai-matchers-viem/behaviour";
import hre from "hardhat";
import { describe, expect, it } from "vitest";

import {
  encodeErrorResult,
  getAddress,
  parseAbi,
  toBytes,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import { normalize } from "viem/ens";
import { createServer } from "node:http";

import { bundleCalls, makeResolutions } from "../utils/resolutions.js";
import {
  COIN_TYPE_ETH,
  COIN_TYPE_DEFAULT,
  getReverseName,
  getParentName,
  dnsEncodeName,
  namehash,
  getLabelAt,
} from "../utils/utils.js";
import { deployV2Fixture } from "./fixtures/deployV2Fixture.js";
import { expectVar } from "../utils/expectVar.js";
import { oldResolverArtifact } from "../../lib/ens-contracts/test/fixtures/OldResolver.js";
import { LOCAL_BATCH_GATEWAY_URL } from "../../script/deploy-constants.ts";

const network = await hre.network.connect();
const loadFixture = async () => network.networkHelpers.loadFixture(fixture);

async function fixture() {
  const v2 = await deployV2Fixture(network, true);
  const ur = await network.viem.deployContract(
    "UniversalResolverV2",
    [
      v2.rootRegistry.address,
      v2.batchGatewayProvider.address,
      v2.contractNamer.address,
    ],
    { client: { public: v2.publicClient } },
  );
  const ss1 = await network.viem.deployContract("DummyShapeshiftResolver");
  const ss2 = await network.viem.deployContract("DummyShapeshiftResolver");
  const old = await network.viem.deployContract(oldResolverArtifact);
  const ensip15 = await network.viem.deployContract("MockENSIP15");
  const owner = getAddress(v2.walletClient.account.address);
  const myResolver = await v2.deployPermissionedResolver();
  return { ...v2, ur, ss1, ss2, old, ensip15, owner, myResolver };
}

const dummyCalldata = "0x12345678";
const testName = "test.eth";
const anotherAddress = "0x8000000000000000000000000000000000000001";
const resolutions = makeResolutions({
  name: testName,
  addresses: [{ coinType: COIN_TYPE_ETH, value: anotherAddress }],
  texts: [{ key: "description", value: "Test" }],
});

// note: these tests are nearly the same as: https://github.com/ensdomains/ens-contracts/blob/staging/test/universalResolver/TestUniversalResolver.test.ts
describe("UniversalResolverV2", () => {
  shouldSupportInterfaces({
    contract: () => loadFixture().then((F) => F.ur),
    interfaces: [
      "IERC165",
      "IUniversalResolver",
      "IUniversalResolverExtended",
      "INormalizedUniversalResolver",
      "INormalizedUniversalResolverExtended",
    ],
  });

  it("isENSv2", async () => {
    const F = await loadFixture();
    await expect(F.ur.read.isENSv2()).resolves.toStrictEqual(true);
  });

  describe("findResolver()", () => {
    it("unset", async () => {
      const F = await loadFixture();
      const [resolver, node, offset] = await F.ur.read.findResolver([
        dnsEncodeName(testName),
      ]);
      expectVar({ resolver }).toEqualAddress(zeroAddress);
      expectVar({ node }).toStrictEqual(namehash(testName));
      expectVar({ offset }).toStrictEqual(0n);
    });

    it("immediate", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const [resolver, node, offset] = await F.ur.read.findResolver([
        dnsEncodeName(testName),
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ node }).toStrictEqual(namehash(testName));
      expectVar({ offset }).toStrictEqual(0n);
    });

    it("extended", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      await F.ss1.write.setExtended([true]);
      const [resolver, node, offset] = await F.ur.read.findResolver([
        dnsEncodeName(testName),
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ node }).toStrictEqual(namehash(testName));
      expectVar({ offset }).toStrictEqual(
        BigInt(1 + toBytes(getLabelAt(testName)).length),
      );
    });
  });

  describe("resolve()", () => {
    it("unset", async () => {
      const F = await loadFixture();
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("ResolverNotFound")
        .withArgs([dnsEncodeName(testName)]);
    });

    it("not extended", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("ResolverNotFound")
        .withArgs([dnsEncodeName(testName)]);
    });

    it("not a contract", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.owner });
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("ResolverNotContract")
        .withArgs([dnsEncodeName(testName), F.owner]);
    });

    it("empty response", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("UnsupportedResolverProfile")
        .withArgs([dummyCalldata]);
    });

    it("empty revert", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await F.ss1.write.setRevertEmpty([true]);
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("ResolverError")
        .withArgs(["0x"]);
    });

    it("resolver revert", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await F.ss1.write.setResponse([dummyCalldata, dummyCalldata]);
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("ResolverError")
        .withArgs([dummyCalldata]);
    });

    for (const statusCode of [400, 500]) {
      it(`batch gateway http error: ${statusCode}`, async () => {
        const http = createServer((_, res) => res.writeHead(statusCode).end());
        try {
          await new Promise<void>((ful) => http.listen(undefined, ful));
          const F = await loadFixture();
          await F.setupName({ name: testName, resolverAddress: F.ss1.address });
          await F.ss1.write.setResponse([dummyCalldata, dummyCalldata]);
          await F.ss1.write.setOffchain([true]);
          await F.ss1.write.setRevertURL([
            `http://localhost:${(http.address() as any).port}`,
          ]);
          await expect(
            F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]),
          )
            .toBeRevertedWithCustomError("HttpError")
            .withArgs([statusCode, "HTTP request failed."]);
        } finally {
          http.close();
        }
      });
    }

    it("unsupported revert", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await F.ss1.write.setRevertUnsupportedResolverProfile([true]);
      await expect(F.ur.read.resolve([dnsEncodeName(testName), dummyCalldata]))
        .toBeRevertedWithCustomError("UnsupportedResolverProfile")
        .withArgs([dummyCalldata]);
    });

    it("old", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.old.address });
      const [res] = makeResolutions({
        name: testName,
        primary: {
          value: testName,
        },
      });
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        res.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.old.address);
      expectVar({ answer }).toStrictEqual(res.answer);
      res.expect(answer);
    });

    it("old w/multicall (1 revert)", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.old.address });
      const bundle = bundleCalls(
        makeResolutions({
          name: testName,
          primary: { value: testName },
          errors: [{ call: dummyCalldata, answer: "0x" }],
        }),
      );
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        bundle.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.old.address);
      expectVar({ answer }).toStrictEqual(bundle.answer);
      bundle.expect(answer);
    });

    it("onchain immediate", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        res.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(res.answer);
      res.expect(answer);
    });

    it("onchain immediate w/multicall", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const bundle = bundleCalls(resolutions);
      for (const res of resolutions) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        bundle.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(bundle.answer);
      bundle.expect(answer);
    });

    it("onchain extended", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      await F.ss1.write.setExtended([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        res.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(res.answer);
      res.expect(answer);
    });

    it("onchain extended w/multicall", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      const bundle = bundleCalls(resolutions);
      for (const res of resolutions) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      await F.ss1.write.setExtended([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        bundle.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(bundle.answer);
      bundle.expect(answer);
    });

    it("offchain immediate", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      await F.ss1.write.setOffchain([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        res.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(res.answer);
      res.expect(answer);
    });

    it("offchain immediate w/multicall", async () => {
      const F = await loadFixture();
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const bundle = bundleCalls(resolutions);
      for (const res of resolutions) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      await F.ss1.write.setOffchain([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        bundle.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(bundle.answer);
      bundle.expect(answer);
    });

    it("offchain extended", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      await F.ss1.write.setExtended([true]);
      await F.ss1.write.setOffchain([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        res.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(res.answer);
      res.expect(answer);
    });

    it("offchain extended w/multicall", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      const bundle = bundleCalls(resolutions);
      for (const res of resolutions) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      await F.ss1.write.setExtended([true]);
      await F.ss1.write.setOffchain([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        bundle.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(bundle.answer);
      bundle.expect(answer);
    });

    it("offchain extended w/multicall (1 revert)", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss1.address,
      });
      const calls = makeResolutions({
        name: testName,
        primary: {
          value: testName,
        },
        errors: [
          {
            call: dummyCalldata,
            answer: encodeErrorResult({
              abi: parseAbi(["error UnsupportedResolverProfile(bytes4)"]),
              args: [dummyCalldata],
            }),
          },
        ],
      });
      const bundle = bundleCalls(calls);
      for (const res of calls) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      await F.ss1.write.setExtended([true]);
      await F.ss1.write.setOffchain([true]);
      const [answer, resolver] = await F.ur.read.resolve([
        dnsEncodeName(testName),
        bundle.call,
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ answer }).toStrictEqual(bundle.answer);
      bundle.expect(answer);
    });
  });

  describe("normalize()", () => {
    for (const name of [
      "",
      // "a".repeat(256), \
      // ".",             | does not
      // ".eth",          |  encode
      // "eth.",          /
      " abc",
      "abc ",
      "abc.eth ",
      "eth",
      "ETH",
      "Test.eth",
      "TEST.ETH",
    ]) {
      it(`"${name.length > 32 ? name.slice(0, 32) + "..." : name}"`, async () => {
        const F = await loadFixture();
        let norm: string | undefined;
        try {
          const temp = normalize(name); // must normalize
          dnsEncodeName(temp); // must encode
          norm = temp;
        } catch {}
        if (typeof norm === "string") {
          await expect(
            F.ur.read.normalize([dnsEncodeName(name), F.ensip15.address]),
          ).resolves.toStrictEqual([name === norm, dnsEncodeName(norm)]);
        } else {
          await expect(
            F.ur.read.normalize([dnsEncodeName(name), F.ensip15.address]),
          ).rejects.toThrow();
        }
      });
    }
  });

  describe("resolveWithNormalization()", () => {
    it("is normalized", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: testName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setAddress([
        dnsEncodeName(testName),
        COIN_TYPE_ETH,
        anotherAddress,
      ]);
      const [res] = makeResolutions({
        name: "anything",
        addresses: [{ coinType: COIN_TYPE_ETH, value: anotherAddress }],
      });
      const [answer, resolver] = await F.ur.read.resolveWithNormalization([
        dnsEncodeName(testName),
        res.call,
        F.ensip15.address,
      ]);
      expectVar({ resolver }).toEqualAddress(F.myResolver.address);
      res.expect(answer);
    });

    it("can normalize", async () => {
      const F = await loadFixture();
      await F.setupName({
        name: testName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setAddress([
        dnsEncodeName(testName),
        COIN_TYPE_ETH,
        anotherAddress,
      ]);
      const [res] = makeResolutions({
        name: "anything",
        addresses: [{ coinType: COIN_TYPE_ETH, value: anotherAddress }],
      });
      await expect(
        F.ur.read.resolveWithNormalization([
          dnsEncodeName(testName.toUpperCase()),
          res.call,
          F.ensip15.address,
        ]),
      )
        .toBeRevertedWithCustomError("NormalizationChangedName")
        .withArgs([dnsEncodeName(testName), res.answer, F.myResolver.address]);
    });

    it("cannot normalize", async () => {
      const F = await loadFixture();
      const badLabel = " ";
      await expect(
        F.ur.read.resolveWithNormalization([
          dnsEncodeName(`test.${badLabel}.eth`),
          dummyCalldata,
          F.ensip15.address,
        ]),
      )
        .toBeRevertedWithCustomErrorFrom(F.ensip15, "CannotNormalize")
        .withArgs([badLabel]);
    });

    it("unnormalized primary", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      const badName = testName.toUpperCase(); // wrong
      const [rev] = makeResolutions({
        name: reverseName,
        primary: { value: badName },
      });
      await F.ss1.write.setResponse([rev.call, rev.answer]);
      await expect(
        F.ur.read.reverseWithNormalization([
          F.owner,
          COIN_TYPE_ETH,
          F.ensip15.address,
        ]),
      )
        .toBeRevertedWithCustomError("PrimaryNameNotNormalized")
        .withArgs([badName]);
    });
  });

  describe("IUniversalResolverExtended", () => {
    it("resolveWithGateways()", async () => {
      const F = await loadFixture();
      await F.batchGatewayProvider.write.setGateways([[]]);
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      await F.ss1.write.setOffchain([true]);
      await expect(
        F.ur.read.resolveWithGateways([dnsEncodeName(testName), res.call, []]),
      ).rejects.toThrow();
      const [answer, resolver] = await F.ur.read.resolveWithGateways([
        dnsEncodeName(testName),
        res.call,
        [LOCAL_BATCH_GATEWAY_URL],
      ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      res.expect(answer);
    });

    it("reverseWithGateways()", async () => {
      const F = await loadFixture();
      await F.batchGatewayProvider.write.setGateways([[]]);
      const reverseName = getReverseName(F.owner);
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      const [fwd] = makeResolutions({
        name: testName,
        addresses: [{ coinType: COIN_TYPE_ETH, value: F.owner }],
      });
      const [rev] = makeResolutions({
        name: reverseName,
        primary: { value: testName },
      });
      for (const res of [fwd, rev]) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      await F.ss1.write.setOffchain([true]);
      await expect(
        F.ur.read.reverseWithGateways([F.owner, COIN_TYPE_ETH, []]),
      ).rejects.toThrow();
      const [primary, resolver, reverseResolver] =
        await F.ur.read.reverseWithGateways([
          F.owner,
          COIN_TYPE_ETH,
          [LOCAL_BATCH_GATEWAY_URL],
        ]);
      expectVar({ primary }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ reverseResolver }).toEqualAddress(F.ss1.address);
    });

    it("resolveWithResolver()", async () => {
      const F = await loadFixture();
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      res.expect(
        await F.ur.read.resolveWithResolver([
          F.ss1.address,
          dnsEncodeName(testName),
          res.call,
          [LOCAL_BATCH_GATEWAY_URL],
        ]),
      );
    });

    describe("requireResolver()", async () => {
      it("unset", async () => {
        const F = await loadFixture();
        await expect(
          F.ur.read.requireResolver([dnsEncodeName(testName)]),
        ).toBeRevertedWithCustomError("ResolverNotFound");
      });

      it("not a contract", async () => {
        const F = await loadFixture();
        await F.setupName({ name: testName, resolverAddress: F.owner });
        await expect(
          F.ur.read.requireResolver([dnsEncodeName(testName)]),
        ).toBeRevertedWithCustomError("ResolverNotContract");
      });

      it("not extended", async () => {
        const F = await loadFixture();
        await F.setupName({
          name: getParentName(testName),
          resolverAddress: F.ss1.address,
        });
        await expect(
          F.ur.read.requireResolver([dnsEncodeName(testName)]),
        ).toBeRevertedWithCustomError("ResolverNotFound");
      });

      it("valid", async () => {
        const F = await loadFixture();
        await F.setupName({ name: testName, resolverAddress: F.ss1.address });
        const { resolver } = await F.ur.read.requireResolver([
          dnsEncodeName(testName),
        ]);
        expectVar({ resolver }).toEqualAddress(F.ss1.address);
      });
    });
  });

  describe("INormalizedUniversalResolverExtended", () => {
    it("resolveWithGatewaysAndNormalization", async () => {
      const F = await loadFixture();
      await F.batchGatewayProvider.write.setGateways([[]]);
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const res = resolutions[0];
      await F.ss1.write.setResponse([res.call, res.answer]);
      await F.ss1.write.setOffchain([true]);
      await expect(
        F.ur.read.resolveWithGatewaysAndNormalization([
          dnsEncodeName(testName),
          res.call,
          [],
          F.ensip15.address,
        ]),
      ).rejects.toThrow();
      const [answer, resolver] =
        await F.ur.read.resolveWithGatewaysAndNormalization([
          dnsEncodeName(testName),
          res.call,
          [LOCAL_BATCH_GATEWAY_URL],
          F.ensip15.address,
        ]);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      res.expect(answer);
    });

    it("reverseWithGatewaysAndNormalization()", async () => {
      const F = await loadFixture();
      await F.batchGatewayProvider.write.setGateways([[]]);
      const reverseName = getReverseName(F.owner);
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      const [fwd] = makeResolutions({
        name: testName,
        addresses: [{ coinType: COIN_TYPE_ETH, value: F.owner }],
      });
      const [rev] = makeResolutions({
        name: reverseName,
        primary: { value: testName },
      });
      for (const res of [fwd, rev]) {
        await F.ss1.write.setResponse([res.call, res.answer]);
      }
      await F.ss1.write.setOffchain([true]);
      await expect(
        F.ur.read.reverseWithGateways([F.owner, COIN_TYPE_ETH, []]),
      ).rejects.toThrow();
      const [primary, resolver, reverseResolver] =
        await F.ur.read.reverseWithGatewaysAndNormalization([
          F.owner,
          COIN_TYPE_ETH,
          [LOCAL_BATCH_GATEWAY_URL],
          F.ensip15.address,
        ]);
      expectVar({ primary }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ reverseResolver }).toEqualAddress(F.ss1.address);
    });
  });

  describe("reverse()", () => {
    it("empty address", async () => {
      const F = await loadFixture();
      await expect(
        F.ur.read.reverse(["0x", COIN_TYPE_ETH]),
      ).toBeRevertedWithCustomError("EmptyAddress");
    });

    it("unset reverse resolver", async () => {
      const F = await loadFixture();
      await expect(F.ur.read.reverse([F.owner, COIN_TYPE_ETH]))
        .toBeRevertedWithCustomError("ResolverNotFound")
        .withArgs([dnsEncodeName(getReverseName(F.owner, COIN_TYPE_ETH))]);
    });

    it("unset primary resolver", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        COIN_TYPE_ETH,
      ]);
      expectVar({ name }).toStrictEqual("");
      expectVar({ resolver }).toEqualAddress(zeroAddress);
      expectVar({ reverseResolver }).toEqualAddress(F.myResolver.address);
    });

    it("unset name()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      const [res] = makeResolutions({
        name: reverseName,
        primary: { value: "" },
      });
      await F.ss1.write.setResponse([res.call, res.answer]);
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        COIN_TYPE_ETH,
      ]);
      expectVar({ name }).toStrictEqual("");
      expectVar({ resolver }).toEqualAddress(zeroAddress);
      expectVar({ reverseResolver }).toEqualAddress(F.ss1.address);
    });

    it("unimplemented name()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      await expect(F.ur.read.reverse([F.owner, COIN_TYPE_ETH]))
        .toBeRevertedWithCustomError("UnsupportedResolverProfile")
        .withArgs([toFunctionSelector("name(bytes32)")]);
    });

    it("onchain immediate name() + onchain immediate addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setName([dnsEncodeName(reverseName), testName]);
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      const [res] = makeResolutions({
        name: testName,
        addresses: [{ coinType: COIN_TYPE_ETH, value: F.owner }],
      });
      await F.ss1.write.setResponse([res.call, res.answer]);
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        COIN_TYPE_ETH,
      ]);
      expectVar({ name }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.ss1.address);
      expectVar({ reverseResolver }).toEqualAddress(F.myResolver.address);
    });

    it("onchain immediate name() + onchain immediate fallback addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setName([dnsEncodeName(reverseName), testName]);
      await F.setupName({
        name: testName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setAddress([
        dnsEncodeName(testName),
        COIN_TYPE_DEFAULT,
        F.owner,
      ]);
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        COIN_TYPE_ETH,
      ]);
      expectVar({ name }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.myResolver.address);
      expectVar({ reverseResolver }).toEqualAddress(F.myResolver.address);
    });

    it("onchain immediate name() + onchain immediate addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setName([dnsEncodeName(reverseName), testName]);
      await F.setupName({
        name: testName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setAddress([
        dnsEncodeName(testName),
        COIN_TYPE_ETH,
        F.owner,
      ]);
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        COIN_TYPE_ETH,
      ]);
      expectVar({ name }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.myResolver.address);
      expectVar({ reverseResolver }).toEqualAddress(F.myResolver.address);
    });

    it("onchain immediate name() + onchain immediate mismatch addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setName([dnsEncodeName(reverseName), testName]);
      await F.setupName({
        name: testName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setAddress([
        dnsEncodeName(testName),
        COIN_TYPE_ETH,
        anotherAddress,
      ]);
      await expect(F.ur.read.reverse([F.owner, COIN_TYPE_ETH]))
        .toBeRevertedWithCustomError("ReverseAddressMismatch")
        .withArgs([testName, anotherAddress]);
    });

    it("onchain immediate name() + old unimplemented addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setName([dnsEncodeName(reverseName), testName]);
      await F.setupName({ name: testName, resolverAddress: F.old.address });
      await expect(F.ur.read.reverse([F.owner, COIN_TYPE_ETH]))
        .toBeRevertedWithCustomError("UnsupportedResolverProfile")
        .withArgs([toFunctionSelector("addr(bytes32)")]);
    });

    it("onchain immediate name() + onchain immediate unimplemented addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({
        name: reverseName,
        resolverAddress: F.myResolver.address,
      });
      await F.myResolver.write.setName([dnsEncodeName(reverseName), testName]);
      await F.setupName({ name: testName, resolverAddress: F.ss1.address });
      await expect(F.ur.read.reverse([F.owner, COIN_TYPE_ETH]))
        .toBeRevertedWithCustomError("UnsupportedResolverProfile")
        .withArgs([toFunctionSelector("addr(bytes32)")]);
    });

    it("offchain extended name() + onchain immediate addr()", async () => {
      const F = await loadFixture();
      const reverseName = getReverseName(F.owner);
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      const [rev] = makeResolutions({
        name: reverseName,
        primary: { value: testName },
      });
      await F.ss1.write.setExtended([true]);
      await F.ss1.write.setOffchain([true]);
      await F.ss1.write.setResponse([rev.call, rev.answer]);
      await F.setupName({ name: testName, resolverAddress: F.ss2.address });
      const [res] = makeResolutions({
        name: testName,
        addresses: [{ coinType: COIN_TYPE_ETH, value: F.owner }],
      });
      await F.ss2.write.setResponse([res.call, res.answer]);
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        COIN_TYPE_ETH,
      ]);
      expectVar({ name }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.ss2.address);
      expectVar({ reverseResolver }).toEqualAddress(F.ss1.address);
    });

    it("offchain extended name() + offchain extended addr()", async () => {
      const F = await loadFixture();
      const coinType = 123n; // non-evm
      const reverseName = getReverseName(F.owner, coinType);
      await F.setupName({ name: reverseName, resolverAddress: F.ss1.address });
      const [rev] = makeResolutions({
        name: reverseName,
        primary: { value: testName },
      });
      await F.ss1.write.setExtended([true]);
      await F.ss1.write.setOffchain([true]);
      await F.ss1.write.setResponse([rev.call, rev.answer]);
      await F.setupName({
        name: getParentName(testName),
        resolverAddress: F.ss2.address,
      });
      const [res] = makeResolutions({
        name: testName,
        addresses: [{ coinType, value: F.owner }],
      });
      await F.ss2.write.setExtended([true]);
      await F.ss2.write.setOffchain([true]);
      await F.ss2.write.setResponse([res.call, res.answer]);
      const [name, resolver, reverseResolver] = await F.ur.read.reverse([
        F.owner,
        coinType,
      ]);
      expectVar({ name }).toStrictEqual(testName);
      expectVar({ resolver }).toEqualAddress(F.ss2.address);
      expectVar({ reverseResolver }).toEqualAddress(F.ss1.address);
    });
  });
});
