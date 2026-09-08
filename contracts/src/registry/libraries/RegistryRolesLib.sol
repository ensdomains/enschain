// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

/// @dev Defines the registry-specific roles used by `PermissionedRegistry` within the
///      `EnhancedAccessControl` nybble-packed bitmap system. Each role occupies one nybble (4 bits)
///      at a specific index, with its admin counterpart shifted 128 bits higher.
library RegistryRolesLib {
    /// @dev Nybble 0: authorizes registering and reserving new names. Root only.
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    /// @dev Nybble 32: authorizes setting `ROLE_REGISTRAR`.
    uint256 internal constant ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128;

    /// @dev Nybble 1: authorizes registering a reserved name (promoting it from RESERVED to REGISTERED). Root-only.
    uint256 internal constant ROLE_REGISTER_RESERVED = 1 << 4;
    /// @dev Nybble 33: authorizes setting `ROLE_REGISTER_RESERVED`.
    uint256 internal constant ROLE_REGISTER_RESERVED_ADMIN = ROLE_REGISTER_RESERVED << 128;

    /// @dev Nybble 2: authorizes setting the parent registry. Root-only.
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    /// @dev Nybble 34: authorizes setting `ROLE_SET_PARENT`.
    uint256 internal constant ROLE_SET_PARENT_ADMIN = ROLE_SET_PARENT << 128;

    /// @dev Nybble 3: authorizes unregistering names. Root or token.
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    /// @dev Nybble 35: authorizes setting `ROLE_UNREGISTER`.
    uint256 internal constant ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128;

    /// @dev Nybble 4: authorizes extending name expiry. Root or token.
    uint256 internal constant ROLE_RENEW = 1 << 16;
    /// @dev Nybble 36: authorizes setting `ROLE_RENEW`.
    uint256 internal constant ROLE_RENEW_ADMIN = ROLE_RENEW << 128;

    /// @dev Nybble 5: authorizes changing a name's child registry. Root or token.
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    /// @dev Nybble 37: authorizes setting `ROLE_SET_SUBREGISTRY`.
    uint256 internal constant ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128;

    /// @dev Nybble 6: authorizes changing a name's resolver. Root or token.
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    /// @dev Nybble 38: authorizes setting `ROLE_SET_RESOLVER`.
    uint256 internal constant ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128;

    /// @dev Nybble 39: authorizes ERC1155 token transfers. Root or token.
    ///      This role is only checked on the token owner, not the operator.
    uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;

    /// @dev Nybble 8: tags a name that was registered via `ROLE_REGISTER_RESERVED`. Token only. Not revokable.
    uint256 internal constant ROLE_WAS_RESERVED = (1 << 32);

    /// @dev Nybble 9: authorizes setting the URI. Root-only.
    uint256 internal constant ROLE_SET_URI = 1 << 36;
    /// @dev Nybble 41: authorizes setting `ROLE_SET_URI`.
    uint256 internal constant ROLE_SET_URI_ADMIN = ROLE_SET_URI << 128;

    /// @dev Nybble 30: authorizes contract naming. Root-only.
    uint256 internal constant ROLE_CAN_NAME = 1 << 120;
    /// @dev Nybble 62: authorizes setting ROLE_CAN_NAME.
    uint256 internal constant ROLE_CAN_NAME_ADMIN = ROLE_CAN_NAME << 128;

    /// @dev Nybble 31: authorizes UUPS proxy upgrades. Root-only.
    uint256 internal constant ROLE_UPGRADE = 1 << 124;
    /// @dev Nybble 63: authorizes setting `ROLE_UPGRADE`.
    uint256 internal constant ROLE_UPGRADE_ADMIN = ROLE_UPGRADE << 128;

    /// @dev Root roles that violate token emancipation.
    ///      Does not include `ROLE_RENEW` and `ROLE_RENEW_ADMIN`.
    uint256 internal constant UNEMANCIPATED_ROLE_BITMAP =
        ROLE_SET_SUBREGISTRY |
        ROLE_SET_SUBREGISTRY_ADMIN |
        ROLE_SET_RESOLVER |
        ROLE_SET_RESOLVER_ADMIN |
        ROLE_UNREGISTER |
        ROLE_UNREGISTER_ADMIN |
        ROLE_UPGRADE |
        ROLE_UPGRADE_ADMIN;
}
