// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IENSIP15} from "~src/universalResolver/interfaces/IENSIP15.sol";

contract MockENSIP15 is IENSIP15 {
    /// @dev ASCII case-folding: [A-Z] => [a-z], expand: "'" => "\u2019", shrink: "\u00AD" => "".
    ///      Revert `CannotNormalize` if contains " ".
    function normalize(string memory label) external pure returns (string memory) {
        uint256 n = bytes(label).length;
        bytes memory v = new bytes(n * 3);
        uint256 size;
        for (uint256 i; i < n; ++i) {
            bytes1 ch = bytes(label)[i];
            if (ch >= "A" && ch <= "Z") {
                v[size++] = bytes1(uint8(ch) + 32); // mapped (in place)
            } else if (ch == " ") {
                revert CannotNormalize(label); // invalid
            } else if (ch == "'") {
                // mapped (expand)
                // typewriter apostrophe
                // utf8(0x2009) = 0xE28099
                v[size++] = 0xE2;
                v[size++] = 0x80;
                v[size++] = 0x99;
            } else if (ch == 0xC2 && i + 1 < n && bytes(label)[i + 1] == 0xAD) {
                // ignored (shrink)
                // soft hyphen
                // utf8(0xAD) = 0xC2AD
                ++i; // skip
            } else {
                v[size++] = ch; // va.id
            }
        }
        assembly {
            mstore(v, size)
        }
        return string(v);
    }
}
