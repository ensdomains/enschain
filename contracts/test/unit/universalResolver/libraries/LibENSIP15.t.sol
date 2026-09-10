// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Test} from "forge-std/Test.sol";

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IENSIP15} from "~src/universalResolver/interfaces/IENSIP15.sol";
import {LibENSIP15} from "~src/universalResolver/libraries/LibENSIP15.sol";
import {MockENSIP15} from "~test/mocks/MockENSIP15.sol";

contract LibENSIP15Test is Test {
    MockENSIP15 ensip15;

    function setUp() external {
        ensip15 = new MockENSIP15();
    }

    function test_normalize_nullImpl() external {
        vm.expectRevert();
        this._callWithNullImpl();
    }

    function _callWithNullImpl() external view {
        LibENSIP15.normalize(NameCoder.encode("A"), MockENSIP15(address(0)));
    }

    function test_normalize_isNormalized() external view {
        (bool wasNorm, bytes memory norm) = normalize("a.bb.ccc");
        assertTrue(wasNorm);
        assertEq(norm, NameCoder.encode("a.bb.ccc"));
    }

    function test_normalize_canNormalize_empty() external view {
        (bool wasNorm, bytes memory norm) = normalize("");
        assertTrue(wasNorm);
        assertEq(norm, NameCoder.encode(""));
    }

    function test_normalize_canNormalize_mixed() external view {
        (bool wasNorm, bytes memory norm) =
            normalize(unicode"A'.B\u00ADb.cC\u00ADc.\u00ADdD'Dd.Ee");
        assertFalse(wasNorm);
        assertEq(norm, NameCoder.encode(unicode"a\u2019.bb.ccc.dd\u2019dd.ee"));
    }

    function test_normalize_cannotNormalize_invalid() external {
        string memory name = " ";
        vm.expectRevert(abi.encodeWithSelector(IENSIP15.CannotNormalize.selector, name));
        this.normalize(name);
    }

    function test_normalize_cannotNormalize_tooLong() external {
        bytes memory name = new bytes(255);
        bytes memory norm;
        for (uint256 i; i < 255; ++i) {
            name[i] = "'";
            norm = abi.encodePacked(norm, ensip15.normalize("'"));
        }
        vm.expectRevert(abi.encodeWithSelector(NameCoder.LabelIsTooLong.selector, norm));
        this.normalize(string(abi.encodePacked("sub.", name, ".eth")));
    }

    function test_normalize_cannotNormalize_empty() external {
        string memory name = "\u00AD";
        vm.expectRevert(abi.encodeWithSelector(NameCoder.LabelIsEmpty.selector, name));
        this.normalize(name);
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function normalize(string memory inputName) public view returns (bool, bytes memory) {
        return LibENSIP15.normalize(NameCoder.encode(inputName), ensip15);
    }
}
