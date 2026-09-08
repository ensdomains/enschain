// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Test} from "forge-std/Test.sol";

import {IENSIP15} from "~src/universalResolver/interfaces/IENSIP15.sol";
import {MockENSIP15} from "~test/mocks/MockENSIP15.sol";

contract MockENSIP15Test is Test {
    MockENSIP15 ensip15;

    function setUp() external {
        ensip15 = new MockENSIP15();
    }

    function test_isNormalized() external view {
        assertEq(ensip15.normalize("abc"), "abc");
    }

    function test_canNormalize_case() external view {
        assertEq(ensip15.normalize("ABC"), "abc");
    }

    function test_canNormalize_expand() external view {
        assertEq(ensip15.normalize("a'z"), unicode"a\u2019z");
    }

    function test_canNormalize_shrink() external view {
        assertEq(ensip15.normalize(unicode"a\u00ADz"), "az");
    }

    function test_canNormalize_mixed() external view {
        assertEq(ensip15.normalize(unicode"ABC\u00AD123's"), "abc123\u2019s");
    }

    function test_cannotNormalize() external {
        vm.expectRevert(abi.encodeWithSelector(IENSIP15.CannotNormalize.selector, " "));
        ensip15.normalize(" ");
    }
}
