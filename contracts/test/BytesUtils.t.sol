// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {BytesUtils} from "../src/BytesUtils.sol";
import {NameEncoder} from "./NameEncoder.sol";

contract BytesUtilsTest is Test {
    using BytesUtils for bytes;
    using NameEncoder for string;

    function test_readLabelsToArray() public view {
        string memory name = "one.test.eth";
        bytes memory dnsName = name.dnsEncodeName();
        uint256[] memory labelhashArray = this.calldatawrite(dnsName);
        assertEq(labelhashArray.length, 3);
        assertEq(labelhashArray[0], uint256(keccak256("one")));
        assertEq(labelhashArray[1], uint256(keccak256("test")));
        assertEq(labelhashArray[2], uint256(keccak256("eth")));
    }

    function calldatawrite(
        bytes calldata self
    ) external pure returns (uint256[] memory) {
        uint256[] memory result = self.readLabelsToArray();
        return result;
    }
}
