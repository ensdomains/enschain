// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

interface IRegistryDatastore {
    event SubregistryUpdate(address indexed registry, uint256 indexed tokenId, address subregistry, uint96 flags);
    event ResolverUpdate(address indexed registry, uint256 indexed tokenId, address resolver, uint96 flags);

    function getSubregistry(address registry, uint256 tokenId) external view returns(address subregistry, uint96 flags);
    function getSubregistry(uint256 tokenId) external view returns(address subregistry, uint96 flags);
    function getResolver(address registry, uint256 tokenId) external view returns(address resolver, uint96 flags);
    function getResolver(uint256 tokenId) external view returns(address resolver, uint96 flags);
    function setSubregistry(uint256 tokenId, address subregistry, uint96 flags) external;
    function setResolver(uint256 tokenId, address resolver, uint96 flags) external;
}
