import { execute } from "@rocketh";
import type { Abi } from "viem";
import type { Abi_DefaultReverseRegistrarAdapter } from "generated/abis/DefaultReverseRegistrarAdapter.js";
import type { Abi_ReverseRegistrarAdapter } from "generated/abis/ReverseRegistrarAdapter.js";
import type { Abi_IPermissionedResolver } from "generated/abis/IPermissionedResolver.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IVerifiableFactory } from "generated/abis/IVerifiableFactory.js";
import type { Abi_MockRegistrationIntentExecutor } from "generated/abis/MockRegistrationIntentExecutor.js";
import { Artifact_HCAOwnerAndSessionValidator } from "generated/artifacts/HCAOwnerAndSessionValidator.js";

import { RHINESTONE_GAS_REFUND_PAYMASTER } from "../../script/deploy-constants.js";
import {
  optionalEnvAddress,
  resolveHCAIntentExecutor,
  shouldDeployStandaloneHCA,
} from "./_helpers.js";

export default execute(
  async ({ deploy, get, getOrNull, namedAccounts: { deployer }, tags }) => {
    if (!shouldDeployStandaloneHCA(tags)) return;

    const defaultReverseRegistrarAdapter =
      get<Abi_DefaultReverseRegistrarAdapter>("DefaultReverseRegistrarAdapter");
    const reverseRegistrarAdapter = get<Abi_ReverseRegistrarAdapter>(
      "ReverseRegistrarAdapter",
    );
    const permittedResolverImpl = get<Abi_IPermissionedResolver>(
      "PermissionedResolverImpl",
    );
    const ethRegistry = get<Abi_IPermissionedRegistry>("ETHRegistry");
    const verifiableFactory = get<Abi_IVerifiableFactory>("VerifiableFactory");
    const localExecutor = getOrNull<Abi_MockRegistrationIntentExecutor>(
      "MockRegistrationIntentExecutor",
    );
    const existingExecutor = getOrNull<Abi>("IntentExecutor");
    const intentExecutor = resolveHCAIntentExecutor({
      tags,
      localExecutor: localExecutor?.address,
      existingExecutor: existingExecutor?.address,
    });
    if (!intentExecutor) {
      throw new Error(
        "HCA_INTENT_EXECUTOR must be set when no IntentExecutor deployment is available",
      );
    }
    const gasRefundPaymaster =
      optionalEnvAddress("HCA_GAS_REFUND_PAYMASTER") ??
      localExecutor?.address ??
      (tags.sepolia || tags.hasDao
        ? RHINESTONE_GAS_REFUND_PAYMASTER
        : intentExecutor);

    await deploy("HCAOwnerAndSessionValidator", {
      account: deployer,
      artifact: Artifact_HCAOwnerAndSessionValidator,
      args: [
        defaultReverseRegistrarAdapter.address,
        reverseRegistrarAdapter.address,
        permittedResolverImpl.address,
        ethRegistry.address,
        verifiableFactory.address,
        intentExecutor,
        gasRefundPaymaster,
      ],
    });
  },
  {
    tags: [
      "HCAOwnerAndSessionValidator",
      "StandaloneHCA",
      "hca",
      "migration:phase1:deploy-v2",
      "v2",
    ],
    dependencies: [
      "DefaultReverseRegistrarAdapter",
      "ReverseRegistrarAdapter",
      "PermissionedResolverImpl",
      "ETHRegistry",
      "VerifiableFactory",
      "MockRegistrationIntentExecutor",
    ],
  },
);
