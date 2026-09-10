// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @dev Interface selector: `0x9ce8c375`
interface IInterfaceSetter {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Interface was changed.
    /// @param recordId The record ID.
    /// @param interfaceId The EIP-165 interface ID.
    /// @param implementer The address of the contract that implements the interface.
    event InterfaceUpdated(
        uint256 indexed recordId,
        bytes4 indexed interfaceId,
        address implementer
    );

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set implementer for `interfaceId`.
    /// @param name The DNS-encoded name.
    /// @param interfaceId The EIP-165 interface ID.
    /// @param implementer The address of the contract that implements the interface.
    function setInterface(bytes calldata name, bytes4 interfaceId, address implementer) external;
}
