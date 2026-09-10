// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IPermissionedRegistry} from "./IPermissionedRegistry.sol";

/// @notice Interface for a registry that manages a locked NameWrapper name.
/// @dev Interface selector: `0xf5586a0b`
interface IWrapperRegistry is IPermissionedRegistry {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Upgrade target is not approved for `WrapperRegistry` proxies.
    /// @dev Error selector: `0xf74d7dd0`
    /// @param implementation The disallowed implementation address.
    error UpgradeTargetNotApproved(address implementation);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Returns the DNS-encoded name for this registry.
    function getWrappedName() external view returns (bytes memory);

    /// @notice Returns the NameWrapper node (namehash).
    function getWrappedNode() external view returns (bytes32);
}
