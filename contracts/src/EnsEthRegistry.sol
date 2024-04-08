// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IEnsReadRegistry} from "./IEnsReadRegistry.sol";

struct Node {
    address owner;
    address resolver;
    address registry;
    uint256 expiry;
}

error Unauthorized();

contract EnsEthRegistry is IEnsReadRegistry {
    address public immutable ejectionAuthority;

    mapping(uint256 => Node) nodes;

    modifier authorized(bytes32 labelhash) {
        address nodeOwner = ownerOf(uint256(labelhash));
        if (nodeOwner == msg.sender) {
            _;
        }

        revert Unauthorized();
    }

    modifier onlyEjectionAuthority() {
        require(msg.sender == ejectionAuthority, "Not ejection authority");
        _;
    }

    constructor(address _ejectionAuthority) {
        ejectionAuthority = _ejectionAuthority;
    }

    function getNode(uint256 tokenId) public view returns (Node memory) {
        Node memory node = nodes[tokenId];
        if (node.expiry < block.timestamp) {
            return nodes[0];
        }
        return node;
    }

    function oneifyName(
        uint256 tokenId,
        uint256 expiry,
        address owner,
        address _resolver,
        address registry
    ) public onlyEjectionAuthority {
        nodes[tokenId] = Node(owner, _resolver, registry, expiry);
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        Node memory node = getNode(tokenId);
        return node.owner;
    }

    function resolver(uint256 tokenId) external view returns (address) {
        Node memory node = getNode(tokenId);
        return node.resolver;
    }

    function recordExists(uint256 tokenId) external view returns (bool) {
        Node memory node = getNode(tokenId);
        if (node.owner != address(0)) return true;
        if (node.registry != address(0)) return true;
        return false;
    }

    function getRegistry(
        uint256 tokenId
    ) external view returns (IEnsReadRegistry) {
        Node memory node = getNode(tokenId);
        return IEnsReadRegistry(node.registry);
    }
}
