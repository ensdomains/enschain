// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {BytesUtils} from "./BytesUtils.sol";
import {IEnsReadRegistry} from "./IEnsReadRegistry.sol";

error Unauthorized();

contract EnsRootRegistry {
    using BytesUtils for bytes;
    using BytesUtils for uint256[];

    address public immutable owner;

    mapping(uint256 => address) tldRegistries;

    constructor(address _owner) {
        owner = _owner;
    }

    modifier authorized(uint256 labelhash) {
        address tldRegistry = tldRegistries[labelhash];
        if (tldRegistry == msg.sender) {
            _;
            return;
        }

        // the owner could have locking functionality internally
        if (owner == msg.sender) {
            _;
            return;
        }

        revert Unauthorized();
    }

    function getTldRegistry(
        uint256 labelhash
    ) public view returns (IEnsReadRegistry) {
        return IEnsReadRegistry(tldRegistries[labelhash]);
    }

    function setTldRegistry(
        uint256 labelhash,
        address tldRegistry
    ) public authorized(labelhash) {
        tldRegistries[labelhash] = tldRegistry;
    }

    function getRegistry(
        bytes calldata name
    ) external view returns (IEnsReadRegistry) {
        (IEnsReadRegistry registry, ) = getRegistry(name, 0);
        return registry;
    }

    function getRegistry(
        bytes calldata name,
        uint256 labelOffset
    ) internal view returns (IEnsReadRegistry, uint256 labelhash) {
        uint256[] memory labelArray = name.readLabelsToArray();
        uint256 tldLabelhash = labelArray[labelArray.length - 1];

        uint256 fullNamehash = labelArray.namehashUntilLabelOffset(0);

        IEnsReadRegistry tldRegistry = getTldRegistry(tldLabelhash);

        if (address(tldRegistry) == address(0) || labelArray.length == 1) {
            return (tldRegistry, fullNamehash);
        }

        IEnsReadRegistry previousRegistry = tldRegistry;

        for (uint256 i = labelArray.length - 2; i > labelOffset; i--) {
            uint256 namehash = labelArray.namehashUntilLabelOffset(i);
            IEnsReadRegistry newRegistry = previousRegistry.getRegistry(
                namehash
            );
            if (address(newRegistry) == address(0)) {
                return (previousRegistry, fullNamehash);
            }
        }

        return (previousRegistry, fullNamehash);
    }

    function resolver(bytes calldata name) public view returns (address) {
        (IEnsReadRegistry registry, uint256 namehash) = getRegistry(name, 0);
        return registry.resolver(namehash);
    }

    function ownerOf(bytes calldata name) public view returns (address) {
        (IEnsReadRegistry registry, uint256 namehash) = getRegistry(name, 1);
        return registry.ownerOf(namehash);
    }

    function recordExists(uint256 labelhash) public view returns (bool) {
        return tldRegistries[labelhash] != address(0);
    }
}
