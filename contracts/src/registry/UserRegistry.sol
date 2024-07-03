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

    constructor(
        IRegistry _parent,
        string memory _label,
        IRegistryDatastore _datastore
    ) BaseRegistry(_datastore) {
        parent = _parent;
        label = _label;
    }

    modifier onlyNameOwner() {
        address owner = parent.ownerOf(uint256(keccak256(bytes(label))));
        if (owner != msg.sender) {
            revert AccessDenied("", owner, msg.sender);
        }
        _;
    }

    function uri(uint256 /*id*/) public override pure returns (string memory) {
        return "";
    }

    function mint(
        string calldata _label,
        address owner,
        IRegistry registry,
        uint96 flags
    ) external onlyNameOwner {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        _mint(owner, tokenId, 1, "");
        datastore.setSubregistry(tokenId, address(registry), flags);
    }

    function burn(
        string calldata _label
    ) external onlyNameOwner withSubregistryFlags(_label, SUBREGISTRY_FLAG_LOCKED, 0) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        address owner = ownerOf(tokenId);
        _burn(owner, tokenId, 1);
        datastore.setSubregistry(tokenId, address(0), 0);
    }

    function locked(
        string memory _label
    ) external view returns (bool) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        return flags & SUBREGISTRY_FLAG_LOCKED != 0;
    }

    function lock(string calldata _label) external onlyTokenOwner(_label) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        (address subregistry, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, subregistry, flags & SUBREGISTRY_FLAG_LOCKED);
    }

    function setSubregistry(
        string calldata _label,
        IRegistry registry
    ) external onlyTokenOwner(_label) withSubregistryFlags(_label, SUBREGISTRY_FLAG_LOCKED, 0) {
        uint256 tokenId = uint256(keccak256(bytes(_label)));
        (, uint96 flags) = datastore.getSubregistry(tokenId);
        datastore.setSubregistry(tokenId, address(registry), flags);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override returns (bool) {
        return
            interfaceId == type(IRegistry).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
