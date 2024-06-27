// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IRegistry} from "./IRegistry.sol";
import {IRegistryDatastore} from "./IRegistryDatastore.sol";
import {BaseRegistry} from "./BaseRegistry.sol";

abstract contract LockableRegistry is BaseRegistry {
    error NameLocked(string label);
    error AccessDenied(address owner, address caller);

    event SubdomainLocked(string label);

    constructor(IRegistryDatastore _datastore) BaseRegistry(_datastore) {
    }

    modifier onlyTokenOwner(string calldata label) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        address owner = ownerOf(tokenId);
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
