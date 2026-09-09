import { execute } from "@rocketh";
import type { Abi_BaseRegistrarImplementation } from "generated/abis/BaseRegistrarImplementation.js";
import type { Abi_RegistrarSecurityController } from "generated/abis/RegistrarSecurityController.js";
import { Artifact_OwnedResolver } from "generated/artifacts/OwnedResolver.js";

// Deploys the .eth resolver and points the registrar at it before the bundled v1
// scripts reach their own copy of this step.
//
// Base registrar setup hands the registrar to the RegistrarSecurityController, so
// the bundled step's direct owner-signed `setResolver` reverts and leaves .eth with
// no resolver — which then silently skips every interface registration that writes
// to it. Routing the write through the controller's passthrough is the same change
// that step needs, made here so the bundled sources stay untouched. The bundled
// step returns as soon as its resolver deployment already exists, so seeding it
// here keeps the reverting call from ever being made.
export default execute(
  async ({
    deploy,
    get,
    getOrNull,
    execute: write,
    namedAccounts: { deployer, owner },
  }) => {
    const ethOwnedResolver = await deploy("OwnedResolver", {
      account: deployer,
      artifact: Artifact_OwnedResolver,
      args: [],
    });

    if (!ethOwnedResolver.newlyDeployed) return;

    if (owner !== deployer) {
      console.log(`  - Transferring ownership of OwnedResolver to ${owner}`);
      await write(ethOwnedResolver, {
        account: deployer,
        functionName: "transferOwnership",
        args: [owner],
      });
    }

    console.log(`  - Setting resolver for .eth to ${ethOwnedResolver.address}`);
    const registrarSecurityController =
      getOrNull<Abi_RegistrarSecurityController>("RegistrarSecurityController");
    if (registrarSecurityController) {
      await write(registrarSecurityController, {
        account: owner,
        functionName: "setRegistrarResolver",
        args: [ethOwnedResolver.address],
      });
      return;
    }

    // No security controller in this configuration, so the registrar is still
    // owned by the account that deployed it.
    const registrar = get<Abi_BaseRegistrarImplementation>(
      "BaseRegistrarImplementation",
    );
    await write(registrar, {
      account: owner,
      functionName: "setResolver",
      args: [ethOwnedResolver.address],
    });
  },
  {
    id: "EthOwnedResolverViaSecurityController v1.0.0",
    tags: ["category:resolvers", "OwnedResolver", "EthOwnedResolver"],
    dependencies: [
      "ENSRegistry",
      "BaseRegistrarImplementation",
      "RegistrarSecurityController",
    ],
  },
);
