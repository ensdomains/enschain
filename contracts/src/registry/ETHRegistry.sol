// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ERC1155Singleton} from "./ERC1155Singleton.sol";
import {IERC1155Singleton} from "./IERC1155Singleton.sol";
import {IRegistry} from "./IRegistry.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {BaseRegistry} from "./BaseRegistry.sol";

contract ETHRegistry is BaseRegistry, AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    uint32 public constant FLAGS_MASK = 0x7;
    uint32 public constant FLAG_SUBREGISTRY_LOCKED = 0x1;
    uint32 public constant FLAG_RESOLVER_LOCKED = 0x2;
    uint32 public constant FLAG_FLAGS_LOCKED = 0x4;

    error NameAlreadyRegistered(string label);
    error NameExpired(uint256 tokenId);
    error CannotReduceExpiration(uint64 oldExpiration, uint64 newExpiration);

    constructor(IRegistryDatastore _datastore) BaseRegistry(_datastore) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function uri(uint256 /*tokenId*/ ) public pure override returns (string memory) {
        return "";
    }

    function ownerOf(uint256 tokenId)
        public
        view
        virtual
        override(ERC1155Singleton, IERC1155Singleton)
        returns (address)
    {
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        uint64 expires = uint64(flags);
        if (expires < block.timestamp) {
            return address(0);
        }
        return super.ownerOf(tokenId);
    }

    function register(string calldata label, address owner, IRegistry registry, uint32 flags, uint64 expires)
        public
        onlyRole(REGISTRAR_ROLE)
        returns (uint256 tokenId)
    {
        flags &= FLAGS_MASK;
        tokenId = (uint256(keccak256(bytes(label))) & ~uint256(FLAGS_MASK)) | flags;

        (, uint96 oldFlags) = datastore.getSubregistry(tokenId);
        uint64 oldExpiry = uint64(oldFlags >> 32);
        if (oldExpiry >= block.timestamp) {
            revert NameAlreadyRegistered(label);
        }

        _mint(tokenId, owner, registry, uint96(flags) | (uint96(expires) << 32));
        emit NewSubname(label);
        return tokenId;
    }

    function renew(uint256 tokenId, uint64 expires) public onlyRole(REGISTRAR_ROLE) {
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        uint64 oldExpiration = uint64(flags >> 32);
        if (oldExpiration < block.timestamp) {
            revert NameExpired(tokenId);
        }
        if (expires < oldExpiration) {
            revert CannotReduceExpiration(oldExpiration, expires);
        }
        datastore.setSubregistry(tokenId, subregistry, (flags & FLAGS_MASK) | (uint96(expires) << 32));
    }

    function nameData(uint256 tokenId) external view returns (uint64 expiry, uint32 flags) {
        (, uint96 _flags) = datastore.getSubregistry(tokenId);
        return (uint64(_flags >> 32), uint32(_flags));
    }

    function lock(uint256 tokenId, uint32 flags)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, FLAG_FLAGS_LOCKED, 0)
        returns (uint256 newTokenId)
    {
        (address subregistry, uint96 oldFlags) = datastore.getSubregistry(tokenId);
        uint96 newFlags = oldFlags | (flags & FLAGS_MASK);
        if (newFlags != oldFlags) {
            address owner = ownerOf(tokenId);
            _burn(owner, tokenId, 1);
            newTokenId = (tokenId & ~uint256(FLAGS_MASK)) | (newFlags & FLAGS_MASK);
            _mint(newTokenId, owner, IRegistry(subregistry), newFlags);
        } else {
            newTokenId = tokenId;
        }
    }

    function setSubregistry(uint256 tokenId, IRegistry registry)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, FLAG_SUBREGISTRY_LOCKED, 0)
    {
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, address(registry), flags);
    }

    function setResolver(uint256 tokenId, address resolver)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, FLAG_RESOLVER_LOCKED, 0)
    {
        (, uint96 flags) = datastore.getResolver(tokenId);
        datastore.setResolver(tokenId, resolver, flags);
    }

    function supportsInterface(bytes4 interfaceId) public view override(BaseRegistry, AccessControl) returns (bool) {
        return interfaceId == type(IRegistry).interfaceId || super.supportsInterface(interfaceId);
    }

    function getSubregistry(string calldata label) external view virtual override returns (IRegistry) {
        (address subregistry, uint96 flags) = datastore.getSubregistry(uint256(keccak256(bytes(label))));
        uint64 expires = uint64(flags);
        if (expires >= block.timestamp) {
            return IRegistry(address(0));
        }
        return IRegistry(subregistry);
    }

    function getResolver(string calldata label) external view virtual override returns (address) {
        (address resolver, uint96 flags) = datastore.getResolver(uint256(keccak256(bytes(label))));
        uint64 expires = uint64(flags);
        if (expires >= block.timestamp) {
            return address(0);
        }
        return resolver;
    }
}
