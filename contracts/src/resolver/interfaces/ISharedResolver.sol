// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IRecordResolver} from "./IRecordResolver.sol";

/// @dev Interface selector: `0xfa89c1e0`
interface ISharedResolver is IRecordResolver {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Authorization for `name` has changed.
    /// @param recordId The record ID.
    /// @param owner The owner account.
    /// @param operator The authorized account.
    /// @param approved The authorization state.
    event ApprovalUpdated(
        uint256 indexed recordId,
        address indexed owner,
        address indexed operator,
        bool approved
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Caller cannot modify name.
    /// @dev Error selector: `0x76652b32`
    error CannotModifyName(bytes name);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Clear all records for `name`.
    /// @param name The DNS-encoded name.
    function clear(bytes calldata name) external;

    /// @notice Authorize `operator` for `name`.
    ///         Use root name to authorize all names.
    /// @param name The DNS-encoded name.
    /// @param operator The account to authorize.
    /// @param approved The authorization state.
    function approve(bytes calldata name, address operator, bool approved) external;

    /// @notice Check if `operator` is approved by `owner` for `name`.
    /// @param name The DNS-encoded name.
    /// @param owner The owner account.
    /// @param operator The authorized account.
    /// @return `true` if `operator` is approved.
    function isApproved(bytes calldata name, address owner, address operator)
        external
        view
        returns (bool);

    /// @notice Determine if `operator` is authorized.
    /// @param name The name to check.
    /// @param operator The account requesting authorization.
    /// @return `true` if authorized.
    function canModifyName(bytes calldata name, address operator) external view returns (bool);

    /// @notice Find the owner for `name`.
    /// @param name The DNS-encoded name.
    /// @return The owner address or null if unowned or not found.
    function ownerOf(bytes calldata name) external view returns (address);
}
