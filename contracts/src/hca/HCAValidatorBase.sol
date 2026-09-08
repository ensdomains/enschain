// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IValidator} from "nexus/interfaces/modules/IValidator.sol";
import {MODULE_TYPE_VALIDATOR} from "nexus/types/Constants.sol";

/// @title HCA Validator Base
/// @notice Shares the stateless ERC-7579 module surface used by fixed HCA validators.
/// @dev Concrete validators provide their signature and operation-policy implementations.
abstract contract HCAValidatorBase is IValidator {
    /// @notice Reports permissions as disabled so reusable proofs remain attached to operations.
    /// @param account Unused account address.
    /// @param permissionId Unused session permission identifier.
    /// @return Always false because the authorization is supplied with each operation.
    function isPermissionEnabled(address account, bytes32 permissionId)
        external
        pure
        returns (bool)
    {
        account;
        permissionId;
        return false;
    }

    /// @notice Returns whether this module is an ERC-7579 validator.
    /// @param moduleTypeId The module type to inspect.
    /// @return True only for the validator module type.
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }
}
