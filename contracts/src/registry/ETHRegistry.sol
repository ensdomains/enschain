// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "./IRegistry.sol";
import {LockableRegistry} from "./LockableRegistry.sol";

contract ETHRegistry is LockableRegistry, AccessControl {
    struct SubdomainData {
        IRegistry registry;
        uint64 expires;
        bool locked;
    }

    mapping(uint256 => SubdomainData) internal subdomains;
    address internal _resolver;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    event ExpirationChanged(string label, uint64 expires);

    error NameAlreadyRegistered(string label);
    error NameExpired(string label);
    error CannotReduceExpiration(uint64 oldExpiration, uint64 newExpiration);

    constructor()
        LockableRegistry("\x03eth\x00")
        ERC721("ENS .eth Registry", ".eth")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function setResolver(
        address newResolver
    ) public onlyRole(DEFAULT_ADMIN_ROLE) {
        _resolver = newResolver;
        emit ResolverChanged(_resolver);
    }

    // TODO: OZ's implementation zeroes out allowance on mint, but our override here breaks that
    // behaviour.
    function _ownerOf(
        uint256 tokenId
    ) internal view virtual override returns (address) {
        if (subdomains[tokenId].expires < block.timestamp) {
            return address(0);
        }
        return super._ownerOf(tokenId);
    }

    function register(
        string calldata label,
        address owner,
        IRegistry registry,
        uint64 expires,
        bool registryLocked
    ) public onlyRole(REGISTRAR_ROLE) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        _safeMint(owner, tokenId);
        if (subdomains[tokenId].expires >= block.timestamp) {
            revert NameAlreadyRegistered(label);
        }
        subdomains[tokenId] = SubdomainData(registry, expires, registryLocked);
        emit RegistryChanged(label, registry);
        emit ExpirationChanged(label, expires);
    }

    function renew(
        string calldata label,
        uint64 expires
    ) public onlyRole(REGISTRAR_ROLE) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        uint64 oldExpiration = subdomains[tokenId].expires;
        if (oldExpiration < block.timestamp) {
            revert NameExpired(label);
        }
        if (expires < oldExpiration) {
            revert CannotReduceExpiration(oldExpiration, expires);
        }
        subdomains[tokenId].expires = expires;
        emit ExpirationChanged(label, expires);
    }

    function _locked(
        string memory label
    ) internal view override returns (bool) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        return subdomains[tokenId].locked;
    }

    function _lock(string memory label) internal override {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        subdomains[tokenId].locked = true;
    }

    function setSubregistry(
        string calldata label,
        IRegistry registry
    ) external override onlyTokenOwner(label) onlyUnlocked(label) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        subdomains[tokenId].registry = registry;
        emit RegistryChanged(label, registry);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(IERC165, ERC721, AccessControl) returns (bool) {
        return
            interfaceId == type(IRegistry).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function getSubregistry(
        bytes calldata name
    ) external view returns (IRegistry) {
        string memory label = string(name[1:1 + uint8(name[0])]);
        uint256 tokenId = uint256(keccak256(bytes(label)));
        SubdomainData memory sub = subdomains[tokenId];
        if (sub.expires < block.timestamp) {
            return IRegistry(address(0));
        }
        return sub.registry;
    }

    function getResolver(
        bytes calldata /*name*/
    ) external view returns (address) {
        return _resolver;
    }
}
