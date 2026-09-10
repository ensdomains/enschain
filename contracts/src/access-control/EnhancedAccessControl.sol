// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (access/AccessControl.sol)

pragma solidity ^0.8.20;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IEnhancedAccessControl} from "./interfaces/IEnhancedAccessControl.sol";
import {EACBaseRolesLib} from "./libraries/EACBaseRolesLib.sol";

/// @dev Resource-scoped access control system with bitmap-packed roles.
///
/// Subclasses define custom roles as constants and assign them to accounts within specific
/// resources. A resource is an arbitrary uint256 identifier whose meaning is determined by
/// the subclass (e.g. a token ID, a name hash, etc.).
///
/// Features:
/// - Resource-based roles: each resource has independent role assignments.
/// - ROOT_RESOURCE fallback: roles granted in `ROOT_RESOURCE` (0x0) automatically apply
///   to all resources. Role checks OR the account's root roles with their resource-specific
///   roles, so holding a role in either scope satisfies the check.
/// - Admin roles: each regular role has a corresponding admin role. Holding an admin role
///   grants authority to grant and revoke both the regular role and the admin role itself.
/// - Assignee counting: per-role assignee counts are tracked, with a maximum of 15 per role.
/// - Callbacks: subclasses can override `_onRolesGranted` and `_onRolesRevoked` to react
///   to role changes (e.g. regenerating tokens, updating metadata).
/// - Separate root operations: `grantRoles`/`revokeRoles` reject `ROOT_RESOURCE` directly;
///   use `grantRootRoles`/`revokeRootRoles` for root-level assignments.
///
/// Bitmap layout (uint256, 64 nybbles):
///
///   255         128 127            0
///   ┌──────────────┬───────────────┐
///   │ Admin Roles  │ Regular Roles │
///   └──────────────┴───────────────┘
///   63           32 31             0
///
/// Each role occupies one nybble (4 bits). A regular role at nybble index N occupies bits
/// N*4 to N*4+3, and its admin counterpart occupies the same relative position in the upper
/// half at bits N*4+128 to N*4+131.
///
/// Defining roles: `uint256 constant MY_ROLE = 1 << (N * 4)` where N is the nybble index
/// (0-31), and the admin role as `uint256 constant MY_ROLE_ADMIN = MY_ROLE << 128`.
///
/// The same nybble-per-role layout is used for assignee counting: each nybble in the count
/// bitmap tracks the number of accounts holding that role within a resource (4 bits = max 15).
///
abstract contract EnhancedAccessControl is ERC165, IEnhancedAccessControl {
    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @notice The `ROOT_RESOURCE`.
    uint256 public constant ROOT_RESOURCE = 0;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev user roles within a resource stored as a bitmap.
    ///      Resource -> User -> RoleBitmap
    mapping(uint256 resource => mapping(address account => uint256 roleBitmap)) private _roles;

    /// @dev The number of assignees for a given role in a given resource.
    ///
    /// Each role's count is represented by 4 bits, in little-endian order.
    /// This results in max. 64 roles, and 15 assignees per role.
    ///
    mapping(uint256 resource => uint256 roleCount) private _roleCount;

    /// @dev Storage gap for future changes.
    uint256[256] private __gap;

    ////////////////////////////////////////////////////////////////////////
    // Modifiers
    ////////////////////////////////////////////////////////////////////////

    /// @dev Modifier that checks that sender has the admin roles for all the given roles.
    modifier canGrantRoles(uint256 resource, uint256 roleBitmap) {
        _checkCanGrantRoles(resource, roleBitmap, msg.sender);
        _;
    }

    /// @dev Modifier that checks that sender has the admin roles for all the given roles and can revoke them.
    modifier canRevokeRoles(uint256 resource, uint256 roleBitmap) {
        _checkCanRevokeRoles(resource, roleBitmap, msg.sender);
        _;
    }

    /// @dev Modifier that checks that sender has all the given roles within the given resource or the ROOT_RESOURCE.
    modifier onlyRoles(uint256 resource, uint256 roleBitmap) {
        _checkRoles(resource, roleBitmap, msg.sender);
        _;
    }

    /// @dev Modifier that checks that sender has all the given roles within the `ROOT_RESOURCE`.
    modifier onlyRootRoles(uint256 roleBitmap) {
        _checkRoles(ROOT_RESOURCE, roleBitmap, msg.sender);
        _;
    }

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IEnhancedAccessControl).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IEnhancedAccessControl
    /// @dev The caller must have all the necessary admin roles for the roles being granted.
    ///      Cannot be used with ROOT_RESOURCE directly, use grantRootRoles instead.
    function grantRoles(uint256 resource, uint256 roleBitmap, address account)
        public
        virtual
        canGrantRoles(resource, roleBitmap)
        returns (bool)
    {
        if (resource == ROOT_RESOURCE) {
            revert EACRootResourceNotAllowed();
        }
        return _grantRoles(resource, roleBitmap, account, true);
    }

    /// @inheritdoc IEnhancedAccessControl
    /// @dev The caller must have all the necessary admin roles for the roles being granted.
    function grantRootRoles(uint256 roleBitmap, address account)
        public
        virtual
        canGrantRoles(ROOT_RESOURCE, roleBitmap)
        returns (bool)
    {
        return _grantRoles(ROOT_RESOURCE, roleBitmap, account, true);
    }

    /// @inheritdoc IEnhancedAccessControl
    /// @dev The caller must have all the necessary admin roles for the roles being revoked.
    ///      Cannot be used with ROOT_RESOURCE directly, use revokeRootRoles instead.
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account)
        public
        virtual
        canRevokeRoles(resource, roleBitmap)
        returns (bool)
    {
        if (resource == ROOT_RESOURCE) {
            revert EACRootResourceNotAllowed();
        }
        return _revokeRoles(resource, roleBitmap, account, true);
    }

    /// @inheritdoc IEnhancedAccessControl
    /// @dev The caller must have all the necessary admin roles for the roles being revoked.
    function revokeRootRoles(uint256 roleBitmap, address account)
        public
        virtual
        canRevokeRoles(ROOT_RESOURCE, roleBitmap)
        returns (bool)
    {
        return _revokeRoles(ROOT_RESOURCE, roleBitmap, account, true);
    }

    /// @inheritdoc IEnhancedAccessControl
    function roles(uint256 resource, address account) public view virtual returns (uint256) {
        return _getRoles(resource, account);
    }

    /// @inheritdoc IEnhancedAccessControl
    function roleCount(uint256 resource) public view virtual returns (uint256) {
        return _roleCount[resource];
    }

    /// @inheritdoc IEnhancedAccessControl
    function hasRootRoles(uint256 roleBitmap, address account) public view virtual returns (bool) {
        return _getRoles(ROOT_RESOURCE, account) & roleBitmap == roleBitmap;
    }

    /// @inheritdoc IEnhancedAccessControl
    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        public
        view
        virtual
        returns (bool)
    {
        return _effectiveRoles(resource, account) & roleBitmap == roleBitmap;
    }

    /// @inheritdoc IEnhancedAccessControl
    function getAssigneeCount(uint256 resource, uint256 roleBitmap)
        public
        view
        virtual
        returns (uint256 counts, uint256 mask)
    {
        mask = _roleBitmapToMask(roleBitmap);
        counts = _roleCount[resource] & mask;
    }

    /// @inheritdoc IEnhancedAccessControl
    function hasAssignees(uint256 resource, uint256 roleBitmap) public view returns (bool) {
        (uint256 counts, ) = getAssigneeCount(resource, roleBitmap);
        return counts != 0;
    }

    /// @inheritdoc IEnhancedAccessControl
    function isOnlyAssignee(uint256 resource, uint256 roleBitmap, address account)
        public
        view
        returns (bool)
    {
        (uint256 counts, ) = getAssigneeCount(resource, roleBitmap);
        return counts != 0 && counts == (roles(resource, account) & roleBitmap);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Transfers all roles from `srcAccount` to `dstAccount` within the same resource.
    ///
    /// This function first revokes all roles from the source account, then grants them to the
    /// destination account. This prevents exceeding max assignees limits during transfer.
    ///
    /// Does nothing if there are no roles to transfer.
    ///
    /// @param resource The resource to transfer roles within.
    /// @param srcAccount The account to transfer roles from.
    /// @param dstAccount The account to transfer roles to.
    /// @param executeCallbacks Whether to execute the callbacks.
    function _transferRoles(
        uint256 resource,
        address srcAccount,
        address dstAccount,
        bool executeCallbacks
    )
        internal
        virtual
    {
        uint256 srcRoles = _roles[resource][srcAccount];
        if (srcRoles != 0) {
            // First revoke roles from source account to free up assignee slots
            _revokeRoles(resource, srcRoles, srcAccount, executeCallbacks);
            // Then grant roles to destination account
            _grantRoles(resource, srcRoles, dstAccount, executeCallbacks);
        }
    }

    /// @dev Grants multiple roles to `account`.
    /// @param resource The resource to grant roles within.
    /// @param roleBitmap The roles bitmap to grant.
    /// @param account The account to grant roles to.
    /// @param executeCallbacks Whether to execute the callbacks.
    /// @return `true` if the roles were granted, `false` otherwise.
    function _grantRoles(
        uint256 resource,
        uint256 roleBitmap,
        address account,
        bool executeCallbacks
    )
        internal
        virtual
        returns (bool)
    {
        if (roleBitmap == 0) {
            return false;
        }
        _checkRoleBitmap(roleBitmap);
        if (account == address(0)) {
            revert EACInvalidAccount();
        }
        uint256 currentRoles = _roles[resource][account];
        uint256 updatedRoles = currentRoles | roleBitmap;

        if (currentRoles != updatedRoles) {
            _roles[resource][account] = updatedRoles;
            uint256 newlyAddedRoles = roleBitmap & ~currentRoles;
            _updateRoleCounts(resource, newlyAddedRoles, true);
            emit EACRolesChanged(resource, account, currentRoles, updatedRoles);
            if (executeCallbacks) {
                _onRolesGranted(resource, account, currentRoles, updatedRoles, roleBitmap);
            }
            return true;
        } else {
            return false;
        }
    }

    /// @dev Attempts to revoke roles from `account` and returns a boolean indicating if roles were revoked.
    /// @param resource The resource to revoke roles within.
    /// @param roleBitmap The roles bitmap to revoke.
    /// @param account The account to revoke roles from.
    /// @param executeCallbacks Whether to execute the callbacks.
    /// @return `true` if the roles were revoked, `false` otherwise.
    function _revokeRoles(
        uint256 resource,
        uint256 roleBitmap,
        address account,
        bool executeCallbacks
    )
        internal
        virtual
        returns (bool)
    {
        _checkRoleBitmap(roleBitmap);
        uint256 currentRoles = _roles[resource][account];
        uint256 updatedRoles = currentRoles & ~roleBitmap;

        if (currentRoles != updatedRoles) {
            _roles[resource][account] = updatedRoles;
            uint256 newlyRemovedRoles = roleBitmap & currentRoles;
            _updateRoleCounts(resource, newlyRemovedRoles, false);
            emit EACRolesChanged(resource, account, currentRoles, updatedRoles);
            if (executeCallbacks) {
                _onRolesRevoked(resource, account, currentRoles, updatedRoles, roleBitmap);
            }
            return true;
        } else {
            return false;
        }
    }

    /// @dev Updates role counts when roles are granted/revoked
    /// @param resource The resource to update counts for
    /// @param roleBitmap The roles being modified
    /// @param isGrant true for grant, false for revoke
    function _updateRoleCounts(uint256 resource, uint256 roleBitmap, bool isGrant) internal {
        uint256 roleMask = _roleBitmapToMask(roleBitmap);

        if (isGrant) {
            // Check for overflow
            if (EACBaseRolesLib.hasZeroNybbles(~(roleMask & _roleCount[resource]))) {
                revert EACMaxAssignees(resource, roleBitmap);
            }
            _roleCount[resource] += roleBitmap;
        } else {
            // Check for underflow
            if (EACBaseRolesLib.hasZeroNybbles(~(roleMask & ~_roleCount[resource]))) {
                revert EACMinAssignees(resource, roleBitmap);
            }
            _roleCount[resource] -= roleBitmap;
        }
    }

    /// @dev Callback for when roles are granted.
    /// @param resource The resource that the roles were granted within.
    /// @param account The account that the roles were granted to.
    /// @param oldRoles The old roles for the account.
    /// @param newRoles The new roles for the account.
    /// @param roleBitmap The roles that were granted.
    function _onRolesGranted(
        uint256 resource,
        address account,
        uint256 oldRoles,
        uint256 newRoles,
        uint256 roleBitmap
    )
        internal
        virtual
    {}

    /// @dev Callback for when roles are revoked.
    /// @param resource The resource that the roles were revoked within.
    /// @param account The account that the roles were revoked from.
    /// @param oldRoles The old roles for the account.
    /// @param newRoles The new roles for the account.
    /// @param roleBitmap The roles that were revoked.
    function _onRolesRevoked(
        uint256 resource,
        address account,
        uint256 oldRoles,
        uint256 newRoles,
        uint256 roleBitmap
    )
        internal
        virtual
    {}

    /// @dev Reverts if `account` does not have all the given roles.
    function _checkRoles(uint256 resource, uint256 roleBitmap, address account)
        internal
        view
        virtual
    {
        if (!hasRoles(resource, roleBitmap, account)) {
            revert EACUnauthorizedAccountRoles(resource, roleBitmap, account);
        }
    }

    /// @dev Reverts if `account` does not have the admin roles for all the given roles.
    function _checkCanGrantRoles(uint256 resource, uint256 roleBitmap, address account)
        internal
        view
        virtual
    {
        uint256 settableRoles = _getSettableRoles(resource, account);
        if ((roleBitmap & ~settableRoles) != 0) {
            revert EACCannotGrantRoles(resource, roleBitmap, account);
        }
    }

    /// @dev Reverts if `account` does not have the admin roles for all the given roles that are being revoked.
    function _checkCanRevokeRoles(uint256 resource, uint256 roleBitmap, address account)
        internal
        view
        virtual
    {
        uint256 revokableRoles = _getRevokableRoles(resource, account);
        if ((roleBitmap & ~revokableRoles) != 0) {
            revert EACCannotRevokeRoles(resource, roleBitmap, account);
        }
    }

    /// @dev Returns the settable roles for `account` within `resource`.
    ///
    /// The settable roles are the roles (both regular and admin) that the account can grant.
    /// An account can grant a regular role if they have the corresponding admin role.
    /// An account can grant an admin role if they have that same admin role.
    ///
    /// @param resource The resource to get settable roles for.
    /// @param account The account to get settable roles for.
    /// @return The settable roles for `account` within `resource`.
    function _getSettableRoles(uint256 resource, address account)
        internal
        view
        virtual
        returns (uint256)
    {
        return EACBaseRolesLib.withAdminRolesApplied(_effectiveRoles(resource, account));
    }

    /// @dev Returns the revokable roles for `account` within `resource`.
    ///
    /// The revokable roles are the roles (including admin roles) that the account can revoke.
    ///
    /// @param resource The resource to get revokable roles for.
    /// @param account The account to get revokable roles for.
    /// @return The revokable roles for `account` within `resource`.
    function _getRevokableRoles(uint256 resource, address account)
        internal
        view
        virtual
        returns (uint256)
    {
        return EACBaseRolesLib.withAdminRolesApplied(_effectiveRoles(resource, account));
    }

    /// @dev Returns the roles bitmap for an account for permission checks.
    function _getRoles(uint256 resource, address account) internal view virtual returns (uint256) {
        return _roles[resource][account];
    }

    ////////////////////////////////////////////////////////////////////////
    // Private Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Returns the effective roles bitmap for an account for permission checks.
    function _effectiveRoles(uint256 resource, address account) private view returns (uint256) {
        return _getRoles(ROOT_RESOURCE, account) | _getRoles(resource, account);
    }

    /// @dev Checks if a role bitmap contains only valid role bits.
    /// @param roleBitmap The role bitmap to check.
    function _checkRoleBitmap(uint256 roleBitmap) private pure {
        if ((roleBitmap & ~EACBaseRolesLib.ALL_ROLES) != 0) {
            revert EACInvalidRoleBitmap(roleBitmap);
        }
    }

    /// @dev Converts a role bitmap to a mask.
    ///
    /// The mask is a bitmap where each nybble is set if the corresponding role is in the role bitmap.
    ///
    /// @param roleBitmap The role bitmap to convert.
    /// @return roleMask The mask for the role bitmap.
    function _roleBitmapToMask(uint256 roleBitmap) private pure returns (uint256 roleMask) {
        _checkRoleBitmap(roleBitmap);
        roleMask = roleBitmap | (roleBitmap << 1);
        roleMask |= roleMask << 2;
    }
}
