// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @dev Interface selector: `0xc5d7badd`
interface IContenthashSetter {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Contenthash was changed.
    /// @param recordId The record ID.
    /// @param hash The content hash.
    event ContenthashUpdated(uint256 indexed recordId, bytes hash);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set contenthash.
    /// @param name The DNS-encoded name.
    /// @param hash The content hash.
    function setContenthash(bytes calldata name, bytes calldata hash) external;
}
