// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IExecutor} from "nexus/interfaces/modules/IExecutor.sol";
import {IValidator} from "nexus/interfaces/modules/IValidator.sol";
import {EncodedModuleTypes} from "nexus/lib/ModuleTypeLib.sol";

import {HCAOwnerAndSessionValidator} from "~src/hca/HCAOwnerAndSessionValidator.sol";

/// @title Mock Standalone HCA
/// @notice Test-only HCA stand-in that exposes an owner and forwards validation.
contract MockStandaloneHCA {
    /// @notice The owner reported to the validator.
    address public owner;

    /// @notice The session nonce reported to the validator.
    uint96 public sessionNonce;

    /// @param owner_ The owner reported to the validator.
    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice Sets the reported session nonce.
    /// @param sessionNonce_ The nonce to report.
    function setSessionNonce(uint96 sessionNonce_) external {
        sessionNonce = sessionNonce_;
    }

    /// @notice Returns the owner and session nonce as one call.
    /// @return owner_ The reported owner.
    /// @return sessionNonce_ The reported session nonce.
    function ownerAndSessionNonce() external view returns (address owner_, uint96 sessionNonce_) {
        return (owner, sessionNonce);
    }

    /// @notice Forwards an ERC-1271 validation to the validator as this account.
    /// @param validator The validator under test.
    /// @param operationHash The digest supplied by the intent executor.
    /// @param signature The owner signature.
    /// @return The ERC-1271 return value.
    function validate(
        HCAOwnerAndSessionValidator validator,
        bytes32 operationHash,
        bytes calldata signature
    )
        external
        view
        returns (bytes4)
    {
        return
            validator.isValidSignatureWithSender(
                validator.INTENT_EXECUTOR(),
                operationHash,
                signature
            );
    }
}


/// @title Mock Validator Module
/// @notice Test-only ERC-7579 validator that rejects user operations.
contract MockValidatorModule is IValidator {
    /// @notice Always fails ERC-4337 validation.
    function validateUserOp(PackedUserOperation calldata, bytes32) external pure returns (uint256) {
        return 1;
    }

    /// @notice Always fails ERC-1271 validation.
    function isValidSignatureWithSender(address, bytes32, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return bytes4(0);
    }

    /// @notice No-op install hook.
    function onInstall(bytes calldata) external pure {}

    /// @notice No-op uninstall hook.
    function onUninstall(bytes calldata) external pure {}

    /// @notice Reports the validator module type.
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1;
    }

    /// @notice Always reports initialized.
    function isInitialized(address) external pure returns (bool) {
        return true;
    }
}


/// @title Mock Executor Module
/// @notice Test-only ERC-7579 executor that records module initialization.
contract MockExecutorModule is IExecutor {
    /// @notice Whether an account invoked the install hook.
    mapping(address account => bool initialized) public initialized;

    /// @notice Records the calling account as initialized.
    function onInstall(bytes calldata) external {
        initialized[msg.sender] = true;
    }

    /// @notice Clears the calling account's initialization marker.
    function onUninstall(bytes calldata) external {
        initialized[msg.sender] = false;
    }

    /// @notice Reports the executor module type.
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 2;
    }

    /// @notice Unused module-type encoding.
    function getModuleTypes() external pure returns (EncodedModuleTypes) {}

    /// @notice Returns whether an account invoked the install hook.
    /// @param account The account to inspect.
    /// @return Whether the account is initialized.
    function isInitialized(address account) external view returns (bool) {
        return initialized[account];
    }
}
