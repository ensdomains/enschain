// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Test} from "forge-std/Test.sol";

import {LibDNSSEC} from "~src/dns/libraries/LibDNSSEC.sol";

contract LibDNSSECTest is Test {
    function test_decodeTXT() external pure {
        assertEq(_decodeTXT(""), "");
        assertEq(_decodeTXT("\x01a"), "a");
        assertEq(_decodeTXT("\x00\x01a"), "a");
        assertEq(_decodeTXT("\x01a\x01b"), "ab");
        assertEq(_decodeTXT("\x01a\x00\x02bc"), "abc");
    }

    function testFuzz_decodeTXT(uint16 pad) external {
        bytes memory v = new bytes(pad);
        bytes memory u;
        for (uint256 i = vm.randomUint(5); i > 0; i--) {
            bytes memory rng = vm.randomBytes(vm.randomUint(0, 255));
            v = abi.encodePacked(v, uint8(rng.length), rng);
            u = abi.encodePacked(u, rng);
        }
        assertEq(LibDNSSEC.decodeTXT(v, pad, v.length), u);
    }

    function test_decodeTXT_invalid() external {
        vm.expectRevert();
        this._decodeTXT("\x01");
        vm.expectRevert();
        this._decodeTXT("\x01a\x01");
        vm.expectRevert();
        this._decodeTXT("\x00a");
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _decodeTXT(bytes memory v) public pure returns (bytes memory) {
        return LibDNSSEC.decodeTXT(v, 0, v.length);
    }
}
