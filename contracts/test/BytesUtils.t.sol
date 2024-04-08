// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {BytesUtils} from "../src/BytesUtils.sol";
import {NameEncoder} from "./NameEncoder.sol";

contract BytesUtilsTest is Test {
    using BytesUtils for bytes;
    using BytesUtils for uint256[];
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

    function test_namehashUntilLabelOffset_zeroOffset() public pure {
        uint256[] memory labelArray = new uint256[](3);
        labelArray[0] = uint256(keccak256("one"));
        labelArray[1] = uint256(keccak256("test"));
        labelArray[2] = uint256(keccak256("eth"));
        uint256 result = labelArray.namehashUntilLabelOffset(0);
        assertEq(
            result,
            uint256(
                0xdd0d907a053c5f43f9a1814db5dc1a0a4d979a740a04fd56146f63e22fb42f19
            )
        );
    }

    function calldatawrite(
        bytes calldata self
    ) external pure returns (uint256[] memory) {
        uint256[] memory result = self.readLabelsToArray();
        return result;
    }
}
