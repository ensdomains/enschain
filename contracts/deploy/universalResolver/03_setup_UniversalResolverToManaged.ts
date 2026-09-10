import { execute } from "@rocketh";
import type { Abi_UpgradableUniversalResolverProxy } from "generated/abis/UpgradableUniversalResolverProxy.js";
import { getAddress } from "viem";

import {
  externalTopProxyOwnerLabel,
  logUpgradeCalldata,
  setProxyImplementationIfNeeded,
} from "../../script/universalResolverDeployUtils.js";

export default execute(
  async ({ get, execute: write, read, namedAccounts: { owner }, tags }) => {
    if (tags.local) return true;

    const topUrp = get<Abi_UpgradableUniversalResolverProxy>(
      "UpgradableUniversalResolverProxy",
    );
    const managedUrp = get<Abi_UpgradableUniversalResolverProxy>(
      "ManagedUniversalResolverProxy",
    );

    // When the top URP already fronts the intermediate URP (the reuse flow), the
    // switch is already done — never re-point the externally-administered top URP.
    const currentImplementation = await read(topUrp, {
      functionName: "implementation",
    });
    if (getAddress(currentImplementation) === getAddress(managedUrp.address)) {
      console.log(
        `UniversalResolver implementation: already ${managedUrp.address} (intermediate URP)`,
      );
      return true;
    }

    const ownerLabel = externalTopProxyOwnerLabel(tags);
    if (ownerLabel) {
      logUpgradeCalldata(
        "Set UniversalResolver implementation to ManagedUniversalResolverProxy",
        topUrp.address,
        managedUrp.address,
        ownerLabel,
      );
      return true;
    }

    await setProxyImplementationIfNeeded({
      read,
      write,
      deployment: topUrp,
      implementation: managedUrp.address,
      account: owner,
      label: "UniversalResolver implementation",
    });
    return true;
  },
  {
    id: "universal-resolver:set-universal-resolver-to-managed:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:phase5:switch-urp-to-managed",
      "UniversalResolverManaged",
      "v2",
    ],
    dependencies: ["ManagedUniversalResolverProxy"],
  },
);
