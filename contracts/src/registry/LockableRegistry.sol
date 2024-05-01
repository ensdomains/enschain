// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

import {IRegistry} from "./IRegistry.sol";

abstract contract LockableRegistry is IRegistry, ERC721 {
    error NameLocked(string label);
    error AccessDenied(address owner, address caller);

    event SubdomainLocked(string label);

    bytes public canonicalName;

    constructor(bytes memory _canonicalName) {
        canonicalName = _canonicalName;
    }

    modifier onlyTokenOwner(string calldata label) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        address owner = _ownerOf(tokenId);
        if (owner != msg.sender) {
            revert AccessDenied(owner, msg.sender);
        }
        _;
    }

    modifier onlyUnlocked(string calldata label) {
        if (_locked(label)) {
            revert NameLocked(label);
        }
        _;
    }

    function lock(string calldata label) external onlyTokenOwner(label) {
        _lock(label);
        emit SubdomainLocked(label);
    }

    function _locked(string memory label) internal view virtual returns (bool);
    function _lock(string memory label) internal virtual;
    function setSubregistry(string calldata label, IRegistry registry) external virtual;
}
