// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IENSIP15} from "../interfaces/IENSIP15.sol";

/// @dev Library for normalizing DNS-encoded names into normalized DNS-encoded names.
library LibENSIP15 {
    /// @dev Normalize a name according to ENSIP-15.
    ///      Reverts `DNSEncodingFailed`, `LabelIsEmpty`, `LabelIsTooLong`, and `CannotNormalize`.
    /// @param name DNS-encoded name to normalize.
    /// @param ensip15 ENSIP-15 Normalization implementation.
    /// @return wasNormalized `true` if `name` was already normalized.
    /// @return normalizedName Normalized DNS-encoded name.
    function normalize(bytes memory name, IENSIP15 ensip15)
        internal
        view
        returns (bool wasNormalized, bytes memory normalizedName)
    {
        wasNormalized = true;
        normalizedName = new bytes((NameCoder.countLabels(name, 0) << 8) + 1);
        uint256 offset;
        uint256 dst;
        assembly {
            dst := add(normalizedName, 32)
        }
        for (;;) {
            string memory label;
            (label, offset) = NameCoder.extractLabel(name, offset);
            if (bytes(label).length == 0) {
                break;
            }
            string memory norm = ensip15.normalize(label);
            NameCoder.assertLabelSize(norm);
            wasNormalized = wasNormalized && keccak256(bytes(label)) == keccak256(bytes(norm));
            assembly {
                let n := mload(norm)
                mstore8(dst, n) // write length
                mcopy(add(dst, 1), add(norm, 32), n) // write normalized label
                dst := add(dst, add(n, 1))
            }
        }
        assembly {
            mstore(normalizedName, sub(dst, add(normalizedName, 31))) // truncate
        }
    }
}
