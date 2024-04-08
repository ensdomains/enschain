// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

library NameEncoder {
    function dnsEncodeName(
        string memory name
    ) internal pure returns (bytes memory dnsName) {
        uint8 labelLength = 0;
        bytes memory bytesName = bytes(name);
        uint256 length = bytesName.length;
        dnsName = new bytes(length + 2);
        if (length == 0) {
            dnsName[0] = 0;
            return dnsName;
        }

        // use unchecked to save gas since we check for an underflow
        // and we check for the length before the loop
        unchecked {
            for (uint256 i = length - 1; i >= 0; i--) {
                if (bytesName[i] == ".") {
                    dnsName[i + 1] = bytes1(labelLength);
                    labelLength = 0;
                } else {
                    labelLength += 1;
                    dnsName[i + 1] = bytesName[i];
                }
                if (i == 0) {
                    break;
                }
            }
        }

        dnsName[0] = bytes1(labelLength);
        return dnsName;
    }
}
