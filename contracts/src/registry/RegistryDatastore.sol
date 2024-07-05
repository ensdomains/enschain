// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import { IRegistryDatastore } from './IRegistryDatastore.sol';

contract RegistryDatastore is IRegistryDatastore {
    mapping(address registry => mapping(uint256 tokenId => uint256)) internal subregistries;
    mapping(address registry => mapping(uint256 tokenId => uint256)) internal resolvers;

    function getSubregistry(address registry, uint256 tokenId) public view returns(address subregistry, uint96 flags) {
        uint256 data = subregistries[registry][tokenId];
        subregistry = address(uint160(data));
        flags = uint96(data >> 160);
    }

    function getSubregistry(uint256 tokenId) external view returns(address subregistry, uint96 flags) {
        return getSubregistry(msg.sender, tokenId);
    }

    function getResolver(address registry, uint256 tokenId) public view returns(address resolver, uint96 flags) {
        uint256 data = subregistries[registry][tokenId];
        resolver = address(uint160(data));
        flags = uint96(data >> 160);
    }

    function getResolver(uint256 tokenId) external view returns(address resolver, uint96 flags) {
        return getResolver(msg.sender, tokenId);
    }

    function setSubregistry(uint256 tokenId, address subregistry, uint96 flags) external {
        subregistries[msg.sender][tokenId] = (uint256(flags) << 160) | uint256(uint160(subregistry));
        emit SubregistryUpdate(msg.sender, tokenId, subregistry, flags);
    }

    function setResolver(uint256 tokenId, address resolver, uint96 flags) external {
        resolvers[msg.sender][tokenId] = (uint256(flags) << 160) | uint256(uint160(resolver));
        emit ResolverUpdate(msg.sender, tokenId, resolver, flags);
    }
}
