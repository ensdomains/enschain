// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IEnhancedAccessControl} from "../../access-control/interfaces/IEnhancedAccessControl.sol";

import {IAddressSet} from "./IAddressSet.sol";

/// @dev Nybble 0: authorizes modifying the set. Root only.
uint256 constant ROLE_APPROVE = 1 << 0;

/// @dev Nybble 32: authorizes setting `ROLE_APPROVE`.
uint256 constant ROLE_APPROVE_ADMIN = ROLE_APPROVE << 128;

/// @dev Nybble 1: authorizes contract naming. Root only.
uint256 constant ROLE_CAN_NAME = 1 << 4;

/// @dev Nybble 33: authorizes setting `ROLE_CAN_NAME`.
uint256 constant ROLE_CAN_NAME_ADMIN = ROLE_CAN_NAME << 128;

/// @dev Interface selector: `0x3d140d21`
interface IPermissionedAddressSet is IEnhancedAccessControl, IAddressSet {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Inclusion of a member of the set has changed.
    /// @param addr The address.
    /// @param approved If `true`, added, otherwise removed.
    /// @param sender The sender of the change.
    event ApprovalChanged(address indexed addr, bool approved, address indexed sender);

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Add or remove a member from the set.
    /// @param addr The address to approve.
    /// @param approved If `true`, added, otherwise removed.
    function approve(address addr, bool approved) external;
}
