// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {CCIPReader} from "@ens/contracts/ccipRead/CCIPBatcher.sol";
import {ICompositeResolver} from "@ens/contracts/resolvers/profiles/ICompositeResolver.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

import {LibRegistry} from "./libraries/LibRegistry.sol";

/// @notice Helper contract for following `ICompositeResolver` chains. 
contract CompositeHelper is DelegatedContractNamer, CCIPReader {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct ResolverInfo {
        address resolver;
        bool offchain;
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 root registry.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice `ICompositeResolver.getResolver()` failed.
    /// @dev Error selector: `0xafdf3039`
    error UnknownResolver(ResolverInfo[] resolvers, bytes error);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootRegistry The root registry.
    /// @param contractNamer Delegated contract namer.
    constructor(IPermissionedRegistry rootRegistry, IContractNamer contractNamer)
        CCIPReader(DEFAULT_UNSAFE_CALL_GAS)
        DelegatedContractNamer(contractNamer)
    {
        ROOT_REGISTRY = rootRegistry;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Find all resolvers in an `ICompositeResolver` chain.
    /// @param name DNS-encoded name to lookup.
    /// @return Array of resolvers.
    function getResolvers(bytes calldata name) external view returns (ResolverInfo[] memory) {
        (, address resolver, , ) = LibRegistry.findResolver(ROOT_REGISTRY, name, 0);
        return _getResolvers(resolver, false, name, new ResolverInfo[](0));
    }

    /// @notice CCIP-Read callback for `_getResolvers()` from calling a resolver successfully.
    // solhint-disable-next-line
    function getResolversCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (ResolverInfo[] memory)
    {
        (bytes memory name, ResolverInfo[] memory resolvers) =
            abi.decode(extraData, (bytes, ResolverInfo[]));
        (address resolver, bool offchain) = abi.decode(response, (address, bool));
        return _getResolvers(resolver, offchain, name, resolvers);
    }

    /// @notice CCIP-Read callback for `_getResolvers()` from calling a resolver unsuccessfully.
    // solhint-disable-next-line
    function getResolversCallbackError(bytes calldata response, bytes calldata extraData)
        external
        pure
    {
        (, ResolverInfo[] memory resolvers) = abi.decode(extraData, (bytes, ResolverInfo[]));
        revert UnknownResolver(resolvers, response);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Find the next resolver in an `ICompositeResolver` chain.
    function _getResolvers(
        address resolver,
        bool offchain,
        bytes memory name,
        ResolverInfo[] memory src
    )
        internal
        view
        returns (ResolverInfo[] memory dst)
    {
        uint256 n = src.length;
        dst = new ResolverInfo[](n + 1);
        for (uint256 i; i < n; ++i) {
            dst[i] = src[i];
        }
        dst[n] = ResolverInfo(resolver, offchain);
        if (!ERC165Checker.supportsInterface(resolver, type(ICompositeResolver).interfaceId)) {
            return dst;
        }
        ccipRead(
            resolver,
            abi.encodeCall(ICompositeResolver.getResolver, (name)),
            this.getResolversCallback.selector,
            this.getResolversCallbackError.selector,
            abi.encode(name, dst)
        );
    }
}
