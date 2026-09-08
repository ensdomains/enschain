// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Interface for Enhanced Access Control system that allows for:
/// * Resource-based roles
/// * Obtaining assignee count for each role in each resource
/// * Root resource override
/// * Up to 32 roles and 32 corresponding admin roles
/// * Up to 15 assignees per role
///
/// @dev Interface selector: `0x0132e43d`
interface IEnhancedAccessControl {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Emitted when roles are changed.
    /// @param resource The resource that the roles were changed within.
    /// @param account The account that the roles were changed for.
    /// @param oldRoleBitmap The old roles for the account.
    /// @param newRoleBitmap The new roles for the account.
    event EACRolesChanged(
        uint256 indexed resource,
        address indexed account,
        uint256 oldRoleBitmap,
        uint256 newRoleBitmap
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @dev Error selector: `0x4b27a133`
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);

    /// @dev Error selector: `0xd1a3b355`
    error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account);

    /// @dev Error selector: `0xa604e318`
    error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account);

    /// @dev Error selector: `0xc2842458`
    error EACRootResourceNotAllowed();

    /// @dev Error selector: `0xf9165348`
    error EACMaxAssignees(uint256 resource, uint256 role);

    /// @dev Error selector: `0x1f80c19b`
    error EACMinAssignees(uint256 resource, uint256 role);

    /// @dev Error selector: `0x2a7b2d20`
    error EACInvalidRoleBitmap(uint256 roleBitmap);

    /// @dev Error selector: `0xec3fc592`
    error EACInvalidAccount();

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Grants all roles in the given role bitmap to `account`.
    /// @param resource The resource to grant roles within.
    /// @param roleBitmap The roles bitmap to grant.
    /// @param account The account to grant roles to.
    /// @return `true` if the roles were granted, `false` otherwise.
    function grantRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        returns (bool);

    /// @notice Grants all roles in the given role bitmap to `account` in the ROOT_RESOURCE.
    /// @param roleBitmap The roles bitmap to grant.
    /// @param account The account to grant roles to.
    /// @return `true` if the roles were granted, `false` otherwise.
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);

    /// @notice Revokes all roles in the given role bitmap from `account`.
    /// @param resource The resource to revoke roles within.
    /// @param roleBitmap The roles bitmap to revoke.
    /// @param account The account to revoke roles from.
    /// @return `true` if the roles were revoked, `false` otherwise.
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        returns (bool);

    /// @notice Revokes all roles in the given role bitmap from `account` in the ROOT_RESOURCE.
    /// @param roleBitmap The roles bitmap to revoke.
    /// @param account The account to revoke roles from.
    /// @return `true` if the roles were revoked, `false` otherwise.
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);

    /// @notice Returns the `ROOT_RESOURCE` constant.
    function ROOT_RESOURCE() external view returns (uint256);

    /// @notice Returns the roles bitmap for an account in a resource.
    /// @param resource The resource to get the roles for.
    /// @param account The account to get the roles for.
    /// @return The roles bitmap for the account in the resource.
    function roles(uint256 resource, address account) external view returns (uint256);

    /// @notice Returns the role count bitmap for a resource.
    /// @param resource The resource to get the role count for.
    /// @return count The role count bitmap for the resource.
    function roleCount(uint256 resource) external view returns (uint256);

    /// @notice Checks if the given account has been granted all the given roles in the `ROOT_RESOURCE`.
    /// @param roleBitmap The roles bitmap to check.
    /// @param account The account to check.
    /// @return `true` if `account` has been granted all the given roles in the `ROOT_RESOURCE`, `false` otherwise.
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);

    /// @notice Checks if the given account has been granted all the given roles in the given resource or the `ROOT_RESOURCE`.
    /// @param resource The resource to check.
    /// @param roleBitmap The roles bitmap to check.
    /// @param account The account to check.
    /// @return `true` if `account` has been granted all the given roles in the given resource or the `ROOT_RESOURCE`, `false` otherwise.
    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);

    /// @notice Returns the number of assignees for the roles in the given role bitmap.
    /// @param resource The resource to check.
    /// @param roleBitmap The roles bitmap to check.
    /// @return counts The number of assignees for each of the roles in the given role bitmap, expressed as a packed array of 4-bit ints.
    /// @return mask The mask for the given role bitmap.
    function getAssigneeCount(uint256 resource, uint256 roleBitmap)
        external
        view
        returns (uint256 counts, uint256 mask);

    /// @notice Checks if any of the roles in the given role bitmap has assignees.
    /// @dev Derivable from `getAssigneeCount()`.
    /// @param resource The resource to check.
    /// @param roleBitmap The roles bitmap to check.
    /// @return `true` if any of the roles in the given role bitmap has assignees, `false` otherwise.
    function hasAssignees(uint256 resource, uint256 roleBitmap) external view returns (bool);

    /// @notice Checks if account is the only assignee.
    /// @dev Derivable from `getAssigneeCount()` and `roles()`.
    /// @param resource The resource to check.
    /// @param roleBitmap The roles bitmap to check.
    /// @param account The account to check.
    /// @return `true` if the only assignee.
    function isOnlyAssignee(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
}
