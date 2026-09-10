import { execute } from "@rocketh";
import type { Abi_UpgradableUniversalResolverProxy } from "generated/abis/UpgradableUniversalResolverProxy.js";
import type { Abi_UniversalResolverV2 } from "generated/abis/UniversalResolverV2.js";
import {
  logUpgradeCalldata,
  setProxyImplementationIfNeeded,
} from "../../script/universalResolverDeployUtils.js";

export default execute(
  async ({
    get,
    execute: write,
    read,
    namedAccounts: { deployer, urManager },
    tags,
  }) => {
    if (tags.local) return true;

    const managedUrp = get<Abi_UpgradableUniversalResolverProxy>(
      "ManagedUniversalResolverProxy",
    );
    const universalResolverV2 = get<Abi_UniversalResolverV2>(
      "UniversalResolverV2",
    );

    if (tags.hasDao) {
      logUpgradeCalldata(
        "Set ManagedUniversalResolverProxy implementation to UniversalResolverImplementation",
        managedUrp.address,
        universalResolverV2.address,
      );
      return true;
    }

    await setProxyImplementationIfNeeded({
      read,
      write,
      deployment: managedUrp,
      implementation: universalResolverV2.address,
      account: urManager ?? deployer,
      label: "ManagedUniversalResolverProxy implementation",
    });
    return true;
  },
  {
    id: "universal-resolver:set-managed-urp-to-universal-resolver-implementation:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:phase6:upgrade-managed-urp",
      "ManagedUniversalResolverProxyToUniversalResolverImplementation",
      "v2",
    ],
    dependencies: [
      "UniversalResolverImplementation",
      "ManagedUniversalResolverProxy",
    ],
  },
);
