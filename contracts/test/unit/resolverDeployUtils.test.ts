import { describe, expect, it } from "bun:test";
import type { ReadFunction } from "@rocketh/read-execute";
import { getAddress, zeroAddress, type Address } from "viem";

import { unwindMirrorResolvers } from "../../script/resolverDeployUtils.js";

const address = (nibble: string): Address =>
  getAddress(`0x${nibble.repeat(40)}`);

const V1_RESOLVER = address("1");
const MIRROR_A = address("a");
const MIRROR_B = address("b");
const ROOT_REGISTRY = address("2");

// Stands in for the chain: addresses listed as mirrors answer both immutable
// getters, and every other address reverts the way a plain ENSv1 resolver does.
const readerFor = (mirrors: Record<Address, Address>): ReadFunction =>
  (async (deployment: { address: Address }, args: { functionName: string }) => {
    const ethResolver = mirrors[getAddress(deployment.address)];
    if (ethResolver === undefined) {
      throw new Error(`no function ${args.functionName}`);
    }
    return args.functionName === "ROOT_REGISTRY" ? ROOT_REGISTRY : ethResolver;
  }) as unknown as ReadFunction;

describe("unwindMirrorResolvers", () => {
  it("returns a plain ENSv1 resolver untouched", async () => {
    const read = readerFor({});
    expect(await unwindMirrorResolvers(read, V1_RESOLVER)).toBe(V1_RESOLVER);
  });

  it("returns the zero address unchanged", async () => {
    const read = readerFor({});
    expect(await unwindMirrorResolvers(read, zeroAddress)).toBe(zeroAddress);
  });

  it("unwinds one mirror to the resolver it was built over", async () => {
    const read = readerFor({ [MIRROR_A]: V1_RESOLVER });
    expect(await unwindMirrorResolvers(read, MIRROR_A)).toBe(V1_RESOLVER);
  });

  it("unwinds a chain of mirrors left by successive redeployments", async () => {
    const read = readerFor({
      [MIRROR_B]: MIRROR_A,
      [MIRROR_A]: V1_RESOLVER,
    });
    expect(await unwindMirrorResolvers(read, MIRROR_B)).toBe(V1_RESOLVER);
  });

  it("reports no ENSv1 resolver when a mirror was deployed without one", async () => {
    const read = readerFor({ [MIRROR_A]: zeroAddress });
    expect(await unwindMirrorResolvers(read, MIRROR_A)).toBe(zeroAddress);
  });

  it("reports no ENSv1 resolver when the chain closes on itself", async () => {
    const read = readerFor({
      [MIRROR_A]: MIRROR_B,
      [MIRROR_B]: MIRROR_A,
    });
    expect(await unwindMirrorResolvers(read, MIRROR_A)).toBe(zeroAddress);
  });
});
