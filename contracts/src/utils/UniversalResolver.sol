// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IRegistry} from "../registry/IRegistry.sol";

contract UniversalResolver {
    IRegistry public immutable root;

    constructor(IRegistry _root) {
        root = _root;
    }

    /**
     * @dev Finds the registry responsible for a name.
     *      If there is no registry for the full name, the registry for the longest
     *      extant suffix is returned instead.
     * @param name The name to look up.
     * @return reg A registry responsible for the name.
     * @return exact A boolean that is true if the registry is an exact match for `name`.
     */
    function getRegistry(bytes calldata name) public view returns (IRegistry reg, bool exact) {
        uint8 len = uint8(name[0]);
        if (len == 0) {
            return (root, true);
        }
        (reg, exact) = getRegistry(name[len + 1:]);
        if (!exact) {
            return (reg, false);
        }
        string memory label = string(name[1:len + 1]);
        IRegistry sub = reg.getSubregistry(label);
        if (sub == IRegistry(address(0))) {
            return (reg, false);
        }
        return (sub, true);
    }

    /**
     * @dev Finds the resolver responsible for a name, or `address(0)` if none.
     * @param name The name to find a resolver for.
     * @return The resolver responsible for this name, or `address(0)` if none.
     */
    function getResolver(bytes calldata name) public view returns (address) {
        (IRegistry reg,) = getRegistry(name);
        uint8 len = uint8(name[0]);
        string memory label = string(name[1:len + 1]);
        return reg.getResolver(label);
    }
}
