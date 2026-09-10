// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {EnhancedAccessControl} from "../access-control/EnhancedAccessControl.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";

import {IAddressSet} from "./interfaces/IAddressSet.sol";
import {
    IPermissionedAddressSet,
    ROLE_APPROVE,
    ROLE_APPROVE_ADMIN,
    ROLE_CAN_NAME,
    ROLE_CAN_NAME_ADMIN,
    ROLE_CALLABLE,
    ROLE_CALLABLE_ADMIN
} from "./interfaces/IPermissionedAddressSet.sol";

/// @dev Default root roles assigned at construction.
uint256 constant DEFAULT_ROLE_BITMAP =
    ROLE_APPROVE |
    ROLE_APPROVE_ADMIN |
    ROLE_CAN_NAME |
    ROLE_CAN_NAME_ADMIN |
    ROLE_CALLABLE |
    ROLE_CALLABLE_ADMIN;

/// @notice An arbitrary set of addresses managed by EAC.
contract PermissionedAddressSet is EnhancedAccessControl, IPermissionedAddressSet, IContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Mapping that determines members of the set.
    mapping(address addr => bool approved) internal _approved;

    /// @dev Whether `call()` is invokable by approved.
    bool internal _callable;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootAccount Account granted root roles.
    /// @param callable `true` if approved can invoke `call()`.
    constructor(address rootAccount, bool callable) {
        _grantRoles(ROOT_RESOURCE, DEFAULT_ROLE_BITMAP, rootAccount, false);
        if (callable) {
            _callable = true;
            emit CallableChanged(true, msg.sender);
        }
    }

    /// @inheritdoc EnhancedAccessControl
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IPermissionedAddressSet).interfaceId ||
            interfaceId == type(IAddressSet).interfaceId ||
            interfaceId == type(IContractNamer).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IPermissionedAddressSet
    function approve(address addr, bool approved) external onlyRootRoles(ROLE_APPROVE) {
        require(_approved[addr] != approved);
        _approved[addr] = approved;
        emit ApprovalChanged(addr, approved, msg.sender);
    }

    /// @inheritdoc IPermissionedAddressSet
    function call(address to, bytes calldata data) external payable returns (bool, bytes memory) {
        if (!_callable) {
            revert NotCallable();
        }
        if (!_approved[msg.sender]) {
            revert NotApproved(msg.sender);
        }
        return to.call{value: msg.value}(data);
    }

    /// @inheritdoc IPermissionedAddressSet
    function setCallable(bool callable) external onlyRootRoles(ROLE_CALLABLE) {
        require(_callable != callable);
        _callable = callable;
        emit CallableChanged(callable, msg.sender);
    }

    /// @inheritdoc IPermissionedAddressSet
    function isCallable() external view returns (bool) {
        return _callable;
    }

    /// @inheritdoc IAddressSet
    function includes(address addr) external view returns (bool) {
        return _approved[addr];
    }

    /// @inheritdoc IContractNamer
    function isContractNamer(address namer) external view returns (bool) {
        return hasRootRoles(ROLE_CAN_NAME, namer);
    }
}
