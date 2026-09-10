import hre from "hardhat";
import { type Address, getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { expectVar } from "../../utils/expectVar.js";
import {
  dnsEncodeName,
  getLabelAt,
  idFromLabel,
  idWithVersion,
} from "../../utils/utils.js";
import { deployV2Fixture } from "./deployV2Fixture.js";
import { ROLES } from "../../../script/deploy-constants.js";

const chain = await hre.network.connect();
async function fixture() {
  return deployV2Fixture(chain);
}
const loadFixture = async () => chain.networkHelpers.loadFixture(fixture);

const testAddress = "0x8000000000000000000000000000000000000001";

function expectRegistries(
  actual: ({ address: Address } | undefined)[],
  expected: typeof actual,
) {
  expect(actual, "registries.length").toHaveLength(expected.length);
  actual.forEach((x, i) => {
    expect(x?.address.toLowerCase(), `registry[${i}]`).toEqual(
      expected[i]?.address.toLowerCase(),
    );
  });
}

describe("deployV2Fixture", () => {
  it("setupName()", async () => {
    const F = await loadFixture();
    const { labels, tokenId, parentRegistry, exactRegistry, registries } =
      await F.setupName({
        name: "test.eth",
      });
    expectVar({ labels }).toStrictEqual(["test", "eth"]);
    expectVar({ tokenId }).toEqual(idWithVersion(idFromLabel("test")));
    expectVar({ parentRegistry }).toEqual(registries[1]);
    expectVar({ exactRegistry }).toBeUndefined();
    expectRegistries(registries, [undefined, F.ethRegistry, F.rootRegistry]);
  });

  it("setupName() w/exact", async () => {
    const F = await loadFixture();
    const { labels, tokenId, parentRegistry, exactRegistry, registries } =
      await F.setupName({
        name: "test.eth",
        exact: true,
      });
    expectVar({ labels }).toStrictEqual(["test", "eth"]);
    expectVar({ tokenId }).toEqual(idWithVersion(idFromLabel("test")));
    expectVar({ parentRegistry }).toEqual(registries[1]);
    expectVar({ exactRegistry }).toBeDefined();
    expectRegistries(registries, [
      exactRegistry,
      F.ethRegistry,
      F.rootRegistry,
    ]);
  });

  it("deployPermissionedResolver", async () => {
    const F = await loadFixture();
    await F.deployPermissionedResolver();
  });

  it("setupName() w/resolver", async () => {
    const F = await loadFixture();
    const resolver = await F.deployPermissionedResolver();
    const { parentRegistry, name } = await F.setupName({
      name: "test.eth",
      resolverAddress: resolver.address,
    });
    const resolverAddress = await parentRegistry.read.getResolver([
      getLabelAt(name),
    ]);
    expectVar({ resolverAddress }).toEqualAddress(resolver.address);
  });

  it("setupName() matches findRegistries()", async () => {
    const F = await loadFixture();
    const name = "a.b.c.d";
    const { registries } = await F.setupName({ name });
    const regs1 = registries.map((x) =>
      x ? getAddress(x.address) : zeroAddress,
    );
    const regs2 = await F.universalHelper.read.findRegistries([
      dnsEncodeName(name),
    ]);
    expect(regs1).toStrictEqual(regs2);
  });

  it("overlapping names", async () => {
    const F = await loadFixture();
    await F.setupName({ name: "test.eth" });
    await F.setupName({ name: "a.b.c.sub.test.eth" });
    await F.setupName({ name: "sub.test.eth" });
  });

  it("arbitrary names", async () => {
    const F = await loadFixture();
    await F.setupName({ name: "xyz" });
    await F.setupName({ name: "chonk.box" });
    await F.setupName({ name: "ens.domains" });
  });

  it("locked resolver", async () => {
    const F = await loadFixture();
    const { parentRegistry, tokenId } = await F.setupName({
      name: "locked.test.eth",
      roles: ROLES.ALL & ~ROLES.REGISTRY.SET_RESOLVER,
    });
    await parentRegistry.write.setSubregistry([tokenId, testAddress]);
    await expect(
      parentRegistry.write.setResolver([tokenId, testAddress]),
    ).toBeRevertedWithCustomError("EACUnauthorizedAccountRoles");
  });

  it("locked registry", async () => {
    const F = await loadFixture();
    const { parentRegistry, tokenId } = await F.setupName({
      name: "locked.test.eth",
      roles: ROLES.ALL & ~ROLES.REGISTRY.SET_SUBREGISTRY,
    });
    await parentRegistry.write.setResolver([tokenId, testAddress]);
    await expect(
      parentRegistry.write.setSubregistry([tokenId, testAddress]),
    ).toBeRevertedWithCustomError("EACUnauthorizedAccountRoles");
  });
});
