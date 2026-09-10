// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title HCA Permit2 Library
/// @notice Decodes and hashes the fixed Permit2 claim format used by HCA routes.
/// @dev Implements the exact compact claim layout emitted by the supported Rhinestone route.
library HCAPermit2Lib {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice Permit2 fields exposed by the fixed claim encoding.
    struct Claim {
        address spender;
        uint256 nonce;
        uint256 deadline;
        address sourceToken;
        uint256 sourceAmount;
        address recipient;
        uint256 targetChainId;
        uint256 fillExpiry;
        address tokenOut;
        uint256 amountOut;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Length of the fixed Permit2 claim encoding.
    uint256 internal constant CLAIM_DATA_LENGTH = 410;

    /// @dev Permit2 EIP-712 domain type hash.
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    /// @dev Permit2 EIP-712 name hash.
    bytes32 internal constant PERMIT2_NAME_HASH = keccak256("Permit2");

    /// @dev Permit2 token-permissions type hash.
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");

    /// @dev Permit2 destination-token type hash.
    bytes32 internal constant TOKEN_TYPEHASH = keccak256("Token(address token,uint256 amount)");

    /// @dev Permit2 destination target type hash.
    bytes32 internal constant TARGET_TYPEHASH =
        keccak256(
            "Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)Token(address token,uint256 amount)"
        );

    /// @dev Permit2 route mandate type hash.
    bytes32 internal constant MANDATE_TYPEHASH =
        keccak256(
            "Mandate(Target target,uint128 minGas,Op originOps,Op destOps,bytes32 q)Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)Token(address token,uint256 amount)"
        );

    /// @dev Permit2 batch witness type hash.
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256(
            "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,Mandate mandate)Mandate(Target target,uint128 minGas,Op originOps,Op destOps,bytes32 q)Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)Token(address token,uint256 amount)TokenPermissions(address token,uint256 amount)"
        );

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Decodes the fields used by the fixed HCA claim policies.
    /// @dev The caller must require `CLAIM_DATA_LENGTH` bytes before decoding.
    /// @param data The compact claim encoding produced by the Rhinestone SDK.
    /// @return claim The decoded Permit2 claim fields.
    function decode(bytes calldata data) internal pure returns (Claim memory claim) {
        claim.spender = address(bytes20(data[0:20]));
        claim.nonce = uint256(bytes32(data[20:52]));
        claim.deadline = uint256(bytes32(data[52:84]));
        claim.sourceToken = address(uint160(uint256(bytes32(data[85:117]))));
        claim.sourceAmount = uint256(bytes32(data[117:149]));
        claim.recipient = address(bytes20(data[149:169]));
        claim.targetChainId = uint256(bytes32(data[169:201]));
        claim.fillExpiry = uint256(bytes32(data[201:233]));
        claim.tokenOut = address(uint160(uint256(bytes32(data[234:266]))));
        claim.amountOut = uint256(bytes32(data[266:298]));
    }

    /// @dev Reconstructs a Permit2 batch-witness digest from the fixed claim encoding.
    /// @param data The compact claim encoding produced by the Rhinestone SDK.
    /// @param claim The claim fields decoded from `data`.
    /// @param sourceChainId The chain whose Permit2 domain authorized the source tokens.
    /// @param permit2 The Permit2 contract in the signed domain.
    /// @return result The Permit2 EIP-712 digest.
    function digest(bytes calldata data, Claim memory claim, uint256 sourceChainId, address permit2)
        internal
        pure
        returns (bytes32 result)
    {
        bytes32 tokenPermissionsHash =
            _hashElement(
                keccak256(
                    abi.encode(TOKEN_PERMISSIONS_TYPEHASH, claim.sourceToken, claim.sourceAmount)
                )
            );
        bytes32 tokenOutHash =
            _hashElement(keccak256(abi.encode(TOKEN_TYPEHASH, claim.tokenOut, claim.amountOut)));
        bytes32 targetHash =
            keccak256(
                abi.encode(
                    TARGET_TYPEHASH,
                    claim.recipient,
                    tokenOutHash,
                    claim.targetChainId,
                    claim.fillExpiry
                )
            );
        bytes32 mandateHash =
            keccak256(
                abi.encode(
                    MANDATE_TYPEHASH,
                    targetHash,
                    uint128(bytes16(data[298:314])),
                    bytes32(data[314:346]),
                    bytes32(data[346:378]),
                    bytes32(data[378:410])
                )
            );
        bytes32 permitHash =
            keccak256(
                abi.encode(
                    PERMIT_TYPEHASH,
                    tokenPermissionsHash,
                    claim.spender,
                    claim.nonce,
                    claim.deadline,
                    mandateHash
                )
            );
        bytes32 domainSeparator =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, PERMIT2_NAME_HASH, sourceChainId, permit2));
        return MessageHashUtils.toTypedDataHash(domainSeparator, permitHash);
    }

    ////////////////////////////////////////////////////////////////////////
    // Private Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Hashes the packed encoding of a single EIP-712 array element.
    function _hashElement(bytes32 elementHash) private pure returns (bytes32 result) {
        assembly ("memory-safe") {
            mstore(0, elementHash)
            result := keccak256(0, 0x20)
        }
    }
}
