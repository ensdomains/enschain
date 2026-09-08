// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IUUPSProxy} from "@ensdomains/verifiable-factory/IUUPSProxy.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IStandaloneHCAFactory} from "./interfaces/IStandaloneHCAFactory.sol";
import {IStandaloneHCAOwner} from "./interfaces/IStandaloneHCAOwner.sol";
import {StandaloneSingleOwnerHCA} from "./StandaloneSingleOwnerHCA.sol";

/// @title Standalone HCA Factory
/// @notice Governs initial HCA implementations and certifies immutable HCA owner bindings.
/// @dev Anyone may deploy an HCA from an approved implementation. A successful deployment is
///      permanently bound to the owner verified immediately after initialization.
contract StandaloneHCAFactory is IStandaloneHCAFactory, Ownable {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The underlying factory used for every HCA deployment.
    IVerifiableFactory public immutable override VERIFIABLE_FACTORY;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IStandaloneHCAFactory
    mapping(address implementation => bool approved) public override approvedImplementations;

    /// @inheritdoc IStandaloneHCAFactory
    mapping(address hca => address owner) public override hcaOwners;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Initial-deployment approval changed for an implementation.
    /// @param implementation The implementation whose approval changed.
    /// @param approved Whether the implementation may initialize new HCAs.
    event ImplementationApprovalChanged(address indexed implementation, bool indexed approved);

    /// @notice An owner-bound HCA was deployed and certified.
    /// @param hca The deployed HCA proxy.
    /// @param owner The immutable owner certified for the HCA.
    /// @param implementation The approved initial implementation.
    /// @param userSalt The caller-supplied account namespace.
    event HCADeployed(
        address indexed hca,
        address indexed owner,
        address indexed implementation,
        uint256 userSalt
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @dev Error selector: `0xbc0ff6a0`
    error VerifiableFactoryCannotBeZero();

    /// @dev Error selector: `0x30eb1e65`
    error HCAImplementationCannotBeZero();

    /// @dev Error selector: `0x1a127e84`
    error HCAImplementationNotApproved(address hcaImplementation);

    /// @dev Error selector: `0x9b15e16f`
    error OwnerCannotBeZero();

    /// @dev Error selector: `0xa6a6d008`
    error UnexpectedHCAImplementation(address expectedImplementation, address actualImplementation);

    /// @dev Error selector: `0x6a238277`
    error UnexpectedHCAOwner(address expectedOwner, address actualOwner);

    /// @dev Error selector: `0x15bd01c5`
    error HCAOwnerUnavailable(address hca);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param verifiableFactory The underlying factory used for every HCA deployment.
    /// @param owner_ The governance account controlling implementation approval.
    constructor(IVerifiableFactory verifiableFactory, address owner_) Ownable(owner_) {
        if (address(verifiableFactory) == address(0)) {
            revert VerifiableFactoryCannotBeZero();
        }
        VERIFIABLE_FACTORY = verifiableFactory;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IStandaloneHCAFactory
    function setImplementationApproval(address implementation, bool approved)
        external
        override
        onlyOwner
    {
        if (implementation == address(0)) {
            revert HCAImplementationCannotBeZero();
        }
        approvedImplementations[implementation] = approved;
        emit ImplementationApprovalChanged(implementation, approved);
    }

    /// @inheritdoc IStandaloneHCAFactory
    function deploy(address owner, address hcaImplementation, uint256 userSalt)
        external
        override
        returns (address hca)
    {
        if (owner == address(0)) {
            revert OwnerCannotBeZero();
        }
        if (hcaImplementation == address(0)) {
            revert HCAImplementationCannotBeZero();
        }
        if (!approvedImplementations[hcaImplementation]) {
            revert HCAImplementationNotApproved(hcaImplementation);
        }

        bytes memory initData =
            abi.encodeCall(StandaloneSingleOwnerHCA.initializeAccount, (abi.encode(owner)));
        hca = VERIFIABLE_FACTORY.deployProxy(
            hcaImplementation,
            deploymentSalt(owner, hcaImplementation, userSalt),
            initData
        );

        (, address deployedImplementation) = IUUPSProxy(hca).getVerifiableProxyData();
        if (deployedImplementation != hcaImplementation) {
            revert UnexpectedHCAImplementation(hcaImplementation, deployedImplementation);
        }

        hcaOwners[hca] = owner;

        address deployedOwner;
        try IStandaloneHCAOwner(hca).owner() returns (address owner_) {
            deployedOwner = owner_;
        } catch {
            revert HCAOwnerUnavailable(hca);
        }
        if (deployedOwner != owner) {
            revert UnexpectedHCAOwner(owner, deployedOwner);
        }

        emit HCADeployed(hca, owner, hcaImplementation, userSalt);
    }

    /// @inheritdoc IStandaloneHCAFactory
    function authorizedOwnerOf(address hca) external view override returns (address owner) {
        return hcaOwners[hca];
    }

    /// @inheritdoc IStandaloneHCAFactory
    function deploymentSalt(address owner, address hcaImplementation, uint256 userSalt)
        public
        pure
        override
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(userSalt, owner, hcaImplementation)));
    }
}
