// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

/// @title Standalone HCA Factory Interface
/// @notice Exposes governed HCA deployment and immutable factory-certified owner bindings.
/// @dev Interface selector: `0xb2a3ab4f`
interface IStandaloneHCAFactory {
    /// @notice Sets whether an implementation may initialize new HCAs through this factory.
    /// @dev Approval changes affect only future deployments.
    /// @param implementation The implementation whose approval changes.
    /// @param approved Whether new HCAs may be initialized from the implementation.
    function setImplementationApproval(address implementation, bool approved) external;

    /// @notice Deploys and initializes an HCA using an approved implementation.
    /// @param owner The immutable owner assigned to the HCA.
    /// @param hcaImplementation The approved initial implementation.
    /// @param userSalt An optional namespace or account-version salt.
    /// @return hca The deployed HCA proxy.
    function deploy(address owner, address hcaImplementation, uint256 userSalt)
        external
        returns (address hca);

    /// @notice Returns the VerifiableFactory used for HCA proxy deployments.
    function VERIFIABLE_FACTORY() external view returns (IVerifiableFactory);

    /// @notice Returns whether an implementation may initialize new HCAs.
    /// @param implementation The candidate initial implementation.
    /// @return approved Whether the implementation is approved.
    function approvedImplementations(address implementation) external view returns (bool approved);

    /// @notice Returns the owner certified when an HCA was deployed.
    /// @param hca The candidate HCA proxy.
    /// @return owner The certified owner, or zero if the factory did not deploy the HCA.
    function hcaOwners(address hca) external view returns (address owner);

    /// @notice Returns the owner authorized through a factory-certified HCA.
    /// @param hca The candidate HCA proxy.
    /// @return owner The certified owner, or zero for an unknown HCA.
    function authorizedOwnerOf(address hca) external view returns (address owner);

    /// @notice Derives the VerifiableFactory salt for an owner, implementation, and user salt.
    /// @param owner The owner assigned to the HCA.
    /// @param hcaImplementation The HCA's initial implementation.
    /// @param userSalt An optional namespace or account-version salt.
    /// @return salt The owner- and implementation-bound VerifiableFactory salt.
    function deploymentSalt(address owner, address hcaImplementation, uint256 userSalt)
        external
        pure
        returns (uint256 salt);
}
