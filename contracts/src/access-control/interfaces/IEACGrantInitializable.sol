// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

/// @dev Initialization-time structure for a grant.
struct Grant {
    address account;
    uint256 roleBitmap;
}

/// @notice Interface for initializing `EnhancedAccessControl` with multiple accounts.
/// @dev Interface selector: `0x37cb53a8`
interface IEACGrantInitializable {
    /// @notice Initialize the contract.
    /// @param grants Accounts and roles granted on root.
    function initialize(Grant[] calldata grants) external;
}
