import { execute } from "@rocketh";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_ENSV1Resolver } from "generated/abis/ENSV1Resolver.js";
import { zeroAddress, isAddressEqual } from "viem";
import { idFromLabel } from "../test/utils/utils.js";
import { DEPLOYMENT_ROLES, MAX_EXPIRY } from "../script/deploy-constants.js";

export default execute(
  async ({ execute: write, get, read, namedAccounts: { deployer, owner } }) => {
    const rootRegistry = get<Abi_IPermissionedRegistry>("RootRegistry");
    const ensV1Resolver = get<Abi_ENSV1Resolver>("ENSV1Resolver");

    // Phase-tagged scripts re-run on every `deploy-v2 --resume`, and
    // registering an existing name reverts, so only register when the name
    // is absent (same guard as the eth registration in 01_ETHRegistry).
    const currentStatus = await read(rootRegistry, {
      functionName: "getStatus",
      args: [idFromLabel("reverse")],
    });

    if (currentStatus === 0) {
      console.log("  - Registering reverse in root");
      await write(rootRegistry, {
        account: deployer,
        functionName: "register",
        args: [
          "reverse",
          owner,
          zeroAddress,
          ensV1Resolver.address,
          DEPLOYMENT_ROLES.REVERSE_REGISTRY_ROOT,
          MAX_EXPIRY,
        ],
      });
      return;
    }

    // A resume can redeploy ENSV1Resolver, leaving reverse pointing at the
    // old one; repoint it so reverse resolution follows the live resolver.
    const currentResolver = await read(rootRegistry, {
      functionName: "getResolver",
      args: ["reverse"],
    });

    if (isAddressEqual(currentResolver, ensV1Resolver.address)) return;

    console.log("  - Updating reverse resolver to current ENSV1Resolver");
    const tokenId = await read(rootRegistry, {
      functionName: "findTokenId",
      args: ["reverse"],
    });
    // setResolver comes from `owner` — the name owner holds the full
    // REVERSE_REGISTRY_ROOT bitmap; `deployer` only has registrar rights.
    await write(rootRegistry, {
      account: owner,
      functionName: "setResolver",
      args: [tokenId, ensV1Resolver.address],
    });
  },
  {
    // The phase1 tag is required for live rotations: `phase deploy-v2` runs
    // only `migration:phase1:deploy-v2` scripts, and this is the sole script
    // that registers reverse on the root.
    tags: ["ReverseMirror", "migration:phase1:deploy-v2", "v2"],
    dependencies: ["RootRegistry", "ENSV1Resolver"],
  },
);
