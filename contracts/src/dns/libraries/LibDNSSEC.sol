// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {RRUtils} from "@ens/contracts/dnssec-oracle/RRUtils.sol";
import {BytesUtils} from "@ens/contracts/utils/BytesUtils.sol";

library LibDNSSEC {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Some raw TXT data was incorrectly encoded.
    /// @dev Error selector: `0xf4ba19b7`
    error InvalidTXT();

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev DNS resource-record class for the Internet (`IN`), as defined in RFC 1035 section 3.2.4.
    uint16 constant CLASS_INET = 1;

    /// @dev DNS resource-record type for TXT records, as defined in RFC 1035 section 3.3.14.
    uint16 constant QTYPE_TXT = 16;

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @dev Returns `true` if `iter` points to a TXT record of class `IN` whose owner name
    ///      matches `name`.
    /// @param iter The current position in the resource-record iteration.
    /// @param name The DNS-encoded name to match against the record's owner name.
    /// @return `true` if the record is a matching Internet-class TXT record.
    function isTXTForName(RRUtils.RRIterator memory iter, bytes memory name)
        internal
        pure
        returns (bool)
    {
        return
            iter.class == CLASS_INET &&
            iter.dnstype == QTYPE_TXT &&
            BytesUtils.equals(iter.data, iter.offset, name, 0, name.length);
    }

    /// @dev Decode `v[off:end]` as raw TXT chunks.
    ///      Encoding: `(byte(n) <n-bytes>)...`
    ///      Reverts `InvalidTXT` if the data is malformed.
    /// @param v The raw TXT data.
    /// @param off The offset of the record data.
    /// @param end The upper bound of the record data.
    /// @return txt The decoded TXT value.
    function decodeTXT(bytes memory v, uint256 off, uint256 end)
        internal
        pure
        returns (bytes memory txt)
    {
        if (end > v.length) {
            revert InvalidTXT();
        }
        txt = new bytes(end - off);
        assembly {
            let ptr := add(v, 32)
            off := add(ptr, off) // start of input
            end := add(ptr, end) // end of input
            ptr := add(txt, 32) // start of output
            // prettier-ignore
            for { } lt(off, end) { } { // while input
                let size := byte(0, mload(off)) // length of chunk
                off := add(off, 1) // advance input
                if size { // length > 0
                    let next := add(off, size) // compute end of chunk
                    if gt(next, end) { // beyond end
                        end := 0 // error: overflow
                        break
                    }
                    mcopy(ptr, off, size) // copy chunk
                    off := next // advance input
                    ptr := add(ptr, size) // advance output
                }
            }
            mstore(txt, sub(ptr, add(txt, 32))) // truncate
        }
        if (off != end) {
            revert InvalidTXT(); // overflow or junk at end
        }
    }
}
