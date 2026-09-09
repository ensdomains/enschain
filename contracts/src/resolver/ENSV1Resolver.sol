// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {RegistryUtils} from "@ens/contracts/universalResolver/RegistryUtils.sol";

import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {LibResolution} from "../universalResolver/libraries/LibResolution.sol";

import {AbstractMirrorResolver} from "./AbstractMirrorResolver.sol";

/// @notice Resolver that performs resolutions using ENSv1.
contract ENSV1Resolver is AbstractMirrorResolver {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv1 registry used to look up resolvers for names.
    ENS public immutable REGISTRY_V1;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param batchGatewayProvider The batch gateway provider.
    /// @param contractNamer Delegated contract namer.
    /// @param registryV1 The ENSv1 registry.
    constructor(IGatewayProvider batchGatewayProvider, IContractNamer contractNamer, ENS registryV1)
        AbstractMirrorResolver(batchGatewayProvider, contractNamer)
    {
        REGISTRY_V1 = registryV1;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc AbstractMirrorResolver
    function _findResolver(bytes calldata name) internal view override returns (address) {
        (address resolver, , uint256 offset) = RegistryUtils.findResolver(REGISTRY_V1, name, 0);
        return LibResolution.validateResolver(resolver, offset == 0);
    }
}
