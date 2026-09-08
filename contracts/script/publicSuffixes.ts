import { labelhash, zeroAddress, type Abi, type Address } from "viem";
import { dnsEncodeName } from "../test/utils/utils.js";
import { MAX_EXPIRY, ROLES, STATUS } from "./deploy-constants.js";

export const SUFFIX_BATCH_SIZE = 25;

const BATCH_REGISTRAR_ROLE_BITMAP =
  ROLES.REGISTRY.REGISTRAR | ROLES.REGISTRY.RENEW;

type DeploymentLike<TAbi extends Abi = Abi> = {
  address: Address;
  abi: TAbi;
};

export async function fetchPublicSuffixes() {
  const res = await fetch(
    "https://publicsuffix.org/list/public_suffix_list.dat",
    { headers: { Connection: "close" } },
  );
  if (!res.ok) throw new Error(`expected suffixes: ${res.status}`);
  return (await res.text())
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("//"));
}

// Filters candidates down to the suffixes that are on the v1 public suffix
// list and still available on the root registry, reading SUFFIX_BATCH_SIZE
// candidates at a time.
export async function filterAvailableSuffixes({
  read,
  publicSuffixList,
  rootRegistry,
  candidates,
}: {
  read: any;
  publicSuffixList: DeploymentLike;
  rootRegistry: DeploymentLike;
  candidates: string[];
}): Promise<string[]> {
  const suffixes: string[] = [];
  for (let i = 0; i < candidates.length; i += SUFFIX_BATCH_SIZE) {
    const batch = candidates.slice(i, i + SUFFIX_BATCH_SIZE);
    const available = await Promise.all(
      batch.map(async (suffix) => {
        const isPublicSuffix = await read(publicSuffixList, {
          functionName: "isPublicSuffix",
          args: [dnsEncodeName(suffix)],
        });
        if (!isPublicSuffix) return "";
        const status = await read(rootRegistry, {
          functionName: "getStatus",
          args: [BigInt(labelhash(suffix))],
        });
        return status === STATUS.AVAILABLE ? suffix : "";
      }),
    );
    suffixes.push(...available.filter(Boolean));
  }
  return suffixes;
}

// Grants REGISTRAR|RENEW root roles to the batch registrar, registers the
// suffixes SUFFIX_BATCH_SIZE at a time against the given resolver, then
// revokes the roles again.
export async function registerSuffixesViaBatchRegistrar({
  write,
  account,
  rootRegistry,
  batchRegistrar,
  resolver,
  suffixes,
}: {
  write: any;
  account: Address;
  rootRegistry: DeploymentLike;
  batchRegistrar: DeploymentLike;
  resolver: Address;
  suffixes: string[];
}) {
  await write(rootRegistry, {
    account,
    functionName: "grantRootRoles",
    args: [BATCH_REGISTRAR_ROLE_BITMAP, batchRegistrar.address],
  });

  try {
    for (let i = 0; i < suffixes.length; i += SUFFIX_BATCH_SIZE) {
      const batch = suffixes.slice(i, i + SUFFIX_BATCH_SIZE);
      const progress = Math.min(i + SUFFIX_BATCH_SIZE, suffixes.length);
      console.log(
        `  - Registering ${batch.length} suffixes (${progress}/${suffixes.length})`,
      );
      await write(batchRegistrar, {
        account,
        functionName: "batchRegister",
        args: [
          zeroAddress,
          resolver,
          batch,
          new Array(batch.length).fill(MAX_EXPIRY),
        ],
      });
    }
  } finally {
    // Always revoke the temporary roles, even if a batch reverts partway, so the
    // batch registrar is never left holding registrar permissions on the root.
    await write(rootRegistry, {
      account,
      functionName: "revokeRootRoles",
      args: [BATCH_REGISTRAR_ROLE_BITMAP, batchRegistrar.address],
    });
  }
}
