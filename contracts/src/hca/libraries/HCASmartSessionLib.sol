// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {HCASignatureLib} from "./HCASignatureLib.sol";

/// @title HCA Smart Session Library
/// @notice Reconstructs the authorization hashes used by Rhinestone Smart Sessions.
/// @dev Shares proof validation between the destination and source HCA session validators.
library HCASmartSessionLib {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice Result of validating one multi-chain owner authorization.
    enum AuthorizationStatus {
        InvalidSelection,
        InvalidSigner,
        Valid
    }

    /// @notice One chain and session digest from a multi-chain authorization.
    struct HashAndChainId {
        uint64 chainId;
        bytes32 sessionDigest;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Size of the mode and permission ID preceding a packed authorization proof.
    uint256 internal constant ENABLE_PREFIX_LENGTH = 33;

    /// @dev Size of one packed chain identifier and session digest.
    uint256 internal constant AUTHORIZATION_ENTRY_LENGTH = 40;

    /// @dev Canonical Smart Session emissary.
    address private constant SMART_SESSION_EMISSARY = 0xad568B3F825A8d5FFc06DD3253526B64D810Ae89;

    /// @dev Canonical one-of-one session validator.
    address private constant OWNABLE_SESSION_VALIDATOR = 0x000000000013fdB5234E4E3162a810F54d9f7E98;

    /// @dev Smart Session EIP-712 domain separator.
    bytes32 private constant SMART_SESSION_DOMAIN_SEPARATOR =
        0xe4b7e03cf1e8e7a6af0eec6f72a68d532e03fdaad0b8326461731cb31803a084;

    /// @dev Signed-session type hash.
    bytes32 private constant SIGNED_SESSION_TYPEHASH =
        0x984917e689987af96289e12c5f5e934fcdf1df4186108f69ff7e8c3df950ce33;

    /// @dev Chain-session type hash.
    bytes32 private constant CHAIN_SESSION_TYPEHASH =
        0xabc350ff4773ba356e85e2d2ee58d7d7511767acdb108b59058f5b4a5afc074b;

    /// @dev Multi-chain session type hash.
    bytes32 private constant MULTI_CHAIN_SESSION_TYPEHASH =
        0xb4323194e4ca3723804b96dc7a0960bde1afff2b080b8b288fdc264c82e21357;

    /// @dev Hash of the default empty Smart Session permissions.
    bytes32 private constant DEFAULT_SIGNED_PERMISSIONS_HASH =
        0x242b79d1322c5e6b12b617584cc2d5766cf18be6feb6acfa469ccf289e11e504;

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Validates the selected chain session and its multi-chain owner signature.
    /// @dev Reconstructs the Smart Session digest before recovering the authorizing signer.
    /// @param expectedOwner The owner that authorized the session set.
    /// @param expectedSessionDigest The session digest authorized for the current chain.
    /// @param selectedIndex The current chain's index in `hashesAndChainIds`.
    /// @param packedSessions Packed chain identifiers and session digests covered by the signature.
    /// @param ownerSignature The owner's ECDSA signature over the multi-chain authorization.
    /// @return status Whether selection and signer validation succeeded.
    function validateMultiChainAuthorization(
        address expectedOwner,
        bytes32 expectedSessionDigest,
        uint256 selectedIndex,
        bytes calldata packedSessions,
        bytes calldata ownerSignature
    )
        internal
        view
        returns (AuthorizationStatus status)
    {
        uint256 packedLength = packedSessions.length;
        uint256 count = packedLength / AUTHORIZATION_ENTRY_LENGTH;
        if (
            count == 0 ||
            packedLength != count * AUTHORIZATION_ENTRY_LENGTH ||
            selectedIndex >= count
        ) {
            return AuthorizationStatus.InvalidSelection;
        }

        uint256 selectedOffset = selectedIndex * AUTHORIZATION_ENTRY_LENGTH;
        uint64 selectedChainId = uint64(bytes8(packedSessions[selectedOffset:selectedOffset + 8]));
        bytes32 selectedSessionDigest =
            bytes32(packedSessions[selectedOffset + 8:selectedOffset + AUTHORIZATION_ENTRY_LENGTH]);
        if (selectedChainId != block.chainid || selectedSessionDigest != expectedSessionDigest) {
            return AuthorizationStatus.InvalidSelection;
        }

        bytes32[] memory chainSessionHashes = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            uint256 offset = i * AUTHORIZATION_ENTRY_LENGTH;
            chainSessionHashes[i] = chainSessionHash(
                uint64(bytes8(packedSessions[offset:offset + 8])),
                bytes32(packedSessions[offset + 8:offset + AUTHORIZATION_ENTRY_LENGTH])
            );
        }
        address signer =
            HCASignatureLib.recover(multiChainDigest(chainSessionHashes), ownerSignature);
        return
            signer == expectedOwner ? AuthorizationStatus.Valid : AuthorizationStatus.InvalidSigner;
    }

    /// @notice Derives the hashes that bind a one-of-one key to an account and policy.
    /// @dev Matches the permission and session hashing used by Rhinestone Smart Sessions.
    /// @param account The account authorized on the selected chain.
    /// @param sessionKey The session key installed in the Ownable validator.
    /// @param salt The application policy bound into the Smart Session.
    /// @return permissionId The standard Smart Session permission identifier.
    /// @return sessionDigest The signed-session struct hash for the selected chain.
    function authorizationHashes(address account, address sessionKey, bytes32 salt)
        internal
        pure
        returns (bytes32 permissionId, bytes32 sessionDigest)
    {
        bytes32 validatorInitDataHash;
        assembly ("memory-safe") {
            let ptr := mload(0x40)

            // Hash the canonical ABI encoding of the validator, its dynamic init data, and salt.
            mstore(ptr, OWNABLE_SESSION_VALIDATOR)
            mstore(add(ptr, 0x20), 0x60)
            mstore(add(ptr, 0x40), salt)
            mstore(add(ptr, 0x60), 0x80)
            mstore(add(ptr, 0x80), 1)
            mstore(add(ptr, 0xa0), 0x40)
            mstore(add(ptr, 0xc0), 1)
            mstore(add(ptr, 0xe0), sessionKey)
            validatorInitDataHash := keccak256(add(ptr, 0x80), 0x80)
            permissionId := keccak256(ptr, 0x100)

            // Reuse the buffer for the fixed-width signed-session struct.
            mstore(ptr, SIGNED_SESSION_TYPEHASH)
            mstore(add(ptr, 0x20), account)
            mstore(add(ptr, 0x40), not(0))
            mstore(add(ptr, 0x60), 0)
            mstore(add(ptr, 0x80), DEFAULT_SIGNED_PERMISSIONS_HASH)
            mstore(add(ptr, 0xa0), salt)
            mstore(add(ptr, 0xc0), OWNABLE_SESSION_VALIDATOR)
            mstore(add(ptr, 0xe0), validatorInitDataHash)
            mstore(add(ptr, 0x100), SMART_SESSION_EMISSARY)
            sessionDigest := keccak256(ptr, 0x120)

            mstore(0x40, add(ptr, 0x120))
        }
    }

    /// @notice Hashes a chain identifier and its signed-session digest.
    /// @dev Produces one item in the ordered multi-chain authorization array.
    /// @param chainId The chain containing the authorized account.
    /// @param signedSessionHash The signed-session struct hash for the chain.
    /// @return result The chain-session struct hash.
    function chainSessionHash(uint64 chainId, bytes32 signedSessionHash)
        internal
        pure
        returns (bytes32 result)
    {
        return keccak256(abi.encode(CHAIN_SESSION_TYPEHASH, chainId, signedSessionHash));
    }

    /// @notice Produces the owner-signature digest for a multi-chain session authorization.
    /// @dev Applies the Smart Session EIP-712 domain to the ordered chain-session hash.
    /// @param chainSessionHashes The ordered chain-session struct hashes.
    /// @return result The Smart Session EIP-712 digest.
    function multiChainDigest(bytes32[] memory chainSessionHashes)
        internal
        pure
        returns (bytes32 result)
    {
        bytes32 chainSessionsHash;
        assembly ("memory-safe") {
            chainSessionsHash :=
                keccak256(add(chainSessionHashes, 0x20), shl(5, mload(chainSessionHashes)))
        }
        bytes32 structHash = keccak256(abi.encode(MULTI_CHAIN_SESSION_TYPEHASH, chainSessionsHash));
        return MessageHashUtils.toTypedDataHash(SMART_SESSION_DOMAIN_SEPARATOR, structHash);
    }
}
