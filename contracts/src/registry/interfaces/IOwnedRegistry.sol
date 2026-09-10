// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IRegistry} from "./IRegistry.sol";

/// @notice A registry with owners.
/// @dev Interface selector: `0xf6046c7b`
interface IOwnedRegistry is IRegistry {
    /// @notice Fetches the label owner.
    /// @param label The label to query.
    /// @return The owner of the label.
    function findOwner(string calldata label) external view returns (address);

    /// @notice Return `true` if the tokens cannot be controlled by root.
    function isEmancipated() external view returns (bool);
}
