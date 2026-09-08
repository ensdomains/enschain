// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ERC1271_MAGICVALUE, VALIDATION_FAILED} from "nexus/types/Constants.sol";
import {Execution} from "nexus/types/DataTypes.sol";

import {HCAValidatorBase} from "./HCAValidatorBase.sol";
import {HCAExecutionLib} from "./libraries/HCAExecutionLib.sol";
import {HCAOperationHashLib} from "./libraries/HCAOperationHashLib.sol";
import {HCAPermit2Lib} from "./libraries/HCAPermit2Lib.sol";
import {HCASignatureLib} from "./libraries/HCASignatureLib.sol";
import {HCASmartSessionLib} from "./libraries/HCASmartSessionLib.sol";

/// @title Rhinestone Claim Router
/// @notice Resolves the active claim adapter for a route.
/// @dev Interface selector: `0x9e4ba7aa`
interface IRhinestoneClaimRouter {
    /// @notice Returns the claim adapter for a protocol version and function selector.
    /// @param version The route protocol version.
    /// @param selector The claim function selector.
    /// @return adapter The active claim adapter.
    /// @return adapterTag The adapter metadata tag.
    function getClaimAdapter(bytes2 version, bytes4 selector)
        external
        view
        returns (address adapter, bytes12 adapterTag);
}


