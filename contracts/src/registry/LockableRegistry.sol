// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ERC1155Singleton} from "./ERC1155Singleton.sol";
import {IERC1155Singleton} from "./IERC1155Singleton.sol";
import {IRegistry} from "./IRegistry.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {BaseRegistry} from "./BaseRegistry.sol";

abstract contract LockableRegistry is BaseRegistry {
    uint96 public constant FLAGS_MASK = 0x7;
    uint96 public constant FLAG_SUBREGISTRY_LOCKED = 0x1;
    uint96 public constant FLAG_RESOLVER_LOCKED = 0x2;
    uint96 public constant FLAG_FLAGS_LOCKED = 0x4;

    constructor(IRegistryDatastore _datastore) BaseRegistry(_datastore) {
    }

    function _lock(uint256 tokenId, uint96 _flags)
        internal
        withSubregistryFlags(tokenId, FLAG_FLAGS_LOCKED, 0)
        returns(uint96 newFlags)
    {
        (address subregistry, uint96 oldFlags) = datastore.getSubregistry(tokenId);
        newFlags = oldFlags | (_flags & FLAGS_MASK);
        if (newFlags != oldFlags) {
            datastore.setSubregistry(tokenId, subregistry, newFlags);
        }
    }

    function setSubregistry(uint256 tokenId, IRegistry registry)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, FLAG_SUBREGISTRY_LOCKED, 0)
    {
        (, uint96 _flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, address(registry), _flags);
    }

    function setResolver(uint256 tokenId, address resolver)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, FLAG_RESOLVER_LOCKED, 0)
    {
        (, uint96 _flags) = datastore.getResolver(tokenId);
        datastore.setResolver(tokenId, resolver, _flags);
    }

    function flags(uint256 tokenId) external view returns(uint96) {
        (, uint96 _flags) = datastore.getSubregistry(tokenId);
        return _flags;
    }
}
