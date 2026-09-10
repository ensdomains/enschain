import { execute } from "@rocketh";
import type { Abi_BaseRegistrarImplementation } from "generated/abis/BaseRegistrarImplementation.js";
import type { Abi_ENS } from "generated/abis/ENS.js";
import type { Abi_ReverseRegistrar } from "generated/abis/ReverseRegistrar.js";
import type { Abi_DefaultReverseRegistrar } from "generated/abis/DefaultReverseRegistrar.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_ENSV1Resolver } from "generated/abis/ENSV1Resolver.js";
import type { Abi_RegistrarSecurityController } from "generated/abis/RegistrarSecurityController.js";
import { Artifact_TestnetV1PremigrationRegistrar } from "generated/artifacts/TestnetV1PremigrationRegistrar.js";
import { zeroAddress } from "viem";
import { ROLES } from "../../script/deploy-constants.js";

const PREMIGRATION_ROLE_BITMAP =
  ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW;

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    getV1,
    namedAccounts: { deployer, owner, v1Owner },
    network,
    read,
    tags,
  }) => {
    if (
      network.chain.id === 1 ||
      (!tags.tenderly && !tags["testnet-premigration-registrar"])
    )
      return;

    const baseRegistrar = await getV1<Abi_BaseRegistrarImplementation>(
      "BaseRegistrarImplementation",
    );
    const ensRegistry = await getV1<Abi_ENS>("ENSRegistry");
    const reverseRegistrar =
      await getV1<Abi_ReverseRegistrar>("ReverseRegistrar");
    const defaultReverseRegistrar = await getV1<Abi_DefaultReverseRegistrar>(
      "DefaultReverseRegistrar",
    );
    const ethRegistry = get<Abi_IPermissionedRegistry>("ETHRegistry");
    const ensV1Resolver = get<Abi_ENSV1Resolver>("ENSV1Resolver");

    const registrar = await deploy("TestnetV1PremigrationRegistrar", {
      account: deployer,
      artifact: Artifact_TestnetV1PremigrationRegistrar,
      args: [
        baseRegistrar.address,
        ensRegistry.address,
        reverseRegistrar.address,
        defaultReverseRegistrar.address,
        ethRegistry.address,
        zeroAddress,
        ensV1Resolver.address,
      ],
    });

    const hasPremigrationRoles = await read(ethRegistry, {
      functionName: "hasRootRoles",
      args: [PREMIGRATION_ROLE_BITMAP, registrar.address],
    });
    if (!hasPremigrationRoles) {
      await write(ethRegistry, {
        account: deployer,
        functionName: "grantRootRoles",
        args: [PREMIGRATION_ROLE_BITMAP, registrar.address],
      });
    }

    // register() calls BASE.register(), so the registrar must also be an
    // ENSv1 registrar controller; that grant is a v1-owner transaction
    // (deferred on phased deploys via deferV1OwnerTransactions)
    const isV1Controller = await read(baseRegistrar, {
      functionName: "controllers",
      args: [registrar.address],
    });
    if (!isV1Controller) {
      console.log("  - Adding as ENSv1 registrar controller");
      const registrarSecurityController =
        await getV1<Abi_RegistrarSecurityController>(
          "RegistrarSecurityController",
        ).catch(() => {});
      if (registrarSecurityController) {
        await write(registrarSecurityController, {
          account: v1Owner ?? owner,
          functionName: "addRegistrarController",
          args: [registrar.address],
        });
      } else {
        await write(baseRegistrar, {
          account: v1Owner ?? owner,
          functionName: "addController",
          args: [registrar.address],
        });
      }
    }

    // register() sets reverse records on behalf of the registrant, so the registrar
    // must also be a controller of the reverse registrars; these are v1-owner
    // transactions (deferred on phased deploys via deferV1OwnerTransactions)
    const isReverseController = await read(reverseRegistrar, {
      functionName: "controllers",
      args: [registrar.address],
    });
    if (!isReverseController) {
      await write(reverseRegistrar, {
        account: v1Owner ?? owner,
        functionName: "setController",
        args: [registrar.address, true],
      });
    }

    const isDefaultReverseController = await read(defaultReverseRegistrar, {
      functionName: "controllers",
      args: [registrar.address],
    });
    if (!isDefaultReverseController) {
      await write(defaultReverseRegistrar, {
        account: v1Owner ?? owner,
        functionName: "setController",
        args: [registrar.address, true],
      });
    }
  },
  {
    tags: [
      "TestnetV1PremigrationRegistrar",
      "migration:phase1:deploy-v2",
      "migration:testnet:v1-premigration-registrar",
      "testnet",
    ],
    dependencies: ["ETHRegistry", "ENSV1Resolver"],
  },
);
