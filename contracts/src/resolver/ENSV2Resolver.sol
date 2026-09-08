// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {LibRegistry} from "../universalResolver/libraries/LibRegistry.sol";

import {AbstractMirrorResolver} from "./AbstractMirrorResolver.sol";

/// @notice Resolver that performs resolutions using ENSv2 with override for ENSv1 "eth" resolver.
contract ENSV2Resolver is AbstractMirrorResolver {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 root registry used to traverse the registry hierarchy and locate resolvers.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    /// @notice The ENSv1 resolver for "eth".
    address public immutable ETH_RESOLVER;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param batchGatewayProvider The batch gateway provider.
    /// @param contractNamer Delegated contract namer.
    /// @param rootRegistry The ENSv2 root registry.
    /// @param ethResolver The override resolver for "eth" or null to use ENSv2.
    constructor(
        IGatewayProvider batchGatewayProvider,
        IContractNamer contractNamer,
        IPermissionedRegistry rootRegistry,
        address ethResolver
    )
        AbstractMirrorResolver(batchGatewayProvider, contractNamer)
    {
        ROOT_REGISTRY = rootRegistry;
        ETH_RESOLVER = ethResolver;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc AbstractMirrorResolver
    function _findResolver(bytes calldata name) internal view override returns (address resolver) {
        bytes32 node;
        (, resolver, node, ) = LibRegistry.findResolver(ROOT_REGISTRY, name, 0);
        if (node == NameCoder.ETH_NODE && address(ETH_RESOLVER) != address(0)) {
            resolver = ETH_RESOLVER;
        }
    }
}
