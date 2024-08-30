// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import "src/registry/RootRegistry.sol";
import "src/registry/RegistryDatastore.sol";

contract TestRootRegistry is Test, ERC1155Holder {
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);

    RegistryDatastore datastore;
    RootRegistry registry;

    function setUp() public {
        datastore = new RegistryDatastore();
        registry = new RootRegistry(datastore);
        registry.grantRole(registry.TLD_ISSUER_ROLE(), address(this));
    }

    function test_register_unlocked() public {
        uint256 expectedId = uint256(keccak256("test2"));
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(address(this), address(0), address(this), expectedId, 1);

        uint256 tokenId = registry.mint("test2", address(this), registry, 0, "");
        vm.assertEq(tokenId, expectedId);
        uint96 flags = registry.flags(tokenId);
        vm.assertEq(flags, 0);
    }

    function test_register_locked() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();
        uint256 expectedId = uint256(keccak256("test2"));
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(address(this), address(0), address(this), expectedId, 1);

        uint256 tokenId = registry.mint("test2", address(this), registry, flags, "");
        vm.assertEq(tokenId, expectedId);
        uint96 actualFlags = registry.flags(tokenId);
        vm.assertEq(flags, actualFlags);
    }

    function test_lock_name() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();
        uint256 tokenId = registry.mint("test2", address(this), registry, 0, "");
        uint96 actualFlags = registry.lock(tokenId, flags);
        vm.assertEq(flags, actualFlags);
        uint96 actualFlags2 = registry.flags(tokenId);
        vm.assertEq(flags, actualFlags2);
    }

    function test_cannot_unlock_name() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED() | registry.FLAG_RESOLVER_LOCKED();

        uint256 tokenId = registry.mint("test2", address(this), registry, flags, "");
        uint96 newFlags = registry.lock(tokenId, 0);
        vm.assertEq(flags, newFlags);
        uint96 newFlags2 = registry.flags(tokenId);
        vm.assertEq(flags, newFlags2);
    }

    function test_set_subregistry() public {
        uint256 tokenId = registry.mint("test", address(this), registry, 0, "");
        registry.setSubregistry(tokenId, IRegistry(address(this)));
        vm.assertEq(address(registry.getSubregistry("test")), address(this));
    }

    function testFail_cannot_set_locked_subregistry() public {
        uint96 flags = registry.FLAG_SUBREGISTRY_LOCKED();
        uint256 tokenId = registry.mint("test", address(this), registry, flags, "");
        registry.setSubregistry(tokenId, IRegistry(address(this)));
    }

    function test_set_resolver() public {
        uint256 tokenId = registry.mint("test", address(this), registry, 0, "");
        registry.setResolver(tokenId, address(this));
        vm.assertEq(address(registry.getResolver("test")), address(this));
    }

    function testFail_cannot_set_locked_resolver() public {
        uint96 flags = registry.FLAG_RESOLVER_LOCKED();
        uint256 tokenId = registry.mint("test", address(this), registry, flags, "");
        registry.setResolver(tokenId, address(this));
    }

    function testFail_cannot_set_locked_flags() public {
        uint96 flags = registry.FLAG_FLAGS_LOCKED();
        uint256 tokenId = registry.mint("test", address(this), registry, flags, "");
        registry.lock(tokenId, registry.FLAG_RESOLVER_LOCKED());
    }

    function test_set_uri() public {
        string memory uri = "https://example.com/";
        uint256 tokenId = registry.mint("test2", address(this), registry, 0, uri);
        string memory actualUri = registry.uri(tokenId);
        vm.assertEq(actualUri, uri);
        
        uri = "https://ens.domains/";
        registry.setUri(tokenId, uri);
        actualUri = registry.uri(tokenId);
        vm.assertEq(actualUri, uri);
    }
}
