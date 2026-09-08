// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {CCIPReader} from "@ens/contracts/ccipRead/CCIPReader.sol";
import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {IExtendedDNSResolver} from "@ens/contracts/resolvers/profiles/IExtendedDNSResolver.sol";
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {ResolverCaller} from "@ens/contracts/universalResolver/ResolverCaller.sol";
import {BytesUtils} from "@ens/contracts/utils/BytesUtils.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {ResolverProfileRewriterLib} from "../resolver/libraries/ResolverProfileRewriterLib.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {LibResolution} from "../universalResolver/libraries/LibResolution.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

/// @notice Gasless DNSSEC resolver that rewrites DNS names according to an alias rule encoded in
/// a TXT record's context field. Supports two modes:
///
/// - Rewrite: context is `<oldSuffix> <newSuffix>` — replaces the matching suffix
///   (e.g., `*.nick.com` + context `com base.eth` → `*.nick.base.eth`).
/// - Replace: context is `<newName>` (no space) — replaces the entire name.
///
/// After rewriting, resolves the new name through the v2 registry via
/// `LibResolution.findResolver()`, rewriting the node in the calldata via
/// `ResolverProfileRewriterLib`.
///
/// Only invoked indirectly by `DNSTLDResolver` when processing an `ENS1` TXT record.
///
contract DNSAliasResolver is
    DelegatedContractNamer,
    ResolverCaller,
    IERC7996,
    IExtendedDNSResolver
{
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 root registry used to look up resolvers for rewritten names.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    /// @notice Provider for batch CCIP-Read gateway URLs, used when forwarding resolution calls.
    IGatewayProvider public immutable BATCH_GATEWAY_PROVIDER;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The `name` did not end with `suffix`.
    /// @dev Error selector: `0x017817ea`
    ///
    /// @param name The DNS-encoded name.
    /// @param suffix THe DNS-encoded suffix.
    error NoSuffixMatch(bytes name, bytes suffix);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootRegistry The ENSv2 root registry.
    /// @param batchGatewayProvider The batch gateway provider.
    /// @param contractNamer Delegated contract namer.
    constructor(
        IPermissionedRegistry rootRegistry,
        IGatewayProvider batchGatewayProvider,
        IContractNamer contractNamer
    )
        CCIPReader(DEFAULT_UNSAFE_CALL_GAS)
        DelegatedContractNamer(contractNamer)
    {
        ROOT_REGISTRY = rootRegistry;
        BATCH_GATEWAY_PROVIDER = batchGatewayProvider;
    }

    /// @inheritdoc DelegatedContractNamer
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            type(IExtendedDNSResolver).interfaceId == interfaceId ||
            type(IERC7996).interfaceId == interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IERC7996
    function supportsFeature(bytes4 feature) external pure returns (bool) {
        return ResolverFeatures.RESOLVE_MULTICALL == feature;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Apply rewrite rule to name and resolve it instead.
    /// @dev The operating assumption is that this contract is never called directly,
    ///      and instead only invoked by DNSTLDResolver in response to an TXT record.
    /// @param name The DNS-encoded name.
    /// @param data The data to resolve.
    /// @param context The TXT record context.
    /// @return The abi-encoded result from the resolver.
    function resolve(bytes calldata name, bytes calldata data, bytes calldata context)
        external
        view
        returns (bytes memory)
    {
        bytes memory newName = rewriteNameWithContext(name, context);
        (, address resolver, bytes32 node, ) = LibResolution.findResolver(ROOT_REGISTRY, newName, 0);
        callResolver(
            resolver,
            newName,
            ResolverProfileRewriterLib.replaceNode(data, node),
            false,
            "",
            BATCH_GATEWAY_PROVIDER.gateways()
        );
    }

    /// @notice Applies the rewrite rule encoded in `context` to `name`.
    /// @dev If `context` contains a space, it is split into an old suffix and a new suffix;
    ///      the old suffix is matched against `name` and replaced with the new suffix. If there
    ///      is no space, the entire `name` is replaced with the DNS-encoding of `context`.
    /// @param name The DNS-encoded name to rewrite.
    /// @param context The rewrite rule — either `<oldSuffix> <newSuffix>` or `<newName>`.
    /// @return The rewritten DNS-encoded name.
    function rewriteNameWithContext(bytes calldata name, bytes calldata context)
        public
        pure
        returns (bytes memory)
    {
        uint256 sep = BytesUtils.find(context, 0, context.length, " ");
        if (sep < context.length) {
            bytes memory oldSuffix = NameCoder.encode(string(context[:sep]));
            (bool matched, , , uint256 offset) =
                NameCoder.matchSuffix(name, 0, NameCoder.namehash(oldSuffix, 0));
            if (!matched) {
                revert NoSuffixMatch(name, oldSuffix);
            }
            bytes memory newSuffix = NameCoder.encode(string(context[sep + 1:]));
            return abi.encodePacked(name[:offset], newSuffix); // rewrite
        } else {
            return NameCoder.encode(string(context)); // replace
        }
    }
}
