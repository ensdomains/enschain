// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {CloneProxyBytecode} from "@ensdomains/verifiable-factory/CloneProxyBytecode.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {Test} from "forge-std/Test.sol";

import {MockExecutorModule, MockValidatorModule} from "../../mocks/MockStandaloneHCAStack.sol";

import {StandaloneHCAFactory} from "~src/hca/StandaloneHCAFactory.sol";
import {StandaloneSingleOwnerHCA} from "~src/hca/StandaloneSingleOwnerHCA.sol";
import {IAddressSet} from "~src/utils/interfaces/IAddressSet.sol";

/// @title Standalone HCA Factory Tests
/// @notice Exercises governed deployment and immutable HCA owner certification.
contract StandaloneHCAFactoryTest is Test {
    string internal constant PERMISSIONED_ADDRESS_SET_ARTIFACT =
        "src/utils/PermissionedAddressSet.sol:PermissionedAddressSet";

    uint256 internal constant USER_SALT = 7;

    address internal owner = makeAddr("owner");
    address internal otherOwner = makeAddr("other-owner");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");

    VerifiableFactory internal verifiableFactory;
    StandaloneSingleOwnerHCA internal implementation;
    StandaloneSingleOwnerHCA internal otherImplementation;
    StandaloneSingleOwnerHCA internal unapprovedImplementation;
    StandaloneHCAFactory internal hcaFactory;

    function setUp() public {
        verifiableFactory = new VerifiableFactory();
        hcaFactory = new StandaloneHCAFactory(verifiableFactory, address(this));
        implementation = _newImplementation("entry-point");
        otherImplementation = _newImplementation("other-entry-point");
        unapprovedImplementation = _newImplementation("unapproved-entry-point");
        hcaFactory.setImplementationApproval(address(implementation), true);
        hcaFactory.setImplementationApproval(address(otherImplementation), true);
    }

    function test_constructorPinsDeploymentConfiguration() public view {
        assertEq(address(hcaFactory.VERIFIABLE_FACTORY()), address(verifiableFactory));
        assertEq(hcaFactory.owner(), address(this));
    }

    function test_constructorRejectsZeroConfiguration() public {
        vm.expectRevert(StandaloneHCAFactory.VerifiableFactoryCannotBeZero.selector);
        new StandaloneHCAFactory(IVerifiableFactory(address(0)), address(this));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new StandaloneHCAFactory(verifiableFactory, address(0));
    }

    function test_deploymentSaltBindsOwnerImplementationAndUserSalt() public view {
        assertEq(
            hcaFactory.deploymentSalt(owner, address(implementation), USER_SALT),
            uint256(keccak256(abi.encode(USER_SALT, owner, address(implementation))))
        );
        assertNotEq(
            hcaFactory.deploymentSalt(owner, address(implementation), USER_SALT),
            hcaFactory.deploymentSalt(otherOwner, address(implementation), USER_SALT)
        );
        assertNotEq(
            hcaFactory.deploymentSalt(owner, address(implementation), USER_SALT),
            hcaFactory.deploymentSalt(owner, address(implementation), USER_SALT + 1)
        );
        assertNotEq(
            hcaFactory.deploymentSalt(owner, address(implementation), USER_SALT),
            hcaFactory.deploymentSalt(owner, address(otherImplementation), USER_SALT)
        );
    }

    function test_deploysExpectedOwnerBoundAddressFromArbitraryRelayer() public {
        address expected = _expectedAddress(owner, address(implementation), USER_SALT);

        vm.expectEmit(true, true, true, true, address(hcaFactory));
        emit StandaloneHCAFactory.HCADeployed(expected, owner, address(implementation), USER_SALT);
        vm.prank(relayer);
        address hca = hcaFactory.deploy(owner, address(implementation), USER_SALT);

        assertEq(hca, expected);
        assertEq(hcaFactory.hcaOwners(hca), owner);
        assertEq(hcaFactory.authorizedOwnerOf(hca), owner);
        assertEq(StandaloneSingleOwnerHCA(payable(hca)).owner(), owner);
        assertEq(verifiableFactory.verifyContract(hca), address(implementation));
        assertEq(vm.load(hca, bytes32(0)), bytes32(0));

        vm.expectRevert(StandaloneSingleOwnerHCA.StandaloneHCAAlreadyInitialized.selector);
        StandaloneSingleOwnerHCA(payable(hca)).initializeAccount(abi.encode(otherOwner));
    }

    function test_allowsMultipleHCAsForOneOwner() public {
        address first = hcaFactory.deploy(owner, address(implementation), USER_SALT);
        address second = hcaFactory.deploy(owner, address(implementation), USER_SALT + 1);
        address third = hcaFactory.deploy(owner, address(otherImplementation), USER_SALT);

        assertNotEq(first, second);
        assertNotEq(first, third);
        assertNotEq(second, third);
        assertEq(hcaFactory.authorizedOwnerOf(first), owner);
        assertEq(hcaFactory.authorizedOwnerOf(second), owner);
        assertEq(hcaFactory.authorizedOwnerOf(third), owner);
    }

    function test_differentOwnersReceiveDifferentAccounts() public {
        vm.prank(relayer);
        address first = hcaFactory.deploy(owner, address(implementation), USER_SALT);

        vm.prank(attacker);
        address second = hcaFactory.deploy(otherOwner, address(implementation), USER_SALT);

        assertNotEq(first, second);
        assertEq(hcaFactory.hcaOwners(first), owner);
        assertEq(hcaFactory.hcaOwners(second), otherOwner);
    }

    function test_setImplementationApproval() public {
        vm.expectEmit(true, true, false, false, address(hcaFactory));
        emit StandaloneHCAFactory.ImplementationApprovalChanged(
            address(unapprovedImplementation),
            true
        );
        hcaFactory.setImplementationApproval(address(unapprovedImplementation), true);
        assertTrue(hcaFactory.approvedImplementations(address(unapprovedImplementation)));

        vm.expectEmit(true, true, false, false, address(hcaFactory));
        emit StandaloneHCAFactory.ImplementationApprovalChanged(
            address(unapprovedImplementation),
            false
        );
        hcaFactory.setImplementationApproval(address(unapprovedImplementation), false);
        assertFalse(hcaFactory.approvedImplementations(address(unapprovedImplementation)));
    }

    function test_setImplementationApprovalRejectsUnauthorizedCallerAndZeroAddress() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        vm.prank(attacker);
        hcaFactory.setImplementationApproval(address(unapprovedImplementation), true);

        vm.expectRevert(StandaloneHCAFactory.HCAImplementationCannotBeZero.selector);
        hcaFactory.setImplementationApproval(address(0), true);
    }

    function test_removingImplementationApprovalDoesNotRewriteExistingCertification() public {
        address hca = hcaFactory.deploy(owner, address(implementation), USER_SALT);

        hcaFactory.setImplementationApproval(address(implementation), false);

        assertEq(hcaFactory.hcaOwners(hca), owner);
        assertEq(hcaFactory.authorizedOwnerOf(hca), owner);

        vm.expectRevert(
            abi.encodeWithSelector(
                StandaloneHCAFactory.HCAImplementationNotApproved.selector,
                address(implementation)
            )
        );
        hcaFactory.deploy(owner, address(implementation), USER_SALT + 1);
    }

    function test_rejectsZeroOwnerOrImplementation() public {
        vm.expectRevert(StandaloneHCAFactory.OwnerCannotBeZero.selector);
        hcaFactory.deploy(address(0), address(implementation), USER_SALT);

        vm.expectRevert(StandaloneHCAFactory.HCAImplementationCannotBeZero.selector);
        hcaFactory.deploy(owner, address(0), USER_SALT);
    }

    function test_rejectsUnapprovedInitialImplementationWithoutCertification() public {
        address expected = _expectedAddress(owner, address(unapprovedImplementation), USER_SALT);

        vm.expectRevert(
            abi.encodeWithSelector(
                StandaloneHCAFactory.HCAImplementationNotApproved.selector,
                address(unapprovedImplementation)
            )
        );
        hcaFactory.deploy(owner, address(unapprovedImplementation), USER_SALT);

        assertEq(expected.code.length, 0);
        assertEq(hcaFactory.hcaOwners(expected), address(0));
    }

    function test_rejectsInitializerThatChangesImplementationWithoutCertification() public {
        ImplementationSwappingInitializer swappingImplementation =
            new ImplementationSwappingInitializer(address(otherImplementation));
        hcaFactory.setImplementationApproval(address(swappingImplementation), true);
        address expected = _expectedAddress(owner, address(swappingImplementation), USER_SALT);

        vm.expectRevert(
            abi.encodeWithSelector(
                StandaloneHCAFactory.UnexpectedHCAImplementation.selector,
                address(swappingImplementation),
                address(otherImplementation)
            )
        );
        hcaFactory.deploy(owner, address(swappingImplementation), USER_SALT);

        assertEq(expected.code.length, 0);
        assertEq(hcaFactory.hcaOwners(expected), address(0));
    }

    function test_rejectsInitializerThatReportsUnexpectedOwner() public {
        OwnerSpoofingInitializer spoofingImplementation = new OwnerSpoofingInitializer(otherOwner);
        hcaFactory.setImplementationApproval(address(spoofingImplementation), true);
        address expected = _expectedAddress(owner, address(spoofingImplementation), USER_SALT);

        vm.expectRevert(
            abi.encodeWithSelector(
                StandaloneHCAFactory.UnexpectedHCAOwner.selector,
                owner,
                otherOwner
            )
        );
        hcaFactory.deploy(owner, address(spoofingImplementation), USER_SALT);

        assertEq(expected.code.length, 0);
        assertEq(hcaFactory.hcaOwners(expected), address(0));
    }

    function test_rejectsInitializerWhoseOwnerIsUnavailable() public {
        RevertingOwnerInitializer revertingImplementation = new RevertingOwnerInitializer();
        hcaFactory.setImplementationApproval(address(revertingImplementation), true);
        address expected = _expectedAddress(owner, address(revertingImplementation), USER_SALT);

        vm.expectRevert(
            abi.encodeWithSelector(StandaloneHCAFactory.HCAOwnerUnavailable.selector, expected)
        );
        hcaFactory.deploy(owner, address(revertingImplementation), USER_SALT);

        assertEq(expected.code.length, 0);
        assertEq(hcaFactory.hcaOwners(expected), address(0));
    }

    function _newImplementation(string memory entryPointName)
        internal
        returns (StandaloneSingleOwnerHCA)
    {
        return
            new StandaloneSingleOwnerHCA(
                makeAddr(entryPointName),
                address(new MockValidatorModule()),
                address(new MockExecutorModule()),
                "",
                _deployPermissionedAddressSet(address(this)),
                IAddressSet(address(0)),
                hcaFactory
            );
    }

    function _deployPermissionedAddressSet(address rootAccount) internal returns (IAddressSet) {
        return
            IAddressSet(
                deployCode(PERMISSIONED_ADDRESS_SET_ARTIFACT, abi.encode(rootAccount, false))
            ); // PermissionedAddressSet.constructor()
    }

    function _expectedAddress(address owner_, address implementation_, uint256 userSalt)
        internal
        view
        returns (address)
    {
        bytes32 outerSalt =
            keccak256(
                abi.encode(
                    address(hcaFactory),
                    hcaFactory.deploymentSalt(owner_, implementation_, userSalt)
                )
            );
        bytes memory bytecode =
            CloneProxyBytecode.creationCode(verifiableFactory.proxyLogic(), outerSalt);
        return Create2.computeAddress(outerSalt, keccak256(bytecode), address(verifiableFactory));
    }
}


