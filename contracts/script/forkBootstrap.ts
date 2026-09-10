import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { type Address, parseEther } from "viem";
import { RegistrarOwnership } from "./abis.js";

// v1 contracts on canonical mainnet that v2 deploys and `setup.ts` reference
// by name through rocketh's `get()`. Pre-populated into the devnet deployments
// dir so `get(name)` resolves to the canonical address without redeploying.
const V1_DEPLOYMENT_NAMES = [
  "ENSRegistry",
  "Root",
  "BaseRegistrarImplementation",
  "NameWrapper",
  "RegistrarSecurityController",
  "ETHRegistrarController",
  "WrappedETHRegistrarController",
  "PublicResolver",
  "UniversalResolver",
  "OffchainDNSResolver",
  "SimplePublicSuffixList",
  "DNSSECImpl",
  "ReverseRegistrar",
  "DefaultReverseRegistrar",
  "DefaultReverseResolver",
  "BatchGatewayProvider",
] as const;

// Canonical contracts whose `.owner()` issues writes during the v2 deploy or
// activation flow. Read live so that future ownership changes on mainnet are
// picked up without code changes.
const V1_OWNABLE_NAMES = [
  "BaseRegistrarImplementation",
  "NameWrapper",
  "ReverseRegistrar",
  "DefaultReverseRegistrar",
  "RegistrarSecurityController",
] as const;

// ENS DAO multisig — mapped to the `owner` named account on chainId 1 via
// Rocketh config. Included unconditionally so that even if a future ownership
// transfer hasn't fully propagated, the DAO address is still funded.
export const ENS_DAO_MULTISIG: Address =
  "0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7";

// Original ETHRegistrarController deployed at mainnet block 9380471. Still
// authorised on `BaseRegistrarImplementation.controllers` on canonical
// mainnet, so `activateV2` must explicitly revoke it. The address is
// hard-coded because `lib/ens-contracts/deployments/mainnet/` does not ship
// a rocketh artifact for it (the canonical deploy scripts wire it in only
// for the synthetic devnet); the ABI is recovered from the archive sibling.
const LEGACY_ETH_REGISTRAR_CONTROLLER_ADDRESS: Address =
  "0x283Af0B28c62C092C9727F1Ee09c02CA627EB7F5";
const LEGACY_ETH_REGISTRAR_CONTROLLER_ARCHIVE = join(
  "..",
  "archive",
  "ETHRegistrarController_mainnet_9380471.sol",
  "ETHRegistrarController_mainnet_9380471.json",
);

const OWNER_ABI = RegistrarOwnership.owner;

type ClientLike = {
  readContract: (args: {
    address: Address;
    abi: typeof OWNER_ABI;
    functionName: "owner";
  }) => Promise<unknown>;
  setBalance: (args: { address: Address; value: bigint }) => Promise<void>;
};

export async function bootstrapForkDeployments({
  client,
  deploymentsDir,
  canonicalDir,
  chainId,
}: {
  client: ClientLike;
  deploymentsDir: string;
  canonicalDir: string;
  chainId: number;
}) {
  await mkdir(deploymentsDir, { recursive: true });

  for (const name of V1_DEPLOYMENT_NAMES) {
    const src = JSON.parse(
      await readFile(join(canonicalDir, `${name}.json`), "utf8"),
    );
    const dst = { address: src.address, abi: src.abi };
    await writeFile(
      join(deploymentsDir, `${name}.json`),
      JSON.stringify(dst, null, 2),
    );
  }

  // Synthesise the LegacyETHRegistrarController rocketh artifact from the
  // hard-coded mainnet address + the archive ABI, so `rocketh.get(...)` in
  // `setup.ts` resolves to the live contract during fork-mode activateV2.
  const legacyArchive = JSON.parse(
    await readFile(
      join(canonicalDir, LEGACY_ETH_REGISTRAR_CONTROLLER_ARCHIVE),
      "utf8",
    ),
  );
  await writeFile(
    join(deploymentsDir, "LegacyETHRegistrarController.json"),
    JSON.stringify(
      {
        address: LEGACY_ETH_REGISTRAR_CONTROLLER_ADDRESS,
        abi: legacyArchive.abi,
      },
      null,
      2,
    ),
  );

  // Mirror the canonical `.chain` so rocketh's chainId/genesisHash checks pass
  // against the live forked node (which exposes the upstream genesis at block
  // 0). rocketh stores chainId as a string and compares it strictly.
  await copyFile(join(canonicalDir, ".chain"), join(deploymentsDir, ".chain"));

  // sanity: bail loudly if the canonical chainId disagrees with the live one
  const liveChainHeader = JSON.parse(
    await readFile(join(deploymentsDir, ".chain"), "utf8"),
  );
  if (String(liveChainHeader.chainId) !== String(chainId)) {
    throw new Error(
      `canonical .chain chainId=${liveChainHeader.chainId} does not match live chainId=${chainId}`,
    );
  }

  const ownerAddrs = new Set<Address>([ENS_DAO_MULTISIG]);
  for (const name of V1_OWNABLE_NAMES) {
    const src = JSON.parse(
      await readFile(join(canonicalDir, `${name}.json`), "utf8"),
    );
    try {
      const addr = (await client.readContract({
        address: src.address as Address,
        abi: OWNER_ABI,
        functionName: "owner",
      })) as Address;
      ownerAddrs.add(addr);
    } catch {
      // contract doesn't expose owner(); skip
    }
  }

  const fundWei = parseEther("10000");
  for (const addr of ownerAddrs) {
    await client.setBalance({ address: addr, value: fundWei });
  }
}
