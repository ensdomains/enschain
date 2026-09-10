// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IStandaloneHCAFactory} from "./interfaces/IStandaloneHCAFactory.sol";

/// @dev Authorizes an account through an immutable factory-certified HCA owner binding.
abstract contract HCAAuthorizer {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The factory that certifies HCA owner bindings.
    IStandaloneHCAFactory public immutable STANDALONE_HCA_FACTORY;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @dev Error selector: `0x8d859048`
    error HCADeploymentNotTrusted(address hca);

    /// @dev Error selector: `0xa8f2205f`
    error HCAOwnerMismatch(address account, address hcaOwner);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param standaloneHCAFactory Factory certifying immutable HCA owner bindings.
    constructor(IStandaloneHCAFactory standaloneHCAFactory) {
        STANDALONE_HCA_FACTORY = standaloneHCAFactory;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Resolves a certified HCA caller to its owner, then ensures that owner is `account`.
    function _requireHCAForAccount(address account) internal view returns (address hcaOwner) {
        hcaOwner = _hcaOwner();
        if (hcaOwner != account) {
            revert HCAOwnerMismatch(account, hcaOwner);
        }
    }

    /// @dev Returns the factory-certified owner of the HCA caller.
    function _hcaOwner() internal view returns (address hcaOwner) {
        hcaOwner = STANDALONE_HCA_FACTORY.authorizedOwnerOf(msg.sender);
        if (hcaOwner == address(0)) {
            revert HCADeploymentNotTrusted(msg.sender);
        }
    }
}
