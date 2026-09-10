// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IProxyAuthorization} from "@ensdomains/verifiable-factory/IProxyAuthorization.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IValidator} from "nexus/interfaces/modules/IValidator.sol";
import {
    CALLTYPE_BATCH,
    CALLTYPE_DELEGATECALL,
    CALLTYPE_SINGLE,
    EXECTYPE_DEFAULT,
    EXECTYPE_TRY,
    CallType,
    ExecType,
    ExecutionMode,
    ModeLib
} from "nexus/lib/ModeLib.sol";
import {NonceLib} from "nexus/lib/NonceLib.sol";
import {Nexus} from "nexus/Nexus.sol";
import {VALIDATION_FAILED} from "nexus/types/Constants.sol";
import {Execution} from "nexus/types/DataTypes.sol";

import {IAddressSet} from "../utils/interfaces/IAddressSet.sol";

import {IStandaloneHCAFactory} from "./interfaces/IStandaloneHCAFactory.sol";

/// @title Standalone Single Owner HCA
/// @notice Nexus account whose owner is set once during account initialization.
/// @dev Module changes are disabled after initialization and the configured default validator
///      remains the only validator path for the account. Upgrades are owner-triggered and require
///      DAO approval for both the target and its predecessor.
contract StandaloneSingleOwnerHCA is Nexus, IProxyAuthorization {
    using ModeLib for ExecutionMode;
    using NonceLib for uint256;

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The allowlist of upgrade target implementations permitted from this implementation.
    IAddressSet public immutable UPGRADE_SET;

    /// @notice The allowlist of implementations permitted to upgrade into this implementation.
    /// @dev The initial trusted implementation uses the zero address and rejects all predecessors.
    IAddressSet public immutable PREDECESSOR_UPGRADE_SET;

    /// @notice The factory that stores immutable owner certifications for production HCAs.
    /// @dev A zero address retains direct-deployment behavior for isolated account deployments.
    IStandaloneHCAFactory public immutable OWNER_REGISTRY;

    /// @dev The VerifiableFactory allowed to invoke production proxy initialization.
    address private immutable _ACCOUNT_DEPLOYER;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Legacy owner storage retained at its original offset for upgrade compatibility.
    ///      New factory deployments read the canonical owner from `OWNER_REGISTRY`.
    address private _owner;

    /// @notice The nonce bound to every enabled fixed session.
    /// @dev Packed into the `_owner` slot and incremented by `revokeSessions`.
    uint96 private _sessionNonce;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice All enabled sessions were revoked.
    /// @param sessionNonce The new session nonce.
    event SessionsRevoked(uint96 indexed sessionNonce);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @dev Error selector: `0x9b15e16f`
    error OwnerCannotBeZero();

    /// @dev Error selector: `0xa413196e`
    error StandaloneHCAAlreadyInitialized();

    /// @dev Error selector: `0xca962ccf`
    error NoModuleChangeAllowed();

    /// @dev Error selector: `0x5cd83192`
    error CallerNotOwner();

    /// @dev Error selector: `0xf74d7dd0`
    /// @param implementation The disallowed implementation address.
    error UpgradeTargetNotApproved(address implementation);

    /// @dev Error selector: `0x6e29a697`
    error NoNFTAllowed();

    /// @notice Delegatecall execution is disabled to protect account storage invariants.
    /// @dev Error selector: `0x0d89438e`
    error DelegateCallNotAllowed();

    ////////////////////////////////////////////////////////////////////////
    // Modifiers
    ////////////////////////////////////////////////////////////////////////

    /// @dev Restricts a function to the initialized account owner.
    modifier onlyOwner() {
        if (msg.sender != _accountOwner()) {
            revert CallerNotOwner();
        }
        _;
    }

    /// @dev Restricts executor entry to installed executors and rejects delegatecall execution.
    modifier onlyExecutorModule() override {
        if (!_isExecutorInstalled(msg.sender)) {
            revert InvalidModule(msg.sender);
        }
        ExecutionMode mode;
        assembly ("memory-safe") {
            mode := calldataload(4)
        }
        _requireNonDelegateCall(mode);
        _;
    }

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param entryPoint_ ERC-4337 EntryPoint used by Nexus.
    /// @param defaultValidator_ Validator module used as the account's default validator.
    /// @param intentExecutor_ Executor module used by the intent execution flow.
    /// @param validatorInitData_ Initialization data passed to the default validator.
    /// @param upgradeSet_ The allowlist of permitted upgrade target implementations.
    /// @param predecessorUpgradeSet_ The predecessor allowlist; zero rejects every predecessor.
    /// @param ownerRegistry_ The factory containing immutable HCA owner certifications.
    constructor(
        address entryPoint_,
        address defaultValidator_,
        address intentExecutor_,
        bytes memory validatorInitData_,
        IAddressSet upgradeSet_,
        IAddressSet predecessorUpgradeSet_,
        IStandaloneHCAFactory ownerRegistry_
    )
        Nexus(entryPoint_, defaultValidator_, intentExecutor_, validatorInitData_, "")
    {
        UPGRADE_SET = upgradeSet_;
        PREDECESSOR_UPGRADE_SET = predecessorUpgradeSet_;
        OWNER_REGISTRY = ownerRegistry_;
        _ACCOUNT_DEPLOYER =
            address(ownerRegistry_) == address(0)
                ? address(0)
                : address(ownerRegistry_.VERIFIABLE_FACTORY());
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Initializes a direct account or validates a factory account's proposed owner.
    /// @dev The immutable default executor is authorized directly by Nexus and does not require
    ///      per-account module initialization.
    /// @param initData ABI-encoded owner address.
    function initializeAccount(bytes calldata initData) external payable override {
        address initialOwner = abi.decode(initData, (address));
        if (initialOwner == address(0)) {
            revert OwnerCannotBeZero();
        }

        IStandaloneHCAFactory ownerRegistry = OWNER_REGISTRY;
        if (address(ownerRegistry) == address(0)) {
            if (_owner != address(0)) {
                revert StandaloneHCAAlreadyInitialized();
            }
            _owner = initialOwner;
        } else if (msg.sender != _ACCOUNT_DEPLOYER) {
            revert StandaloneHCAAlreadyInitialized();
        }
    }

    /// @notice Disables module installation.
    /// @param moduleTypeId Unused module type id.
    /// @param module Unused module address.
    /// @param initData Unused module initialization data.
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        payable
        override
    {
        moduleTypeId;
        module;
        initData;

        revert NoModuleChangeAllowed();
    }

    /// @notice Disables module uninstallation.
    /// @param moduleTypeId Unused module type id.
    /// @param module Unused module address.
    /// @param deInitData Unused module de-initialization data.
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        payable
        override
    {
        moduleTypeId;
        module;
        deInitData;

        revert NoModuleChangeAllowed();
    }

    /// @notice Invalidates every enabled session for this account.
    /// @dev Increments the nonce checked by the fixed validator. Only callable by the owner
    ///      directly; account execution paths cannot reach it because self-calls carry the
    ///      account as `msg.sender`.
    function revokeSessions() external onlyOwner {
        uint96 sessionNonce;
        unchecked {
            sessionNonce = ++_sessionNonce;
        }
        emit SessionsRevoked(sessionNonce);
    }

    /// @notice Executes an atomic batch submitted directly by the account owner.
    /// @dev The wallet transaction authenticates the owner, so this path does not require an
    ///      intent signature or the default executor. The session policy does not apply, and
    ///      each inner call is made by the HCA.
    /// @param executions The calls to execute in order.
    function executeByOwner(Execution[] calldata executions) external payable onlyProxy onlyOwner {
        _executeBatchNoReturndata(executions);
    }

    /// @inheritdoc Nexus
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    )
        external
        override
        payPrefund(missingAccountFunds)
        onlyEntryPoint
        returns (uint256 validationData)
    {
        if (
            !userOp.nonce.isValidateMode() ||
            !userOp.nonce.isDefaultValidatorMode() ||
            !_isAllowedUserOpCallData(userOp.callData)
        ) {
            return VALIDATION_FAILED;
        }
        return IValidator(_DEFAULT_VALIDATOR).validateUserOp(userOp, userOpHash);
    }

    /// @notice Validates a signature through the account's fixed default validator.
    /// @dev Preserves Nexus's zero-address default-validator prefix and ERC-7739 detection while
    ///      omitting dynamic validator and pre-validation-hook lookups that this account disables.
    /// @param hash The digest to validate.
    /// @param signature A zero-address validator prefix followed by validator-specific data.
    /// @return magicValue The ERC-1271 success value, or the failure value when validation reverts.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        override
        returns (bytes4 magicValue)
    {
        if (signature.length == 0) {
            if (uint256(hash) == (~signature.length / 0xffff) * 0x7739) {
                return checkERC7739Support(hash, signature);
            }
        }

        address validator = address(bytes20(signature[:20]));
        if (validator != address(0)) {
            revert ValidatorNotInstalled(validator);
        }
        try IValidator(_DEFAULT_VALIDATOR).isValidSignatureWithSender(
            msg.sender,
            hash,
            signature[20:]
        ) returns (bytes4 result) {
            return result;
        } catch {
            return bytes4(0xffffffff);
        }
    }

    /// @notice Returns the account owner.
    function owner() external view returns (address) {
        return _accountOwner();
    }

    /// @notice Returns the account owner and current session nonce.
    /// @return owner_ The account owner.
    /// @return sessionNonce_ The current session nonce.
    function ownerAndSessionNonce() external view returns (address owner_, uint96 sessionNonce_) {
        return (_accountOwner(), _sessionNonce);
    }

    /// @notice Returns whether a predecessor may upgrade into this implementation.
    /// @dev The target's predecessor gate is independent from the current implementation's target
    ///      gate, so approval remains directional.
    /// @param previousImplementation The current proxy implementation.
    /// @return allowed Whether the DAO approved the predecessor for this implementation.
    function canUpgradeFrom(address previousImplementation)
        external
        view
        override
        returns (bool allowed)
    {
        IAddressSet predecessorSet = PREDECESSOR_UPGRADE_SET;
        return
            address(predecessorSet) != address(0) && predecessorSet.includes(previousImplementation);
    }

    /// @inheritdoc Nexus
    function supportsExecutionMode(ExecutionMode mode)
        external
        pure
        override
        returns (bool isSupported)
    {
        (CallType callType, ExecType execType) = mode.decodeBasic();
        return
            (callType == CALLTYPE_SINGLE || callType == CALLTYPE_BATCH) &&
            (execType == EXECTYPE_DEFAULT || execType == EXECTYPE_TRY);
    }

    /// @notice Returns the account implementation identifier.
    function accountId() external pure override returns (string memory) {
        return "ens-standalone-hca.1.1.0";
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Rejects NFT receiver callbacks before forwarding other fallback calls to Nexus.
    function _fallback(bytes calldata callData) internal override {
        if (callData.length >= 4) {
            bytes4 selector = bytes4(callData[0:4]);
            if (selector == IERC721Receiver.onERC721Received.selector) {
                revert NoNFTAllowed();
            }
            if (selector == IERC1155Receiver.onERC1155Received.selector) {
                revert NoNFTAllowed();
            }
            if (selector == IERC1155Receiver.onERC1155BatchReceived.selector) {
                revert NoNFTAllowed();
            }
        }

        super._fallback(callData);
    }

    /// @dev Returns the factory-certified owner or the directly initialized legacy owner.
    function _accountOwner() internal view returns (address owner_) {
        IStandaloneHCAFactory ownerRegistry = OWNER_REGISTRY;
        return
            address(ownerRegistry) == address(0)
                ? _owner
                : ownerRegistry.hcaOwners(address(this));
    }

    /// @dev Requires the owner as caller and allowlist approval for the target implementation.
    /// @param newImplementation The implementation to upgrade to.
    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        if (!UPGRADE_SET.includes(newImplementation)) {
            revert UpgradeTargetNotApproved(newImplementation);
        }
    }

    /// @dev Reverts when an inherited executor entry requests delegatecall execution.
    function _requireNonDelegateCall(ExecutionMode mode) internal pure {
        if (mode.getCallType() == CALLTYPE_DELEGATECALL) {
            revert DelegateCallNotAllowed();
        }
    }

    /// @dev Rejects an owner UserOperation that directly or indirectly requests delegatecall.
    function _isAllowedUserOpCallData(bytes calldata callData) internal pure returns (bool) {
        if (callData.length < 4) {
            return true;
        }

        bytes4 selector = bytes4(callData[:4]);
        if (selector == Nexus.executeUserOp.selector) {
            callData = callData[4:];
            if (callData.length < 4) {
                return true;
            }
            selector = bytes4(callData[:4]);
            if (selector == Nexus.executeUserOp.selector) {
                return false;
            }
        }
        if (selector != Nexus.execute.selector) {
            return true;
        }
        if (callData.length < 36) {
            return false;
        }

        return ExecutionMode.wrap(bytes32(callData[4:36])).getCallType() != CALLTYPE_DELEGATECALL;
    }
}
