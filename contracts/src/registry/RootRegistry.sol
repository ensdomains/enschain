// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "./IRegistry.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {BaseRegistry} from "./BaseRegistry.sol";

contract RootRegistry is BaseRegistry, AccessControl {
    bytes32 public constant SUBDOMAIN_ISSUER_ROLE = keccak256("SUBDOMAIN_ISSUER_ROLE");
    uint96 public constant SUBREGISTRY_FLAGS_MASK = 0x1;
    uint96 public constant SUBREGISTRY_FLAG_LOCKED = 0x1;

    constructor(IRegistryDatastore _datastore) BaseRegistry(_datastore) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function uri(uint256 /*id*/) public override pure returns (string memory) {
        return "";
    }

    function mint(string calldata label, address owner, IRegistry registry, bool locked)
        external
        onlyRole(SUBDOMAIN_ISSUER_ROLE)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        _mint(owner, tokenId, 1, "");
        datastore.setSubregistry(tokenId, address(registry), locked ? SUBREGISTRY_FLAG_LOCKED : 0);
    }

    function burn(string calldata label) 
        external
        onlyRole(SUBDOMAIN_ISSUER_ROLE)
        withSubregistryFlags(label, SUBREGISTRY_FLAGS_MASK, 0)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        address owner = ownerOf(tokenId);
        _burn(owner, tokenId, 1);
        datastore.setSubregistry(tokenId, address(0), 0);
    }

    function lock(string calldata label)
        external
        onlyRole(SUBDOMAIN_ISSUER_ROLE)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, subregistry, flags & SUBREGISTRY_FLAG_LOCKED);
    }

    function setSubregistry(string calldata label, IRegistry registry)
        external
        onlyTokenOwner(label)
        withSubregistryFlags(label, SUBREGISTRY_FLAGS_MASK, 0)
    {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, address(registry), flags);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(BaseRegistry, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
