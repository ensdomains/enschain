// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {LibLabel} from "../utils/LibLabel.sol";

/// @title BatchRegistrar
/// @notice Simple batch registration contract for pre-migration of ENS names.
///         Only the owner can invoke batch registration.
contract BatchRegistrar is Ownable {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ETH registry to use for batch registration.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Thrown when batch registration inputs have different lengths.
    /// @dev Error selector: `0xaaad13f7`
    error InputLengthMismatch();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param ethRegistry_ The ETH registry to use for batch registration.
    /// @param owner_ The owner of the contract.
    constructor(IPermissionedRegistry ethRegistry_, address owner_) Ownable(owner_) {
        ETH_REGISTRY = ethRegistry_;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Batch reserve or renew names for pre-migration
    /// @param registry The registry for all names
    /// @param resolver The resolver for all names
    /// @param labels Array of labels to reserve or renew
    /// @param expires Array of expiry timestamps corresponding to each label
    function batchRegister(
        IRegistry registry,
        address resolver,
        string[] calldata labels,
        uint64[] calldata expires
    )
        external
        onlyOwner
    {
        if (labels.length != expires.length) {
            revert InputLengthMismatch();
        }

        for (uint256 i = 0; i < labels.length; i++) {
            IPermissionedRegistry.State memory state = ETH_REGISTRY.getState(LibLabel.id(labels[i]));

            if (state.status == IPermissionedRegistry.Status.AVAILABLE) {
                ETH_REGISTRY.register(labels[i], address(0), registry, resolver, 0, expires[i]);
            } else if (
                state.status == IPermissionedRegistry.Status.RESERVED && expires[i] > state.expiry
            ) {
                ETH_REGISTRY.renew(state.tokenId, expires[i]);
            }
        }
    }
}
