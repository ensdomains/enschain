import { execute } from "@rocketh";
import type { Abi_UniversalResolver } from "generated/abis/UniversalResolver.js";
import type { Abi_UpgradableUniversalResolverProxy } from "generated/abis/UpgradableUniversalResolverProxy.js";
import { getAddress, zeroAddress } from "viem";

import {
  externalTopProxyOwnerLabel,
  logUpgradeCalldata,
  setProxyImplementationIfNeeded,
} from "../../script/universalResolverDeployUtils.js";

export default execute(
  async ({
    get,
    getV1,
    execute: write,
    read,
    namedAccounts: { owner },
    tags,
  }) => {
    if (tags.local) return true;

    const topUrp = get<Abi_UpgradableUniversalResolverProxy>(
      "UpgradableUniversalResolverProxy",
    );

    // Only a freshly bootstrapped top URP with an unset implementation needs
    // initializing to v1. An adopted top URP already serves either v1 or the
    // intermediate URP and must never be re-pointed here.
    const currentImplementation = (await read(topUrp, {
      functionName: "implementation",
    })) as `0x${string}`;
    if (getAddress(currentImplementation) !== getAddress(zeroAddress)) {
      console.log(
        `UniversalResolver implementation: already ${currentImplementation}`,
      );
      return true;
    }

    const v1UniversalResolver =
      await getV1<Abi_UniversalResolver>("UniversalResolver");

    const ownerLabel = externalTopProxyOwnerLabel(tags);
    if (ownerLabel) {
      logUpgradeCalldata(
        "Set UniversalResolver implementation to v1 UniversalResolver",
        topUrp.address,
        v1UniversalResolver.address,
        ownerLabel,
      );
      return true;
    }

    await setProxyImplementationIfNeeded({
      read,
      write,
      deployment: topUrp,
      implementation: v1UniversalResolver.address,
      account: owner,
      label: "UniversalResolver implementation",
    });
    return true;
  },
  {
    id: "universal-resolver:set-universal-resolver-to-v1:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:phase1:deploy-v2",
      "UniversalResolverV1",
      "v2",
    ],
    dependencies: ["UniversalResolver"],
  },
);
