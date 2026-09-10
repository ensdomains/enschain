// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IEnhancedAccessControl} from "~src/access-control/interfaces/IEnhancedAccessControl.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {IPermissionedAddressSet} from "~src/utils/interfaces/IPermissionedAddressSet.sol";
import {IAddressSet} from "~src/utils/interfaces/IAddressSet.sol";
import {
    PermissionedAddressSet,
    ROLE_APPROVE,
    ROLE_CAN_NAME,
    ROLE_CALLABLE
} from "~src/utils/PermissionedAddressSet.sol";

contract PermissionedAddressSetTest is Test {
    PermissionedAddressSet set;
    MockCalled called;

    address testAddr = makeAddr("something");
    address friend = makeAddr("anotherAdmin");

    function setUp() external {
        set = new PermissionedAddressSet(address(this), false);
        called = new MockCalled();
    }

    function initWithCallable() external {
        vm.expectEmit();
        emit IPermissionedAddressSet.CallableChanged(true, address(this));
        new PermissionedAddressSet(address(this), true);
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(address(set), type(IPermissionedAddressSet).interfaceId),
            "IPermissionedAddressSet"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(set), type(IAddressSet).interfaceId),
            "IAddressSet"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(set), type(IContractNamer).interfaceId),
            "IContractNamer"
        );
    }

    function test_approve_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                set.ROOT_RESOURCE(),
                ROLE_APPROVE,
                friend
            )
        );
        vm.prank(friend);
        set.approve(testAddr, true);
    }

    function test_approve_unchanged() external {
        vm.expectRevert();
        set.approve(testAddr, false);
    }

    function test_approve() external {
        assertFalse(set.includes(testAddr));

        vm.expectEmit();
        emit IPermissionedAddressSet.ApprovalChanged(testAddr, true, address(this));
        set.approve(testAddr, true);

        assertTrue(set.includes(testAddr));

        vm.expectEmit();
        emit IPermissionedAddressSet.ApprovalChanged(testAddr, false, address(this));
        set.approve(testAddr, false);

        assertFalse(set.includes(testAddr));
    }

    function test_approve_multiple(bool[] calldata approved) external {
        for (uint160 i; i < approved.length; ++i) {
            if (approved[i]) {
                set.approve(address(i), true);
            }
        }
        for (uint160 i; i < approved.length; ++i) {
            assertEq(set.includes(address(i)), approved[i]);
        }
    }

    function test_approve_granted() external {
        vm.expectRevert();
        vm.prank(friend);
        set.approve(testAddr, true);

        set.grantRootRoles(ROLE_APPROVE, friend);

        vm.prank(friend);
        set.approve(testAddr, true);
    }

    function test_setCallable() external {
        assertFalse(set.isCallable());

        vm.expectEmit();
        emit IPermissionedAddressSet.CallableChanged(true, address(this));
        set.setCallable(true);

        assertTrue(set.isCallable());
    }

    function test_setCallable_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                set.ROOT_RESOURCE(),
                ROLE_CALLABLE,
                friend
            )
        );
        vm.prank(friend);
        set.setCallable(true);
    }

    function test_call() external {
        set.approve(friend, true);
        set.setCallable(true);

        vm.prank(friend);
        (bool ok, bytes memory v) =
            set.call(address(called), abi.encodeCall(MockCalled.add, (123)));
        assertTrue(ok);
        assertEq(v, abi.encode(124));
    }

    function test_call_revert() external {
        set.approve(friend, true);
        set.setCallable(true);

        vm.prank(friend);
        (bool ok, bytes memory v) =
            set.call(address(called), abi.encodeCall(MockCalled.add, (123)));
        assertTrue(ok);
        assertEq(v, abi.encode(124));
    }

    function test_call_notCallable() external {
        vm.expectRevert(abi.encodeWithSelector(IPermissionedAddressSet.NotCallable.selector));
        vm.prank(friend);
        set.call(address(this), "");
    }

    function test_call_notApproved() external {
        set.setCallable(true);
        vm.expectRevert(
            abi.encodeWithSelector(IPermissionedAddressSet.NotApproved.selector, address(this))
        );
        set.call(address(called), "");
    }

    function test_isContractNamer() external {
        assertTrue(set.isContractNamer(address(this)));

        assertFalse(set.isContractNamer(friend), "before");

        set.grantRootRoles(ROLE_CAN_NAME, friend);
        assertTrue(set.isContractNamer(friend), "granted");

        set.revokeRootRoles(ROLE_CAN_NAME, friend);
        assertFalse(set.isContractNamer(friend), "revoked");
    }
}


contract MockCalled {
    function add(uint256 x) external pure returns (uint256) {
        return x + 1;
    }
}
