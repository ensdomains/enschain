//SPDX-License-Identifier: MIT
pragma solidity ~0.8.17;

library BytesUtils {
    /*
     * @dev Returns the keccak-256 hash of a byte range.
     * @param self The byte string to hash.
     * @param offset The position to start hashing at.
     * @param len The number of bytes to hash.
     * @return The hash of the byte range.
     */
    function keccak(
        bytes memory self,
        uint256 offset,
        uint256 len
    ) internal pure returns (bytes32 ret) {
        require(offset + len <= self.length);
        assembly {
            ret := keccak256(add(add(self, 32), offset), len)
        }
    }

    function readLabelsToArray(
        bytes calldata self
    ) internal pure returns (uint256[] memory) {
        uint256[] memory labelArray = new uint256[](self.length);
        uint256 pos = 0;
        uint256 currentLabelIndex = 0;
        uint256 currentLabelLength = uint256(uint8(self[0]));
        while (currentLabelLength != 0) {
            labelArray[currentLabelIndex] = uint256(
                keccak(self, pos + 1, currentLabelLength)
            );
            pos += currentLabelLength + 1;
            currentLabelLength = uint256(uint8(self[pos]));
            currentLabelIndex++;
        }

        uint256[] memory result = new uint256[](currentLabelIndex);
        for (uint256 i = 0; i < currentLabelIndex; i++) {
            result[i] = labelArray[i];
        }
        return result;
    }

    // function readNthLabelFromChild(
    //     bytes memory self,
    //     uint256 labelOffset
    // ) internal pure returns (bytes32) {
    //     string memory labelArray = new string[](self.length);
    //     uint256 pos = 0;
    //     uint256 currentLabelIndex = 0;
    //     uint256 currentLabelLength = uint256(uint8(self[0]));
    //     while (currentLabelLength != 0) {

    //     }
    // }

    // function readNthLabelFromRoot(
    //     bytes memory self,
    //     uint256 labelOffset
    // ) internal pure returns (bytes32) {
    //     uint256 currentLabel = 0;
    //     uint256 pos = 0;
    //     uint256 currentLabelLength = uint256(uint8(self[0]));
    //     while (currentLabel < labelOffset) {
    //         pos += currentLabelLength + 1;
    //         currentLabelLength = uint256(uint8(self[pos]));
    //         currentLabel++;
    //     }
    //     pos += 1;
    //     return keccak(self, pos, currentLabelLength);
    // }
}
