// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// solhint-disable private-vars-leading-underscore, state-visibility, func-name-mixedcase

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {DefaultReverseRegistrar} from "@ens/contracts/reverseRegistrar/DefaultReverseRegistrar.sol";
import {MockOwnable} from "@ens/contracts/test/mocks/MockOwnable.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {
    DefaultReverseRegistrarAdapter
} from "~src/reverse-registrar/DefaultReverseRegistrarAdapter.sol";
import {MockContractNamer} from "~test/mocks/MockContractNamer.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {
    IDefaultReverseRegistrarAdapter
} from "~src/reverse-registrar/interfaces/IDefaultReverseRegistrarAdapter.sol";
import {AccountNamerLib} from "~src/reverse-registrar/libraries/AccountNamerLib.sol";
import {HCAAuthorizer} from "~src/hca/HCAAuthorizer.sol";
import {IStandaloneHCAFactory} from "~src/hca/interfaces/IStandaloneHCAFactory.sol";
import {IStandaloneHCAOwner} from "~src/hca/interfaces/IStandaloneHCAOwner.sol";
import {PermissionedAddressSet} from "~src/utils/PermissionedAddressSet.sol";
import {IAddressSet} from "~src/utils/interfaces/IAddressSet.sol";
import {HCAFixture} from "~test/fixtures/HCAFixture.sol";

/// @title Default Reverse Registrar Adapter Tests
/// @notice Exercises authorization and naming through the default reverse registrar adapter.
contract DefaultReverseRegistrarAdapterTest is HCAFixture {
    DefaultReverseRegistrar defaultReverseRegistrar;
    DefaultReverseRegistrarAdapter defaultAdapter;
    MockContractNamer delegatedNamer;

    address owner = makeAddr("owner");
    address actor = makeAddr("actor");
    string name = "primary.eth";

    function setUp() external {
        deployHCAFixture();

        defaultReverseRegistrar = new DefaultReverseRegistrar();
        delegatedNamer = new MockContractNamer(owner);

        defaultAdapter = new DefaultReverseRegistrarAdapter(
            defaultReverseRegistrar,
            IStandaloneHCAFactory(address(standaloneHCAFactory)),
            delegatedNamer
        );

        defaultReverseRegistrar.setController(address(defaultAdapter), true);
    }

    function test_constructor() external view {
        assertEq(
            address(defaultAdapter.DEFAULT_REVERSE_REGISTRAR()),
            address(defaultReverseRegistrar),
            "DEFAULT_REVERSE_REGISTRAR"
        );
        assertEq(
            address(defaultAdapter.STANDALONE_HCA_FACTORY()),
            address(standaloneHCAFactory),
            "STANDALONE_HCA_FACTORY"
        );
        assertEq(address(defaultAdapter.CONTRACT_NAMER()), address(delegatedNamer), "CONTRACT_NAMER");
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(defaultAdapter),
                type(IContractNamer).interfaceId
            )
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(defaultAdapter),
                type(IDefaultReverseRegistrarAdapter).interfaceId
            )
        );
    }

    function test_delegatesContractNamer() external view {
        assertTrue(defaultAdapter.isContractNamer(owner));
        assertFalse(defaultAdapter.isContractNamer(actor));
    }

    function test_setName_EOA() external {
        vm.prank(owner);
        defaultAdapter.setName(owner, name);

        assertEq(defaultReverseRegistrar.nameForAddr(owner), name);
    }

    function test_setName_revert_unauthorized() external {
        vm.expectRevert(abi.encodeWithSelector(AccountNamerLib.UnauthorizedNamer.selector, actor));
        vm.prank(actor);
        defaultAdapter.setName(owner, name);
    }

    function test_setName_Ownable() external {
        MockOwnable c = new MockOwnable(owner);

        vm.prank(owner);
        defaultAdapter.setName(address(c), name);

        assertEq(defaultReverseRegistrar.nameForAddr(address(c)), name);
    }

    function test_setName_IContractNamer() external {
        MockContractNamer c = new MockContractNamer(owner);

        vm.prank(owner);
        defaultAdapter.setName(address(c), name);

        assertEq(defaultReverseRegistrar.nameForAddr(address(c)), name);
    }

    function test_setNameWithHCA_EOA() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));

        vm.prank(hca);
        defaultAdapter.setNameWithHCA(owner, name);

        assertEq(defaultReverseRegistrar.nameForAddr(owner), name);
        assertEq(defaultReverseRegistrar.nameForAddr(hca), "");
    }

    function test_setNameWithHCA_revert_hcaOwnerMismatch_ownable() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));
        MockOwnable c = new MockOwnable(owner);

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCAOwnerMismatch.selector, address(c), owner)
        );
        vm.prank(hca);
        defaultAdapter.setNameWithHCA(address(c), name);
    }

    function test_setNameWithHCA_revert_hcaOwnerMismatch_contractNamer() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));
        MockContractNamer c = new MockContractNamer(owner);

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCAOwnerMismatch.selector, address(c), owner)
        );
        vm.prank(hca);
        defaultAdapter.setNameWithHCA(address(c), name);
    }

    function test_setNameWithHCA_revert_uncertifiedHCA() external {
        address hca =
            verifiableFactory.deployProxy(
                address(untrustedHCAImpl),
                999,
                abi.encodeCall(untrustedHCAImpl.initialize, (owner))
            );

        vm.expectRevert(abi.encodeWithSelector(HCAAuthorizer.HCADeploymentNotTrusted.selector, hca));
        vm.prank(hca);
        defaultAdapter.setNameWithHCA(owner, name);
    }

    function test_setNameWithHCA_revert_uncertifiedImplementation() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                HCAAuthorizer.HCADeploymentNotTrusted.selector,
                address(trustedHCAImpl)
            )
        );
        vm.prank(address(trustedHCAImpl));
        defaultAdapter.setNameWithHCA(owner, name);
    }

    function test_setNameWithHCA_revert_hcaOwnerMismatch() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCAOwnerMismatch.selector, actor, owner)
        );
        vm.prank(hca);
        defaultAdapter.setNameWithHCA(actor, name);
    }

    function test_poc_untrustedProxyTemporarilySpoofsTrustedImplementation() external {
        PermissionedAddressSet trustedHCASet = new PermissionedAddressSet(address(this));
        trustedHCASet.approve(address(trustedHCAImpl), true);
        TransientImplementationSpoofHCA maliciousImplementation =
            new TransientImplementationSpoofHCA();
        address maliciousProxy =
            verifiableFactory.deployProxy(address(maliciousImplementation), 1, "");
        TransientlySpoofableDefaultAdapter legacyAdapter =
            new TransientlySpoofableDefaultAdapter(
                defaultReverseRegistrar,
                verifiableFactory,
                trustedHCASet
            );
        defaultReverseRegistrar.setController(address(legacyAdapter), true);

        TransientImplementationSpoofHCA(maliciousProxy).callAs(
            address(trustedHCAImpl),
            actor,
            address(legacyAdapter),
            abi.encodeCall(TransientlySpoofableDefaultAdapter.setNameWithHCA, (actor, name))
        );

        assertEq(defaultReverseRegistrar.nameForAddr(actor), name);
        assertEq(verifiableFactory.verifyContract(maliciousProxy), address(maliciousImplementation));
    }

    function test_setNameWithHCA_rejectsUnregisteredVerifiableProxySlotSpoof() external {
        TransientImplementationSpoofHCA maliciousImplementation =
            new TransientImplementationSpoofHCA();
        address maliciousProxy =
            verifiableFactory.deployProxy(address(maliciousImplementation), 2, "");

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCADeploymentNotTrusted.selector, maliciousProxy)
        );
        TransientImplementationSpoofHCA(maliciousProxy).callAs(
            address(trustedHCAImpl),
            actor,
            address(defaultAdapter),
            abi.encodeCall(DefaultReverseRegistrarAdapter.setNameWithHCA, (actor, name))
        );

        assertEq(defaultReverseRegistrar.nameForAddr(actor), "");
    }
}


