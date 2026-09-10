import { execute } from "@rocketh";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IGatewayProvider } from "generated/abis/IGatewayProvider.js";
import type { Abi_RegistrarSecurityController } from "generated/abis/RegistrarSecurityController.js";
import type { Abi_BaseRegistrarImplementation } from "generated/abis/BaseRegistrarImplementation.js";
import type { Abi_OwnedResolver } from "generated/abis/OwnedResolver.js";
import type { Abi_ENS } from "generated/abis/ENS.js";
import { Artifact_ENSV2Resolver } from "generated/artifacts/ENSV2Resolver.js";
import { getAddress, namehash, zeroAddress } from "viem";

export default execute(
  async ({
    get,
    getOrNull,
    getV1,
    deploy,
    execute: write,
    read,
    namedAccounts: { deployer, owner, v1Owner },
  }) => {
    const batchGatewayProvider = await getV1<Abi_IGatewayProvider>(
      "BatchGatewayProvider",
    );
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");
    const rootRegistry = get<Abi_IPermissionedRegistry>("RootRegistry");
    const ensRegistry = await getV1<Abi_ENS>("ENSRegistry");
    const registrarSecurityController =
      await getV1<Abi_RegistrarSecurityController>(
        "RegistrarSecurityController",
      ).catch(() => {});

    console.log("Deploying ENSV2Resolver");
    console.log("  - Getting ENSv1 .eth resolver");
    const currentResolver = await read(ensRegistry, {
      functionName: "resolver",
      args: [namehash("eth")],
    });
    const ethResolver =
      getAddress(currentResolver) === getAddress(zeroAddress)
        ? await getV1<Abi_OwnedResolver>("OwnedResolver")
            .then((deployment) => deployment.address)
            .catch(() => currentResolver)
        : currentResolver;
    console.log(`  - Got: ${ethResolver}`);

    const existingEnsV2Resolver =
      getOrNull<(typeof Artifact_ENSV2Resolver)["abi"]>("ENSV2Resolver");
    const ensV2Resolver =
      existingEnsV2Resolver ??
      (await deploy("ENSV2Resolver", {
        account: deployer,
        artifact: Artifact_ENSV2Resolver,
        args: [
          batchGatewayProvider.address,
          contractNamer.address,
          rootRegistry.address,
          ethResolver,
        ],
      }));

    if (getAddress(currentResolver) === getAddress(ensV2Resolver.address)) {
      return;
    }

    console.log("  - Setting ENSv1 .eth resolver to ENSV2Resolver");
    if (registrarSecurityController) {
      await write(registrarSecurityController, {
        account: v1Owner ?? owner,
        functionName: "setRegistrarResolver",
        args: [ensV2Resolver.address],
      });
    } else {
      const baseRegistrar = await getV1<Abi_BaseRegistrarImplementation>(
        "BaseRegistrarImplementation",
      );
      await write(baseRegistrar, {
        account: v1Owner ?? owner,
        functionName: "setResolver",
        args: [ensV2Resolver.address],
      });
    }
  },
  {
    tags: ["ENSV2Resolver", "migration:phase1:deploy-v2", "v2"],
    dependencies: [
      "BatchGatewayProvider",
      "ContractNamer",
      "RootRegistry",
      "EthOwnedResolver", // BaseRegistrarImplementation:setup => eventually setup as OwnedResolver
      "RegistrarSecurityController",
    ],
  },
);
