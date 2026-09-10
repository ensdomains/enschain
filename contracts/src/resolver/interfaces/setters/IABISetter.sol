// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @dev Interface selector: `0xd26f550e`
interface IABISetter {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice ABI was changed.
    /// @param recordId The record ID.
    /// @param contentType The ABI content type.
    event ABIUpdated(uint256 indexed recordId, uint256 indexed contentType);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The content type must be a single bit.
    /// @dev Error selector: `0x5742bb26`
    error InvalidContentType(uint256 contentType);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set ABI for `contentType`.
    /// @param name The DNS-encoded name.
    /// @param contentType The ABI content type.
    /// @param data The ABI data.
    function setABI(bytes calldata name, uint256 contentType, bytes calldata data) external;
}
