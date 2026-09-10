// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IBaseRegistrar} from "@ens/contracts/ethregistrar/IBaseRegistrar.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {INameWrapper} from "@ens/contracts/wrapper/INameWrapper.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {InvalidOwner, UnauthorizedCaller} from "../CommonErrors.sol";
import {REGISTRATION_ROLE_BITMAP} from "../registrar/ETHRegistrar.sol";
import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

import {AbstractWrapperReceiver} from "./AbstractWrapperReceiver.sol";
import {LibMigration} from "./libraries/LibMigration.sol";

/// @title UnlockedMigrationController
/// @notice Migration controller for handling unwrapped and unlocked .eth names.
///
/// Assumes premigration has `RESERVED` existing ENSv1 names.
/// Requires `ROLE_REGISTER_RESERVED` on .eth registry to perform migration.
///
/// Supports (2) token sources:
/// 1. NameWrapper (ERC-1155) but unlocked only.
///    Reverts with `NameIsWrapped` if `LibMigration.isLocked()` => use LockedMigrationController instead.
/// 2. BaseRegistrar (ERC-721)
///
/// Unlike locked migration, no subregistry is deployed and no fuse-to-role translation is
/// performed.  The name is registered in the .eth registry with the roles and subregistry
/// specified in the caller-provided `LibMigration.Data`.
///
contract UnlockedMigrationController is
    AbstractWrapperReceiver,
    IERC721Receiver,
    DelegatedContractNamer
{
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 .eth `PermissionedRegistry` where migrated names are registered.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    /// @dev The ENSv1 `BaseRegistrar` contract.
    IBaseRegistrar internal immutable _BASE_REGISTRAR;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param nameWrapper The ENSv1 `NameWrapper` contract.
    /// @param graveyard The ENSv1 `BaseRegistrar` token graveyard.
    /// @param ethRegistry The ENSv2 .eth `PermissionedRegistry` where migrated names are registered.
    /// @param contractNamer Delegated contract namer.
    constructor(
        INameWrapper nameWrapper,
        address graveyard,
        IPermissionedRegistry ethRegistry,
        IContractNamer contractNamer
    )
        AbstractWrapperReceiver(nameWrapper, graveyard)
        DelegatedContractNamer(contractNamer)
    {
        ETH_REGISTRY = ethRegistry;
        _BASE_REGISTRAR = nameWrapper.registrar();
    }

    /// @inheritdoc DelegatedContractNamer
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbstractWrapperReceiver, DelegatedContractNamer)
        returns (bool)
    {
        return
            interfaceId == type(IERC721Receiver).interfaceId || super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Receives an unwrapped .eth name via ERC721 `safeTransferFrom` from the `BaseRegistrar`.
    ///         Decodes a single `LibMigration.Data` from `data` and registers the equivalent name in ENSv2.
    /// @param {operator} Ignored.
    /// @param {from} Ignored.
    /// @param tokenId The BaseRegistrar token ID (labelhash) of the name being migrated.
    /// @param data ABI-encoded `LibMigration.Data` struct containing migration parameters.
    /// @return The selector of the `onERC721Received` function.
    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 tokenId,
        bytes calldata data
    )
        external
        returns (bytes4)
    {
        if (msg.sender != address(_BASE_REGISTRAR)) {
            revert UnauthorizedCaller(msg.sender);
        }
        if (data.length < LibMigration.MIN_DATA_SIZE) {
            revert LibMigration.InvalidData();
        }
        LibMigration.Data memory md = abi.decode(data, (LibMigration.Data)); // reverts if invalid
        if (tokenId != uint256(keccak256(bytes(md.label)))) {
            revert LibMigration.NameDataMismatch(tokenId);
        }
        _BASE_REGISTRAR.reclaim(tokenId, address(this));
        _REGISTRY_V1.setRecord(
            NameCoder.namehash(NameCoder.ETH_NODE, bytes32(tokenId)),
            GRAVEYARD, // transfer ownership to graveyard
            address(0), // clear ENSv1 resolver
            0
        );
        _BASE_REGISTRAR.safeTransferFrom(address(this), GRAVEYARD, tokenId); // transfer token to graveyard
        _inject(md);
        return this.onERC721Received.selector;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc AbstractWrapperReceiver
    /// @dev Reverts `NameIsLocked` if any token is locked.
    ///      Reverts `NameDataMismatch` if any token is mislabeled.
    /// @param ids The NameWrapper token IDs (namehash) of the names to migrate.
    /// @param mds The migration parameters for each name, indexed in parallel with `ids`.
    function _migrateWrapped(uint256[] calldata ids, LibMigration.Data[] calldata mds)
        internal
        override
    {
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            (, uint32 fuses, ) = NAME_WRAPPER.getData(id);
            if (LibMigration.isLocked(fuses)) {
                revert LibMigration.NameIsLocked(id);
            }
            bytes32 labelHash = keccak256(bytes(mds[i].label));
            if (bytes32(id) != NameCoder.namehash(NameCoder.ETH_NODE, labelHash)) {
                revert LibMigration.NameDataMismatch(id);
            }
            NAME_WRAPPER.setResolver(bytes32(id), address(0)); // clear ENSv1 resolver
            NAME_WRAPPER.unwrapETH2LD(labelHash, GRAVEYARD, GRAVEYARD); // unwrap and transfer to graveyard
            _inject(mds[i]);
        }
    }

    /// @dev Claim premigrated reservation.
    function _inject(LibMigration.Data memory md) internal {
        if (md.owner == address(0)) {
            revert InvalidOwner();
        }
        // Register the name in the ETH registry
        ETH_REGISTRY.register(
            md.label,
            md.owner,
            md.subregistry,
            md.resolver,
            REGISTRATION_ROLE_BITMAP,
            0 // use reserved expiry
        ); // reverts if not RESERVED
    }
}
