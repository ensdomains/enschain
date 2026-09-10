// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {LibMem} from "~src/utils/LibMem.sol";

contract LibMemTest is Test {
    function test_ptr() external pure {
        for (uint256 i; i < 100; ++i) {
            bytes memory v = new bytes(i);
            uint256 ptr;
            assembly {
                ptr := add(v, 32)
            }
            assertEq(ptr, LibMem.ptr(v));
        }
    }

    function test_load() external pure {
        for (uint256 i; i < 100; ++i) {
            bytes memory v = new bytes(i);
            uint256 value;
            assembly {
                value := mload(add(v, 32))
            }
            assertEq(value, LibMem.load(LibMem.ptr(v)));
        }
    }

    function test_copy(bytes memory v0) external pure {
        bytes memory v = new bytes(v0.length);
        LibMem.copy(LibMem.ptr(v), LibMem.ptr(v0), v0.length);
        assertEq(v, v0);
    }
}
