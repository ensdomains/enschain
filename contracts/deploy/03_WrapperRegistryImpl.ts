import { execute } from "@rocketh";
import type { Abi_INameWrapper } from "generated/abis/INameWrapper.js";
import type { Abi_Graveyard } from "generated/abis/Graveyard.js";
import type { Abi_IVerifiableFactory } from "generated/abis/IVerifiableFactory.js";
import type { Abi_ENSV1Resolver } from "generated/abis/ENSV1Resolver.js";
import type { Abi_ILabelStore } from "generated/abis/ILabelStore.js";
import type { Abi_IAddressSet } from "generated/abis/IAddressSet.js";
import type { Abi_PublicResolverV2 } from "generated/abis/PublicResolverV2.js";
import { Artifact_WrapperRegistry } from "generated/artifacts/WrapperRegistry.js";

export default execute(
  async ({ deploy, get, getV1, namedAccounts: { deployer, owner } }) => {
    const nameWrapper = await getV1<Abi_INameWrapper>("NameWrapper");
    const graveyard = get<Abi_Graveyard>("Graveyard");
    const verifiableFactory = get<Abi_IVerifiableFactory>("VerifiableFactory");
    const ensV1Resolver = get<Abi_ENSV1Resolver>("ENSV1Resolver");
    const labelStore = get<Abi_ILabelStore>("LabelStore");
    const registryUpgradeSet = get<Abi_IAddressSet>("RegistryUpgradeSet");
    const publicResolverSet = get<Abi_IAddressSet>("PublicResolverSet");
    const publicResolverV2 = get<Abi_PublicResolverV2>("PublicResolverV2");

    await deploy("WrapperRegistryImpl", {
      account: deployer,
      artifact: Artifact_WrapperRegistry,
      args: [
        nameWrapper.address,
        graveyard.address,
        verifiableFactory.address,
        ensV1Resolver.address,
        registryUpgradeSet.address,
        labelStore.address,
        publicResolverSet.address,
        publicResolverV2.address,
        owner,
      ],
    });
  },
  {
    tags: ["WrapperRegistryImpl", "migration:phase1:deploy-v2", "v2"],
    dependencies: [
      "NameWrapper",
      "Graveyard",
      "VerifiableFactory",
      "ENSV1Resolver",
      "RegistryUpgradeSet",
      "LabelStore",
      "PublicResolverSet",
      "PublicResolverV2",
    ],
  },
);
