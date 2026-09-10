import { execute } from "@rocketh";
import type { Abi_UpgradableUniversalResolverProxy } from "generated/abis/UpgradableUniversalResolverProxy.js";
import type { Abi_UniversalResolverV2 } from "generated/abis/UniversalResolverV2.js";
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
    const universalResolverV2 = get<Abi_UniversalResolverV2>(
      "UniversalResolverV2",
    );

    const ownerLabel = externalTopProxyOwnerLabel(tags);
    if (ownerLabel) {
      logUpgradeCalldata(
        "Set UniversalResolver implementation to UniversalResolverImplementation",
        topUrp.address,
        universalResolverV2.address,
        ownerLabel,
      );
      return true;
    }

    await setProxyImplementationIfNeeded({
      read,
      write,
      deployment: topUrp,
      implementation: universalResolverV2.address,
      account: owner,
      label: "UniversalResolver implementation",
    });
    return true;
  },
  {
    id: "universal-resolver:set-universal-resolver-to-universal-resolver-implementation:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:post-cutover:direct-urp-to-v2",
      "UniversalResolverToUniversalResolverImplementation",
      "v2",
    ],
    dependencies: [
      "ManagedUniversalResolverProxyToUniversalResolverImplementation",
    ],
  },
);
