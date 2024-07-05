// SPDX-License-Identifier: MIT
// Portions from OpenZeppelin Contracts (last updated v5.0.0) (token/ERC1155/ERC1155.sol)
pragma solidity >=0.8.13;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155MetadataURI} from "@openzeppelin/contracts/token/ERC1155/extensions/IERC1155MetadataURI.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1155Utils} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Utils.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {ERC1155Singleton} from "./ERC1155Singleton.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {IRegistry} from "./IRegistry.sol";

abstract contract BaseRegistry is IRegistry, ERC1155Singleton {
    error AccessDenied(string label, address owner, address caller);
    error InvalidSubregistryFlags(string label, uint96 flags, uint96 expected);
    error InvalidResolverFlags(string label, uint96 flags, uint96 expected);

    IRegistryDatastore public datastore;

    constructor(IRegistryDatastore _datastore) {
        datastore = _datastore;
    }

    modifier onlyTokenOwner(string calldata label) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        address owner = ownerOf(tokenId);
        if (owner != msg.sender) {
            revert AccessDenied(label, owner, msg.sender);
        }
        _;
    }

    modifier withSubregistryFlags(string calldata label, uint96 mask, uint96 expected) {
        (, uint96 flags) = datastore.getSubregistry(uint256(keccak256(bytes(label))));
        if (flags & mask != expected) {
            revert InvalidSubregistryFlags(label, flags & mask, expected);
        }
        _;
    }

    modifier withResolverFlags(string calldata label, uint96 mask, uint96 expected) {
        (, uint96 flags) = datastore.getResolver(uint256(keccak256(bytes(label))));
        if (flags & mask != expected) {
            revert InvalidResolverFlags(label, flags & mask, expected);
        }
        _;
    }

    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC1155Singleton, IERC165) returns (bool) {
        return
            interfaceId == type(IERC1155).interfaceId ||
            interfaceId == type(IERC1155MetadataURI).interfaceId ||
            interfaceId == type(IRegistry).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function _mint(string calldata label, address owner, IRegistry registry, uint96 flags) internal {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        _mint(owner, tokenId, 1, "");
        datastore.setSubregistry(tokenId, address(registry), flags);
        emit NewSubname(label);
    }

    /***********************
     * IRegistry functions *
     ***********************/
    
    /**
     * @dev Fetches the registry for a subdomain of the current registry.
     * @param label The label to resolve.
     * @return The address of the registry for this subdomain, or `address(0)` if none exists.
     */
    function getSubregistry(string calldata label) external virtual view returns (IRegistry) {
        (address subregistry,) = datastore.getSubregistry(uint256(keccak256(bytes(label))));
        return IRegistry(subregistry);
    }

    /**
     * @dev Fetches the resolver responsible for the specified label.
     * @param label The label to fetch a resolver for.
     * @return resolver The address of a resolver responsible for this name, or `address(0)` if none exists.
     */
    function getResolver(string calldata label) external virtual view returns (address resolver) {
        (resolver,) = datastore.getResolver(uint256(keccak256(bytes(label))));
    }
}