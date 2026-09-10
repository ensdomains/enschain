// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {
    CAN_DO_EVERYTHING,
    CANNOT_SET_RESOLVER,
    CANNOT_UNWRAP,
    PARENT_CANNOT_CONTROL
} from "@ens/contracts/wrapper/INameWrapper.sol";

import {console} from "forge-std/console.sol";

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {HexUtils} from "@ens/contracts/utils/HexUtils.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {Graveyard} from "~src/migration/Graveyard.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {MigrationControllerFixture} from "~test/fixtures/MigrationControllerFixture.sol";

contract GraveyardTest is MigrationControllerFixture {
    uint256 constant N = 10;

    /// @dev Batch size for the gas measurements. Large enough that the fixed
    ///      per-transaction overhead amortises to noise.
    uint256 constant GAS_BATCH = 50;

    /// @dev Band the measured per-name cost must sit inside. Wide enough to
    ///      survive compiler and dependency churn, tight enough that a change
    ///      materially altering the cost of draining the backlog fails here
    ///      first. The measured figure sits around fifty thousand.
    uint256 constant GAS_PER_NAME_MIN = 20_000;
    uint256 constant GAS_PER_NAME_MAX = 70_000;

    function setUp() external {
        deployMigrationControllerFixture();
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(address(graveyard), type(IContractNamer).interfaceId),
            "IContractNamer"
        );
    }

    function test_clear_root() external {
        graveyard.clear(_oneName(NameCoder.encode(""))); // noop
    }

    function test_clear_eth() external {
        graveyard.clear(_oneName(NameCoder.encode("eth"))); // noop
    }

    function test_clear_xyz() external {
        vm.expectRevert(abi.encodeWithSelector(Graveyard.NameNotClearable.selector));
        graveyard.clear(_oneName(NameCoder.encode("xyz")));
        vm.expectRevert();
        graveyard.clear(_oneName(NameCoder.encode("test.xyz")));
    }

    function test_clear_afterGrace() external {
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);

        vm.warp(baseRegistrar.nameExpires(tokenIdV1) + gracePeriodV1);
        vm.expectRevert();
        baseRegistrar.ownerOf(tokenIdV1);
        assertTrue(baseRegistrar.available(tokenIdV1), "grace:available");

        graveyard.clear(_oneName(name));
    }

    function test_clear_registered_unwrapped() external {
        (bytes memory name, ) = registerUnwrapped(testLabel);

        vm.expectRevert();
        graveyard.clear(_oneName(name));
    }

    function test_clear_registered_unlocked() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);

        vm.expectRevert();
        graveyard.clear(_oneName(name));
    }

    function test_clear_registered_locked() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);

        vm.expectRevert();
        graveyard.clear(_oneName(name));
    }

    function test_encodeLabelHash() external pure {
        assertEq(
            _encodedLabelHash(bytes32(0)),
            "[0000000000000000000000000000000000000000000000000000000000000000]"
        );
        assertEq(
            _encodedLabelHash(0x5cee339e13375638553bdf5a6e36ba80fb9f6a4f0783680884d92b558aa471da),
            "[5cee339e13375638553bdf5a6e36ba80fb9f6a4f0783680884d92b558aa471da]"
        );
    }

    function test_clear_prehashedLabel_invalid() external {
        bytes memory name = NameCoder.encode("eth");
        for (uint256 i; i < 32; ++i) {
            vm.expectRevert();
            graveyard.clear(_oneName(abi.encodePacked(uint8(0), new bytes(i), name)));
        }
    }

    function test_clear_prehashedLabel_literal(bytes32 labelHash) external {
        (bytes memory name, ) = registerUnwrapped(testLabel);
        bytes32 node = NameCoder.namehash(name, 0);

        string memory label = _encodedLabelHash(labelHash);
        bytes32 actualLabelHash = keccak256(bytes(label));

        vm.prank(testOwner);
        registryV1.setSubnodeRecord(node, actualLabelHash, friend, address(1), 0);

        _simulateMigration(name);

        node = NameCoder.namehash(node, actualLabelHash);

        assertEq(registryV1.resolver(node), address(1), "before");
        graveyard.clear(_oneName(abi.encodePacked(uint8(0), labelHash, name))); // mark as prehashed
        assertEq(registryV1.resolver(node), address(1), "uncleared");
        graveyard.clear(_oneName(NameCoder.addLabel(name, label)));
        assertEq(registryV1.resolver(node), address(0), "after");
    }

    function test_clear_prehashedLabel_hashed(bytes32 labelHash) external {
        (bytes memory name, ) = registerUnwrapped(testLabel);
        bytes32 node = NameCoder.namehash(name, 0);

        vm.prank(testOwner);
        registryV1.setSubnodeRecord(node, labelHash, friend, address(1), 0);

        _simulateMigration(name);

        node = NameCoder.namehash(node, labelHash);

        assertEq(registryV1.resolver(node), address(1), "before");
        graveyard.clear(_oneName(NameCoder.addLabel(name, _encodedLabelHash(labelHash))));
        assertEq(registryV1.resolver(node), address(1), "uncleared");
        graveyard.clear(_oneName(abi.encodePacked(uint8(0), labelHash, name))); // mark as prehashed
        assertEq(registryV1.resolver(node), address(0), "after");
    }

    function test_clear_unregistered() external {
        vm.expectRevert(abi.encodeWithSelector(Graveyard.NameNotClearable.selector));
        graveyard.clear(_oneName(_randomEthName()));
    }

    function test_clear_expired(uint256) external {
        registerUnwrapped(testLabel); // ensure expiry > 0
        _simulateExpiry(NameCoder.ethName(testLabel)); // ensure expired

        graveyard.clear(_oneName(_randomEthName()));
    }

    function test_clear_junk_deep(uint256) external {
        bytes memory name = _randomEthName();
        bytes32 node = NameCoder.namehash(name, 0);

        registerUnwrapped(testLabel); // ensure expiry > 0
        _simulateExpiry(NameCoder.ethName(testLabel)); // ensure expired

        _claimNodes(name, 0, address(testOwner));
        vm.prank(testOwner);
        registryV1.setResolver(node, address(1));
        assertEq(registryV1.resolver(node), address(1));

        graveyard.clear(_oneName(name));

        assertEq(registryV1.resolver(node), address(0));
    }

    function test_clear_deep() external {
        (bytes memory name0, ) = registerUnwrapped(testLabel);

        bytes memory name = name0;
        for (uint256 i; i < N; ++i) {
            vm.prank(testOwner);
            registryV1.setSubnodeRecord(
                NameCoder.namehash(name, 0),
                keccak256(bytes(testLabel)),
                testOwner,
                address(1),
                0
            );
            name = NameCoder.addLabel(name, testLabel);
        }

        _simulateMigration(name0);

        graveyard.clear(_oneName(name));

        name = name0;
        for (uint256 i; i < N; ++i) {
            name = NameCoder.addLabel(name, testLabel);
            assertEq(registryV1.resolver(NameCoder.namehash(name, 0)), address(0), vm.toString(i));
        }
    }

    function test_clear_wide() external {
        bytes[] memory names = new bytes[](N);

        for (uint256 i; i < names.length; ++i) {
            (bytes memory name, ) = registerUnwrapped(_label(i));
            vm.prank(testOwner);
            registryV1.setSubnodeRecord(
                NameCoder.namehash(name, 0),
                keccak256(bytes(testLabel)),
                friend,
                address(1),
                0
            );
            _simulateMigration(name);
            names[i] = NameCoder.addLabel(name, testLabel);
        }

        graveyard.clear(names);

        for (uint256 i; i < names.length; ++i) {
            assertEq(
                registryV1.resolver(NameCoder.namehash(names[i], 0)),
                address(0),
                vm.toString(i)
            );
        }
    }

    function test_clear_nestedLocked_migrateBoth() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name3 =
            createWrappedChild(name2, testLabel, PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name2, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        vm.stopPrank();

        _simulateMigration(name2);

        vm.expectRevert();
        graveyard.clear(_oneName(name3));

        _simulateMigration(name3);

        graveyard.clear(_oneName(name3));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
    }

    function test_clear_nestedLocked_migrateParent_expiredChild() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name3 =
            createWrappedChild(name2, testLabel, PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name2, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        vm.stopPrank();

        _simulateMigration(name2);

        vm.expectRevert();
        graveyard.clear(_oneName(name3));

        _simulateExpiry(name3);

        graveyard.clear(_oneName(name3));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
    }

    function test_clear_nestedLocked_bothExpired() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name3 =
            createWrappedChild(name2, testLabel, PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name2, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        vm.stopPrank();

        // expiry(name2) > expiry(name3)
        vm.prank(ethControllerV1);
        nameWrapper.renew(uint256(keccak256(bytes(testLabel))), 10 days);

        vm.expectRevert();
        graveyard.clear(_oneName(name3));

        _simulateExpiry(name3);

        vm.expectRevert();
        graveyard.clear(_oneName(name3));

        _simulateExpiry(name2);

        graveyard.clear(_oneName(name3));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
    }

    function test_clear_migrateParent_unwrappedChild() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name3 = NameCoder.addLabel(name2, testLabel);

        // claim 3LD ownership without wrapping
        _claimNodes(name3, 0, testOwner);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name2, 0), address(1));
        registryV1.setResolver(NameCoder.namehash(name3, 0), address(1));
        vm.stopPrank();

        _simulateMigration(name2);

        vm.expectRevert(abi.encodeWithSelector(Graveyard.NameRequiresPreimage.selector));
        graveyard.clear(_oneName(abi.encodePacked(uint8(0), keccak256(bytes(testLabel)), name2)));

        graveyard.clear(_oneName(name3));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
    }

    function test_clear_detachedAndUnmigrated() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name3 = createWrappedChild(name2, testLabel, PARENT_CANNOT_CONTROL);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name2, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        vm.stopPrank();

        _simulateMigration(name2);

        vm.expectRevert();
        graveyard.clear(_oneName(name3));

        graveyard.clear(_oneName(name2));

        _simulateMigration(name3);

        graveyard.clear(_oneName(name3));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
    }

    function test_clear_detachedAndExpired(bool unwrapped) external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name3 = createWrappedChild(name2, testLabel, PARENT_CANNOT_CONTROL);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name2, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        vm.stopPrank();

        if (unwrapped) {
            vm.prank(testOwner);
            nameWrapper.unwrap(
                NameCoder.namehash(name2, 0),
                keccak256(bytes(NameCoder.firstLabel(name3))),
                address(testOwner)
            );
        }

        _simulateExpiry(name2);

        graveyard.clear(_oneName(name3));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
    }

    function test_clear_locked_expired() external {
        bytes memory name0 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes memory name = name0;
        for (uint256 i; i < N; ++i) {
            name = createWrappedChild(name, testLabel, PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);
            vm.prank(testOwner);
            nameWrapper.setResolver(NameCoder.namehash(name, 0), address(1));
        }

        vm.expectRevert();
        graveyard.clear(_oneName(name));

        _simulateExpiry(name0);

        graveyard.clear(_oneName(name));

        name = name0;
        for (uint256 i; i < N; ++i) {
            name = NameCoder.addLabel(name, testLabel);
            assertEq(registryV1.resolver(NameCoder.namehash(name, 0)), address(0), vm.toString(i));
        }
    }

    function test_clear_complex() external {
        bytes memory name2 = registerWrappedETH2LD("2", CANNOT_UNWRAP);
        bytes memory name3 = createWrappedChild(name2, "3", PARENT_CANNOT_CONTROL);
        bytes memory name4 = createWrappedChild(name3, "4", CAN_DO_EVERYTHING);

        // set resolvers
        vm.startPrank(testOwner);
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name3, 0), address(1));
        nameWrapper.setResolver(NameCoder.namehash(name4, 0), address(1));
        vm.stopPrank();

        // unwrap name4
        vm.prank(testOwner);
        nameWrapper.unwrap(
            NameCoder.namehash(name3, 0),
            keccak256(bytes(NameCoder.firstLabel(name4))),
            address(testOwner)
        );

        // name2 = locked
        // name3 = detached (wrapped unlocked emancipated)
        // name4 = unwrapped

        _simulateMigration(name2);
        _simulateMigration(name3);

        graveyard.clear(_oneName(name4));

        assertEq(registryV1.resolver(NameCoder.namehash(name2, 0)), address(0), "2");
        assertEq(registryV1.resolver(NameCoder.namehash(name3, 0)), address(0), "3");
        assertEq(registryV1.resolver(NameCoder.namehash(name4, 0)), address(0), "4");
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    /// @dev Clear resolver if possible and transfer to graveyard.
    function _simulateMigration(bytes memory name) internal {
        bytes32 node = NameCoder.namehash(name, 0);
        (bytes32 labelHash, uint256 offset) = NameCoder.readLabel(name, 0);
        bytes32 parentNode = NameCoder.namehash(name, offset);
        address owner = registryV1.owner(node);
        if (owner == address(nameWrapper)) {
            uint32 fuses;
            (owner, fuses, ) = nameWrapper.getData(uint256(node));
            if ((fuses & CANNOT_SET_RESOLVER) == 0) {
                vm.prank(owner);
                nameWrapper.setResolver(node, address(0));
            }
            if ((fuses & CANNOT_UNWRAP) == 0) {
                vm.prank(owner);
                nameWrapper.unwrap(parentNode, labelHash, address(graveyard));
            } else {
                vm.prank(owner);
                nameWrapper.safeTransferFrom(owner, address(graveyard), uint256(node), 1, "");
            }
        } else if (parentNode == NameCoder.ETH_NODE) {
            vm.prank(owner);
            registryV1.setRecord(
                node,
                address(graveyard), // owner
                address(0), // resolver
                0 // ttl
            );
            vm.prank(owner);
            baseRegistrar.safeTransferFrom(owner, address(graveyard), uint256(labelHash));
        } else {
            revert("migrated failed");
        }
    }

    /// @dev Warp past expiry + grace.
    function _simulateExpiry(bytes memory name) internal {
        (bytes32 labelHash, uint256 offset) = NameCoder.readLabel(name, 0);
        if (NameCoder.namehash(name, offset) == NameCoder.ETH_NODE) {
            vm.warp(baseRegistrar.nameExpires(uint256(labelHash)) + gracePeriodV1);
        } else {
            (address owner, , uint64 expiry) =
                nameWrapper.getData(uint256(NameCoder.namehash(name, 0)));
            if (owner != address(0)) {
                vm.warp(expiry + 1); // see: gracePeriodV1 definition
            }
        }
    }

    /// @dev Create random .eth name with known 2LD.
    function _randomEthName() internal returns (bytes memory name) {
        name = NameCoder.ethName(testLabel);
        for (uint256 n = vm.randomUint(0, 10); n > 0; --n) {
            name = NameCoder.addLabel(name, new string(vm.randomUint(1, 255)));
        }
    }

    /// @dev Convert labelhash to encoded form.
    function _encodedLabelHash(bytes32 labelHash) internal pure returns (string memory) {
        return string(abi.encodePacked("[", HexUtils.bytesToHex(abi.encodePacked(labelHash)), "]"));
    }

    function _oneName(bytes memory name) internal pure returns (bytes[] memory names) {
        names = new bytes[](1);
        names[0] = name;
    }

    /// @dev Registers `count` 2LDs, optionally gives each a resolver, then
    ///      warps past expiry + grace so every one takes the reclaim branch.
    function _expired2LDs(uint256 count, bool withResolver) internal returns (bytes[] memory names) {
        names = new bytes[](count);
        for (uint256 i; i < count; ++i) {
            (bytes memory name, ) = registerUnwrapped(_label(i));
            if (withResolver) {
                vm.prank(registryV1.owner(NameCoder.namehash(name, 0)));
                registryV1.setResolver(NameCoder.namehash(name, 0), address(1));
            }
            names[i] = name;
        }
        _simulateExpiry(names[0]);
    }

    /// @dev Measures the per-name execution cost of clearing a batch of
    ///      already-expired 2LDs — the shape the backlog drain submits, and the
    ///      only figure that turns a name count into a gas budget. Reported as
    ///      an amortised number, so it carries the batch's fixed overhead and
    ///      the first name's cold-storage warmup spread across the batch.
    ///      Calldata is charged at transaction level and is not included.
    function _measureClearPerName(uint256 count, bool withResolver)
        internal
        returns (uint256 perName)
    {
        bytes[] memory names = _expired2LDs(count, withResolver);
        uint256 before = gasleft();
        graveyard.clear(names);
        perName = (before - gasleft()) / count;
    }

    function test_gas_clear_expired2LDs_resolverUnset() external {
        uint256 perName = _measureClearPerName(GAS_BATCH, false);
        console.log("clear() gas per expired 2LD, resolver unset:", perName);
        assertGt(perName, GAS_PER_NAME_MIN, "below band");
        assertLt(perName, GAS_PER_NAME_MAX, "above band");
    }

    function test_gas_clear_expired2LDs_resolverSet() external {
        uint256 perName = _measureClearPerName(GAS_BATCH, true);
        console.log("clear() gas per expired 2LD, resolver set:", perName);
        assertGt(perName, GAS_PER_NAME_MIN, "below band");
        assertLt(perName, GAS_PER_NAME_MAX, "above band");
    }
}
