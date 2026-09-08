// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ERC1271_MAGICVALUE, VALIDATION_FAILED, VALIDATION_SUCCESS} from "nexus/types/Constants.sol";
import {Execution} from "nexus/types/DataTypes.sol";

import {IETHRegistrar} from "../registrar/interfaces/IETHRegistrar.sol";
import {
    IDefaultReverseRegistrarAdapter
} from "../reverse-registrar/interfaces/IDefaultReverseRegistrarAdapter.sol";
import {
    IReverseRegistrarAdapter
} from "../reverse-registrar/interfaces/IReverseRegistrarAdapter.sol";

import {HCAValidatorBase} from "./HCAValidatorBase.sol";
import {IStandaloneHCAOwner} from "./interfaces/IStandaloneHCAOwner.sol";
import {HCAExecutionLib} from "./libraries/HCAExecutionLib.sol";
import {HCAOperationHashLib} from "./libraries/HCAOperationHashLib.sol";
import {HCAPermit2Lib} from "./libraries/HCAPermit2Lib.sol";
import {HCARegistrarPolicyLib} from "./libraries/HCARegistrarPolicyLib.sol";
import {HCAResolverPolicyLib} from "./libraries/HCAResolverPolicyLib.sol";
import {HCASignatureLib} from "./libraries/HCASignatureLib.sol";
import {HCASmartSessionLib} from "./libraries/HCASmartSessionLib.sol";

