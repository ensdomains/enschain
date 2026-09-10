import { readFile } from "node:fs/promises";
import { normalize } from "viem/ens";

const CLAIMS = [
  "Ownable",
  "DelegatedContractNamer",
  "IContractNamer",
  "Constructor",
] as const;

export type ContractNameInfo = {
  deployment: string;
  name: string;
  claim?: (typeof CLAIMS)[number];
};

export async function getContractNames(): Promise<ContractNameInfo[]> {
  return JSON.parse(
    await readFile(new URL("../docs/contractNames.json", import.meta.url), {
      encoding: "utf8",
    }),
  ).map((json: any) => {
    try {
      if (typeof json !== "object") {
        throw new Error("not object");
      } else if (typeof json.deployment !== "string") {
        throw new Error("invalid deployment");
      } else if (normalize(json.name) !== json.name) {
        throw new Error("invalid name");
      } else if (
        typeof json.claim !== "undefined" &&
        !CLAIMS.includes(json.claim)
      ) {
        throw new Error("invalid method");
      }
      return json;
    } catch (cause) {
      throw new Error(`invalid contract name: ${JSON.stringify(json)}`, {
        cause,
      });
    }
  });
}

console.log(await getContractNames());

//   await setName("2to1.resolver", v2.ENSV1Resolver.address);
//   await setName("1to2.resolver", v2.ENSV2Resolver.address);
//   await setName("impl.resolver", v2.PermissionedResolverImpl.address);
//   await setName("universal", v2.UniversalResolver.address);
//   await setName("impl.universal", v2.UniversalResolver.address); // devnet doesn't deploy a proxy
//   await setName("helper", v2.UniversalHelper.address);
//   await setName("public.resolver", v2.PublicResolver.address);
//   await setName("dns.resolver", v2.DNSTLDResolver.address);

//   await setName("dnsname", v2.DNSTXTResolver.address); // remap v1 ExtendedDNSResolver
//   await setName("dnstxt", v2.DNSTXTResolver.address); // TODO: could just use "dnsname"?
//   await setName("dnsalias", v2.DNSAliasResolver.address);

//   await setName("registrar", v2.ETHRegistrar.address);
//   await setName("renewer", v2.ETHRenewerV1.address);
//   await setName("oracle", v2.StandardRentPriceOracle.address);
//   // await setName("batch.migration", v2.BatchRegistrar.address); // this is only used internally for premigration
//   await setName("addr.reverse", shared.ReverseRegistrarAdapter.address);
//   await setName(
//     "default.reverse",
//     shared.DefaultReverseRegistrarAdapter.address,
//   );

//   await setName(
//     "unlocked.migration",
//     v2.UnlockedMigrationController.address,
//   );
//   await setName("locked.migration", v2.LockedMigrationController.address);
//   await setName("graveyard", v2.Graveyard.address);
//   await setName("helper.migration", v2.MigrationHelper.address);
//   await setName("upgradeset.registry", v2.RegistryUpgradeSet.address);
//   await setName("prset.migration", v2.PublicResolverSet.address);

//   await setName("batch.gateways", shared.BatchGatewayProvider.address);
//   await setName("dnssec.gateways", shared.DNSSECGatewayProvider.address);
//   await setName("labelstore", v2.LabelStore.address);
//   await setName("verifiable-factory", v2.VerifiableFactory.address);
