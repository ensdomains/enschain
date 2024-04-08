// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

interface IEnsReadRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);

    function resolver(uint256 tokenId) external view returns (address);

    function recordExists(uint256 tokenId) external view returns (bool);

    function getRegistry(
        uint256 tokenId
    ) external view returns (IEnsReadRegistry);
}
