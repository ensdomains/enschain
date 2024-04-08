// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {BytesUtils} from "./BytesUtils.sol";
import {IEnsReadRegistry} from "./IEnsReadRegistry.sol";

error Unauthorized();

contract EnsRootRegistry {
    using BytesUtils for bytes;

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
        bytes calldata name,
        uint256 labelOffset
    )
        internal
        view
        returns (IEnsReadRegistry, bool isExact, uint256 labelhash)
    {
        uint256[] memory labelArray = name.readLabelsToArray();
        uint256 tldLabelhash = labelArray[labelArray.length - 1];

        IEnsReadRegistry tldRegistry = getTldRegistry(tldLabelhash);

        if (address(tldRegistry) == address(0) || labelArray.length == 1) {
            isExact = labelArray.length == 1;
            return (tldRegistry, isExact, tldLabelhash);
        }

        IEnsReadRegistry previousRegistry = tldRegistry;

        for (uint256 i = labelArray.length - 2; i > labelOffset; i--) {
            IEnsReadRegistry newRegistry = previousRegistry.getRegistry(
                labelArray[i]
            );
            if (address(newRegistry) == address(0)) {
                return (previousRegistry, false, labelArray[i + 1]);
            }
        }

        return (previousRegistry, true, labelArray[labelOffset]);
    }

    function resolver(bytes calldata name) public view returns (address) {
        (IEnsReadRegistry registry, , uint256 labelhash) = getRegistry(name, 0);
        return registry.resolver(labelhash);
    }

    function ownerOf(bytes calldata name) public view returns (address) {
        (
            IEnsReadRegistry registry,
            bool isExact,
            uint256 labelhash
        ) = getRegistry(name, 0);
        if (!isExact) return address(0);
        return registry.ownerOf(labelhash);
    }

    function recordExists(uint256 labelhash) public view returns (bool) {
        return tldRegistries[labelhash] != address(0);
    }
}
