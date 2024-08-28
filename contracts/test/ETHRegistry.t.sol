// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import "src/registry/ETHRegistry.sol";
import "src/registry/RegistryDatastore.sol";

contract TestETHRegistry is Test, ERC1155Holder {
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);

    RegistryDatastore datastore;
    ETHRegistry registry;

    function setUp() public {
        datastore = new RegistryDatastore();
        registry = new ETHRegistry(datastore);
        registry.grantRole(registry.REGISTRAR_ROLE(), address(this));
    }

    function test_register_unlocked() public {
        uint256 expectedId =
            uint256(keccak256("test2") & 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8);
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(address(this), address(0), address(this), expectedId, 1);

        uint256 tokenId = registry.register("test2", address(this), registry, 0, uint64(block.timestamp) + 86400);
        vm.assertEq(tokenId, expectedId);
    }

    function test_register_locked() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();
        uint256 expectedId =
            uint256(keccak256("test2") & 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8) | flags;
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(address(this), address(0), address(this), expectedId, 1);

        uint256 tokenId = registry.register("test2", address(this), registry, flags, uint64(block.timestamp) + 86400);
        vm.assertEq(tokenId, expectedId);
    }

    function test_lock_name() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();
        uint256 oldTokenId = registry.register("test2", address(this), registry, 0, uint64(block.timestamp) + 86400);

        vm.expectEmit(true, true, true, true);
        emit TransferSingle(address(this), address(this), address(0), oldTokenId, 1);
        uint256 expectedTokenId = oldTokenId | flags;
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(address(this), address(0), address(this), expectedTokenId, 1);

        uint256 newTokenId = registry.lock(oldTokenId, flags);
        vm.assertEq(newTokenId, expectedTokenId);
    }

    function test_cannot_unlock_name() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();

        uint256 oldTokenId = registry.register("test2", address(this), registry, flags, uint64(block.timestamp) + 86400);
        uint256 newTokenId = registry.lock(oldTokenId, 0);
        vm.assertEq(oldTokenId, newTokenId);
    }

    function testFail_cannot_mint_duplicates() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();

        registry.register("test2", address(this), registry, flags, uint64(block.timestamp) + 86400);
        registry.register("test2", address(this), registry, 0, uint64(block.timestamp) + 86400);
    }
}
