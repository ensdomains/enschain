import { Artifact_BaseRegistrarImplementation } from "generated/artifacts/BaseRegistrarImplementation.js";
import { Artifact_ENSRegistry } from "generated/artifacts/ENSRegistry.js";
import { Artifact_ETHRegistrarController } from "generated/artifacts/ETHRegistrarController.js";
import { Artifact_ETHRenewerV1 } from "generated/artifacts/ETHRenewerV1.js";
import { Artifact_NameWrapper } from "generated/artifacts/NameWrapper.js";
import { Artifact_PermissionedRegistry } from "generated/artifacts/PermissionedRegistry.js";
import { Artifact_PublicResolver } from "generated/artifacts/PublicResolver.js";
import { Artifact_ReverseRegistrar } from "generated/artifacts/ReverseRegistrar.js";

/// Single function fragments, taken from the compiled contracts.
///
/// The scripts cannot hand a whole artifact ABI to `multicall`: viem infers the
/// return tuple across every entry of a batch, and a batch of full ABIs
/// exhausts TypeScript's instantiation budget — the checker abandons the call
/// and every decoded result downstream degrades to `unknown`. So each call site
/// gets an ABI holding only what it calls.
///
/// Narrow does not have to mean hand-written. `pick` cuts the fragment out of
/// the generated artifact and keeps its literal type, so arguments and return
/// values stay precisely typed, the compiled contract remains the only
/// definition, and a function renamed in Solidity resolves to `never` and fails
/// the build rather than surviving as a decode error at run time.
///
/// Compose with a spread, which preserves those literal types:
///
///     const ABI = [...NameWrapper.getData, ...BaseRegistrar.ownerOf] as const;
function pick<const abi extends readonly unknown[], name extends string>(
  abi: abi,
  name: name,
  /// Required only where the contract overloads the name, since viem cannot
  /// choose between two arities from one ABI.
  inputs?: number,
) {
  const matches = (abi as readonly any[]).filter(
    (entry) =>
      entry.type === "function" &&
      entry.name === name &&
      (inputs === undefined || entry.inputs.length === inputs),
  );
  // The type says the name exists; this says exactly one shape of it does.
  // Without it an overload picked by the wrong arity would type fine here and
  // fail on the first call.
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one "${name}"${inputs === undefined ? "" : `/${inputs}`} fragment, found ${matches.length}`,
    );
  }
  return matches as Extract<abi[number], { name: name; type: "function" }>[];
}

const BASE_REGISTRAR = Artifact_BaseRegistrarImplementation.abi;
const NAME_WRAPPER = Artifact_NameWrapper.abi;
const REGISTRY = Artifact_ENSRegistry.abi;
const RESOLVER = Artifact_PublicResolver.abi;
const CONTROLLER = Artifact_ETHRegistrarController.abi;
const REVERSE = Artifact_ReverseRegistrar.abi;
const RENEWER = Artifact_ETHRenewerV1.abi;
const V2_REGISTRY = Artifact_PermissionedRegistry.abi;

/// The v1 `.eth` registrar: an ERC-721 plus its own registration surface.
export const BaseRegistrar = {
  ownerOf: pick(BASE_REGISTRAR, "ownerOf"),
  transferFrom: pick(BASE_REGISTRAR, "transferFrom"),
  safeTransferFrom: pick(BASE_REGISTRAR, "safeTransferFrom", 3),
  setApprovalForAll: pick(BASE_REGISTRAR, "setApprovalForAll"),
  isApprovedForAll: pick(BASE_REGISTRAR, "isApprovedForAll"),
  nameExpires: pick(BASE_REGISTRAR, "nameExpires"),
  /// Points the registry record at an owner. Authorised by the token, so the
  /// holder can aim it anywhere — including at an address that never signs.
  reclaim: pick(BASE_REGISTRAR, "reclaim"),
} as const;

export const NameWrapper = {
  /// Owner, fuses and expiry in one read, all three normalised for expiry —
  /// which is the reading the wrapper's own transfer guard acts on.
  getData: pick(NAME_WRAPPER, "getData"),
  ownerOf: pick(NAME_WRAPPER, "ownerOf"),
  safeTransferFrom: pick(NAME_WRAPPER, "safeTransferFrom", 5),
  setApprovalForAll: pick(NAME_WRAPPER, "setApprovalForAll"),
  isApprovedForAll: pick(NAME_WRAPPER, "isApprovedForAll"),
  supportsInterface: pick(NAME_WRAPPER, "supportsInterface"),
  wrapETH2LD: pick(NAME_WRAPPER, "wrapETH2LD"),
  unwrapETH2LD: pick(NAME_WRAPPER, "unwrapETH2LD"),
  setSubnodeRecord: pick(NAME_WRAPPER, "setSubnodeRecord"),
  setFuses: pick(NAME_WRAPPER, "setFuses"),
  approve: pick(NAME_WRAPPER, "approve"),
  setResolver: pick(NAME_WRAPPER, "setResolver"),
  setTTL: pick(NAME_WRAPPER, "setTTL"),
} as const;

export const EnsRegistry = {
  owner: pick(REGISTRY, "owner"),
  resolver: pick(REGISTRY, "resolver"),
  ttl: pick(REGISTRY, "ttl"),
  setResolver: pick(REGISTRY, "setResolver"),
  setTTL: pick(REGISTRY, "setTTL"),
} as const;

/// The v1 PublicResolver. `addr` and `setAddr` are overloaded, so each arity is
/// picked separately and a call site takes only the one it means.
export const PublicResolver = {
  addr: pick(RESOLVER, "addr", 1),
  addrMulticoin: pick(RESOLVER, "addr", 2),
  text: pick(RESOLVER, "text"),
  contenthash: pick(RESOLVER, "contenthash"),
  setAddr: pick(RESOLVER, "setAddr", 2),
  setAddrMulticoin: pick(RESOLVER, "setAddr", 3),
  setText: pick(RESOLVER, "setText"),
  setContenthash: pick(RESOLVER, "setContenthash"),
} as const;

export const EthRegistrarController = {
  renew: pick(CONTROLLER, "renew"),
  rentPrice: pick(CONTROLLER, "rentPrice"),
} as const;

export const ReverseRegistrar = {
  setName: pick(REVERSE, "setName", 1),
} as const;

/// Whatever currently owns the v1 BaseRegistrar — the v1 owner directly, or a
/// renewer holding it on their behalf.
export const RegistrarOwnership = {
  owner: pick(RENEWER, "owner"),
  transferRegistrarOwnership: pick(RENEWER, "transferRegistrarOwnership"),
} as const;

/// The registrar-ownership pair, composed once because both the phase runner
/// and the fixture seeder walk the same chain of owners to re-enable the v1
/// controller.
export const RegistrarOwnershipAbi = [
  ...RegistrarOwnership.owner,
  ...RegistrarOwnership.transferRegistrarOwnership,
] as const;

/// The v2 registry, as the pre-migration verification reads it.
export const PermissionedRegistry = {
  getState: pick(V2_REGISTRY, "getState"),
  getResolver: pick(V2_REGISTRY, "getResolver"),
} as const;
