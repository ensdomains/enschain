// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "./IRegistry.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {LockableRegistry} from "./LockableRegistry.sol";
import {BaseRegistry} from "./BaseRegistry.sol";

contract RootRegistry is LockableRegistry, AccessControl {
    bytes32 public constant TLD_ISSUER_ROLE = keccak256("TLD_ISSUER_ROLE");

    mapping(uint256 tokenId=>string) uris;

    constructor(IRegistryDatastore _datastore) LockableRegistry(_datastore) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function uri(uint256 tokenId ) public view override returns (string memory) {
        return uris[tokenId];
    }

    /**
     * @dev Mints a new TLD.
     * @param label The plaintext label for the TLD.
     * @param owner The new owner of the TLD token.
     * @param registry The address of the registry to use.
     * @param flags Flags to set.
     * @param _uri URI for TLD metadata.
     */
    function mint(string calldata label, address owner, IRegistry registry, uint96 flags, string memory _uri)
        external
        onlyRole(TLD_ISSUER_ROLE)
        returns(uint256 tokenId)
    {
        tokenId = uint256(keccak256(bytes(label)));
        _mint(owner, tokenId, 1, "");
        datastore.setSubregistry(tokenId, address(registry), flags);
        uris[tokenId] = _uri;
        emit URI(_uri, tokenId);
        emit NewSubname(label);
    }

    /**
     * @dev Burns a TLD.
     *      TLDs cannot be burned if any of their flags are set.
     * @param tokenId The tokenID of the TLD to burn.
     */
    function burn(uint256 tokenId)
        external
        onlyTokenOwner(tokenId)
        withSubregistryFlags(tokenId, FLAGS_MASK, 0)
    {
        address owner = ownerOf(tokenId);
        _burn(owner, tokenId, 1);
        datastore.setSubregistry(tokenId, address(0), 0);
    }

    function lock(uint256 tokenId, uint96 flags)
        external
        onlyTokenOwner(tokenId)
        returns(uint96)
    {
        return _lock(tokenId, flags);
    }

    function setUri(uint256 tokenId, string memory _uri) 
        external
        onlyTokenOwner(tokenId)
    {
        emit URI(_uri, tokenId);
        uris[tokenId] = _uri;
    }

    function supportsInterface(bytes4 interfaceId) public view override(BaseRegistry, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
