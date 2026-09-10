import { execute } from "@rocketh";
import type { Abi_ENS } from "generated/abis/ENS.js";
import type { Abi_OffchainDNSResolver } from "generated/abis/OffchainDNSResolver.js";
import type { Abi_SimplePublicSuffixList } from "generated/abis/SimplePublicSuffixList.js";
import type { Abi_DNSSECImpl } from "generated/abis/DNSSECImpl.js";
import type { Abi_IPermissionedRegistry } from "generated/abis/IPermissionedRegistry.js";
import type { Abi_IGatewayProvider } from "generated/abis/IGatewayProvider.js";
import type { Abi_IContractNamer } from "generated/abis/IContractNamer.js";
import { Artifact_DNSTLDResolver } from "generated/artifacts/DNSTLDResolver.js";
import { Artifact_BatchRegistrar } from "generated/artifacts/BatchRegistrar.js";
import {
  fetchPublicSuffixes,
  filterAvailableSuffixes,
  registerSuffixesViaBatchRegistrar,
} from "../script/publicSuffixes.js";

export default execute(
  async ({
    deploy,
    execute: write,
    get,
    getV1,
    read,
    namedAccounts: { deployer },
    tags,
  }) => {
    const ensRegistry = await getV1<Abi_ENS>("ENSRegistry");
    const dnsTLDResolverV1 = await getV1<Abi_OffchainDNSResolver>(
      "OffchainDNSResolver",
    );
    const publicSuffixList = await getV1<Abi_SimplePublicSuffixList>(
      "SimplePublicSuffixList",
    );
    const rootRegistry = get<Abi_IPermissionedRegistry>("RootRegistry");
    const dnssecOracle = await getV1<Abi_DNSSECImpl>("DNSSECImpl");
    const batchGatewayProvider = await getV1<Abi_IGatewayProvider>(
      "BatchGatewayProvider",
    );
    const dnssecGatewayProvider = get<Abi_IGatewayProvider>(
      "DNSSECGatewayProvider",
    );
    const contractNamer = get<Abi_IContractNamer>("ContractNamer");

    const dnsTLDResolver = await deploy("DNSTLDResolver", {
      account: deployer,
      artifact: Artifact_DNSTLDResolver,
      args: [
        ensRegistry.address,
        dnsTLDResolverV1.address,
        rootRegistry.address,
        dnssecOracle.address,
        dnssecGatewayProvider.address,
        batchGatewayProvider.address,
        contractNamer.address,
      ],
    });

    const allSuffixes = tags.local
      ? ["com", "org", "net", "xyz"]
      : await fetchPublicSuffixes();

    const publicTLDs = await filterAvailableSuffixes({
      read,
      publicSuffixList,
      rootRegistry,
      candidates: allSuffixes.filter((x) => !x.includes(".")), // only TLDs
    });

    if (!publicTLDs.length) {
      console.warn("  - No public DNS TLDs found");
      return;
    }

    const batchRegistrar = await deploy("RootBatchRegistrar", {
      account: deployer,
      artifact: Artifact_BatchRegistrar,
      args: [rootRegistry.address, deployer],
    });

    await registerSuffixesViaBatchRegistrar({
      write,
      account: deployer,
      rootRegistry,
      batchRegistrar,
      resolver: dnsTLDResolver.address,
      suffixes: publicTLDs,
    });
  },
  {
    tags: ["DNSTLDResolver", "v2", "migration:phase1:deploy-v2"],
    dependencies: [
      "RootRegistry",
      "ENSRegistry",
      "DNSSECImpl",
      "OffchainDNSResolver",
      "SimplePublicSuffixList",
      "BatchGatewayProvider",
      "DNSSECGatewayProvider",
      "ContractNamer",
    ],
  },
);