/// @title HCA Funding Session Validator
/// @notice Fixed validator for a Nexus that funds an HCA registration from another chain.
/// @dev The Nexus installs one session during account creation. The session can pull the
///      owner's permitted token into the Nexus and sign a Permit2 claim that delivers the
///      configured token to the configured HCA.
contract HCAFundingSessionValidator is HCAValidatorBase {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice Configuration for one Nexus funding session.
    struct SessionConfig {
        bytes32 permissionId;
        address owner;
        uint48 validUntil;
        address sessionKey;
        address sourceToken;
        address destinationRecipient;
        address destinationToken;
        uint64 destinationChainId;
        uint96 maxSourceAmount;
        uint96 maxDestinationAmount;
    }

    /// @notice Operation supplied by the IntentExecutor.
    struct Operation {
        bytes data;
    }

    /// @notice Reusable owner authorization represented for off-chain construction.
    struct FundingAuthorizationProof {
        uint8 sessionToEnableIndex;
        HCASmartSessionLib.HashAndChainId[] hashesAndChainIds;
        bytes32 ownerR;
        bytes32 ownerS;
        uint8 ownerV;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @dev Fixed source-session mode carrying the reusable multi-chain owner authorization.
    bytes1 internal constant FUNDING_SESSION_MODE = 0x04;

    /// @dev Selected-session index and entry count preceding packed chain sessions.
    uint256 private constant _FUNDING_PROOF_HEADER_LENGTH = 2;

    /// @dev Fixed proof bytes including the owner signature but excluding chain entries.
    uint256 private constant _FUNDING_PROOF_BASE_LENGTH =
        _FUNDING_PROOF_HEADER_LENGTH + HCASignatureLib.SIGNATURE_LENGTH;

    /// @notice Rhinestone protocol version used by the supported Across claim.
    bytes2 public constant RHINESTONE_PROTOCOL_VERSION = 0x0001;

    /// @notice Function selector for the supported Permit2 Across claim.
    bytes4 public constant ACROSS_PERMIT2_CLAIM_SELECTOR = 0xc9df5e29;

    /// @notice The only executor allowed to present session operations.
    address public immutable INTENT_EXECUTOR;

    /// @notice The Permit2 contract that requests ERC-1271 claim validation.
    address public immutable PERMIT2;

    /// @notice The Rhinestone Router that resolves the active Across claim adapter.
    IRhinestoneClaimRouter public immutable ROUTER;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Installed funding session for each source Nexus.
    mapping(address account => SessionConfig config) internal _sessions;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Emitted when a Nexus installs a funding session.
    /// @param account The Nexus that installed the session.
    /// @param permissionId The permission used by the Rhinestone SDK.
    /// @param sessionKey The authorized session signer.
    /// @param destinationRecipient The HCA that receives bridged funds.
    event SessionInstalled(
        address indexed account,
        bytes32 indexed permissionId,
        address indexed sessionKey,
        address destinationRecipient
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The caller is not authorized for this validation path.
    /// @dev Error selector: `0x5c427cd9`
    error UnauthorizedCaller();

    /// @notice The session configuration or signature is invalid.
    /// @dev Error selector: `0x2def1a76`
    error InvalidSession();

    /// @notice The session has expired.
    /// @dev Error selector: `0x1fd05a4a`
    error SessionExpired();

    /// @notice The operation encoding is invalid.
    /// @dev Error selector: `0x398d4d32`
    error InvalidOperation();

    /// @notice The operation is outside the fixed funding policy.
    /// @dev Error selector: `0xe1d1c3b3`
    error FundingPolicyFailed();

    /// @notice The Permit2 claim is outside the fixed destination policy.
    /// @dev Error selector: `0xb5b02681`
    error ClaimPolicyFailed();

    /// @notice One field in the fixed Permit2 claim does not match the funding session.
    /// @dev Error selector: `0xe4de9307`
    error ClaimFieldMismatch(uint8 field);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param intentExecutor The Rhinestone IntentExecutor used by the Nexus.
    /// @param permit2 The Permit2 contract used by Rhinestone claims.
    /// @param router The Rhinestone Router that resolves the active claim adapter.
    constructor(address intentExecutor, address permit2, address router) {
        if (intentExecutor == address(0) || permit2 == address(0) || router == address(0)) {
            revert InvalidSession();
        }
        INTENT_EXECUTOR = intentExecutor;
        PERMIT2 = permit2;
        ROUTER = IRhinestoneClaimRouter(router);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Installs one fixed funding session for the calling Nexus.
    /// @param data ABI-encoded `SessionConfig`.
    function onInstall(bytes calldata data) external {
        if (_sessions[msg.sender].sessionKey != address(0)) {
            revert InvalidSession();
        }
        SessionConfig memory config = abi.decode(data, (SessionConfig));
        if (
            config.permissionId == bytes32(0) ||
            config.owner == address(0) ||
            config.sessionKey == address(0) ||
            config.sourceToken == address(0) ||
            config.destinationRecipient == address(0) ||
            config.destinationToken == address(0) ||
            config.destinationChainId == 0 ||
            config.maxSourceAmount == 0 ||
            config.maxDestinationAmount == 0
        ) {
            revert InvalidSession();
        }
        if (config.validUntil <= block.timestamp) {
            revert SessionExpired();
        }
        _sessions[msg.sender] = config;
        emit SessionInstalled(
            msg.sender,
            config.permissionId,
            config.sessionKey,
            config.destinationRecipient
        );
    }

    /// @notice Removes the calling Nexus's funding session.
    /// @param data Unused uninstall data.
    function onUninstall(bytes calldata data) external {
        data;
        delete _sessions[msg.sender];
    }

    /// @notice Returns whether a Nexus has installed this validator.
    /// @param account The Nexus to inspect.
    /// @return Whether the Nexus has a session.
    function isInitialized(address account) external view returns (bool) {
        return _sessions[account].sessionKey != address(0);
    }

    /// @notice Returns a Nexus's installed funding session.
    /// @param account The Nexus to inspect.
    /// @return The installed configuration.
    function sessionConfig(address account) external view returns (SessionConfig memory) {
        return _sessions[account];
    }

    /// @notice Validates the session's Permit2 claim through the Nexus ERC-1271 path.
    /// @param sender The caller of `Nexus.isValidSignature`.
    /// @param hash The Permit2 typed-data digest.
    /// @param data The fixed claim signature and policy data.
    /// @return The ERC-1271 success value.
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4)
    {
        if (sender != PERMIT2 && sender != INTENT_EXECUTOR) {
            revert UnauthorizedCaller();
        }
        SessionConfig memory config = _sessions[msg.sender];
        _validateFundingClaim(hash, data, config);
        return ERC1271_MAGICVALUE;
    }

    /// @notice Rejects the separate emissary-execution path.
    /// @dev Funding is valid only as part of the Permit2 claim checked by `isValidSignatureWithSender`.
    /// @param account Unused source Nexus address.
    /// @param digest Unused execution digest.
    /// @param data Unused validator data.
    /// @param operation Unused execution operation.
    /// @return This function always reverts.
    function verifyExecution(
        address account,
        bytes32 digest,
        bytes calldata data,
        Operation calldata operation
    )
        external
        pure
        returns (bytes4)
    {
        account;
        digest;
        data;
        operation;
        revert InvalidSession();
    }

    /// @notice Rejects ERC-4337 operations for this intent-only session.
    /// @param userOp Unused user operation.
    /// @param userOpHash Unused user operation hash.
    /// @return The ERC-4337 validation failure value.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        pure
        returns (uint256)
    {
        userOp;
        userOpHash;
        return VALIDATION_FAILED;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Loads and validates the installed session for a permission identifier.
    function _validateConfig(SessionConfig memory config, bytes32 permissionId) internal view {
        if (config.sessionKey == address(0) || config.permissionId != permissionId) {
            revert InvalidSession();
        }
        if (block.timestamp > config.validUntil) {
            revert SessionExpired();
        }
    }

    /// @dev Decodes and validates one fixed source funding envelope.
    function _validateFundingClaim(bytes32 hash, bytes calldata data, SessionConfig memory config)
        internal
        view
    {
        (
            bytes32 permissionId,
            uint256 selectedIndex,
            bytes calldata packedSessions,
            bytes calldata ownerSignature,
            uint256 proofEnd
        ) =
            _decodeFundingAuthorization(
                data,
                HCASignatureLib.SIGNATURE_LENGTH + HCAPermit2Lib.CLAIM_DATA_LENGTH
            );
        if (proofEnd == 0 || data[0] != FUNDING_SESSION_MODE) {
            revert InvalidSession();
        }
        _validateConfig(config, permissionId);
        uint256 operationOffset =
            proofEnd + HCASignatureLib.SIGNATURE_LENGTH + HCAPermit2Lib.CLAIM_DATA_LENGTH;
        _validateMultiChainAuthorization(
            msg.sender,
            config,
            permissionId,
            selectedIndex,
            packedSessions,
            ownerSignature
        );
        _validateSignedPermit2Claim(hash, data, proofEnd, operationOffset, config);
    }

    /// @dev Checks the session signature, Permit2 claim, and matching source operation.
    function _validateSignedPermit2Claim(
        bytes32 hash,
        bytes calldata data,
        uint256 proofEnd,
        uint256 operationOffset,
        SessionConfig memory config
    )
        internal
        view
    {
        uint256 claimOffset = proofEnd + HCASignatureLib.SIGNATURE_LENGTH;
        bytes32 accountBoundHash =
            MessageHashUtils.toEthSignedMessageHash(
                abi.encodePacked(bytes32(uint256(uint160(msg.sender))), hash)
            );
        if (
            HCASignatureLib.recover(accountBoundHash, data[proofEnd:claimOffset]) !=
            config.sessionKey
        ) {
            revert InvalidSession();
        }
        bytes calldata claimData = data[claimOffset:operationOffset];
        bytes calldata operationData = data[operationOffset:];
        uint256 claimSourceAmount = _validatePermit2Claim(hash, claimData, config);
        if (operationData.length < 3) {
            revert InvalidOperation();
        }
        (HCAOperationHashLib.DecodedOperation memory operation, bytes32 operationHash) =
            HCAOperationHashLib.decodeAndHash(operationData);
        if (operationHash != _readWord(claimData, 314)) {
            revert ClaimFieldMismatch(10);
        }
        if (_validateFundingOperation(msg.sender, config, operation) != claimSourceAmount) {
            revert FundingPolicyFailed();
        }
    }

    /// @dev Verifies the reusable owner signature and the selected chain session.
    function _validateMultiChainAuthorization(
        address account,
        SessionConfig memory config,
        bytes32 permissionId,
        uint256 selectedIndex,
        bytes calldata packedSessions,
        bytes calldata ownerSignature
    )
        internal
        view
    {
        bytes32 salt = _fundingAuthorizationSalt(config);
        (bytes32 expectedPermissionId, bytes32 expectedSessionDigest) =
            HCASmartSessionLib.authorizationHashes(account, config.sessionKey, salt);
        if (permissionId != expectedPermissionId) {
            revert InvalidSession();
        }
        if (
            HCASmartSessionLib.validateMultiChainAuthorization(
                config.owner,
                expectedSessionDigest,
                selectedIndex,
                packedSessions,
                ownerSignature
            ) !=
            HCASmartSessionLib.AuthorizationStatus.Valid
        ) {
            revert InvalidSession();
        }
    }

    /// @dev Validates the source calls and returns the amount pulled from the owner.
    function _validateFundingOperation(
        address account,
        SessionConfig memory config,
        HCAOperationHashLib.DecodedOperation memory operation
    )
        internal
        view
        returns (uint256 totalPulled)
    {
        if (!HCAOperationHashLib.isSupportedMode(operation.mode)) {
            revert InvalidOperation();
        }
        Execution[] memory executions = operation.executions;
        uint256 approvedAmount;
        uint256 approvalCount;
        uint256 permitCount;
        for (uint256 i; i < executions.length; ++i) {
            Execution memory execution = executions[i];
            if (execution.target != config.sourceToken || execution.value != 0) {
                revert FundingPolicyFailed();
            }
            bytes4 selector = _selector(execution.callData);
            if (selector == IERC20.transferFrom.selector) {
                if (
                    _readAddress(execution.callData, 4) != config.owner ||
                    _readAddress(execution.callData, 36) != account
                ) {
                    revert FundingPolicyFailed();
                }
                totalPulled += _readUint(execution.callData, 68);
            } else if (selector == IERC20.approve.selector) {
                if (++approvalCount > 1 || _readAddress(execution.callData, 4) != PERMIT2) {
                    revert FundingPolicyFailed();
                }
                approvedAmount = _readUint(execution.callData, 36);
            } else if (selector == IERC20Permit.permit.selector) {
                if (
                    ++permitCount > 1 ||
                    _readAddress(execution.callData, 4) != config.owner ||
                    _readAddress(execution.callData, 36) != account ||
                    _readUint(execution.callData, 68) > config.maxSourceAmount ||
                    _readUint(execution.callData, 100) > config.validUntil ||
                    _readUint(execution.callData, 100) < block.timestamp
                ) {
                    revert FundingPolicyFailed();
                }
            } else {
                revert FundingPolicyFailed();
            }
        }
        if (
            totalPulled == 0 ||
            totalPulled > config.maxSourceAmount ||
            (approvalCount == 1 && approvedAmount < totalPulled)
        ) {
            revert FundingPolicyFailed();
        }
    }

    /// @dev Validates the compact Permit2 claim and returns its source amount.
    function _validatePermit2Claim(
        bytes32 expectedDigest,
        bytes calldata data,
        SessionConfig memory config
    )
        internal
        view
        returns (uint256 sourceAmount)
    {
        if (data.length != HCAPermit2Lib.CLAIM_DATA_LENGTH) {
            revert ClaimPolicyFailed();
        }

        HCAPermit2Lib.Claim memory claim = _decodeAndValidateClaim(data, config);
        if (HCAPermit2Lib.digest(data, claim, block.chainid, PERMIT2) != expectedDigest) {
            revert ClaimFieldMismatch(9);
        }
        return claim.sourceAmount;
    }

    /// @dev Decodes the route fields and checks them against the installed session.
    function _decodeAndValidateClaim(bytes calldata data, SessionConfig memory config)
        internal
        view
        returns (HCAPermit2Lib.Claim memory claim)
    {
        claim = HCAPermit2Lib.decode(data);

        (address activeArbiter, ) =
            ROUTER.getClaimAdapter(RHINESTONE_PROTOCOL_VERSION, ACROSS_PERMIT2_CLAIM_SELECTOR);
        if (activeArbiter == address(0) || claim.spender != activeArbiter) {
            revert ClaimFieldMismatch(1);
        }
        if (claim.deadline < block.timestamp || claim.deadline > config.validUntil) {
            revert ClaimFieldMismatch(2);
        }
        if (uint8(data[84]) != 1) {
            revert ClaimFieldMismatch(3);
        }
        if (
            claim.sourceToken != config.sourceToken ||
            claim.sourceAmount == 0 ||
            claim.sourceAmount > config.maxSourceAmount
        ) {
            revert ClaimFieldMismatch(4);
        }
        if (claim.recipient != config.destinationRecipient) {
            revert ClaimFieldMismatch(5);
        }
        if (
            claim.targetChainId != config.destinationChainId ||
            claim.fillExpiry < block.timestamp ||
            claim.fillExpiry > config.validUntil
        ) {
            revert ClaimFieldMismatch(6);
        }
        if (uint8(data[233]) != 1) {
            revert ClaimFieldMismatch(7);
        }
        if (
            claim.tokenOut != config.destinationToken ||
            claim.amountOut == 0 ||
            claim.amountOut > config.maxDestinationAmount
        ) {
            revert ClaimFieldMismatch(8);
        }
    }

    /// @dev Locates the packed multi-chain authorization and its trailing owner signature.
    ///      Returns a zero proof end when the envelope cannot contain the required tail.
    function _decodeFundingAuthorization(bytes calldata data, uint256 tailLength)
        internal
        pure
        returns (
            bytes32 permissionId,
            uint256 selectedIndex,
            bytes calldata packedSessions,
            bytes calldata ownerSignature,
            uint256 proofEnd
        )
    {
        packedSessions = data[0:0];
        ownerSignature = data[0:0];
        uint256 proofOffset = HCASmartSessionLib.ENABLE_PREFIX_LENGTH;
        if (data.length <= proofOffset + _FUNDING_PROOF_BASE_LENGTH + tailLength) {
            return (permissionId, selectedIndex, packedSessions, ownerSignature, 0);
        }

        permissionId = bytes32(data[1:proofOffset]);
        selectedIndex = uint8(data[proofOffset]);
        uint256 chainCount = uint8(data[proofOffset + 1]);
        if (chainCount == 0) {
            return (permissionId, selectedIndex, packedSessions, ownerSignature, 0);
        }

        uint256 sessionsOffset = proofOffset + _FUNDING_PROOF_HEADER_LENGTH;
        uint256 signatureOffset =
            sessionsOffset + chainCount * HCASmartSessionLib.AUTHORIZATION_ENTRY_LENGTH;
        proofEnd = signatureOffset + HCASignatureLib.SIGNATURE_LENGTH;
        if (proofEnd + tailLength >= data.length) {
            return (permissionId, selectedIndex, packedSessions, ownerSignature, 0);
        }

        packedSessions = data[sessionsOffset:signatureOffset];
        ownerSignature = data[signatureOffset:proofEnd];
    }

    /// @dev Hashes the fields fixed by one source funding session.
    function _fundingAuthorizationSalt(SessionConfig memory config) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    config.owner,
                    config.validUntil,
                    config.sourceToken,
                    config.destinationRecipient,
                    config.destinationToken,
                    config.destinationChainId,
                    config.maxSourceAmount,
                    config.maxDestinationAmount
                )
            );
    }

    /// @dev Reads a function selector from ABI call data.
    function _selector(bytes memory callData) internal pure returns (bytes4 selector) {
        if (callData.length < 4) {
            revert InvalidOperation();
        }
        return HCAExecutionLib.selector(callData);
    }

    /// @dev Reads an ABI-encoded address from memory.
    function _readAddress(bytes memory data, uint256 offset) internal pure returns (address value) {
        value = address(uint160(_readUint(data, offset)));
    }

    /// @dev Reads an ABI-encoded integer from memory.
    function _readUint(bytes memory data, uint256 offset) internal pure returns (uint256 value) {
        if (data.length < offset + 32) {
            revert InvalidOperation();
        }
        return HCAExecutionLib.readUint(data, offset);
    }

    /// @dev Reads a raw word from calldata.
    function _readWord(bytes calldata data, uint256 offset) internal pure returns (bytes32 value) {
        if (data.length < offset + 32) {
            revert ClaimPolicyFailed();
        }
        return bytes32(data[offset:offset + 32]);
    }
}
