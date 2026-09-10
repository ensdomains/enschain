// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {LibLabel} from "~src/utils/LibLabel.sol";

/// @title MockPremigrator
/// @notice Mocks premigration script state for testing on un-pre-migrated deployments.
contract MockPremigrator {
    /// @notice The ETH registry to use for registration.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Initializes the MockPremigrator.
    /// @param ethRegistry_ The ETH registry to use for registration.
    constructor(IPermissionedRegistry ethRegistry_) {
        ETH_REGISTRY = ethRegistry_;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Register/renew a name for pre-migration
    /// @param label Label to reserve or renew
    /// @param expiry Expiry for the name
    /// @param registry The registry for the name
    /// @param resolver The resolver for the name
    function preMigrate(string calldata label, uint64 expiry, IRegistry registry, address resolver)
        external
    {
        IPermissionedRegistry.State memory state = ETH_REGISTRY.getState(LibLabel.id(label));

        if (state.status == IPermissionedRegistry.Status.AVAILABLE) {
            ETH_REGISTRY.register(label, address(0), registry, resolver, 0, expiry);
        } else if (state.status == IPermissionedRegistry.Status.RESERVED && expiry > state.expiry) {
            ETH_REGISTRY.renew(state.tokenId, expiry);
        }
    }
}
