import { execute } from "@rocketh";
import type { Abi_PublicResolver } from "generated/abis/PublicResolver.js";
import { Artifact_PermissionedAddressSet } from "generated/artifacts/PermissionedAddressSet.js";
import type { Address } from "viem";

export default execute(
  async ({
    deploy,
    execute: write,
    getV1,
    read,
    namedAccounts: { deployer, owner },
    name,
  }) => {
    const publicResolverSet = await deploy("PublicResolverSet", {
      account: deployer,
      artifact: Artifact_PermissionedAddressSet,
      args: [owner, false],
    });

    // The wrapper-aware v1 public resolvers whose locked names should be
    // re-pointed at the new v2 PublicResolver during migration. On mainnet these
    // are the historical PublicResolverV3/V4 deployments; elsewhere the single
    // resolved v1 PublicResolver covers the local/test deployment.
    const wrapperAwarePublicResolvers: Address[] =
      name === "mainnet"
        ? [
            "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63", // PublicResolverV3: https://etherscan.io/address/0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63
            "0xF29100983E058B709F3D539b0c765937B804AC15", // PublicResolverV4: https://etherscan.io/address/0xF29100983E058B709F3D539b0c765937B804AC15
          ]
        : [(await getV1<Abi_PublicResolver>("PublicResolver")).address];

    for (const addr of wrapperAwarePublicResolvers) {
      const approved = await read(publicResolverSet, {
        functionName: "includes",
        args: [addr],
      });
      if (approved) continue;

      await write(publicResolverSet, {
        account: owner,
        functionName: "approve",
        args: [addr, true],
      });
    }

    console.log("Wrapper-aware PublicResolvers:");
    console.table(wrapperAwarePublicResolvers);
  },
  {
    tags: ["PublicResolverSet", "v2"],
    dependencies: ["PublicResolver"],
  },
);
