import type { ReadFunction } from "@rocketh/read-execute";
import { getAddress, zeroAddress, type Address } from "viem";
import { Artifact_ENSV2Resolver } from "generated/artifacts/ENSV2Resolver.js";

// Walks a chain of ENSv2 mirror resolvers back to the ENSv1 resolver underneath.
//
// A redeployment finds "eth" already pointing at the mirror resolver an earlier
// deployment installed. Wiring that address in as the ENSv1 override would resolve
// "eth" through the registry the superseded deployment mirrors, so each mirror is
// followed to the resolver it was itself built over. Exposing both mirror
// immutables is what marks a link in the chain; anything else ends the walk and is
// returned as the ENSv1 resolver. A chain that closes on itself or bottoms out
// unset yields the zero address, which the caller reads as "none installed".
export async function unwindMirrorResolvers(
  read: ReadFunction,
  start: Address,
): Promise<Address> {
  const visited = new Set<Address>();
  let resolver = start;
  while (getAddress(resolver) !== getAddress(zeroAddress)) {
    const address = getAddress(resolver);
    if (visited.has(address)) return zeroAddress;
    visited.add(address);
    const mirror = { address, abi: Artifact_ENSV2Resolver.abi };
    const next = await Promise.all([
      read(mirror, { functionName: "ROOT_REGISTRY" }),
      read(mirror, { functionName: "ETH_RESOLVER" }),
    ])
      .then(([, ethResolver]) => ethResolver)
      .catch(() => undefined);
    if (next === undefined) return resolver;
    resolver = next;
  }
  return zeroAddress;
}
