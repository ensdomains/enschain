// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "./IRegistry.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {BaseRegistry} from "./BaseRegistry.sol";
import {NameUtils} from "../utils/NameUtils.sol";

contract UserRegistry is BaseRegistry {
    uint96 public constant SUBREGISTRY_FLAGS_MASK = 0x1;
    uint96 public constant SUBREGISTRY_FLAG_LOCKED = 0x1;

    IRegistry public parent;
    string public label;

    constructor(IRegistry _parent, string memory _label, IRegistryDatastore _datastore) BaseRegistry(_datastore) {
        parent = _parent;
        label = _label;
    }

    modifier onlyNameOwner() {
        address owner = parent.ownerOf(uint256(keccak256(bytes(label))));
        if (owner != msg.sender) {
            revert AccessDenied(0, owner, msg.sender);
        }
        _;
    }

    function uri(uint256 /*id*/ ) public pure override returns (string memory) {
        return "";
    }

    function mint(string calldata _label, address owner, IRegistry registry, uint96 flags) external onlyNameOwner {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        _mint(tokenId, owner, registry, flags);
        emit NewSubname(label);
    }

    function burn(uint256 tokenId) external onlyNameOwner withSubregistryFlags(tokenId, SUBREGISTRY_FLAG_LOCKED, 0) {
        address owner = ownerOf(tokenId);
        _burn(owner, tokenId, 1);
        datastore.setSubregistry(tokenId, address(0), 0);
    }

    function locked(uint256 tokenId) external view returns (bool) {
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        return flags & SUBREGISTRY_FLAG_LOCKED != 0;
    }

    function lock(uint256 tokenId) external onlyTokenOwner(tokenId) {
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, subregistry, flags & SUBREGISTRY_FLAG_LOCKED);
    }

    function setSubregistry(uint256 tokenId, IRegistry registry)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, SUBREGISTRY_FLAG_LOCKED, 0)
    {
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, address(registry), flags);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IRegistry).interfaceId || super.supportsInterface(interfaceId);
    }
}
