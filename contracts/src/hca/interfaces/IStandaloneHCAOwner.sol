// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/// @title Standalone HCA Owner Interface
/// @notice Minimal owner view exposed by a standalone HCA account.
/// @dev Interface selector: `0xd70318f2`
interface IStandaloneHCAOwner {
    /// @notice Returns the account owner.
    function owner() external view returns (address);

    /// @notice Returns the account owner and current session nonce.
    /// @return owner_ The account owner.
    /// @return sessionNonce_ The current session nonce.
    function ownerAndSessionNonce() external view returns (address owner_, uint96 sessionNonce_);
}
