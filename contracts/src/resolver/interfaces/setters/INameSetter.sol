// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @dev Interface selector: `0x0ce0112a`
interface INameSetter {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Primary name was changed.
    /// @param recordId The record ID.
    /// @param primaryName The primary name.
    event NameUpdated(uint256 indexed recordId, string primaryName);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set primary name.
    /// @param name The DNS-encoded name.
    /// @param primaryName The primary name.
    function setName(bytes calldata name, string calldata primaryName) external;
}
