// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {
    INameWrapper,
    CAN_EXTEND_EXPIRY,
    CANNOT_APPROVE,
    CANNOT_CREATE_SUBDOMAIN,
    CANNOT_SET_RESOLVER,
    CANNOT_TRANSFER
} from "@ens/contracts/wrapper/INameWrapper.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {InvalidOwner} from "../CommonErrors.sol";
import {REGISTRATION_ROLE_BITMAP} from "../registrar/ETHRegistrar.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {
    IWrapperRegistryInitializable
} from "../registry/interfaces/IWrapperRegistryInitializable.sol";
import {RegistryRolesLib} from "../registry/libraries/RegistryRolesLib.sol";
import {IAddressSet} from "../utils/interfaces/IAddressSet.sol";

import {AbstractWrapperReceiver} from "./AbstractWrapperReceiver.sol";
import {LibMigration} from "./libraries/LibMigration.sol";

/// @title LockedWrappedReceiver
/// @dev AbstractWrapperReceiver for locked NameWrapper tokens.
///
/// There are (2) LockedWrapperReceiver implementations:
/// 1. LockedMigrationController only accepts .eth 2LD tokens.
/// 2. WrapperRegistry only accepts emancipated (N+1)-LD children with a matching N-LD parent node.
///
/// eg. transfer("nick.eth") => LockedMigrationController
///     ↪ ETHRegistry.subregistry("nick") = WrapperRegistry("nick.eth")
///     transfer("sub.nick.eth") => WrapperRegistry("nick.eth")
///     ↪ WrapperRegistry("nick.eth").subregistry("sub") = WrapperRegistry("sub.nick.eth")
///     transfer("abc.sub.nick.eth") => WrapperRegistry("sub.nick.eth")
///     ↪ WrapperRegistry("sub.nick.eth").subregistry("abc") = WrapperRegistry("abc.sub.nick.eth")
///
/// Upon successful migration:
/// * subregistry is bound to a WrapperRegistry (does not have `ROLE_SET_SUBREGISTRY`)
/// * subregistry is canonical (does not have `ROLE_SET_PARENT`) and knows its name
/// * subregistry migrates emancipated children with the same parent
///
abstract contract LockedWrapperReceiver is AbstractWrapperReceiver {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The shared factory for verifiable deployments.
    IVerifiableFactory public immutable VERIFIABLE_FACTORY;

    /// @notice The `WrapperRegistry` implementation contract.
    address public immutable WRAPPER_REGISTRY_IMPL;

    /// @notice The list of `PublicResolver` contracts that require replacement.
    IAddressSet public immutable PUBLIC_RESOLVER_SET;

    /// @notice The replacement `PublicResolver`.
    address public immutable PUBLIC_RESOLVER;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param nameWrapper The ENSv1 `NameWrapper` contract.
    /// @param graveyard The ENSv1 `BaseRegistrar` token graveyard.
    /// @param verifiableFactory The shared factory for verifiable deployments.
    /// @param wrapperRegistryImpl The `WrapperRegistry` implementation contract.
    /// @param publicResolverSet The list of `PublicResolver` contracts that require replacement.
    /// @param publicResolver The replacement `PublicResolver`.
    constructor(
        INameWrapper nameWrapper,
        address graveyard,
        IVerifiableFactory verifiableFactory,
        address wrapperRegistryImpl,
        IAddressSet publicResolverSet,
        address publicResolver
    )
        AbstractWrapperReceiver(nameWrapper, graveyard)
    {
        VERIFIABLE_FACTORY = verifiableFactory;
        WRAPPER_REGISTRY_IMPL = wrapperRegistryImpl;
        PUBLIC_RESOLVER_SET = publicResolverSet;
        PUBLIC_RESOLVER = publicResolver;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Returns the DNS-encoded name for this registry.
    function getWrappedName() public view virtual returns (bytes memory) {
        return NAME_WRAPPER.names(getWrappedNode());
    }

    /// @notice Returns the NameWrapper node (namehash).
    function getWrappedNode() public view virtual returns (bytes32);

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc AbstractWrapperReceiver
    function _migrateWrapped(uint256[] calldata ids, LibMigration.Data[] calldata mds)
        internal
        override
    {
        IRegistry parentRegistry = _getRegistry();
        bytes32 parentNode = getWrappedNode();
        for (uint256 i; i < ids.length; ++i) {
            LibMigration.Data memory md = mds[i];
            if (md.owner == address(0)) {
                revert InvalidOwner();
            }
            bytes32 node = bytes32(ids[i]);
            bytes32 labelHash = keccak256(bytes(md.label));
            if (node != NameCoder.namehash(parentNode, labelHash)) {
                revert LibMigration.NameDataMismatch(uint256(node));
            }

            // by construction: 1 <= length(label) <= 255
            // same as NameCoder.assertLabelSize()
            // see: V1Fixture.t.sol: `test_nameWrapper_labelTooShort()` and `test_nameWrapper_labelTooLong()`.

            address resolver = md.resolver;
            (, uint32 fuses, uint64 expiry) = NAME_WRAPPER.getData(uint256(node));
            if (LibMigration.isLocked(fuses)) {
                if (
                    (fuses & CANNOT_APPROVE) != 0 &&
                    NAME_WRAPPER.getApproved(uint256(node)) != address(0)
                ) {
                    revert LibMigration.FrozenTokenApproval(uint256(node));
                }

                if ((fuses & CANNOT_SET_RESOLVER) == 0) {
                    NAME_WRAPPER.setResolver(node, address(0)); // clear ENSv1 resolver
                } else {
                    resolver = _REGISTRY_V1.resolver(node); // replace with ENSv1 resolver
                    if (resolver != address(0) && PUBLIC_RESOLVER_SET.includes(resolver)) {
                        resolver = PUBLIC_RESOLVER; // replace with new PublicResolver
                    }
                }

                NAME_WRAPPER.safeTransferFrom(address(this), GRAVEYARD, uint256(node), 1, ""); // transfer to graveyard

                // create subregistry
                IRegistry subregistry =
                    IRegistry(
                        VERIFIABLE_FACTORY.deployProxy(
                            WRAPPER_REGISTRY_IMPL,
                            uint256(node),
                            abi.encodeCall(
                                IWrapperRegistryInitializable.initialize,
                                (
                                    node,
                                    parentRegistry,
                                    md.label,
                                    _subregistryRoleBitmapFromFuses(fuses)
                                )
                            )
                        )
                    );

                // add name to ENSv2
                // PermissionedRegistry._register() => CannotSetPastExpiry :: see expiry check
                // PermissionedRegistry._register() => LabelAlreadyRegistered :: only have ROLE_REGISTER_RESERVED
                // ERC1155._safeTransferFrom() => ERC1155InvalidReceiver :: see owner check
                _inject(
                    md.label,
                    md.owner,
                    subregistry,
                    resolver,
                    _tokenRoleBitmapFromFuses(fuses),
                    expiry
                );
            } else if (LibMigration.isEmancipatedChild(fuses)) {
                NAME_WRAPPER.setResolver(node, address(0)); // clear ENSv1 resolver
                NAME_WRAPPER.unwrap(parentNode, labelHash, GRAVEYARD); // unwrap and transfer to graveyard

                // add name to ENSv2 (same as UnlockedMigrationController, plus
                // renewal rights when the name could extend its own expiry in v1)
                uint256 roleBitmap = REGISTRATION_ROLE_BITMAP;
                if ((fuses & CAN_EXTEND_EXPIRY) != 0) {
                    roleBitmap |= RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_RENEW_ADMIN;
                }
                _inject(md.label, md.owner, md.subregistry, resolver, roleBitmap, expiry);
            } else {
                revert LibMigration.NameNotLocked(uint256(node));
            }
        }
    }

    /// @dev Register a locked name.
    function _inject(
        string memory label,
        address owner,
        IRegistry subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    )
        internal
        virtual
        returns (uint256 tokenId);

    /// @dev The ENSv2 registry being migrated to.
    function _getRegistry() internal view virtual returns (IRegistry);

    /// @dev Convert fuses to equivalent subregistry root roles.
    function _subregistryRoleBitmapFromFuses(uint32 fuses)
        internal
        pure
        returns (uint256 roleBitmap)
    {
        if ((fuses & CANNOT_CREATE_SUBDOMAIN) == 0) {
            roleBitmap |= RegistryRolesLib.ROLE_REGISTRAR;
        }
        roleBitmap |=
            RegistryRolesLib.ROLE_RENEW |
            RegistryRolesLib.ROLE_UPGRADE |
            RegistryRolesLib.ROLE_CAN_NAME;
        if (LibMigration.notFrozen(fuses)) {
            roleBitmap |= roleBitmap << 128; // give admin
        }
    }

    /// @dev Convert fuses to equivalent token roles.
    function _tokenRoleBitmapFromFuses(uint32 fuses) internal pure returns (uint256 roleBitmap) {
        if ((fuses & CAN_EXTEND_EXPIRY) != 0) {
            roleBitmap |= RegistryRolesLib.ROLE_RENEW;
        }
        if ((fuses & CANNOT_SET_RESOLVER) == 0) {
            roleBitmap |= RegistryRolesLib.ROLE_SET_RESOLVER;
        }
        if (LibMigration.notFrozen(fuses)) {
            roleBitmap |= roleBitmap << 128; // give admin
        }
        if ((fuses & CANNOT_TRANSFER) == 0) {
            roleBitmap |= RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN; // no user
        }
    }
}
