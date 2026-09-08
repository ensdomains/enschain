import { execute } from "@rocketh";
import type { Abi_UniversalResolver } from "generated/abis/UniversalResolver.js";
import { Artifact_UpgradableUniversalResolverProxy } from "generated/artifacts/UpgradableUniversalResolverProxy.js";
import { getAddress, zeroAddress } from "viem";

import {
  knownProxyNetworkName,
  loadKnownIntermediateUrpDeployment,
} from "../../script/universalResolverDeployUtils.js";

export default execute(
  async ({
    deploy,
    get,
    getV1,
    getOrNull,
    save,
    read,
    namedAccounts: { deployer, urManager },
    name,
    tags,
  }) => {
    if (tags.local) return true;

    if (
      getOrNull<(typeof Artifact_UpgradableUniversalResolverProxy)["abi"]>(
        "ManagedUniversalResolverProxy",
      )
    )
      return true;

    // Reuse a long-lived intermediate URP when one already fronts the top URP on
    // this network. A fresh v2 deployment then only re-points this proxy at the
    // new implementation, leaving the externally-administered top URP untouched.
    // A clean-testnet run is excluded: it builds a self-owned stack down to its
    // own top URP, so adopting the canonical proxy would leave the cutover
    // upgrading a live deployment's proxy under an admin it does not control.
    const knownIntermediate = tags["clean-testnet"]
      ? null
      : await loadKnownIntermediateUrpDeployment(
          knownProxyNetworkName(tags, name),
        );
    if (knownIntermediate) {
      await save("ManagedUniversalResolverProxy", knownIntermediate);
      return true;
    }

    // No pre-existing intermediate URP: deploy one seeded with whatever the top
    // proxy currently serves so that later switching the top proxy onto it is
    // transparent for resolution. Fall back to the v1 UniversalResolver only when
    // the top proxy implementation is unset.
    const topProxy = get<
      (typeof Artifact_UpgradableUniversalResolverProxy)["abi"]
    >("UpgradableUniversalResolverProxy");
    const topImplementation = await read(topProxy, {
      functionName: "implementation",
    });
    const seedImplementation =
      getAddress(topImplementation) !== getAddress(zeroAddress)
        ? topImplementation
        : (await getV1<Abi_UniversalResolver>("UniversalResolver")).address;

    await deploy("ManagedUniversalResolverProxy", {
      account: deployer,
      artifact: Artifact_UpgradableUniversalResolverProxy,
      args: [urManager ?? deployer, seedImplementation],
    });
    return true;
  },
  {
    id: "universal-resolver:deploy-managed-urp:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:phase1:deploy-v2",
      "ManagedUniversalResolverProxy",
      "v2",
    ],
    dependencies: ["UniversalResolverV1"],
  },
);
