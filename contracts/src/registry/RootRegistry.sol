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
        _mint(tokenId, owner, registry, locked ? SUBREGISTRY_FLAG_LOCKED : 0);
        emit NewSubname(label);
    }

    function burn(uint256 tokenId) 
        external
        onlyRole(SUBDOMAIN_ISSUER_ROLE)
        withSubregistryFlags(tokenId, SUBREGISTRY_FLAGS_MASK, 0)
    {
        address owner = ownerOf(tokenId);
        _burn(owner, tokenId, 1);
        datastore.setSubregistry(tokenId, address(0), 0);
    }

    function lock(uint256 tokenId)
        external
        onlyRole(SUBDOMAIN_ISSUER_ROLE)
    {
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, subregistry, flags & SUBREGISTRY_FLAG_LOCKED);
    }

    function setSubregistry(uint256 tokenId, IRegistry registry)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, SUBREGISTRY_FLAGS_MASK, 0)
    {
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