/// @title Transient Implementation-Spoofing HCA
/// @notice Temporarily exposes trusted implementation and owner slots during a nested call.
contract TransientImplementationSpoofHCA {
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @notice Calls a target while transiently presenting a trusted implementation and owner.
    /// @param trustedImplementation The implementation exposed during the nested call.
    /// @param claimedOwner The owner exposed during the nested call.
    /// @param target The authorization target.
    /// @param callData The target calldata.
    /// @return result The nested call result.
    function callAs(
        address trustedImplementation,
        address claimedOwner,
        address target,
        bytes calldata callData
    )
        external
        returns (bytes memory result)
    {
        bytes32 originalImplementation;
        bytes32 originalOwnerSlot;
        assembly {
            originalImplementation := sload(IMPLEMENTATION_SLOT)
            originalOwnerSlot := sload(0)
            sstore(IMPLEMENTATION_SLOT, trustedImplementation)
            sstore(0, claimedOwner)
        }

        bool success;
        (success, result) = target.call(callData);
        if (!success) {
            assembly {
                revert(add(result, 0x20), mload(result))
            }
        }

        assembly {
            sstore(0, originalOwnerSlot)
            sstore(IMPLEMENTATION_SLOT, originalImplementation)
        }
    }
}


/// @title Transiently Spoofable Default Adapter
/// @notice Reproduces implementation-and-owner checks without factory deployment provenance.
contract TransientlySpoofableDefaultAdapter {
    DefaultReverseRegistrar internal immutable REGISTRAR;
    IVerifiableFactory internal immutable VERIFIABLE_FACTORY;
    IAddressSet internal immutable TRUSTED_HCA_SET;

    constructor(
        DefaultReverseRegistrar registrar,
        IVerifiableFactory verifiableFactory,
        IAddressSet trustedHCASet
    )
    {
        REGISTRAR = registrar;
        VERIFIABLE_FACTORY = verifiableFactory;
        TRUSTED_HCA_SET = trustedHCASet;
    }

    /// @notice Sets a reverse name after performing the vulnerable runtime checks.
    /// @param account The account whose name changes.
    /// @param name The reverse name to set.
    function setNameWithHCA(address account, string calldata name) external {
        address implementation = VERIFIABLE_FACTORY.verifyContract(msg.sender);
        require(TRUSTED_HCA_SET.includes(implementation));
        require(IStandaloneHCAOwner(msg.sender).owner() == account);
        REGISTRAR.setNameForAddr(account, name);
    }
}
