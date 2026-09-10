// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {PermissionedResolverLib} from "~src/resolver/libraries/PermissionedResolverLib.sol";

contract PermissionedResolverLibTest is Test {
    function test_resource_string(string calldata s) external pure {
        assertEq(PermissionedResolverLib.resource(s), _hash(abi.encodePacked(s)));
    }

    function test_resource_uint256(uint256 x) external pure {
        assertEq(PermissionedResolverLib.resource(x), _hash(abi.encodePacked(x)));
    }

    function test_resource_bytes4(bytes4 x) external pure {
        assertEq(PermissionedResolverLib.resource(x), _hash(abi.encodePacked(x)));
    }

    function _hash(bytes memory v) internal pure returns (uint256) {
        return uint256(keccak256(v));
    }
}
