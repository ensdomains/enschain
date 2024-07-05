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
    uint96 public constant SUBREGISTRY_FLAGS_MASK = 0x100000000;
    uint96 public constant SUBREGISTRY_FLAG_LOCKED = 0x100000000;

    error NameAlreadyRegistered(string label);
    error NameExpired(string label);
    error CannotReduceExpiration(uint64 oldExpiration, uint64 newExpiration);

    constructor(IRegistryDatastore _datastore)
        BaseRegistry(_datastore)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function uri(uint256 /*tokenId*/) public override pure returns(string memory) {
        return "";
    }

    function ownerOf(
        uint256 tokenId
    ) public view virtual override(ERC1155Singleton, IERC1155Singleton) returns (address) {
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        uint64 expires = uint64(flags);
        if (expires < block.timestamp) {
            return address(0);
        }
        return super.ownerOf(tokenId);
    }

    function register(
        string calldata label,
        address owner,
        IRegistry registry,
        uint96 flags
    ) public onlyRole(REGISTRAR_ROLE) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        
        (, uint96 oldFlags) = datastore.getSubregistry(tokenId);
        uint64 expires = uint64(oldFlags);
        if (expires >= block.timestamp) {
            revert NameAlreadyRegistered(label);
        }
        
        _mint(label, owner, registry, flags);
    }

    function renew(
        string calldata label,
        uint64 expires
    ) public onlyRole(REGISTRAR_ROLE) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        uint64 oldExpiration = uint64(flags);
        if (oldExpiration < block.timestamp) {
            revert NameExpired(label);
        }
        if (expires < oldExpiration) {
            revert CannotReduceExpiration(oldExpiration, expires);
        }
        datastore.setSubregistry(tokenId, subregistry, (flags & SUBREGISTRY_FLAGS_MASK) | uint96(expires));
    }

    function locked(
        string memory label
    ) external view returns (bool) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        return flags & SUBREGISTRY_FLAG_LOCKED != 0;
    }

    function lock(string calldata label) external onlyTokenOwner(label) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, subregistry, flags & SUBREGISTRY_FLAG_LOCKED);
    }

    function setSubregistry(
        string calldata label,
        IRegistry registry
    ) 
        external
        onlyTokenOwner(label)
        withSubregistryFlags(label, SUBREGISTRY_FLAG_LOCKED, 0)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, address(registry), flags);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(BaseRegistry, AccessControl) returns (bool) {
        return
            interfaceId == type(IRegistry).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function getSubregistry(string calldata label) external override virtual view returns (IRegistry) {
        (address subregistry, uint96 flags) = datastore.getSubregistry(uint256(keccak256(bytes(label))));
        uint64 expires = uint64(flags);
        if (expires >= block.timestamp) {
            return IRegistry(address(0));
        }
        return IRegistry(subregistry);
    }

    function getResolver(string calldata label) external override virtual view returns (address) {
        (address resolver, uint96 flags) = datastore.getResolver(uint256(keccak256(bytes(label))));
        uint64 expires = uint64(flags);
        if (expires >= block.timestamp) {
            return address(0);
        }
        return resolver;
    }
}
