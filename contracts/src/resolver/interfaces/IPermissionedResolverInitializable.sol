// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Grant} from "../../access-control/interfaces/IEACGrantInitializable.sol";

/// @notice Interface for initializing a `PermissionedResolver`.
/// @dev Interface selector: `0x33cc44a0`
interface IPermissionedResolverInitializable {
    /// @notice Initialize the contract.
    /// @param grants Accounts and roles granted on root.
    /// @param calls The calldata that avoids permission checks.
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
}
