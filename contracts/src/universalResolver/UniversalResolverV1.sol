// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {ReverseClaimer} from "@ens/contracts/reverseRegistrar/ReverseClaimer.sol";
import {RegistryUtils} from "@ens/contracts/universalResolver/RegistryUtils.sol";

import {AbstractNormalizedUniversalResolver} from "./AbstractNormalizedUniversalResolver.sol";

/// @notice Universal Resolver for ENSv1.
contract UniversalResolverV1 is AbstractNormalizedUniversalResolver, ReverseClaimer {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice ENSv1 global registry.
    ENS public immutable REGISTRY_V1;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param namer The primary name owner.
    /// @param ens ENSv1 global registry.
    /// @param _batchGatewayProvider Shared batch gateway provider.
    constructor(address namer, ENS ens, IGatewayProvider _batchGatewayProvider)
        AbstractNormalizedUniversalResolver(_batchGatewayProvider)
        ReverseClaimer(ens, namer)
    {
        REGISTRY_V1 = ens;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Same as `REGISTRY_V1()` for backwards-compatability with ENSv1.
    function registry() external view returns (ENS) {
        return REGISTRY_V1;
    }

    /// @inheritdoc AbstractNormalizedUniversalResolver
    function findResolver(bytes memory name)
        public
        view
        override
        returns (address, bytes32, uint256)
    {
        // https://docs.ens.domains/ensip/10       
        return RegistryUtils.findResolver(REGISTRY_V1, name, 0);
    }

    /// @inheritdoc AbstractNormalizedUniversalResolver
    function isENSv2() public pure override returns (bool) {
        return false;
    }
}
