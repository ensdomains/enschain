import { execute } from "@rocketh";
import type { Abi_UniversalResolver } from "generated/abis/UniversalResolver.js";
import { Artifact_UpgradableUniversalResolverProxy } from "generated/artifacts/UpgradableUniversalResolverProxy.js";
import {
  isDeployedTopProxy,
  knownProxyNetworkName,
  loadKnownTopProxyDeployment,
} from "../../script/universalResolverDeployUtils.js";

export default execute(
  async ({
    deploy,
    getV1,
    getOrNull,
    save,
    namedAccounts: { deployer, owner },
    name,
    tags,
  }) => {
    if (tags.local) return true;

    // A clean-testnet run builds a self-owned stack from scratch (including its
    // own v1), so it deploys its own top URP it can administer.
    if (tags["clean-testnet"]) {
      const v1UniversalResolver =
        await getV1<Abi_UniversalResolver>("UniversalResolver");
      await deploy("UpgradableUniversalResolverProxy", {
        account: deployer,
        artifact: Artifact_UpgradableUniversalResolverProxy,
        args: [owner, v1UniversalResolver.address],
      });
      return true;
    }

    // Otherwise the top URP is a pre-existing, long-lived deployment: adopt the
    // canonical address for the network. Deploying a fresh top URP is no longer
    // supported here — the migration reuses the existing one.
    const currentDeployment = getOrNull<
      (typeof Artifact_UpgradableUniversalResolverProxy)["abi"]
    >("UpgradableUniversalResolverProxy");
    const currentTopProxyDeployment =
      currentDeployment && isDeployedTopProxy(currentDeployment)
        ? currentDeployment
        : null;
    const knownProxyNetwork = knownProxyNetworkName(tags, name);
    const knownTopProxyDeployment =
      await loadKnownTopProxyDeployment(knownProxyNetwork);
    const topProxyDeployment =
      currentTopProxyDeployment ?? knownTopProxyDeployment;

    if (!topProxyDeployment) {
      throw new Error(
        `No known top URP for network "${knownProxyNetwork}". A pre-existing top URP is required; deploying a fresh top URP is not supported (re-add the create3 deploy to bootstrap a new network).`,
      );
    }

    if (!currentTopProxyDeployment) {
      await save("UpgradableUniversalResolverProxy", topProxyDeployment);
    }
    return true;
  },
  {
    id: "universal-resolver:deploy-universal-resolver:v1",
    tags: [
      "UniversalResolverMigration",
      "migration:phase1:deploy-v2",
      "UniversalResolver",
      "UpgradableUniversalResolverProxy",
      "v2",
    ],
  },
);
