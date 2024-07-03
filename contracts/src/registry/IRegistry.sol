// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IERC1155Singleton} from "./IERC1155Singleton.sol";

interface IRegistry is IERC1155Singleton {
    /**
     * @dev Fetches the registry for a subdomain of the current registry.
     * @param label The label to resolve.
     * @return The address of the registry for this subdomain, or `address(0)` if none exists.
     */
    function getSubregistry(string calldata label) external view returns (IRegistry);

    /**
     * @dev Fetches the resolver responsible for the specified label.
     * @param label The label to fetch a resolver for.
     * @return resolver The address of a resolver responsible for this name, or `address(0)` if none exists.
     */
    function getResolver(string calldata label) external view returns (address);
}
