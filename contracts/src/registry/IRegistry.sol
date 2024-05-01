// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IRegistry is IERC721 {
    event RegistryChanged(string label, IRegistry registry);
    event ResolverChanged(address resolver);

    /**
     * @dev Fetches the registry for a subdomain of the current registry.
     * @param label The label for the subdomain to fetch.
     * @return The address of the registry for this subdomain, or `address(0)` if none exists.
     */
    function getSubregistry(string calldata label) external view returns (IRegistry);

    /**
     * @dev Fetches the resolver responsible for the name this registry administers.
     * @return The address of a resolver responsible for this name, or `address(0)` if none exists.
     */
    function getResolver() external view returns (address);
}
