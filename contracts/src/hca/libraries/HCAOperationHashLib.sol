// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Execution} from "nexus/types/DataTypes.sol";

/// @title HCA Operation Hash Library
/// @notice Reconstructs the operation hashes used by Rhinestone intents.
/// @dev Uses the canonical Nexus execution tuple when decoding operation batches.
library HCAOperationHashLib {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice Decoded ERC-7579 operation reused across hashing and policy validation.
    struct DecodedOperation {
        bytes32 mode;
        Execution[] executions;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Intent operation-call type hash.
    bytes32 internal constant EXECUTION_TYPEHASH =
        keccak256("Ops(address to,uint256 value,bytes data)");

    /// @dev Intent operation type hash.
    bytes32 internal constant OPERATION_TYPEHASH =
        keccak256("Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)");

    /// @notice Rhinestone operation mode for ERC-1271 ERC-7579 execution.
    /// @dev Encoded in the most significant bytes of the operation mode word.
    bytes32 internal constant ERC7579_ERC1271_MODE = bytes32(uint256(0x0201) << 240);

    /// @notice Rhinestone operation mode for emissary ERC-7579 execution.
    /// @dev Encoded in the most significant bytes of the operation mode word.
    bytes32 internal constant ERC7579_EMISSARY_EXECUTION_MODE = bytes32(uint256(0x0204) << 240);

    /// @notice Rhinestone operation mode for ERC-1271 with emissary-execution fallback.
    /// @dev Encoded in the most significant bytes of the operation mode word.
    bytes32 internal constant ERC7579_ERC1271_EMISSARY_EXECUTION_MODE =
        bytes32(uint256(0x0206) << 240);

    /// @dev Bytes preceding the packed execution entries: two mode bytes and one count byte.
    uint256 private constant _PACKED_OPERATION_PREFIX_LENGTH = 3;

    /// @dev Bytes preceding each packed execution's calldata: target and three-byte length.
    uint256 private constant _PACKED_EXECUTION_PREFIX_LENGTH = 23;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice A packed operation is malformed.
    /// @dev Error selector: `0xf679d4db`
    error InvalidOperationEncoding();

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Checks whether an operation mode can execute an HCA policy-controlled batch.
    /// @dev Accepts the ERC-1271 and emissary execution variants supported by the HCA.
    /// @param mode The Rhinestone operation mode.
    /// @return supported Whether the mode is supported by an HCA validator.
    function isSupportedMode(bytes32 mode) internal pure returns (bool supported) {
        return
            mode == ERC7579_ERC1271_MODE ||
            mode == ERC7579_EMISSARY_EXECUTION_MODE ||
            mode == ERC7579_ERC1271_EMISSARY_EXECUTION_MODE;
    }

    /// @notice Checks whether an operation mode binds execution through ERC-1271.
    /// @dev Excludes the emissary-only execution variant.
    /// @param mode The Rhinestone operation mode.
    /// @return supported Whether the mode uses ERC-1271 authorization.
    function isERC1271Mode(bytes32 mode) internal pure returns (bool supported) {
        return mode == ERC7579_ERC1271_MODE || mode == ERC7579_ERC1271_EMISSARY_EXECUTION_MODE;
    }

    /// @notice Decodes a packed zero-value ERC-7579 operation for reuse across validation stages.
    /// @dev The encoding is two mode bytes, a one-byte execution count, then entries containing
    ///      a 20-byte target, three-byte calldata length, and raw calldata. Values are omitted
    ///      because every HCA policy rejects nonzero-value executions.
    /// @param operationData The packed operation.
    /// @return operation The decoded mode and execution array.
    function decode(bytes calldata operationData)
        internal
        pure
        returns (DecodedOperation memory operation)
    {
        (operation, ) = decodeAndHash(operationData);
    }

    /// @notice Decodes and hashes a packed zero-value ERC-7579 operation in one pass.
    /// @dev Reverts unless the execution count and every calldata length consume the input exactly.
    /// @param operationData The packed operation.
    /// @return operation The decoded mode and execution array.
    /// @return operationHash The EIP-712 operation struct hash.
    function decodeAndHash(bytes calldata operationData)
        internal
        pure
        returns (DecodedOperation memory operation, bytes32 operationHash)
    {
        assembly ("memory-safe") {
            function fail() {
                mstore(0, shl(224, 0xf679d4db))
                revert(0, 4)
            }

            if lt(operationData.length, _PACKED_OPERATION_PREFIX_LENGTH) { fail() }

            let count
            {
                let firstWord := calldataload(operationData.offset)
                count := byte(2, firstWord)
                operation := mload(0x40)
                mstore(operation, shl(240, shr(240, firstWord)))
            }

            mstore(add(operation, 0x20), add(operation, 0x40))
            mstore(add(operation, 0x40), count)
            let executionCursor := add(operation, 0x60)
            let hashes := add(executionCursor, shl(5, count))
            mstore(hashes, count)
            let hashCursor := add(hashes, 0x20)
            let free := add(hashCursor, shl(5, count))
            let cursor := _PACKED_OPERATION_PREFIX_LENGTH

            for { let i := 0 } lt(i, count) { i := add(i, 1) } {
                if gt(add(cursor, _PACKED_EXECUTION_PREFIX_LENGTH), operationData.length) {
                    fail()
                }
                let target := shr(96, calldataload(add(operationData.offset, cursor)))
                let callDataLength :=
                    shr(232, calldataload(add(add(operationData.offset, cursor), 20)))
                cursor := add(cursor, _PACKED_EXECUTION_PREFIX_LENGTH)
                if gt(add(cursor, callDataLength), operationData.length) { fail() }

                mstore(executionCursor, free)
                mstore(free, target)
                mstore(add(free, 0x20), 0)
                mstore(add(free, 0x40), add(free, 0x60))
                mstore(add(free, 0x60), callDataLength)
                let callDataPointer := add(free, 0x80)
                mstore(add(callDataPointer, callDataLength), 0)
                calldatacopy(
                    callDataPointer, add(operationData.offset, cursor), callDataLength
                )
                free := and(add(add(callDataPointer, callDataLength), 0x1f), not(0x1f))

                mstore(
                    free,
                    0x09b0a32e9842b65559835c235891737e06927d59e48a6f0e0512e136a513a9e4
                )
                mstore(add(free, 0x20), target)
                mstore(add(free, 0x40), 0)
                mstore(add(free, 0x60), keccak256(callDataPointer, callDataLength))
                mstore(hashCursor, keccak256(free, 0x80))

                executionCursor := add(executionCursor, 0x20)
                hashCursor := add(hashCursor, 0x20)
                cursor := add(cursor, callDataLength)
            }
            if iszero(eq(cursor, operationData.length)) { fail() }

            let executionArrayHash := keccak256(add(hashes, 0x20), shl(5, count))
            mstore(
                free,
                0xdbc520cb50a8aaf3fa06ea43dc3d59d248e52ae638476e3268a1e6e36bffe196
            )
            mstore(add(free, 0x20), mload(operation))
            mstore(add(free, 0x40), executionArrayHash)
            operationHash := keccak256(free, 0x60)
            mstore(0x40, add(free, 0x80))
        }
    }
}
