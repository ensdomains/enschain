// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

import {AbstractNormalizedUniversalResolver} from "./AbstractNormalizedUniversalResolver.sol";
import {LibRegistry} from "./libraries/LibRegistry.sol";

/// @notice Universal Resolver for ENSv2.
contract UniversalResolverV2 is AbstractNormalizedUniversalResolver, DelegatedContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice ENSv2 root registry.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootRegistry ENSv2 root registry.
    /// @param batchGatewayProvider Shared batch gateway provider.
    /// @param contractNamer Delegated contract namer.
    constructor(
        IPermissionedRegistry rootRegistry,
        IGatewayProvider batchGatewayProvider,
        IContractNamer contractNamer
    )
        AbstractNormalizedUniversalResolver(batchGatewayProvider)
        DelegatedContractNamer(contractNamer)
    {
        ROOT_REGISTRY = rootRegistry;
    }

    /// @inheritdoc AbstractNormalizedUniversalResolver
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbstractNormalizedUniversalResolver, DelegatedContractNamer)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc AbstractNormalizedUniversalResolver
    function findResolver(bytes memory name)
        public
        view
        override
        returns (address resolver, bytes32 node, uint256 offset)
    {
        (, resolver, node, offset) = LibRegistry.findResolver(ROOT_REGISTRY, name, 0);
    }

    /// @inheritdoc AbstractNormalizedUniversalResolver
    function isENSv2() public pure override returns (bool) {
        return true;
    }
}
