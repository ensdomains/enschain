// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "./IRegistry.sol";
import {LockableRegistry} from "./LockableRegistry.sol";
import {NameUtils} from "../utils/NameUtils.sol";

struct SubdomainData {
    IRegistry registry;
    bool locked;
}

contract UserRegistry is LockableRegistry {
    mapping(uint256 => SubdomainData) internal subdomains;
    address internal _resolver;
    IRegistry public parent;
    string public label;

    constructor(
        IRegistry _parent,
        string memory _label,
        address newResolver
    ) LockableRegistry() ERC721("ENS User Registry", "something.eth") {
        parent = _parent;
        label = _label;
        if (newResolver != address(0)) {
            _resolver = newResolver;
            emit ResolverChanged(newResolver);
        }
    }

    modifier onlyNameOwner() {
        address owner = parent.ownerOf(uint256(keccak256(bytes(label))));
        if (owner != msg.sender) {
            revert AccessDenied(owner, msg.sender);
        }
        _;
    }

    function setResolver(address newResolver) public onlyNameOwner {
        _resolver = newResolver;
        emit ResolverChanged(_resolver);
    }

    function mint(
        string calldata _label,
        address owner,
        IRegistry registry,
        bool locked
    ) external onlyNameOwner {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        _safeMint(owner, tokenId);
        subdomains[tokenId] = SubdomainData(registry, locked);
        emit RegistryChanged(_label, registry);
        if (locked) {
            emit SubdomainLocked(_label);
        }
    }

    function burn(
        string calldata _label
    ) external onlyNameOwner onlyUnlocked(_label) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        _burn(tokenId);
        subdomains[tokenId] = SubdomainData(IRegistry(address(0)), false);
        emit RegistryChanged(_label, IRegistry(address(0)));
    }

    function _locked(
        string memory _label
    ) internal view override returns (bool) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        return subdomains[tokenId].locked;
    }

    function _lock(string memory _label) internal override {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        subdomains[tokenId].locked = true;
    }

    function setSubregistry(
        string calldata _label,
        IRegistry registry
    ) external override onlyTokenOwner(_label) onlyUnlocked(_label) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        subdomains[tokenId].registry = registry;
        emit RegistryChanged(_label, registry);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(IERC165, ERC721) returns (bool) {
        return
            interfaceId == type(IRegistry).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function getSubregistry(
        bytes calldata name
    ) external view returns (IRegistry) {
        string memory _label = string(name[1:1 + uint8(name[0])]);
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        SubdomainData memory sub = subdomains[tokenId];
        return sub.registry;
    }

    function getResolver(
        bytes calldata /*name*/
    ) external view returns (address) {
        return _resolver;
    }
}
