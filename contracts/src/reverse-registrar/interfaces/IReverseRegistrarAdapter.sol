// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IReverseRegistrar} from "@ens/contracts/reverseRegistrar/IReverseRegistrar.sol";

/// @title Reverse Registrar Adapter Interface
/// @notice Forwards v1 `addr.reverse` registrar claims for contracts and HCAs.
/// @dev Interface selector: `0x7deebf61`
interface IReverseRegistrarAdapter {
    /// @notice Claims account's `addr.reverse` node and sets its resolver.
    /// @param account The account to claim.
    /// @param resolver The resolver to set.
    /// @return The ENS node hash for the contract's reverse record.
    function claim(address account, address resolver) external returns (bytes32);

    /// @notice Claims account's `addr.reverse` node through an HCA caller.
    /// @param account The account to claim.
    /// @param resolver The resolver to set.
    /// @return The ENS node hash for the contract's reverse record.
    function claimWithHCA(address account, address resolver) external returns (bytes32);

    /// @notice Returns the v1 reverse registrar for `addr.reverse`.
    function REVERSE_REGISTRAR() external view returns (IReverseRegistrar);
}
