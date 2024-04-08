// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

interface IENSRegistry {
    function owner(bytes32 node) external view returns (address);

    function resolver(bytes32 node) external view returns (address);

    function recordExists(bytes32 node) external view returns (bool);

    function isApprovedForAll(
        address owner,
        address operator
    ) external view returns (bool);

    function getRegistry(bytes memory name) external view returns (address);
}
