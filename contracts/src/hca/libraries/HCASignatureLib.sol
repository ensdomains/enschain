// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title HCA Signature Library
/// @notice Recovers the signature variants produced by the Rhinestone and Nexus integrations.
/// @dev Enforces canonical ECDSA recovery for raw and explicitly EIP-191-wrapped digests.
library HCASignatureLib {
    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Length of one ECDSA signature.
    uint256 internal constant SIGNATURE_LENGTH = 65;

    /// @dev Highest canonical secp256k1 `s` value accepted by EIP-2.
    uint256 private constant _HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Recovers a signer from a Rhinestone-compatible signature.
    /// @dev Values 31 and 32 select EIP-191 wrapping. Values 0, 1, 27, and 28 recover the supplied
    ///      digest directly. Invalid signatures return the zero address.
    /// @param digest The digest represented by the signature.
    /// @param signature The compact ECDSA signature.
    /// @return signer The recovered signer or the zero address.
    function recover(bytes32 digest, bytes calldata signature)
        internal
        pure
        returns (address signer)
    {
        if (signature.length != SIGNATURE_LENGTH) {
            return address(0);
        }

        (bytes32 r, bytes32 s, uint8 v) = rsvFromSignature(signature);
        return recover(digest, r, s, v);
    }

    /// @notice Recovers a signer from separate Rhinestone-compatible signature fields.
    /// @dev Normalizes compact recovery identifiers and rejects non-canonical `s` values.
    /// @param digest The digest represented by the signature.
    /// @param r The ECDSA `r` value.
    /// @param s The ECDSA `s` value.
    /// @param v The recovery identifier and optional EIP-191 mode marker.
    /// @return signer The recovered signer or the zero address.
    function recover(bytes32 digest, bytes32 r, bytes32 s, uint8 v)
        internal
        pure
        returns (address signer)
    {
        if (v == 31 || v == 32) {
            digest = MessageHashUtils.toEthSignedMessageHash(digest);
            v -= 4;
        } else if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) {
            return address(0);
        }
        if (uint256(s) > _HALF_CURVE_ORDER) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }

    /// @notice Checks the raw and EIP-191 UserOperation signatures accepted by the Nexus validator.
    /// @dev Tries the raw digest first unless the signature explicitly selects EIP-191 wrapping.
    /// @param expectedSigner The account owner expected to have signed the digest.
    /// @param digest The EntryPoint UserOperation digest.
    /// @param signature The ECDSA signature to validate.
    /// @return valid Whether the signature is valid for `expectedSigner`.
    function isValidUserOpSignature(address expectedSigner, bytes32 digest, bytes calldata signature)
        internal
        pure
        returns (bool valid)
    {
        if (signature.length != SIGNATURE_LENGTH) {
            return false;
        }

        (bytes32 r, bytes32 s, uint8 v) = rsvFromSignature(signature);

        bool explicitEthSigned = v == 31 || v == 32;
        if (explicitEthSigned) {
            v -= 4;
        } else if (v < 27) {
            v += 27;
        }
        if (v != 27 && v != 28) {
            return false;
        }
        if (uint256(s) > _HALF_CURVE_ORDER) {
            return false;
        }

        address signer;
        if (!explicitEthSigned) {
            signer = ecrecover(digest, v, r, s);
            if (signer != address(0) && signer == expectedSigner) {
                return true;
            }
        }

        signer = ecrecover(MessageHashUtils.toEthSignedMessageHash(digest), v, r, s);
        return signer != address(0) && signer == expectedSigner;
    }

    /// @notice Reads the ECDSA fields from a complete signature.
    /// @dev The caller must verify that the signature has the expected length.
    /// @param signature The ECDSA signature to read.
    /// @return r The ECDSA r value.
    /// @return s The ECDSA s value.
    /// @return v The recovery identifier.
    function rsvFromSignature(bytes calldata signature)
        private
        pure
        returns (bytes32 r, bytes32 s, uint8 v)
    {
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
    }
}
