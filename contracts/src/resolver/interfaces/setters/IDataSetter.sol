// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @dev Interface selector: `0xeb4b73bb`
interface IDataSetter {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Data was changed.
    /// @param recordId The record ID.
    /// @param keyHash The hash of `key`.
    /// @param key The data key.
    /// @param value The data value.
    event DataUpdated(uint256 indexed recordId, string indexed keyHash, string key, bytes value);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set data for `key`.
    /// @param name The DNS-encoded name.
    /// @param key The data key.
    /// @param value The data value.
    function setData(bytes calldata name, string calldata key, bytes calldata value) external;
}