/// @title Implementation-Swapping Initializer
/// @notice Models initialization code that replaces its proxy implementation before returning.
contract ImplementationSwappingInitializer {
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address internal immutable REPLACEMENT;

    /// @param replacement The implementation installed during initialization.
    constructor(address replacement) {
        REPLACEMENT = replacement;
    }

    /// @notice Replaces the proxy implementation during initialization.
    function initializeAccount(bytes calldata) external {
        address replacement = REPLACEMENT;
        assembly {
            sstore(IMPLEMENTATION_SLOT, replacement)
        }
    }
}


/// @title Owner-Spoofing Initializer
/// @notice Models an implementation that ignores the requested owner during initialization.
contract OwnerSpoofingInitializer {
    address internal immutable REPORTED_OWNER;

    /// @param reportedOwner The owner returned after initialization.
    constructor(address reportedOwner) {
        REPORTED_OWNER = reportedOwner;
    }

    /// @notice Accepts initialization without binding the supplied owner.
    function initializeAccount(bytes calldata) external {}

    /// @notice Returns the configured owner.
    function owner() external view returns (address) {
        return REPORTED_OWNER;
    }
}


/// @title Reverting-Owner Initializer
/// @notice Models an implementation that initializes but cannot report an owner.
contract RevertingOwnerInitializer {
    error OwnerUnavailable();

    /// @notice Accepts initialization without exposing an owner.
    function initializeAccount(bytes calldata) external {}

    /// @notice Reverts instead of returning an owner.
    function owner() external pure returns (address) {
        revert OwnerUnavailable();
    }
}
