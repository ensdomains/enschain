// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {INexus} from "nexus/interfaces/INexus.sol";
import {IExecutor} from "nexus/interfaces/modules/IExecutor.sol";
import {ExecLib} from "nexus/lib/ExecLib.sol";
import {ModeLib} from "nexus/lib/ModeLib.sol";
import {EncodedModuleTypes} from "nexus/lib/ModuleTypeLib.sol";
import {Execution} from "nexus/types/DataTypes.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Mock Registration Intent Executor
/// @notice Test-only executor that validates the HCA's ERC-1271 signature before executing.
contract MockRegistrationIntentExecutor is IExecutor {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice Executor reimbursement included in a single-chain intent.
    struct GasRefund {
        address token;
        uint256 exchangeRate;
        uint256 overhead;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @notice Standard ERC-1271 success return value.
    /// @dev Returned by ERC-1271 validators for valid signatures.
    bytes4 internal constant ERC1271_MAGICVALUE = 0x1626ba7e;

    /// @notice ERC-7579 executor module type id.
    /// @dev Module type ID for executor modules.
    uint256 internal constant MODULE_TYPE_EXECUTOR = 2;

    /// @notice Rhinestone operation mode for ERC-1271 execution.
    bytes32 internal constant ERC7579_ERC1271_MODE = bytes32(uint256(0x0201) << 240);

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 internal constant INTENT_EXECUTOR_NAME_HASH = keccak256("IntentExecutor");
    bytes32 internal constant INTENT_EXECUTOR_VERSION_HASH = keccak256("v0.0.1");
    bytes32 internal constant SINGLE_CHAIN_OPS_TYPEHASH =
        0xbae11135c33effc421d699bbb53d9926a005ed0f2f5eb672c62cbfa943807291;
    bytes32 internal constant OP_TYPEHASH =
        0xdbc520cb50a8aaf3fa06ea43dc3d59d248e52ae638476e3268a1e6e36bffe196;
    bytes32 internal constant EXECUTION_TYPEHASH =
        0x09b0a32e9842b65559835c235891737e06927d59e48a6f0e0512e136a513a9e4;
    bytes32 internal constant GAS_REFUND_TYPEHASH =
        0x0bf04d9dcc5e703a75ba16d19c00f9d87fa30b9a815627102c15624d338eb094;
    bytes32 internal constant NO_GAS_REFUND_HASH =
        0x44db4de84d423abe696e354fc99de162153ee2f8985ab84305061247a78a3be4;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The account did not accept the provided signature.
    /// @dev Error selector: `0x8baa579f`
    error InvalidSignature();

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Executes a batch after validating the account's registration signature.
    /// @param account The standalone HCA account.
    /// @param executions The ERC-7579 executions to run through the account.
    /// @param signature The ERC-1271 signature routed to the account's default validator.
    /// @return returnData Return data from the account execution.
    function execute(INexus account, Execution[] calldata executions, bytes calldata signature)
        external
        returns (bytes[] memory returnData)
    {
        bytes memory operationData = encodeOperation(executions);
        bytes32 digest = keccak256(operationData);
        if (account.isValidSignature(digest, signature) != ERC1271_MAGICVALUE) {
            revert InvalidSignature();
        }

        return
            account.executeFromExecutor(ModeLib.encodeSimpleBatch(), ExecLib.encodeBatch(executions));
    }

    /// @notice Executes a batch after fixed-session verification.
    function executeWithSession(
        INexus account,
        Execution[] calldata executions,
        uint256 nonce,
        bytes calldata signature
    )
        external
        returns (bytes[] memory returnData)
    {
        bytes32 digest = singleChainDigest(address(account), nonce, executions);
        if (account.isValidSignature(digest, signature) != ERC1271_MAGICVALUE) {
            revert InvalidSignature();
        }

        return
            account.executeFromExecutor(ModeLib.encodeSimpleBatch(), ExecLib.encodeBatch(executions));
    }

    /// @notice Executes a batch after refund-aware fixed-session verification.
    function executeWithSessionAndRefund(
        INexus account,
        Execution[] calldata executions,
        uint256 nonce,
        GasRefund calldata gasRefund,
        bytes calldata signature
    )
        external
        returns (bytes[] memory returnData)
    {
        bytes32 digest = singleChainDigestWithRefund(address(account), nonce, executions, gasRefund);
        if (account.isValidSignature(digest, signature) != ERC1271_MAGICVALUE) {
            revert InvalidSignature();
        }

        return
            account.executeFromExecutor(ModeLib.encodeSimpleBatch(), ExecLib.encodeBatch(executions));
    }

    /// @notice Encodes an ERC-7579 ERC-1271 batch operation payload.
    /// @param executions The executions to encode.
    /// @return The encoded operation payload consumed by the validator.
    function encodeOperation(Execution[] calldata executions) public pure returns (bytes memory) {
        return abi.encodePacked(ERC7579_ERC1271_MODE, abi.encode(executions));
    }

    /// @notice Encodes a compact zero-value ERC-7579 session operation.
    /// @param executions The executions to encode.
    /// @return The encoded operation payload consumed by the validator.
    function encodeSessionOperation(Execution[] calldata executions)
        public
        pure
        returns (bytes memory)
    {
        bytes memory packed =
            abi.encodePacked(bytes2(ERC7579_ERC1271_MODE), uint8(executions.length));
        for (uint256 i; i < executions.length; ++i) {
            Execution calldata execution = executions[i];
            if (execution.value != 0 || execution.callData.length > type(uint24).max) {
                revert InvalidSignature();
            }
            packed = bytes.concat(
                packed,
                abi.encodePacked(
                    execution.target,
                    uint24(execution.callData.length),
                    execution.callData
                )
            );
        }
        return packed;
    }

    /// @notice Reproduces the production IntentExecutor's no-refund SingleChainOps digest.
    function singleChainDigest(address account, uint256 nonce, Execution[] calldata executions)
        public
        view
        returns (bytes32)
    {
        return _singleChainDigest(account, nonce, executions, GasRefund(address(0), 0, 0));
    }

    /// @notice Reproduces the production IntentExecutor's refund-aware SingleChainOps digest.
    function singleChainDigestWithRefund(
        address account,
        uint256 nonce,
        Execution[] calldata executions,
        GasRefund calldata gasRefund
    )
        public
        view
        returns (bytes32)
    {
        return _singleChainDigest(account, nonce, executions, gasRefund);
    }

    function _singleChainDigest(
        address account,
        uint256 nonce,
        Execution[] calldata executions,
        GasRefund memory gasRefund
    )
        internal
        view
        returns (bytes32)
    {
        bytes32[] memory executionHashes = new bytes32[](executions.length);
        for (uint256 i; i < executions.length; ++i) {
            Execution calldata execution = executions[i];
            executionHashes[i] = keccak256(
                abi.encode(
                    EXECUTION_TYPEHASH,
                    execution.target,
                    execution.value,
                    keccak256(execution.callData)
                )
            );
        }
        bytes32 operationHash =
            keccak256(
                abi.encode(
                    OP_TYPEHASH,
                    ERC7579_ERC1271_MODE,
                    keccak256(abi.encodePacked(executionHashes))
                )
            );
        bytes32 gasRefundHash = gasRefund.token == address(0) &&
        gasRefund.exchangeRate == 0 &&
        gasRefund.overhead == 0
        ? NO_GAS_REFUND_HASH
        : keccak256(
            abi.encode(
                GAS_REFUND_TYPEHASH,
                gasRefund.token,
                gasRefund.exchangeRate,
                gasRefund.overhead
            )
        );
        bytes32 structHash =
            keccak256(
                abi.encode(SINGLE_CHAIN_OPS_TYPEHASH, account, nonce, operationHash, gasRefundHash)
            );
        bytes32 domainSeparator =
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    INTENT_EXECUTOR_NAME_HASH,
                    INTENT_EXECUTOR_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @notice No-op install hook for ERC-7579 compatibility.
    /// @param data Unused install data.
    function onInstall(bytes calldata data) external pure {
        data;
    }

    /// @notice No-op uninstall hook for ERC-7579 compatibility.
    /// @param data Unused uninstall data.
    function onUninstall(bytes calldata data) external pure {
        data;
    }

    /// @notice Returns whether this module is an executor.
    /// @param moduleTypeId The ERC-7579 module type id.
    /// @return True when the module type is executor.
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @notice Returns the encoded module types supported by this module.
    function getModuleTypes() external pure returns (EncodedModuleTypes) {}

    /// @notice Returns whether this stateless module is initialized for an account.
    /// @param account Unused account address.
    /// @return Always true because there is no per-account storage.
    function isInitialized(address account) external pure returns (bool) {
        account;

        return true;
    }
}
