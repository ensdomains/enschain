// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @title HCA Execution Library
/// @notice Reads selectors and ABI words from policy-controlled execution calldata.
/// @dev Preserves one policy-specific error for malformed execution encodings.
library HCAExecutionLib {
    /// @notice Operation data cannot be decoded as the expected execution call.
    /// @dev Error selector: `0xf679d4db`
    error InvalidOperationEncoding();

    /// @notice Reads a function selector from encoded call data.
    /// @dev Reverts when the call data does not contain a complete selector.
    /// @param callData ABI-encoded call data.
    /// @return callSelector The function selector.
    function selector(bytes memory callData) internal pure returns (bytes4 callSelector) {
        if (callData.length < 4) {
            revert InvalidOperationEncoding();
        }
        return bytes4(callData);
    }

    /// @notice Copies function arguments out of encoded call data.
    /// @dev Reverts when the call data does not contain a complete selector.
    /// @param callData ABI-encoded call data with a function selector prefix.
    /// @return args ABI-encoded function arguments.
    function callArgs(bytes memory callData) internal pure returns (bytes memory args) {
        if (callData.length < 4) {
            revert InvalidOperationEncoding();
        }
        uint256 size = callData.length - 4;
        args = new bytes(size);
        assembly ("memory-safe") {
            mcopy(add(args, 0x20), add(callData, 0x24), size)
        }
    }

    /// @notice Reads an ABI-encoded address argument from call data.
    /// @dev Reverts when the requested ABI word is out of bounds.
    /// @param callData ABI-encoded call data.
    /// @param offset Offset of the ABI word to read.
    /// @return result The decoded address.
    function readAddress(bytes memory callData, uint256 offset)
        internal
        pure
        returns (address result)
    {
        result = address(uint160(readUint(callData, offset)));
    }

    /// @notice Reads a raw ABI word from call data.
    /// @dev Reverts when the requested ABI word is out of bounds.
    /// @param callData ABI-encoded call data.
    /// @param offset Offset of the ABI word to read.
    /// @return result The word as a uint256.
    function readUint(bytes memory callData, uint256 offset) internal pure returns (uint256 result) {
        if (callData.length < offset + 32) {
            revert InvalidOperationEncoding();
        }
        assembly ("memory-safe") {
            result := mload(add(add(callData, 0x20), offset))
        }
    }
}
