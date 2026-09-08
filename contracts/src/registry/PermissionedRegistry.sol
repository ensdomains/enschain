// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {EnhancedAccessControl} from "../access-control/EnhancedAccessControl.sol";
import {IEnhancedAccessControl} from "../access-control/interfaces/IEnhancedAccessControl.sol";
import {ERC1155Singleton} from "../erc1155/ERC1155Singleton.sol";
import {IERC1155Singleton} from "../erc1155/interfaces/IERC1155Singleton.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {ILabelStore} from "../utils/interfaces/ILabelStore.sol";
import {LibLabel} from "../utils/LibLabel.sol";

import {IOwnedRegistry} from "./interfaces/IOwnedRegistry.sol";
import {IPermissionedRegistry} from "./interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "./interfaces/IRegistry.sol";
import {IRegistryURIRenderer} from "./interfaces/IRegistryURIRenderer.sol";
import {IStandardRegistry} from "./interfaces/IStandardRegistry.sol";
import {ITemporalRegistry} from "./interfaces/ITemporalRegistry.sol";
import {ITokenizedRegistry} from "./interfaces/ITokenizedRegistry.sol";
import {RegistryRolesLib} from "./libraries/RegistryRolesLib.sol";

/// @notice A tokenized (ERC1155) registry with resource-scoped access control for subdomain management.
///
/// Many functions accept an `anyId` parameter that can be a labelhash, tokenId, or resource
/// interchangeably. Internally, `_entry()` zeroes version bits (via `LibLabel.withVersion(anyId, 0)`)
/// to resolve any of these to the canonical storage slot for the name.
///
/// The registry maintains two independent version counters per name:
///   - `eacVersionId`: incremented on unregister/re-register. Combined with the labelhash to form
///     the EAC resource ID. This means a re-registered name gets a fresh permission scope.
///   - `tokenVersionId`: incremented on unregister and whenever the token is regenerated (burn + mint)
///     due to role changes. Combined with the labelhash to form the ERC1155 token ID, ensuring
///     changes to roles create new tokens and prevent frontrunning a transfer with a role revocation.
///
/// Names are treated as `AVAILABLE` once `block.timestamp >= expiry`.
///
/// State diagram:
///
///                      register()
///                   +ROLE_REGISTRAR
///       +------------------->----------------------+
///       |                                          |
///       |                renew()                   |    renew()
///       |              +ROLE_RENEW                 |  +ROLE_RENEW
///       |               +------+                   |   +------+
///       |               |      |                   |   |      |
///       ʌ               ʌ      v                   v   v      |
///   AVAILABLE --------> RESERVED -------------> REGISTERED >--+
///       ʌ    register()    v       register()        v
///       |    w/owner=0     | +ROLE_REGISTER_RESERVED |
///       | +ROLE_REGISTRAR  |                         |
///       |                  |                         |
///       +--------<---------+------------<------------+
///                     unregister()
///                  +ROLE_UNREGISTER
///
contract PermissionedRegistry is ERC1155Singleton, EnhancedAccessControl, IPermissionedRegistry {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct Entry {
        /// @dev Incremented on unregister; combined with labelhash to form the EAC resource ID.
        uint32 eacVersionId;
        /// @dev Incremented on unregister and on token regeneration; combined with labelhash to form the ERC1155 token ID.
        uint32 tokenVersionId;
        /// @dev Child registry for this name.
        IRegistry subregistry;
        /// @dev Timestamp at or after which the name is considered expired/available.
        uint64 expiry;
        /// @dev Resolver address for this name.
        address resolver;
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The shared label database.
    ILabelStore public immutable LABEL_STORE;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev The parent registry of this registry.
    IRegistry internal _parentRegistry;

    /// @dev The child label of this registry.
    string internal _childLabel;

    /// @dev The metadata URI.
    string internal _uri;

    /// @dev The metadata renderer.
    IRegistryURIRenderer internal _uriRenderer;

    /// @dev The entries of this registry.
    mapping(uint256 storageId => Entry entry) internal _entries;

    /// @dev Storage gap for future changes.
    uint256[256] private __gap;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param labelStore The shared label database.
    /// @param rootAccount Account granted root roles.
    /// @param roleBitmap The role bitmap granted to `rootAccount`.
    constructor(ILabelStore labelStore, address rootAccount, uint256 roleBitmap) {
        emit RegistryCreated();
        LABEL_STORE = labelStore;
        _grantRoles(ROOT_RESOURCE, roleBitmap, rootAccount, false);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(IERC165, ERC1155Singleton, EnhancedAccessControl)
        returns (bool)
    {
        return
            interfaceId == type(IPermissionedRegistry).interfaceId ||
            interfaceId == type(IStandardRegistry).interfaceId ||
            interfaceId == type(ITokenizedRegistry).interfaceId ||
            interfaceId == type(ITemporalRegistry).interfaceId ||
            interfaceId == type(IOwnedRegistry).interfaceId ||
            interfaceId == type(IRegistry).interfaceId ||
            interfaceId == type(IContractNamer).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IStandardRegistry
    function setSubregistry(uint256 anyId, IRegistry registry) public virtual {
        (uint256 tokenId, Entry storage entry) =
            _checkExpiryAndTokenRoles(anyId, RegistryRolesLib.ROLE_SET_SUBREGISTRY);
        entry.subregistry = registry;
        emit SubregistryUpdated(tokenId, registry, msg.sender);
    }

    /// @inheritdoc IStandardRegistry
    function setResolver(uint256 anyId, address resolver) public virtual {
        (uint256 tokenId, Entry storage entry) =
            _checkExpiryAndTokenRoles(anyId, RegistryRolesLib.ROLE_SET_RESOLVER);
        entry.resolver = resolver;
        emit ResolverUpdated(tokenId, resolver, msg.sender);
    }

    /// @inheritdoc IPermissionedRegistry
    function setURI(string calldata uri_, IRegistryURIRenderer renderer)
        public
        virtual
        onlyRootRoles(RegistryRolesLib.ROLE_SET_URI)
    {
        _uri = uri_;
        _uriRenderer = renderer;
        emit URIUpdated(uri_, address(renderer), msg.sender);
    }

    /// @inheritdoc IStandardRegistry
    function setParent(IRegistry parent, string memory label)
        public
        onlyRootRoles(RegistryRolesLib.ROLE_SET_PARENT)
    {
        _parentRegistry = parent;
        _childLabel = label;
        emit ParentUpdated(parent, label, msg.sender);
    }

    /// @inheritdoc IStandardRegistry
    function register(
        string memory label,
        address owner,
        IRegistry registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    )
        public
        virtual
        returns (uint256)
    {
        return _register(label, owner, registry, resolver, roleBitmap, expiry, true);
    }

    /// @inheritdoc IStandardRegistry
    /// @dev Requires `REGISTERED | RESERVED` and `ROLE_UNREGISTER`.
    function unregister(uint256 anyId) public {
        (uint256 tokenId, Entry storage entry) =
            _checkExpiryAndTokenRoles(anyId, RegistryRolesLib.ROLE_UNREGISTER);
        emit LabelUnregistered(tokenId, msg.sender);
        address owner = super.ownerOf(tokenId);
        if (owner != address(0)) {
            _burn(owner, tokenId, 1);
            ++entry.eacVersionId;
            ++entry.tokenVersionId;
        }
        entry.expiry = uint64(block.timestamp);
    }

    /// @inheritdoc IStandardRegistry
    /// @dev If `REGISTERED | RESERVED`, requires `ROLE_RENEW`.
    ///      If `AVAILABLE`, requires expiry > 0 and `ROLE_RENEW` on root.
    function renew(uint256 anyId, uint64 newExpiry) public override {
        Entry storage entry = _entry(anyId);
        uint256 tokenId = _constructTokenId(anyId, entry);
        uint64 expiry = entry.expiry;
        if (_isExpired(expiry)) {
            if (expiry == 0 || !_canRevive(tokenId, msg.sender)) {
                revert LabelExpired(tokenId); // never registered OR cannot revive
            }
        } else {
            _checkRoles(_constructResource(anyId, entry), RegistryRolesLib.ROLE_RENEW, msg.sender);
        }
        if (newExpiry < expiry) {
            revert CannotReduceExpiry(expiry, newExpiry);
        }
        entry.expiry = newExpiry;
        emit ExpiryUpdated(tokenId, newExpiry, msg.sender);
    }

    /// @inheritdoc IEnhancedAccessControl
    function grantRoles(uint256 anyId, uint256 roleBitmap, address account)
        public
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (bool)
    {
        return super.grantRoles(getResource(anyId), roleBitmap, account);
    }

    /// @inheritdoc IEnhancedAccessControl
    function revokeRoles(uint256 anyId, uint256 roleBitmap, address account)
        public
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (bool)
    {
        return super.revokeRoles(getResource(anyId), roleBitmap, account);
    }

    /// @inheritdoc IRegistry
    function getSubregistry(string calldata label) public view virtual returns (IRegistry) {
        Entry storage entry = _entry(LibLabel.id(label));
        return _isExpired(entry.expiry) ? IRegistry(address(0)) : entry.subregistry;
    }

    /// @inheritdoc IRegistry
    function getResolver(string calldata label) public view virtual returns (address) {
        Entry storage entry = _entry(LibLabel.id(label));
        return _isExpired(entry.expiry) ? address(0) : entry.resolver;
    }

    /// @inheritdoc IRegistry
    function getParent() public view returns (IRegistry parent, string memory label) {
        return (_parentRegistry, _childLabel);
    }

    /// @inheritdoc IPermissionedRegistry
    function getURI() public view returns (string memory uri_, IRegistryURIRenderer renderer) {
        return (_uri, _uriRenderer);
    }

    /// @inheritdoc IContractNamer
    function isContractNamer(address namer) public view virtual returns (bool) {
        return hasRootRoles(RegistryRolesLib.ROLE_CAN_NAME, namer);
    }

    /// @inheritdoc ITemporalRegistry
    function findExpiry(string calldata label) public view returns (uint64) {
        return getExpiry(LibLabel.id(label));
    }

    /// @inheritdoc IOwnedRegistry
    function findOwner(string calldata label) public view returns (address) {
        return getOwner(LibLabel.id(label));
    }

    /// @inheritdoc ITokenizedRegistry
    function findTokenId(string calldata label) public view returns (uint256) {
        return getTokenId(LibLabel.id(label));
    }

    /// @inheritdoc ERC1155Singleton
    function uri(uint256 tokenId) public view override returns (string memory) {
        return
            address(_uriRenderer) != address(0)
                ? _uriRenderer.renderURI(this, tokenId)
                : _uri;
    }

    /// @inheritdoc IStandardRegistry
    function getExpiry(uint256 anyId) public view returns (uint64) {
        return _entry(anyId).expiry;
    }

    /// @inheritdoc IPermissionedRegistry
    function getResource(uint256 anyId) public view returns (uint256) {
        return _constructResource(anyId, _entry(anyId));
    }

    /// @inheritdoc IPermissionedRegistry
    function getTokenId(uint256 anyId) public view returns (uint256) {
        return _constructTokenId(anyId, _entry(anyId));
    }

    /// @inheritdoc IPermissionedRegistry
    function getOwner(uint256 anyId) public view returns (address) {
        return _isExpired(getExpiry(anyId)) ? address(0) : super.ownerOf(getTokenId(anyId));
    }

    /// @inheritdoc IPermissionedRegistry
    function getStatus(uint256 anyId) public view returns (Status) {
        Entry storage entry = _entry(anyId);
        return _constructStatus(entry.expiry, super.ownerOf(_constructTokenId(anyId, entry)));
    }

    /// @inheritdoc IPermissionedRegistry
    function getState(uint256 anyId) public view returns (State memory state) {
        Entry storage entry = _entry(anyId);
        uint64 expiry = entry.expiry;
        state.expiry = expiry;
        uint256 tokenId = _constructTokenId(anyId, entry);
        state.tokenId = tokenId;
        state.resource = _constructResource(anyId, entry);
        address owner = super.ownerOf(tokenId);
        state.latestOwner = owner;
        state.status = _constructStatus(expiry, owner);
    }

    /// @inheritdoc IPermissionedRegistry
    function latestOwnerOf(uint256 tokenId) public view returns (address) {
        return super.ownerOf(tokenId);
    }

    /// @inheritdoc IERC1155Singleton
    function ownerOf(uint256 tokenId)
        public
        view
        override(ERC1155Singleton, IERC1155Singleton)
        returns (address)
    {
        Entry storage entry = _entry(tokenId);
        return
            tokenId != _constructTokenId(tokenId, entry) || _isExpired(entry.expiry)
                ? address(0)
                : super.ownerOf(tokenId);
    }

    /// @inheritdoc IEnhancedAccessControl
    function roles(uint256 anyId, address account)
        public
        view
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (uint256)
    {
        return super.roles(getResource(anyId), account);
    }

    /// @inheritdoc IEnhancedAccessControl
    function roleCount(uint256 anyId)
        public
        view
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (uint256)
    {
        return super.roleCount(getResource(anyId));
    }

    /// @inheritdoc IEnhancedAccessControl
    function hasRoles(uint256 anyId, uint256 roleBitmap, address account)
        public
        view
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (bool)
    {
        return super.hasRoles(getResource(anyId), roleBitmap, account);
    }

    /// @inheritdoc IEnhancedAccessControl
    function getAssigneeCount(uint256 anyId, uint256 roleBitmap)
        public
        view
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (uint256 counts, uint256 mask)
    {
        return super.getAssigneeCount(getResource(anyId), roleBitmap);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev If `AVAILABLE`, requires `ROLE_REGISTRAR` on root and status becomes `REGISTERED`.
    ///         * If `owner` is null (`roleBitmap` must be 0), status becomes `RESERVED`.
    ///      If `RESERVED`, requires `ROLE_REGISTER_RESERVED` on root and status becomes `REGISTERED`.
    ///         * If `expiry` is 0, uses current expiry.
    function _register(
        string memory label,
        address owner,
        IRegistry registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry,
        bool checkRoles
    )
        internal
        returns (uint256 tokenId)
    {
        LABEL_STORE.setLabel(label);
        uint256 labelId = LibLabel.id(label);
        Entry storage entry = _entry(labelId);
        tokenId = _constructTokenId(labelId, entry);
        address prevOwner = super.ownerOf(tokenId);
        if (_isExpired(entry.expiry)) {
            if (checkRoles) {
                _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTRAR, msg.sender);
            }
            if (owner == address(0) && roleBitmap != 0) {
                revert EACCannotGrantRoles(ROOT_RESOURCE, roleBitmap, msg.sender); // strict
            }
        } else {
            if (prevOwner != address(0)) {
                revert LabelAlreadyRegistered(label); // cannot overwrite REGISTERED
            } else if (owner == address(0)) {
                revert LabelAlreadyReserved(label); // cannot overwrite RESERVED
            }
            if (checkRoles) {
                _checkRoles(ROOT_RESOURCE, RegistryRolesLib.ROLE_REGISTER_RESERVED, msg.sender);
            }
            if (expiry == 0) {
                expiry = entry.expiry; // use RESERVED expiry
            }
            roleBitmap |= RegistryRolesLib.ROLE_WAS_RESERVED; // remember
        }
        if (owner == address(0) ? expiry == 0 : _isExpired(expiry)) {
            revert CannotSetPastExpiry(expiry);
        }
        if (prevOwner != address(0)) {
            _burn(prevOwner, tokenId, 1);
            ++entry.eacVersionId;
            ++entry.tokenVersionId;
            tokenId = _constructTokenId(tokenId, entry);
        }
        entry.expiry = expiry;
        entry.subregistry = registry;
        entry.resolver = resolver;
        if (owner == address(0)) {
            emit LabelReserved(tokenId, bytes32(labelId), label, expiry, msg.sender);
        } else {
            emit LabelRegistered(tokenId, bytes32(labelId), label, owner, expiry, msg.sender);
            _mint(owner, tokenId, 1, "");
            uint256 resource = _constructResource(tokenId, entry);
            assert(resource != ROOT_RESOURCE);
            emit TokenResource(tokenId, resource);
            _grantRoles(resource, roleBitmap, owner, false);
        }
        if (address(registry) != address(0)) {
            emit SubregistryUpdated(tokenId, registry, msg.sender);
        }
        if (address(resolver) != address(0)) {
            emit ResolverUpdated(tokenId, resolver, msg.sender);
        }
    }

    /// @dev Override `ERC1155Singleton._update()` to transfer the roles to the new owner if the token is transferred.
    function _update(address from, address to, uint256[] memory tokenIds, uint256[] memory amounts)
        internal
        override
    {
        super._update(from, to, tokenIds, amounts); // ensures amounts[i] is 0 or 1
        if (to != address(0) && from != address(0)) {
            // only transfers (skip mint and burn)
            for (uint256 i; i < tokenIds.length; ++i) {
                uint256 tokenId = tokenIds[i];
                uint256 resource = getResource(tokenId);
                // only check ROLE_CAN_TRANSFER_ADMIN on original owner (from)
                // ROLE_CAN_TRANSFER_ADMIN is technically a property of the token
                if ((_getRoles(resource, from) & RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN) == 0) {
                    revert TransferDisallowed(tokenId, from);
                } else if (amounts[i] > 0) {
                    _transferRoles(resource, from, to, false);
                }
            }
        }
    }

    /// @dev Override the base registry _onRolesGranted function to regenerate the token when the roles are granted.
    function _onRolesGranted(
        uint256 resource,
        address /*account*/,
        uint256 /*oldRoles*/,
        uint256 /*newRoles*/,
        uint256 /*roleBitmap*/
    )
        internal
        override
    {
        _regenerate(resource);
    }

    /// @dev Override the base registry _onRolesRevoked function to regenerate the token when the roles are revoked.
    function _onRolesRevoked(
        uint256 resource,
        address /*account*/,
        uint256 /*oldRoles*/,
        uint256 /*newRoles*/,
        uint256 /*roleBitmap*/
    )
        internal
        override
    {
        _regenerate(resource);
    }

    /// @dev Bump `tokenVersionId` via burn+mint if token is not expired.
    function _regenerate(uint256 resource) internal {
        if (resource != ROOT_RESOURCE) {
            Entry storage entry = _entry(resource);
            uint256 tokenId = _constructTokenId(resource, entry);
            address owner = super.ownerOf(tokenId); // grant/revoke only on registered
            _burn(owner, tokenId, 1);
            ++entry.tokenVersionId;
            uint256 newTokenId = _constructTokenId(tokenId, entry);
            emit TokenRegenerated(tokenId, newTokenId); // resource is unchanged
            _mint(owner, newTokenId, 1, "");
        }
    }

    /// @inheritdoc EnhancedAccessControl
    /// @dev Override for token-dependent logic:
    ///
    /// Token non-admin roles can only be granted to registered tokens.
    ///
    /// Token admin roles are only assigned during name registration to maintain
    /// controlled permission management. This ensures that role delegation
    /// follows the intended security model where admin privileges are granted at
    /// registration time and cannot be arbitrarily granted afterward.
    ///
    /// Root admin roles are unaffected.
    ///
    /// @param resource The resource to get settable roles for.
    /// @param account The account to get settable roles for.
    /// @return The settable roles (regular roles only, not admin roles).
    function _getSettableRoles(uint256 resource, address account)
        internal
        view
        virtual
        override
        returns (uint256)
    {
        if (resource != ROOT_RESOURCE && getOwner(resource) == address(0)) {
            return 0;
        }
        uint256 roleBitmap = super._getSettableRoles(resource, account);
        return resource == ROOT_RESOURCE ? roleBitmap : roleBitmap >> 128;
    }

    /// @inheritdoc EnhancedAccessControl
    /// @dev Override for token-dependent logic:
    ///
    /// * if caller is approved by token owner, combine the caller's roles with the owner's roles
    ///
    function _getRoles(uint256 resource, address account)
        internal
        view
        virtual
        override
        returns (uint256 roleBitmap)
    {
        roleBitmap = super._getRoles(resource, account);
        if (resource != ROOT_RESOURCE) {
            address owner = getOwner(resource);
            if (owner != address(0) && owner != account && isApprovedForAll(owner, account)) {
                roleBitmap |= super._getRoles(resource, owner);
            }
        }
    }

    /// @dev Zeroes version bits in `anyId` to return the canonical storage entry for the name.
    function _entry(uint256 anyId) internal view returns (Entry storage) {
        return _entries[LibLabel.withVersion(anyId, 0)];
    }

    /// @dev Determine if token can be revived.
    function _canRevive(
        uint256 /*tokenId*/,
        address sender
    )
        internal
        view
        virtual
        returns (bool)
    {
        return hasRootRoles(RegistryRolesLib.ROLE_RENEW, sender);
    }

    /// @dev Assert token is not expired and caller has necessary roles.
    function _checkExpiryAndTokenRoles(uint256 anyId, uint256 roleBitmap)
        internal
        view
        returns (uint256 tokenId, Entry storage entry)
    {
        entry = _entry(anyId);
        tokenId = _constructTokenId(anyId, entry);
        if (_isExpired(entry.expiry)) {
            revert LabelExpired(tokenId);
        }
        _checkRoles(_constructResource(anyId, entry), roleBitmap, msg.sender);
    }

    /// @dev Internal logic for expired status.
    function _isExpired(uint64 expiry) internal view returns (bool) {
        return block.timestamp >= expiry;
    }

    /// @dev Create `resource` from parts.
    ///      Does nothing if `ROOT_RESOURCE`.
    ///      Returns next resource if expired.
    function _constructResource(uint256 anyId, Entry storage entry) internal view returns (uint256) {
        if (anyId == ROOT_RESOURCE) {
            return anyId;
        }
        return
            LibLabel.withVersion(
                anyId,
                _isExpired(entry.expiry)
                    ? entry.eacVersionId + 1
                    : entry.eacVersionId
            );
    }

    /// @dev Create `tokenId` from parts.
    function _constructTokenId(uint256 anyId, Entry storage entry) internal view returns (uint256) {
        return LibLabel.withVersion(anyId, entry.tokenVersionId);
    }

    /// @dev Create `Status` from parts.
    function _constructStatus(uint64 expiry, address owner) internal view returns (Status) {
        if (_isExpired(expiry)) {
            return Status.AVAILABLE;
        } else if (owner == address(0)) {
            return Status.RESERVED;
        } else {
            return Status.REGISTERED;
        }
    }
}
