// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "./IRegistry.sol";
import {LockableRegistry} from "./LockableRegistry.sol";

struct SubdomainData {
    IRegistry registry;
    bool locked;
}

contract RootRegistry is LockableRegistry, AccessControl {
    mapping(uint256 => SubdomainData) internal subdomains;

    bytes32 public constant SUBDOMAIN_ISSUER_ROLE = keccak256("SUBDOMAIN_ISSUER_ROLE");

    constructor() LockableRegistry() ERC721("ENS Root Registry", "ENSROOT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function mint(string calldata label, address owner, IRegistry registry, bool locked)
        external
        onlyRole(SUBDOMAIN_ISSUER_ROLE)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        _safeMint(owner, tokenId);
        subdomains[tokenId] = SubdomainData(registry, locked);
        emit RegistryChanged(label, registry);
        if (locked) {
            emit SubdomainLocked(label);
        }
    }

    function burn(string calldata label) external onlyRole(SUBDOMAIN_ISSUER_ROLE) onlyUnlocked(label) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        _burn(tokenId);
        subdomains[tokenId] = SubdomainData(IRegistry(address(0)), false);
        emit RegistryChanged(label, IRegistry(address(0)));
    }

    function _locked(string memory label) internal view override returns (bool) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        return subdomains[tokenId].locked;
    }

    function _lock(string memory label) internal override {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        subdomains[tokenId].locked = true;
    }

    function setSubregistry(string calldata label, IRegistry registry)
        external
        override
        onlyTokenOwner(label)
        onlyUnlocked(label)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        subdomains[tokenId].registry = registry;
        emit RegistryChanged(label, registry);
    }

    function getSubregistry(bytes calldata name) external view returns (IRegistry) {
        string memory label = string(name[1:1 + uint8(name[0])]);
        uint256 tokenId = uint256(keccak256(bytes(label)));
        SubdomainData memory sub = subdomains[tokenId];
        return sub.registry;
    }

    function getResolver(bytes calldata /*name*/ ) external pure returns (address) {
        return address(0);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(IERC165, ERC721, AccessControl)
        returns (bool)
    {
        return interfaceId == type(IRegistry).interfaceId || super.supportsInterface(interfaceId);
    }
}
