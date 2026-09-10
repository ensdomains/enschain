// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IEnhancedAccessControl} from "../../access-control/interfaces/IEnhancedAccessControl.sol";

import {IRecordResolver} from "./IRecordResolver.sol";

/// @dev Interface selector: `0x8c2427cc`
interface IPermissionedResolver is IRecordResolver, IEnhancedAccessControl {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Associate EAC resource with setter argument.
    /// @param resource The resource to associate.
    /// @param arg The setter argument.
    event ResourceArgument(uint256 indexed resource, bytes arg);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Authorize fine-grained permission to `account`.
    /// @param setter The ABI-encoded setter calldata to authorize.
    /// @param account The account to be authorize for role.
    /// @return `true` if an authorization was changed.
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);

    /// @notice Associate `name` with `targetNode`.
    /// @param sourceName The DNS-encoded name to link.
    /// @param targetNode The target namehash.
    function linkToNode(bytes calldata sourceName, bytes32 targetNode) external;

    /// @notice Associate `name` with `recordId`.
    /// @param sourceName The DNS-encoded name to link.
    /// @param recordId The record ID or 0 to unlink.
    function linkToRecord(bytes calldata sourceName, uint256 recordId) external;

    /// @notice Get the number of created records.
    function getRecordCount() external view returns (uint256);

    /// @notice Get the record linked to `node`.
    /// @param node The namehash to find.
    /// @return The record ID or 0 if not linked.
    function getRecordId(bytes32 node) external view returns (uint256);

    /// @notice Decode setter calldata into parts and corresponding role.
    /// @param setter The ABI-encoded setter calldata.
    /// @return arg The setter argument.
    /// @return resource The EAC resource.
    /// @return roleBitmap The corresponding role bit.
    function decodeSetter(bytes calldata setter)
        external
        pure
        returns (bytes memory arg, uint256 resource, uint256 roleBitmap);
}
