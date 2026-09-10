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

/// @dev Nybble 2: authorizes `call()` for approved addresses.  Root only.
uint256 constant ROLE_CALLABLE = 1 << 8;

/// @dev Nybble 34: authorizes setting `ROLE_CAN_NAME`.
uint256 constant ROLE_CALLABLE_ADMIN = ROLE_CALLABLE << 128;

/// @dev Interface selector: `0x31a033fd`
interface IPermissionedAddressSet is IEnhancedAccessControl, IAddressSet {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Inclusion of a member of the set has changed.
    /// @param addr The address.
    /// @param approved If `true`, added, otherwise removed.
    /// @param sender The sender of the change.
    event ApprovalChanged(address indexed addr, bool approved, address indexed sender);

    /// @notice Whether `call()` can be invoked has changed.
    /// @param callable `true` if approved can invoke `call()`.
    /// @param sender The sender of the change.
    event CallableChanged(bool callable, address indexed sender);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @dev Error selector: `0x902824c1`
    error NotCallable();

    /// @dev Error selector: `0x0ca968d8`
    error NotApproved(address account);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Call `to` with `data`.  Only invokable by approved.
    /// @param to The contract to call.
    /// @param data The data to call with.
    /// @return ok `true` if call was successful.
    /// @return result The result of the call.
    function call(address to, bytes calldata data)
        external
        payable
        returns (bool ok, bytes memory result);

    /// @notice Add or remove a member from the set.
    /// @param addr The address to approve.
    /// @param approved If `true`, added, otherwise removed.
    function approve(address addr, bool approved) external;

    /// @notice Set whether `call()` can be invoked by approved.
    /// @param callable `true` if approved can invoke `call()`.
    function setCallable(bool callable) external;

    /// @notice `true` if approved can invoke `call()`.
    function isCallable() external view returns (bool);
}
