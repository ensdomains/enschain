// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

/// @dev Roles for PermissionedResolver.
library PermissionedResolverLib {
    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Nybble 0: authorizes setting address records. Root or argument.
    uint256 internal constant ROLE_SET_ADDRESS = 1 << 0;
    /// @dev Nybble 32: authorizes setting ROLE_SET_ADDRESS.
    uint256 internal constant ROLE_SET_ADDRESS_ADMIN = ROLE_SET_ADDRESS << 128;

    /// @dev Nybble 1: authorizes setting text records. Root or argument.
    uint256 internal constant ROLE_SET_TEXT = 1 << 4;
    /// @dev Nybble 33: authorizes setting ROLE_SET_TEXT.
    uint256 internal constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;

    /// @dev Nybble 2: authorizes setting the contenthash record. Root-only.
    uint256 internal constant ROLE_SET_CONTENTHASH = 1 << 8;
    /// @dev Nybble 34: authorizes setting ROLE_SET_CONTENTHASH.
    uint256 internal constant ROLE_SET_CONTENTHASH_ADMIN =
        ROLE_SET_CONTENTHASH << 128;

    /// @dev Nybble 3: authorizes setting ABI records. Root or argument.
    uint256 internal constant ROLE_SET_ABI = 1 << 12;
    /// @dev Nybble 35: authorizes setting ROLE_SET_ABI.
    uint256 internal constant ROLE_SET_ABI_ADMIN = ROLE_SET_ABI << 128;

    /// @dev Nybble 4: authorizes setting interface implementer records. Root or argument.
    uint256 internal constant ROLE_SET_INTERFACE = 1 << 16;
    /// @dev Nybble 36: authorizes setting ROLE_SET_INTERFACE.
    uint256 internal constant ROLE_SET_INTERFACE_ADMIN =
        ROLE_SET_INTERFACE << 128;

    /// @dev Nybble 5: authorizes setting the reverse name record. Root-only.
    uint256 internal constant ROLE_SET_NAME = 1 << 20;
    /// @dev Nybble 37: authorizes setting ROLE_SET_NAME.
    uint256 internal constant ROLE_SET_NAME_ADMIN = ROLE_SET_NAME << 128;

    /// @dev Nybble 6: authorizes setting data records. Root or argument.
    uint256 internal constant ROLE_SET_DATA = 1 << 24;
    /// @dev Nybble 38: authorizes setting ROLE_SET_DATA.
    uint256 internal constant ROLE_SET_DATA_ADMIN = ROLE_SET_DATA << 128;

    /// @dev Nybble 7: authorizes linking records. Root-only.
    uint256 internal constant ROLE_LINK = 1 << 28;
    /// @dev Nybble 39: authorizes setting ROLE_LINK.
    uint256 internal constant ROLE_LINK_ADMIN = ROLE_LINK << 128;

    /// @dev Nybble 30: authorizes contract naming. Root-only.
    uint256 internal constant ROLE_CAN_NAME = 1 << 120;
    /// @dev Nybble 62: authorizes setting ROLE_CAN_NAME.
    uint256 internal constant ROLE_CAN_NAME_ADMIN = ROLE_CAN_NAME << 128;

    /// @dev Nybble 31: authorizes UUPS proxy upgrades. Root-only.
    uint256 internal constant ROLE_UPGRADE = 1 << 124;
    /// @dev Nybble 63: authorizes setting ROLE_UPGRADE.
    uint256 internal constant ROLE_UPGRADE_ADMIN = ROLE_UPGRADE << 128;

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Compute EAC resource from `string` argument.
    ///      Equivalent to `uint256(keccak256(abi.encodePacked(s)))`.
    function resource(string calldata s) internal pure returns (uint256 ret) {
        return uint256(keccak256(bytes(s)));
    }

    /// @dev Compute EAC resource from `uint256` argument.
    ///      Equivalent to `uint256(keccak256(abi.encodePacked(x)))`.
    function resource(uint256 x) internal pure returns (uint256 ret) {
        assembly {
            mstore(0, x)
            ret := keccak256(0, 32)
        }
    }

    /// @dev Compute EAC resource from `bytes4` argument.
    ///      Equivalent to `uint256(keccak256(abi.encodePacked(x)))`.
    function resource(bytes4 x) internal pure returns (uint256 ret) {
        assembly {
            mstore(0, x)
            ret := keccak256(0, 4)
        }
    }
}
