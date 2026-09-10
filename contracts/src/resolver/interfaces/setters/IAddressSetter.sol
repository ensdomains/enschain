// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @dev Interface selector: `0xb4436dde`
interface IAddressSetter {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Address was changed.
    /// @param recordId The record ID.
    /// @param coinType The coin type.
    /// @param addressBytes The encoded address.
    event AddressUpdated(uint256 indexed recordId, uint256 coinType, bytes addressBytes);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Address was not 0 or 20 bytes.
    /// @dev Error selector: `0x8d666f60`
    error InvalidEVMAddress(bytes addressBytes);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set address for `coinType`.
    /// @param name The DNS-encoded name.
    /// @param coinType The coin type.
    /// @param addressBytes The encoded address.
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes)
        external;
}
