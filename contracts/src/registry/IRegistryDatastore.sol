// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

/**
 * @dev Interface for the ENSv2 registry datastore, which stores subregistry and resolver addresses and flags
 *      for all names, keyed by registry address and `keccak256(label)`.
 *      The lower 32 bits of label hashes are masked out for storage and retreival, allowing these bits to be used
 *      by registry implementations for different versions of tokens that reference the same underlying name. This
 *      means that two labelHashes that differ only in the least-significant 32 bits will resolve to the same name.
 */
interface IRegistryDatastore {
    event SubregistryUpdate(address indexed registry, uint256 indexed labelHash, address subregistry, uint96 flags);
    event ResolverUpdate(address indexed registry, uint256 indexed labelHash, address resolver, uint96 flags);

    function getSubregistry(address registry, uint256 labelHash) external view returns(address subregistry, uint96 flags);
    function getSubregistry(uint256 labelHash) external view returns(address subregistry, uint96 flags);
    function getResolver(address registry, uint256 labelHash) external view returns(address resolver, uint96 flags);
    function getResolver(uint256 labelHash) external view returns(address resolver, uint96 flags);
    function setSubregistry(uint256 labelHash, address subregistry, uint96 flags) external;
    function setResolver(uint256 labelHash, address resolver, uint96 flags) external;
}
