// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// solhint-disable private-vars-leading-underscore, state-visibility, func-name-mixedcase

import {ENSRegistry} from "@ens/contracts/registry/ENSRegistry.sol";
import {ReverseRegistrar} from "@ens/contracts/reverseRegistrar/ReverseRegistrar.sol";
import {MockOwnable} from "@ens/contracts/test/mocks/MockOwnable.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {MockContractNamer} from "~test/mocks/MockContractNamer.sol";
import {ReverseRegistrarAdapter} from "~src/reverse-registrar/ReverseRegistrarAdapter.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {
    IReverseRegistrarAdapter
} from "~src/reverse-registrar/interfaces/IReverseRegistrarAdapter.sol";
import {AccountNamerLib} from "~src/reverse-registrar/libraries/AccountNamerLib.sol";
import {HCAAuthorizer} from "~src/hca/HCAAuthorizer.sol";
import {IStandaloneHCAFactory} from "~src/hca/interfaces/IStandaloneHCAFactory.sol";
import {HCAFixture} from "~test/fixtures/HCAFixture.sol";

/// @title Reverse Registrar Adapter Tests
/// @notice Exercises authorization and naming through the reverse registrar adapter.
contract ReverseRegistrarAdapterTest is HCAFixture {
    bytes32 constant REVERSE_LABELHASH = keccak256("reverse");
    bytes32 constant ADDR_LABELHASH = keccak256("addr");
    bytes32 constant REVERSE_NODE = keccak256(abi.encodePacked(bytes32(0), REVERSE_LABELHASH));

    ENSRegistry registry;
    ReverseRegistrar reverseRegistrar;
    ReverseRegistrarAdapter reverseAdapter;
    MockContractNamer delegatedNamer;

    address owner = makeAddr("owner");
    address actor = makeAddr("actor");
    address resolver = makeAddr("resolver");

    function setUp() external {
        deployHCAFixture();

        registry = new ENSRegistry();
        reverseRegistrar = new ReverseRegistrar(registry);
        delegatedNamer = new MockContractNamer(owner);

        reverseAdapter = new ReverseRegistrarAdapter(
            reverseRegistrar,
            IStandaloneHCAFactory(address(standaloneHCAFactory)),
            delegatedNamer
        );

        registry.setSubnodeOwner(bytes32(0), REVERSE_LABELHASH, address(this));
        registry.setSubnodeOwner(REVERSE_NODE, ADDR_LABELHASH, address(reverseRegistrar));

        reverseRegistrar.setController(address(reverseAdapter), true);
    }

    function test_reverse_constructor() external view {
        assertEq(
            address(reverseAdapter.REVERSE_REGISTRAR()),
            address(reverseRegistrar),
            "REVERSE_REGISTRAR"
        );
        assertEq(
            address(reverseAdapter.STANDALONE_HCA_FACTORY()),
            address(standaloneHCAFactory),
            "STANDALONE_HCA_FACTORY"
        );
        assertEq(address(reverseAdapter.CONTRACT_NAMER()), address(delegatedNamer), "CONTRACT_NAMER");
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(reverseAdapter),
                type(IContractNamer).interfaceId
            )
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(reverseAdapter),
                type(IReverseRegistrarAdapter).interfaceId
            )
        );
    }

    function test_delegatesContractNamer() external view {
        assertTrue(reverseAdapter.isContractNamer(owner));
        assertFalse(reverseAdapter.isContractNamer(actor));
    }

    function test_claim_EOA() external {
        vm.prank(owner);
        bytes32 node = reverseAdapter.claim(owner, resolver);

        assertEq(node, reverseRegistrar.node(owner), "node");
        assertEq(registry.owner(node), owner, "owner");
        assertEq(registry.resolver(node), resolver, "resolver");
    }

    function test_claim_revert_unauthorized() external {
        vm.expectRevert(abi.encodeWithSelector(AccountNamerLib.UnauthorizedNamer.selector, actor));
        vm.prank(actor);
        reverseAdapter.claim(owner, resolver);
    }

    function test_claim_Ownable() external {
        MockOwnable c = new MockOwnable(owner);

        vm.prank(owner);
        bytes32 node = reverseAdapter.claim(address(c), resolver);

        assertEq(node, reverseRegistrar.node(address(c)), "node");
        assertEq(registry.owner(node), owner, "owner");
        assertEq(registry.resolver(node), resolver, "resolver");
    }

    function test_claim_IContractNamer() external {
        MockContractNamer c = new MockContractNamer(owner);

        vm.prank(owner);
        bytes32 node = reverseAdapter.claim(address(c), resolver);

        assertEq(node, reverseRegistrar.node(address(c)), "node");
        assertEq(registry.owner(node), owner, "owner");
        assertEq(registry.resolver(node), resolver, "resolver");
    }

    function test_claimWithHCA_EOA() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));

        vm.prank(hca);
        bytes32 node = reverseAdapter.claimWithHCA(owner, resolver);

        assertEq(node, reverseRegistrar.node(owner), "node");
        assertEq(registry.owner(node), owner, "owner");
        assertEq(registry.resolver(node), resolver, "resolver");
    }

    function test_claimWithHCA_revert_hcaOwnerMismatch_ownable() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));
        MockOwnable c = new MockOwnable(owner);

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCAOwnerMismatch.selector, address(c), owner)
        );
        vm.prank(hca);
        reverseAdapter.claimWithHCA(address(c), resolver);
    }

    function test_claimWithHCA_revert_hcaOwnerMismatch_contractNamer() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));
        MockContractNamer c = new MockContractNamer(owner);

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCAOwnerMismatch.selector, address(c), owner)
        );
        vm.prank(hca);
        reverseAdapter.claimWithHCA(address(c), resolver);
    }

    function test_claimWithHCA_revert_hcaDeploymentNotTrusted() external {
        address hca =
            verifiableFactory.deployProxy(
                address(trustedHCAImpl),
                999,
                abi.encodeCall(trustedHCAImpl.initialize, (owner))
            );

        vm.expectRevert(abi.encodeWithSelector(HCAAuthorizer.HCADeploymentNotTrusted.selector, hca));
        vm.prank(hca);
        reverseAdapter.claimWithHCA(owner, resolver);
    }

    function test_claimWithHCA_revert_hcaOwnerMismatch() external {
        address hca = _deployHCA(owner, address(trustedHCAImpl));

        vm.expectRevert(
            abi.encodeWithSelector(HCAAuthorizer.HCAOwnerMismatch.selector, actor, owner)
        );
        vm.prank(hca);
        reverseAdapter.claimWithHCA(actor, resolver);
    }
}
