// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {
    IDefaultReverseRegistrar
} from "@ens/contracts/reverseRegistrar/IDefaultReverseRegistrar.sol";

/// @title Default Reverse Registrar Adapter Interface
/// @notice Forwards v1 `default.reverse` registrar updates for contracts and HCAs.
/// @dev Interface selector: `0x1c946734`
interface IDefaultReverseRegistrarAdapter {
    /// @notice Sets account's `default.reverse` primary name.
    /// @param account The contract address.
    /// @param name The primary name to store.
    function setName(address account, string calldata name) external;

    /// @notice Sets account's `default.reverse` primary name through an HCA caller.
    /// @param account The account to name.
    /// @param name The primary name to store.
    function setNameWithHCA(address account, string calldata name) external;

    /// @notice Returns the v1 default reverse registrar for `default.reverse`.
    function DEFAULT_REVERSE_REGISTRAR() external view returns (IDefaultReverseRegistrar);
}