/// @title HCA Owner and Session Validator
/// @notice Fixed validator for standalone HCA owner authorization and scoped ENS sessions.
/// @dev Owner signatures use Rhinestone's existing HCA format. Session operations carry a
///      reusable owner authorization and are consumed through the IntentExecutor's ERC-1271 path.
///      The permission checks remain hardcoded here rather than in dynamic policy modules.
contract HCAOwnerAndSessionValidator is HCAValidatorBase {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice Executor reimbursement included in a single-chain intent.
    struct GasRefund {
        address token;
        uint256 exchangeRate;
        uint256 overhead;
    }

    /// @dev Reusable owner authorization for a fixed HCA session.
    struct SessionEnableProof {
        address sessionKey;
        uint48 validUntil;
        uint96 sessionNonce;
        address resolver;
        address refundToken;
        uint96 maxRefundExchangeRate;
        uint48 maxRefundGasOverhead;
        uint96 maxRefundAmount;
        uint8 sessionToEnableIndex;
    }

    /// @dev State collected while the validator checks one operation batch.
    struct RegistrationPolicyState {
        bool usesResolver;
        bool deploysResolver;
        address authorizedRegistrar;
    }

    /// @dev State collected while validating an optional owner-funded token pull.
    struct FundingPolicyState {
        address account;
        address owner;
        bool enabled;
        bool permitted;
        bool transferred;
        uint256 permitIndex;
        uint256 permittedAmount;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @dev Permit2 mode carrying one reusable multi-chain session authorization.
    bytes1 internal constant FIXED_SESSION_PERMIT2_ENABLE_MODE = 0x04;

    /// @dev Single-chain mode carrying one reusable multi-chain session authorization.
    bytes1 internal constant FIXED_SESSION_REFUND_ENABLE_MODE = 0x05;

    /// @dev Fixed fields in a packed session authorization before its chain entries.
    uint256 private constant _SESSION_PROOF_HEADER_LENGTH = 110;

    /// @dev Fixed proof bytes including the owner signature but excluding chain entries.
    uint256 private constant _SESSION_PROOF_BASE_LENGTH =
        _SESSION_PROOF_HEADER_LENGTH + HCASignatureLib.SIGNATURE_LENGTH;

    /// @dev Packed fields after a first-use proof and before its single-chain operation.
    uint256 internal constant FIXED_SESSION_REFUND_ENABLE_FIELDS_LENGTH = 82;

    /// @dev EIP-712 domain type used by the production IntentExecutor.
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    /// @dev EIP-712 domain name used by the production IntentExecutor.
    bytes32 internal constant INTENT_EXECUTOR_NAME_HASH = keccak256("IntentExecutor");

    /// @dev EIP-712 domain version used by the production IntentExecutor.
    bytes32 internal constant INTENT_EXECUTOR_VERSION_HASH = keccak256("v0.0.1");

    /// @dev EIP-712 type hash for one standalone single-chain intent.
    bytes32 internal constant SINGLE_CHAIN_OPS_TYPEHASH =
        0xbae11135c33effc421d699bbb53d9926a005ed0f2f5eb672c62cbfa943807291;

    /// @dev EIP-712 type hash for executor reimbursement.
    bytes32 internal constant GAS_REFUND_TYPEHASH =
        0x0bf04d9dcc5e703a75ba16d19c00f9d87fa30b9a815627102c15624d338eb094;

    /// @dev IntentExecutor hash for an intent without a gas refund.
    bytes32 internal constant NO_GAS_REFUND_HASH =
        0x44db4de84d423abe696e354fc99de162153ee2f8985ab84305061247a78a3be4;

    /// @dev Canonical Permit2 deployment used by Rhinestone intents.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice The HCA-aware default reverse registrar adapter permitted for default primary-name setup.
    address public immutable DEFAULT_REVERSE_REGISTRAR_HCA_ADAPTER;

    /// @notice The HCA-aware `addr.reverse` registrar adapter permitted for v1 reverse claims.
    address public immutable REVERSE_REGISTRAR_HCA_ADAPTER;

    /// @notice The resolver implementation permitted for resolver deployment.
    address public immutable PERMITTED_RESOLVER_IMPL;

    /// @notice The ENS registry whose root registrar role authorizes registration targets.
    address public immutable ETH_REGISTRY;

    /// @notice The VerifiableFactory permitted for resolver deployment.
    address public immutable VERIFIABLE_FACTORY;

    /// @notice The proxy logic used by the permitted VerifiableFactory.
    address public immutable VERIFIABLE_PROXY_LOGIC;

    /// @notice The only executor allowed to present session operations for verification.
    address public immutable INTENT_EXECUTOR;

    /// @notice The Rhinestone paymaster permitted to pull a signed executor refund.
    address public immutable GAS_REFUND_PAYMASTER;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Operation data is not an ERC-7579 operation payload.
    /// @dev Error selector: `0xf679d4db`
    error InvalidOperationEncoding();

    /// @notice A supplied signer did not match the HCA owner or session key.
    /// @dev Error selector: `0x815e1d64`
    error InvalidSigner();

    /// @notice The HCA did not expose an owner.
    /// @dev Error selector: `0xbff8a462`
    error OwnerUnavailable();

    /// @notice A session was presented by an address other than the fixed IntentExecutor.
    /// @dev Error selector: `0x037b5679`
    error CallerNotIntentExecutor();

    /// @notice A session payload is not the supported Smart Session USE form.
    /// @dev Error selector: `0x9bdfc59f`
    error InvalidSessionData();

    /// @notice A target/action pair is outside the hardcoded registration policy.
    /// @param target The forbidden execution target.
    /// @param selector The forbidden function selector.
    /// @dev Error selector: `0xde1834f2`
    error ActionNotAllowed(address target, bytes4 selector);

    /// @notice One of the hardcoded policy argument checks failed.
    /// @dev Error selector: `0xe50c42ea`
    error PolicyRuleFailed();

    /// @notice A fixed session did not authorize the supplied executor reimbursement.
    /// @dev Error selector: `0x0672e151`
    error GasRefundNotAllowed();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param defaultReverseRegistrarHcaAdapter The HCA-aware default reverse registrar adapter.
    /// @param reverseRegistrarHcaAdapter The HCA-aware `addr.reverse` registrar adapter.
    /// @param permittedResolverImpl The resolver implementation accepted in resolver deployment actions.
    /// @param ethRegistry The ENS registry that authorizes registrars through its root roles.
    /// @param verifiableFactory The VerifiableFactory accepted by the registration policy.
    /// @param intentExecutor The fixed IntentExecutor allowed to present sponsored operations.
    /// @param gasRefundPaymaster The paymaster allowed to settle signed executor refunds.
    constructor(
        address defaultReverseRegistrarHcaAdapter,
        address reverseRegistrarHcaAdapter,
        address permittedResolverImpl,
        address ethRegistry,
        address verifiableFactory,
        address intentExecutor,
        address gasRefundPaymaster
    )
    {
        DEFAULT_REVERSE_REGISTRAR_HCA_ADAPTER = defaultReverseRegistrarHcaAdapter;
        REVERSE_REGISTRAR_HCA_ADAPTER = reverseRegistrarHcaAdapter;
        PERMITTED_RESOLVER_IMPL = permittedResolverImpl;
        ETH_REGISTRY = ethRegistry;
        VERIFIABLE_FACTORY = verifiableFactory;
        VERIFIABLE_PROXY_LOGIC = VerifiableFactory(verifiableFactory).proxyLogic();
        INTENT_EXECUTOR = intentExecutor;
        GAS_REFUND_PAYMASTER = gasRefundPaymaster;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Validates an HCA owner signature or reusable fixed-session proof.
    /// @param sender The caller forwarded by the account.
    /// @param hash The digest supplied by the intent executor.
    /// @param data A 65-byte owner signature or fixed-session envelope.
    /// @return magicValue ERC-1271 success value.
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4 magicValue)
    {
        if (sender != INTENT_EXECUTOR) {
            revert CallerNotIntentExecutor();
        }
        if (data.length == HCASignatureLib.SIGNATURE_LENGTH) {
            (address expectedOwner, ) = _ownerAndSessionNonce(msg.sender);
            if (HCASignatureLib.recover(hash, data) != expectedOwner) {
                revert InvalidSigner();
            }
        } else {
            _validateFixedSession(hash, data);
        }
        return ERC1271_MAGICVALUE;
    }

    /// @notice Validates an owner-signed ERC-4337 UserOperation.
    /// @dev Accepts both raw-digest and `personal_sign` ECDSA signatures, matching Nexus's K1 validator.
    ///      Fixed sessions remain limited to the intent path.
    /// @param userOp The UserOperation forwarded by the HCA.
    /// @param userOpHash The EntryPoint digest signed by the owner.
    /// @return The ERC-4337 validation result.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        view
        returns (uint256)
    {
        if (userOp.sender != msg.sender) {
            return VALIDATION_FAILED;
        }
        (address expectedOwner, ) = _ownerAndSessionNonce(msg.sender);
        return
            HCASignatureLib.isValidUserOpSignature(expectedOwner, userOpHash, userOp.signature)
                ? VALIDATION_SUCCESS
                : VALIDATION_FAILED;
    }

    /// @notice Returns whether this fixed module is available for an account.
    /// @param account Unused account address.
    /// @return Always true because the module is fixed by the HCA implementation.
    function isInitialized(address account) external pure returns (bool) {
        account;

        return true;
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

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Reads the account owner and session nonce, reverting if either is unavailable.
    function _ownerAndSessionNonce(address account)
        internal
        view
        returns (address owner_, uint96 sessionNonce)
    {
        try IStandaloneHCAOwner(account).ownerAndSessionNonce() returns (
            address owner__,
            uint96 sessionNonce_
        ) {
            owner_ = owner__;
            sessionNonce = sessionNonce_;
        } catch {
            revert OwnerUnavailable();
        }
        if (owner_ == address(0)) {
            revert OwnerUnavailable();
        }
    }

    /// @dev Validates an ERC-1271 session envelope and binds its operation copy to `hash`.
    function _validateFixedSession(bytes32 hash, bytes calldata data) internal view {
        if (data.length == 0) {
            revert InvalidSessionData();
        }

        bytes1 mode = data[0];
        if (mode == FIXED_SESSION_PERMIT2_ENABLE_MODE) {
            _validateFixedPermit2SessionEnable(hash, data);
            return;
        }
        if (mode == FIXED_SESSION_REFUND_ENABLE_MODE) {
            _validateFixedRefundSessionEnable(hash, data);
            return;
        }
        revert InvalidSessionData();
    }

    /// @dev Validates the first Permit2 route and its reusable multi-chain session authorization.
    function _validateFixedPermit2SessionEnable(bytes32 hash, bytes calldata data) internal view {
        (
            bytes32 permissionId,
            SessionEnableProof memory proof,
            bytes calldata packedSessions,
            bytes calldata ownerSignature,
            uint256 proofEnd
        ) =
            _decodeSessionEnableProof(
                data,
                32 + HCAPermit2Lib.CLAIM_DATA_LENGTH + HCASignatureLib.SIGNATURE_LENGTH
            );
        if (proofEnd == 0) {
            revert InvalidSessionData();
        }

        address accountOwner =
            _validateSessionEnableProof(permissionId, proof, packedSessions, ownerSignature);
        _validatePermit2EnableIntent(hash, data, proofEnd, accountOwner, proof);
    }

    /// @dev Validates the fixed HCA fields authorized by the owner.
    function _validateSessionEnableProof(
        bytes32 permissionId,
        SessionEnableProof memory proof,
        bytes calldata packedSessions,
        bytes calldata ownerSignature
    )
        internal
        view
        returns (address owner_)
    {
        uint96 sessionNonce;
        (owner_, sessionNonce) = _ownerAndSessionNonce(msg.sender);
        if (
            proof.sessionKey == address(0) ||
            proof.validUntil < block.timestamp ||
            proof.sessionNonce != sessionNonce ||
            proof.refundToken == address(0) ||
            proof.maxRefundExchangeRate == 0 ||
            proof.maxRefundAmount == 0
        ) {
            revert InvalidSessionData();
        }

        bytes32 salt = _sessionAuthorizationSalt(proof);
        (bytes32 expectedPermissionId, bytes32 sessionDigest) =
            HCASmartSessionLib.authorizationHashes(msg.sender, proof.sessionKey, salt);
        if (permissionId != expectedPermissionId) {
            revert InvalidSessionData();
        }
        _validateMultiChainSessionAuthorization(
            owner_,
            sessionDigest,
            proof.sessionToEnableIndex,
            packedSessions,
            ownerSignature
        );
        return owner_;
    }

    /// @dev Validates the session-signed Permit2 intent and its exact first HCA operation.
    function _validatePermit2EnableIntent(
        bytes32 hash,
        bytes calldata data,
        uint256 proofEnd,
        address accountOwner,
        SessionEnableProof memory proof
    )
        internal
        view
    {
        uint256 operationOffset = proofEnd + 32 + HCAPermit2Lib.CLAIM_DATA_LENGTH;
        uint256 signatureOffset = data.length - HCASignatureLib.SIGNATURE_LENGTH;
        bytes calldata operationData = data[operationOffset:signatureOffset];
        if (HCASignatureLib.recover(hash, data[signatureOffset:]) != proof.sessionKey) {
            revert InvalidSigner();
        }
        HCAOperationHashLib.DecodedOperation memory operation =
            _validatePermit2Destination(
                hash,
                uint256(bytes32(data[proofEnd:proofEnd + 32])),
                data[proofEnd + 32:operationOffset],
                operationData
            );
        _checkStatelessRegistrationPolicy(
            msg.sender,
            accountOwner,
            proof,
            operation,
            GasRefund(address(0), 0, 0)
        );
    }

    /// @dev Validates the first same-chain operation and its reusable session authorization.
    function _validateFixedRefundSessionEnable(bytes32 hash, bytes calldata data) internal view {
        (
            bytes32 permissionId,
            SessionEnableProof memory proof,
            bytes calldata packedSessions,
            bytes calldata ownerSignature,
            uint256 proofEnd
        ) =
            _decodeSessionEnableProof(
                data,
                FIXED_SESSION_REFUND_ENABLE_FIELDS_LENGTH + HCASignatureLib.SIGNATURE_LENGTH
            );
        if (proofEnd == 0) {
            revert InvalidSessionData();
        }

        address accountOwner =
            _validateSessionEnableProof(permissionId, proof, packedSessions, ownerSignature);
        (HCAOperationHashLib.DecodedOperation memory operation, GasRefund memory gasRefund) =
            _validateFixedRefundSessionEnablePayload(hash, data, proofEnd, proof);
        _checkStatelessRegistrationPolicy(msg.sender, accountOwner, proof, operation, gasRefund);
    }

    /// @dev Validates the session signature, refund, and operation in a first same-chain use.
    function _validateFixedRefundSessionEnablePayload(
        bytes32 hash,
        bytes calldata data,
        uint256 proofEnd,
        SessionEnableProof memory proof
    )
        internal
        view
        returns (HCAOperationHashLib.DecodedOperation memory operation, GasRefund memory gasRefund)
    {
        uint256 operationOffset = proofEnd + FIXED_SESSION_REFUND_ENABLE_FIELDS_LENGTH;
        uint256 signatureOffset = data.length - HCASignatureLib.SIGNATURE_LENGTH;
        uint256 refundAmount = uint96(bytes12(data[proofEnd + 64:proofEnd + 76]));
        gasRefund = GasRefund({token: address(bytes20(data[proofEnd + 32:proofEnd + 52])), exchangeRate: uint96(
            bytes12(data[proofEnd + 52:proofEnd + 64])
        ), overhead: (refundAmount << 128) | uint48(bytes6(data[proofEnd + 76:operationOffset]))});
        _checkGasRefund(proof, gasRefund);

        bytes calldata operationData = data[operationOffset:signatureOffset];
        bytes32 operationHash;
        (operation, operationHash) = _decodeERC1271Operation(operationData);
        uint256 nonce = uint256(bytes32(data[proofEnd:proofEnd + 32]));
        if (_singleChainDigest(msg.sender, nonce, operationHash, gasRefund) != hash) {
            revert InvalidSessionData();
        }
        if (HCASignatureLib.recover(hash, data[signatureOffset:]) != proof.sessionKey) {
            revert InvalidSigner();
        }
    }

    /// @dev Validates the standard Rhinestone multi-chain session signature once for this HCA.
    function _validateMultiChainSessionAuthorization(
        address owner_,
        bytes32 expectedSessionDigest,
        uint256 selectedIndex,
        bytes calldata packedSessions,
        bytes calldata ownerSignature
    )
        internal
        view
    {
        HCASmartSessionLib.AuthorizationStatus status =
            HCASmartSessionLib.validateMultiChainAuthorization(
                owner_,
                expectedSessionDigest,
                selectedIndex,
                packedSessions,
                ownerSignature
            );
        if (status == HCASmartSessionLib.AuthorizationStatus.InvalidSelection) {
            revert InvalidSessionData();
        }
        if (status != HCASmartSessionLib.AuthorizationStatus.Valid) {
            revert InvalidSigner();
        }
    }

    /// @dev Binds the destination operation to the signed Permit2 mandate.
    function _validatePermit2Destination(
        bytes32 expectedDigest,
        uint256 sourceChainId,
        bytes calldata claimData,
        bytes calldata operationData
    )
        internal
        view
        returns (HCAOperationHashLib.DecodedOperation memory operation)
    {
        if (
            sourceChainId == 0 ||
            claimData.length != HCAPermit2Lib.CLAIM_DATA_LENGTH ||
            address(bytes20(claimData[0:20])) == address(0) ||
            uint8(claimData[84]) != 1 ||
            uint8(claimData[233]) != 1
        ) {
            revert PolicyRuleFailed();
        }

        HCAPermit2Lib.Claim memory claim = HCAPermit2Lib.decode(claimData);
        if (
            claim.deadline < block.timestamp ||
            claim.recipient != msg.sender ||
            claim.targetChainId != block.chainid ||
            claim.fillExpiry < block.timestamp ||
            claim.tokenOut == address(0) ||
            claim.amountOut == 0
        ) {
            revert PolicyRuleFailed();
        }
        if (operationData.length < 32) {
            revert PolicyRuleFailed();
        }
        bytes32 operationHash;
        (operation, operationHash) = HCAOperationHashLib.decodeAndHash(operationData);
        if (!HCAOperationHashLib.isERC1271Mode(operation.mode)) {
            revert InvalidOperationEncoding();
        }
        if (!HCARegistrarPolicyLib.isBatchPaymentToken(operation.executions, claim.tokenOut)) {
            revert PolicyRuleFailed();
        }
        if (
            operationHash != bytes32(claimData[346:378]) ||
            HCAPermit2Lib.digest(claimData, claim, sourceChainId, PERMIT2) != expectedDigest
        ) {
            revert InvalidSessionData();
        }
    }

    /// @dev Reconstructs the production IntentExecutor digest from a decoded operation.
    function _singleChainDigest(
        address account,
        uint256 nonce,
        bytes32 operationHash,
        GasRefund memory gasRefund
    )
        internal
        view
        returns (bytes32)
    {
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
                    INTENT_EXECUTOR
                )
            );
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @dev Validates a decoded ERC-1271 operation carrying a reusable session proof.
    function _checkStatelessRegistrationPolicy(
        address account,
        address owner,
        SessionEnableProof memory proof,
        HCAOperationHashLib.DecodedOperation memory operation,
        GasRefund memory gasRefund
    )
        internal
        view
    {
        if (operation.executions.length == 0) {
            revert PolicyRuleFailed();
        }
        _checkRegistrationExecutions(
            account,
            owner,
            proof.resolver,
            operation.executions,
            gasRefund,
            proof.refundToken,
            true
        );
    }

    /// @dev Applies the fixed ENS policy to a decoded execution array.
    function _checkRegistrationExecutions(
        address account,
        address owner,
        address allowedResolver,
        Execution[] memory executions,
        GasRefund memory gasRefund,
        address fundingToken,
        bool requireAction
    )
        internal
        view
    {
        RegistrationPolicyState memory state;
        FundingPolicyState memory funding =
            FundingPolicyState({account: account, owner: owner, enabled: fundingToken != address(0), permitted: false, transferred: false, permitIndex: 0, permittedAmount: 0});
        uint256 actionCount;

        for (uint256 i; i < executions.length; ++i) {
            Execution memory execution = executions[i];
            if (execution.value != 0) {
                revert PolicyRuleFailed();
            }

            bytes4 selector = _selector(execution.callData);

            if (
                funding.enabled &&
                execution.target == fundingToken &&
                (selector == IERC20Permit.permit.selector ||
                    selector == IERC20.transferFrom.selector)
            ) {
                _checkFundingCall(execution, selector, i, funding);
                continue;
            }
            ++actionCount;

            if (selector == IETHRegistrar.commit.selector) {
                if (!_isAuthorizedRegistrar(execution.target, state)) {
                    revert ActionNotAllowed(execution.target, selector);
                }
                continue;
            }

            if (selector == IETHRegistrar.register.selector) {
                if (!_isAuthorizedRegistrar(execution.target, state)) {
                    revert ActionNotAllowed(execution.target, selector);
                }
                (address registrant, address resolver) = _registerFields(execution.callData);
                if (registrant != owner || resolver != allowedResolver) {
                    revert PolicyRuleFailed();
                }
                state.usesResolver = true;
                if (allowedResolver.code.length == 0 && !state.deploysResolver) {
                    revert PolicyRuleFailed();
                }
                continue;
            }

            if (allowedResolver != address(0) && execution.target == allowedResolver) {
                state.usesResolver = true;
                if (allowedResolver.code.length == 0 && !state.deploysResolver) {
                    revert PolicyRuleFailed();
                }
                _checkResolverCall(execution.callData);
                continue;
            }

            if (execution.target == DEFAULT_REVERSE_REGISTRAR_HCA_ADAPTER) {
                if (selector != IDefaultReverseRegistrarAdapter.setNameWithHCA.selector) {
                    revert ActionNotAllowed(execution.target, selector);
                }
                if (allowedResolver == address(0)) {
                    revert PolicyRuleFailed();
                }
                address namedAccount = _readAddress(execution.callData, 4);
                if (namedAccount != owner) {
                    revert PolicyRuleFailed();
                }
                continue;
            }

            if (execution.target == REVERSE_REGISTRAR_HCA_ADAPTER) {
                if (selector != IReverseRegistrarAdapter.claimWithHCA.selector) {
                    revert ActionNotAllowed(execution.target, selector);
                }
                address claimedAccount = _readAddress(execution.callData, 4);
                if (claimedAccount != owner) {
                    revert PolicyRuleFailed();
                }
                address claimResolver = _readAddress(execution.callData, 4 + 32);
                if (claimResolver != address(0)) {
                    if (claimResolver != allowedResolver) {
                        revert PolicyRuleFailed();
                    }
                    state.usesResolver = true;
                }
                continue;
            }

            if (execution.target == VERIFIABLE_FACTORY) {
                if (selector != IVerifiableFactory.deployProxy.selector) {
                    revert ActionNotAllowed(execution.target, selector);
                }
                if (state.deploysResolver) {
                    revert PolicyRuleFailed();
                }
                _checkResolverDeployment(account, owner, allowedResolver, execution.callData);
                state.usesResolver = true;
                state.deploysResolver = true;
                continue;
            }

            if (selector == IERC20.approve.selector) {
                _checkPaymentTokenApproval(execution.target, execution.callData, gasRefund, state);
                continue;
            }

            revert ActionNotAllowed(execution.target, selector);
        }
        if (funding.permitted != funding.transferred || (requireAction && actionCount == 0)) {
            revert PolicyRuleFailed();
        }
        _checkResolverBinding(allowedResolver, state);
    }

    /// @dev Validates an exact deployment of the resolver bound to the session.
    /// @param hca The HCA that will call the factory.
    /// @param owner The HCA owner.
    /// @param resolver The resolver address bound to the session.
    /// @param callData ABI-encoded `VerifiableFactory.deployProxy` call data.
    function _checkResolverDeployment(
        address hca,
        address owner,
        address resolver,
        bytes memory callData
    )
        internal
        view
    {
        HCAResolverPolicyLib.checkDeployment(
            hca,
            owner,
            resolver,
            callData,
            PERMITTED_RESOLVER_IMPL,
            VERIFIABLE_FACTORY,
            VERIFIABLE_PROXY_LOGIC
        );
    }

    /// @dev Requires a used resolver to be an exact pending deployment or a verified proxy.
    /// @param resolver The resolver bound to the session.
    /// @param state The resolver-related state collected from the operation batch.
    function _checkResolverBinding(address resolver, RegistrationPolicyState memory state)
        internal
        view
    {
        HCAResolverPolicyLib.checkBinding(
            resolver,
            state.usesResolver,
            state.deploysResolver,
            PERMITTED_RESOLVER_IMPL,
            VERIFIABLE_FACTORY
        );
    }

    /// @dev Allows payment approvals to registry-authorized registrars whose rent price oracle
    ///      accepts the approved token, and exact, signed executor-refund approvals.
    function _checkPaymentTokenApproval(
        address token,
        bytes memory callData,
        GasRefund memory gasRefund,
        RegistrationPolicyState memory state
    )
        internal
        view
    {
        address spender = _readAddress(callData, 4);
        if (
            _isAuthorizedRegistrar(spender, state) &&
            HCARegistrarPolicyLib.isPaymentToken(spender, token)
        ) {
            return;
        }
        if (
            spender != GAS_REFUND_PAYMASTER ||
            gasRefund.token != token ||
            _readUint(callData, 4 + 32) != gasRefund.overhead >> 128
        ) {
            revert PolicyRuleFailed();
        }
    }

    /// @dev Selects the first authorized registrar used by an operation batch and requires every
    ///      later registrar action to use the same account.
    /// @param account The prospective registrar.
    /// @param state The policy state containing the registrar selected by the batch.
    /// @return authorized Whether the account is the batch's selected registry-authorized registrar.
    function _isAuthorizedRegistrar(address account, RegistrationPolicyState memory state)
        internal
        view
        returns (bool authorized)
    {
        if (account == address(0)) {
            return false;
        }
        if (state.authorizedRegistrar != address(0)) {
            return state.authorizedRegistrar == account;
        }
        authorized = HCARegistrarPolicyLib.isAuthorized(ETH_REGISTRY, account);
        if (authorized) {
            state.authorizedRegistrar = account;
        }
    }

    /// @dev Decodes the packed fixed fields and locates the multi-chain owner authorization.
    ///      Returns a zero proof end when the envelope cannot contain the required tail.
    function _decodeSessionEnableProof(bytes calldata data, uint256 tailLength)
        internal
        pure
        returns (
            bytes32 permissionId,
            SessionEnableProof memory proof,
            bytes calldata packedSessions,
            bytes calldata ownerSignature,
            uint256 proofEnd
        )
    {
        packedSessions = data[0:0];
        ownerSignature = data[0:0];
        uint256 proofOffset = HCASmartSessionLib.ENABLE_PREFIX_LENGTH;
        if (data.length <= proofOffset + _SESSION_PROOF_BASE_LENGTH + tailLength) {
            return (permissionId, proof, packedSessions, ownerSignature, 0);
        }

        permissionId = bytes32(data[1:proofOffset]);
        uint256 chainCount = uint8(data[proofOffset + _SESSION_PROOF_HEADER_LENGTH - 1]);
        if (chainCount == 0) {
            return (permissionId, proof, packedSessions, ownerSignature, 0);
        }

        uint256 sessionsOffset = proofOffset + _SESSION_PROOF_HEADER_LENGTH;
        uint256 signatureOffset =
            sessionsOffset + chainCount * HCASmartSessionLib.AUTHORIZATION_ENTRY_LENGTH;
        proofEnd = signatureOffset + HCASignatureLib.SIGNATURE_LENGTH;
        if (proofEnd + tailLength >= data.length) {
            return (permissionId, proof, packedSessions, ownerSignature, 0);
        }

        proof = SessionEnableProof({sessionKey: address(bytes20(data[proofOffset:proofOffset + 20])), validUntil: uint48(
            bytes6(data[proofOffset + 20:proofOffset + 26])
        ), sessionNonce: uint96(bytes12(data[proofOffset + 26:proofOffset + 38])), resolver: address(
            bytes20(data[proofOffset + 38:proofOffset + 58])
        ), refundToken: address(bytes20(data[proofOffset + 58:proofOffset + 78])), maxRefundExchangeRate: uint96(
            bytes12(data[proofOffset + 78:proofOffset + 90])
        ), maxRefundGasOverhead: uint48(bytes6(data[proofOffset + 90:proofOffset + 96])), maxRefundAmount: uint96(
            bytes12(data[proofOffset + 96:proofOffset + 108])
        ), sessionToEnableIndex: uint8(data[proofOffset + 108])});
        packedSessions = data[sessionsOffset:signatureOffset];
        ownerSignature = data[signatureOffset:proofEnd];
    }

    /// @dev Validates one leg of an optional EIP-2612 funding pull into the HCA.
    ///      The permit and transfer must be adjacent, use the same amount, and consume the full
    ///      allowance that the owner gave to this HCA.
    function _checkFundingCall(
        Execution memory execution,
        bytes4 selector,
        uint256 index,
        FundingPolicyState memory state
    )
        internal
        pure
    {
        if (selector == IERC20Permit.permit.selector) {
            if (state.permitted || execution.callData.length != 4 + 7 * 32) {
                revert PolicyRuleFailed();
            }
            _requireArgAddress(execution.callData, 4, state.owner);
            _requireArgAddress(execution.callData, 4 + 32, state.account);
            state.permittedAmount = _readUint(execution.callData, 4 + 2 * 32);
            if (state.permittedAmount == 0) {
                revert PolicyRuleFailed();
            }
            state.permitted = true;
            state.permitIndex = index;
            return;
        }

        if (
            !state.permitted ||
            state.transferred ||
            index != state.permitIndex + 1 ||
            execution.callData.length != 4 + 3 * 32
        ) {
            revert PolicyRuleFailed();
        }
        _requireArgAddress(execution.callData, 4, state.owner);
        _requireArgAddress(execution.callData, 4 + 32, state.account);
        if (_readUint(execution.callData, 4 + 2 * 32) != state.permittedAmount) {
            revert PolicyRuleFailed();
        }
        state.transferred = true;
    }

    /// @dev Hashes the fixed HCA fields stored in the standard Smart Session salt.
    function _sessionAuthorizationSalt(SessionEnableProof memory proof)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    proof.sessionNonce,
                    proof.validUntil,
                    proof.resolver,
                    proof.refundToken,
                    proof.maxRefundExchangeRate,
                    proof.maxRefundGasOverhead,
                    proof.maxRefundAmount
                )
            );
    }

    /// @dev Checks an executor reimbursement against the limits approved for a session.
    function _checkGasRefund(SessionEnableProof memory proof, GasRefund memory gasRefund)
        internal
        pure
    {
        if (gasRefund.token == address(0)) {
            if (gasRefund.exchangeRate != 0 || gasRefund.overhead != 0) {
                revert GasRefundNotAllowed();
            }
            return;
        }
        uint256 refundAmount = gasRefund.overhead >> 128;
        uint256 gasOverhead = uint128(gasRefund.overhead);
        if (
            gasRefund.token != proof.refundToken ||
            gasRefund.exchangeRate == 0 ||
            gasRefund.exchangeRate > proof.maxRefundExchangeRate ||
            refundAmount == 0 ||
            refundAmount > proof.maxRefundAmount ||
            gasOverhead > proof.maxRefundGasOverhead
        ) {
            revert GasRefundNotAllowed();
        }
    }

    /// @dev Decodes an operation after checking that its mode uses ERC-1271 authorization.
    function _decodeERC1271Operation(bytes calldata operationData)
        internal
        pure
        returns (HCAOperationHashLib.DecodedOperation memory operation, bytes32 operationHash)
    {
        (operation, operationHash) = HCAOperationHashLib.decodeAndHash(operationData);
        if (!HCAOperationHashLib.isERC1271Mode(operation.mode)) {
            revert InvalidOperationEncoding();
        }
    }

    /// @notice Reads a function selector from calldata.
    /// @dev Reverts when calldata is shorter than a selector.
    /// @param callData ABI-encoded call data.
    /// @return selector_ The function selector.
    function _selector(bytes memory callData) internal pure returns (bytes4 selector_) {
        return HCAExecutionLib.selector(callData);
    }

    /// @notice Validates resolver record writes on the owner-authorized resolver.
    /// @dev Allows known resolver setters directly or recursively through supported multicalls.
    /// @param callData ABI-encoded resolver call data.
    function _checkResolverCall(bytes memory callData) internal pure {
        HCAResolverPolicyLib.checkCall(callData);
    }

    /// @notice Reads the fields relevant to the registration policy from a register call.
    /// @dev Reads only the needed ABI head words instead of decoding the full register tuple.
    /// @param callData ABI-encoded register call data.
    /// @return registrant The owner argument of the register call.
    /// @return resolver The resolver argument of the register call.
    function _registerFields(bytes memory callData)
        internal
        pure
        returns (address registrant, address resolver)
    {
        return HCARegistrarPolicyLib.registrationFields(callData);
    }

    /// @notice Reads an ABI-encoded address argument from calldata.
    /// @dev Reads and masks a 32-byte ABI word as an address.
    /// @param callData ABI-encoded call data.
    /// @param offset Offset of the ABI word to read.
    /// @return result The decoded address.
    function _readAddress(bytes memory callData, uint256 offset)
        internal
        pure
        returns (address result)
    {
        return HCAExecutionLib.readAddress(callData, offset);
    }

    /// @notice Requires an ABI address argument to match the policy-expected address.
    /// @dev Reverts with `PolicyRuleFailed` on mismatch.
    /// @param callData ABI-encoded call data.
    /// @param offset Offset of the ABI word holding the address.
    /// @param expected The only address the policy accepts at that position.
    function _requireArgAddress(bytes memory callData, uint256 offset, address expected)
        internal
        pure
    {
        if (_readAddress(callData, offset) != expected) {
            revert PolicyRuleFailed();
        }
    }

    /// @notice Reads a raw 32-byte ABI word from calldata bytes.
    /// @dev Reverts when calldata is shorter than the requested word.
    /// @param callData ABI-encoded call data.
    /// @param offset Offset of the ABI word to read.
    /// @return result The word as a uint256.
    function _readUint(bytes memory callData, uint256 offset)
        internal
        pure
        returns (uint256 result)
    {
        return HCAExecutionLib.readUint(callData, offset);
    }
}
