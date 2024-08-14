// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import "src/registry/RegistryDatastore.sol";

contract TestETHRegistry is Test {
    uint256 LABEL_HASH_MASK = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000;
    uint256 labelHash = uint256(keccak256("test"));
    RegistryDatastore datastore;

    function setUp() public {
        datastore = new RegistryDatastore();
    }

    function test_GetSetSubregistry_MsgSender() public {
        // set subregistry with empty flags
        datastore.setSubregistry(labelHash, address(this), 0);

        address subregistry;
        uint96 flags;

        (subregistry, flags) = datastore.getSubregistry(labelHash);
        vm.assertEq(subregistry, address(this));
        vm.assertEq(flags, 0);

        (subregistry, flags) = datastore.getSubregistry(address(this), labelHash);
        vm.assertEq(subregistry, address(this));
        vm.assertEq(flags, 0);
    }

    function test_GetSetSubregistry_OtherRegistry() public {
        DummyRegistry r = new DummyRegistry(datastore);
        r.setSubregistry(labelHash, address(this), 0);

        address subregistry;
        uint96 flags;

        (subregistry, flags) = datastore.getSubregistry(labelHash);
        vm.assertEq(subregistry, address(0));
        vm.assertEq(flags, 0);

        (subregistry, flags) = datastore.getSubregistry(address(r), labelHash);
        vm.assertEq(subregistry, address(this));
        vm.assertEq(flags, 0);
    }

    function test_GetSetSubregistry_32BitCustomFlags() public {
        datastore.setSubregistry(labelHash, address(this), 0x80000001);

        address subregistry;
        uint96 flags;

        (subregistry, flags) = datastore.getSubregistry(labelHash);
        vm.assertEq(subregistry, address(this));
        vm.assertEq(flags, 0x80000001);

        // get with flags on labelhash
        (subregistry, flags) = datastore.getSubregistry((labelHash & LABEL_HASH_MASK) | 0x80000001);
        vm.assertEq(subregistry, address(this));
        vm.assertEq(flags, 0x80000001);
    }

    function test_GetSetSubregistry_96BitCustomFlags() public {
        datastore.setSubregistry(labelHash, address(this), 0x800000000000000000000001);

        (address subregistry, uint96 flags) = datastore.getSubregistry(labelHash);
        vm.assertEq(subregistry, address(this));
        vm.assertEq(flags, 0x800000000000000000000001);
    }

    function test_GetSetResolver_MsgSender() public {
        datastore.setResolver(labelHash, address(this), 0);

        address resolver;
        uint96 flags;

        (resolver, flags) = datastore.getResolver(labelHash);
        vm.assertEq(resolver, address(this));
        vm.assertEq(flags, 0);

        (resolver, flags) = datastore.getResolver(address(this), labelHash);
        vm.assertEq(resolver, address(this));
        vm.assertEq(flags, 0);
    }

    function test_GetSetResolver_OtherRegistry() public {
        DummyRegistry r = new DummyRegistry(datastore);
        r.setResolver(labelHash, address(this), 0);

        address resolver;
        uint96 flags;

        (resolver, flags) = datastore.getResolver(labelHash);
        vm.assertEq(resolver, address(0));
        vm.assertEq(flags, 0);

        (resolver, flags) = datastore.getResolver(address(r), labelHash);
        vm.assertEq(resolver, address(this));
        vm.assertEq(flags, 0);
    }

    function test_GetSetResolver_32BitCustomFlags() public {
        datastore.setResolver(labelHash, address(this), 0x80000001);

        address resolver;
        uint96 flags;

        (resolver, flags) = datastore.getResolver(labelHash);
        vm.assertEq(resolver, address(this));
        vm.assertEq(flags, 0x80000001);

        // get with flags on labelhash
        (resolver, flags) = datastore.getResolver((labelHash & LABEL_HASH_MASK) | 0x80000001);
        vm.assertEq(resolver, address(this));
        vm.assertEq(flags, 0x80000001);
    }

    function test_GetSetResolver_96BitCustomFlags() public {
        datastore.setResolver(labelHash, address(this), 0x800000000000000000000001);

        (address resolver, uint96 flags) = datastore.getResolver(labelHash);
        vm.assertEq(resolver, address(this));
        vm.assertEq(flags, 0x800000000000000000000001);
    }
}

contract DummyRegistry {
    RegistryDatastore datastore;

    constructor(RegistryDatastore _datastore) {
        datastore = _datastore;
    }

    function setSubregistry(uint256 labelHash, address subregistry, uint96 flags) public {
        datastore.setSubregistry(labelHash, subregistry, flags);
    }

    function setResolver(uint256 labelHash, address resolver, uint96 flags) public {
        datastore.setResolver(labelHash, resolver, flags);
    }
}
