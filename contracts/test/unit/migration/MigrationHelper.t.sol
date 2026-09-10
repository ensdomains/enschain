// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {
    CAN_DO_EVERYTHING,
    CANNOT_UNWRAP,
    PARENT_CANNOT_CONTROL
} from "@ens/contracts/wrapper/INameWrapper.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {LibMigration} from "~src/migration/libraries/LibMigration.sol";
import {UnlockedMigrationController} from "~src/migration/UnlockedMigrationController.sol";
import {LockedMigrationController} from "~src/migration/LockedMigrationController.sol";
import {WrapperRegistry} from "~src/registry/WrapperRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {MigrationHelper, LockedChildren} from "~src/migration/MigrationHelper.sol";
import {IStandaloneHCAFactory} from "~src/hca/interfaces/IStandaloneHCAFactory.sol";
import {MigrationControllerFixture} from "~test/fixtures/MigrationControllerFixture.sol";

contract MigrationHelperTest is MigrationControllerFixture {
    string internal constant STANDALONE_HCA_FACTORY_ARTIFACT =
        "src/hca/StandaloneHCAFactory.sol:StandaloneHCAFactory";

    UnlockedMigrationController unlockedController;
    LockedMigrationController lockedController;
    WrapperRegistry wrapperRegistryImpl;
    MigrationHelper helper;

    address hacker = makeAddr("hacker");

    function setUp() external {
        deployMigrationControllerFixture();

        // unlocked
        unlockedController = new UnlockedMigrationController(
            nameWrapper,
            address(graveyard),
            ethRegistry,
            contractNamer
        );
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, premigrationController);
        ethRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTER_RESERVED,
            address(unlockedController)
        );

        // locked
        wrapperRegistryImpl = new WrapperRegistry(
            nameWrapper,
            address(graveyard),
            verifiableFactory,
            address(ensV1Resolver),
            registryUpgradeSet,
            labelStore,
            publicResolverSet,
            address(0), // publicResolver
            address(this) // namer
        );
        lockedController = new LockedMigrationController(
            nameWrapper,
            address(graveyard),
            ethRegistry,
            verifiableFactory,
            address(wrapperRegistryImpl),
            publicResolverSet,
            address(0), // publicResolver
            contractNamer
        );
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, premigrationController);
        ethRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTER_RESERVED,
            address(lockedController)
        );

        helper = new MigrationHelper(
            rootRegistry,
            unlockedController,
            lockedController,
            IStandaloneHCAFactory(
                deployCode(
                    STANDALONE_HCA_FACTORY_ARTIFACT,
                    abi.encode(verifiableFactory, address(this))
                )
            ),
            contractNamer
        );
    }

    function test_migrate_unwrapped_notApproved() external {
        (bytes memory name, ) = registerUnwrapped(testLabel);

        LibMigration.Data[] memory mds = _toArray(_unlockedData(name));

        vm.expectRevert("ERC721: caller is not token owner or approved");
        vm.prank(testOwner);
        helper.migrate(
            mds,
            new LibMigration.Data[][](0),
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );
    }

    function test_migrate_unlocked_notApproved() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);

        LibMigration.Data[][] memory groups = _toGroups(_toArray(_unlockedData(name)));

        vm.expectRevert("ERC1155: caller is not owner nor approved");
        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            groups,
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );
    }

    function test_migrate_locked_notApproved() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);

        LibMigration.Data[][] memory groups = _toGroups(_toArray(_lockedData(name)));

        vm.expectRevert("ERC1155: caller is not owner nor approved");
        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            new LibMigration.Data[][](0),
            groups,
            new LockedChildren[](0)
        );
    }

    function test_migrate_unwrapped_notOperator() external {
        (bytes memory name, ) = registerUnwrapped(testLabel);

        vm.prank(testOwner);
        baseRegistrar.setApprovalForAll(address(helper), true);

        LibMigration.Data[] memory mds = _toArray(_unlockedData(name));

        vm.expectRevert(
            abi.encodeWithSelector(
                MigrationHelper.NotApprovedOperator.selector,
                baseRegistrar,
                testOwner
            )
        );
        vm.prank(hacker);
        helper.migrate(
            mds,
            new LibMigration.Data[][](0),
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );
    }

    function test_migrate_unlocked_notOperator() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);

        vm.prank(testOwner);
        nameWrapper.setApprovalForAll(address(helper), true);

        LibMigration.Data[][] memory groups = _toGroups(_toArray(_unlockedData(name)));

        vm.expectRevert(
            abi.encodeWithSelector(
                MigrationHelper.NotApprovedOperator.selector,
                nameWrapper,
                testOwner
            )
        );
        vm.prank(hacker);
        helper.migrate(
            new LibMigration.Data[](0),
            groups,
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );
    }

    function test_migrate_locked_notOperator() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);

        vm.prank(testOwner);
        nameWrapper.setApprovalForAll(address(helper), true);

        LibMigration.Data[][] memory groups = _toGroups(_toArray(_lockedData(name)));

        vm.expectRevert(
            abi.encodeWithSelector(
                MigrationHelper.NotApprovedOperator.selector,
                nameWrapper,
                testOwner
            )
        );
        vm.prank(hacker);
        helper.migrate(
            new LibMigration.Data[](0),
            new LibMigration.Data[][](0),
            groups,
            new LockedChildren[](0)
        );
    }

    function test_migrate_notSameOwner_wrappedOwnerMismatch() external {
        bytes memory name1 = registerWrappedETH2LD("a", CAN_DO_EVERYTHING);
        vm.prank(friend);
        bytes memory name2 = this.registerWrappedETH2LD("b", CAN_DO_EVERYTHING);

        LibMigration.Data[] memory mds = new LibMigration.Data[](2);
        mds[0] = _unlockedData(name1);
        mds[1] = _unlockedData(name2); // wrong: owner is friend

        LibMigration.Data[][] memory groups = _toGroups(mds);

        vm.prank(testOwner);
        nameWrapper.setApprovalForAll(address(helper), true);
        vm.prank(friend);
        nameWrapper.setApprovalForAll(testOwner, true);
        vm.prank(friend);
        nameWrapper.setApprovalForAll(address(helper), true);

        vm.expectRevert(
            abi.encodeWithSelector(
                MigrationHelper.WrappedOwnerMismatch.selector,
                NameCoder.namehash(name2, 0)
            )
        );
        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            groups,
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );
    }

    function test_migrate_notSameOwner() external {
        bytes memory name1 = registerWrappedETH2LD("a", CAN_DO_EVERYTHING);
        vm.prank(friend);
        bytes memory name2 = this.registerWrappedETH2LD("b", CAN_DO_EVERYTHING);

        LibMigration.Data[][] memory groups = new LibMigration.Data[][](2);
        groups[0] = _toArray(_unlockedData(name1));
        groups[1] = _toArray(_unlockedData(name2));

        // testOwner grants approval to helper
        vm.prank(testOwner);
        nameWrapper.setApprovalForAll(address(helper), true);

        // friend must grant approval to operator AND helper!

        // only helper
        vm.startPrank(friend);
        nameWrapper.setApprovalForAll(testOwner, false);
        nameWrapper.setApprovalForAll(address(helper), true);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(MigrationHelper.NotApprovedOperator.selector, nameWrapper, friend)
        );
        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            groups,
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );

        // only operator
        vm.startPrank(friend);
        nameWrapper.setApprovalForAll(testOwner, true);
        nameWrapper.setApprovalForAll(address(helper), false);
        vm.stopPrank();

        vm.expectRevert("ERC1155: caller is not owner nor approved");
        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            groups,
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );

        // both
        vm.startPrank(friend);
        nameWrapper.setApprovalForAll(testOwner, true);
        nameWrapper.setApprovalForAll(address(helper), true);
        vm.stopPrank();

        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            groups,
            new LibMigration.Data[][](0),
            new LockedChildren[](0)
        );
    }

    function test_migrate_parentAndChildren_parentNotMigrated() external {
        bytes memory name2 = registerWrappedETH2LD("2", CANNOT_UNWRAP);
        bytes memory name3 = createWrappedChild(name2, "3", PARENT_CANNOT_CONTROL);

        vm.prank(testOwner);
        nameWrapper.setApprovalForAll(address(helper), true);

        LockedChildren[] memory lcs = new LockedChildren[](1);
        lcs[0] = LockedChildren(name2, _toGroups(_toArray(_lockedData(name3))));

        vm.expectRevert(abi.encodeWithSelector(MigrationHelper.ParentNotMigrated.selector, name2));
        vm.prank(testOwner);
        helper.migrate(
            new LibMigration.Data[](0),
            new LibMigration.Data[][](0),
            new LibMigration.Data[][](0), // wrong: forgot parent
            lcs
        );
    }

    function test_migrate_parentAndChildren() external {
        bytes memory name2 = registerWrappedETH2LD("2", CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3a =
            this.createWrappedChild(name2, "3a", PARENT_CANNOT_CONTROL | CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3b = this.createWrappedChild(name2, "3b", PARENT_CANNOT_CONTROL);

        vm.prank(testOwner);
        nameWrapper.setApprovalForAll(address(helper), true);
        vm.prank(friend);
        nameWrapper.setApprovalForAll(testOwner, true);
        vm.prank(friend);
        nameWrapper.setApprovalForAll(address(helper), true);

        LibMigration.Data[][] memory groups = _toGroups(_toArray(_lockedData(name2)));

        LibMigration.Data[] memory mds = new LibMigration.Data[](2);
        mds[0] = _lockedData(name3a);
        mds[1] = _unlockedData(name3b);

        LockedChildren[] memory lcs = new LockedChildren[](1);
        lcs[0] = LockedChildren(name2, _toGroups(mds));

        vm.prank(testOwner);
        helper.migrate(new LibMigration.Data[](0), new LibMigration.Data[][](0), groups, lcs);
    }

    function test_migrate_0unwrapped_0unlocked_0locked() external {
        _testMigrate(0, 0, 0);
    }
    function test_migrate_1unwrapped_0unlocked_0locked() external {
        _testMigrate(1, 0, 0);
    }
    function test_migrate_0unwrapped_1unlocked_0locked() external {
        _testMigrate(0, 1, 0);
    }
    function test_migrate_0unwrapped_0unlocked_1locked() external {
        _testMigrate(0, 0, 1);
    }
    function test_migrate_1unwrapped_1unlocked_1locked() external {
        _testMigrate(1, 1, 1);
    }
    function test_migrate_2unwrapped_2unlocked_2locked() external {
        _testMigrate(2, 2, 2);
    }
    function test_migrate_7unwrapped_8unlocked_9locked() external {
        _testMigrate(7, 8, 9);
    }

    function _testMigrate(uint256 numUnwrapped, uint256 numUnlocked, uint256 numLocked) public {
        LibMigration.Data[] memory unwrapped = new LibMigration.Data[](numUnwrapped);
        LibMigration.Data[] memory unlocked = new LibMigration.Data[](numUnlocked);
        LibMigration.Data[] memory locked = new LibMigration.Data[](numLocked);

        testLabel = "unwrapped";
        for (uint256 i; i < numUnwrapped; ++i) {
            (bytes memory name, ) = registerUnwrapped(_label(i));
            unwrapped[i] = _unlockedData(name);
        }
        testLabel = "unlocked";
        for (uint256 i; i < numUnlocked; ++i) {
            bytes memory name = registerWrappedETH2LD(_label(i), CAN_DO_EVERYTHING);
            unlocked[i] = _unlockedData(name);
        }
        testLabel = "locked";
        for (uint256 i; i < numLocked; ++i) {
            bytes memory name = registerWrappedETH2LD(_label(i), CANNOT_UNWRAP);
            locked[i] = _lockedData(name);
        }

        if (numUnwrapped > 0) {
            vm.prank(testOwner);
            baseRegistrar.setApprovalForAll(address(helper), true);
        }
        if (numUnlocked > 0 || numLocked > 0) {
            vm.prank(testOwner);
            nameWrapper.setApprovalForAll(address(helper), true);
        }

        LibMigration.Data[][] memory unlockedGroups = _toGroups(unlocked);
        LibMigration.Data[][] memory lockedGroups = _toGroups(locked);

        vm.prank(testOwner);
        helper.migrate(unwrapped, unlockedGroups, lockedGroups, new LockedChildren[](0));
    }

    function _toArray(LibMigration.Data memory md)
        internal
        pure
        returns (LibMigration.Data[] memory mds)
    {
        mds = new LibMigration.Data[](1);
        mds[0] = md;
    }

    function _toGroups(LibMigration.Data[] memory mds)
        internal
        pure
        returns (LibMigration.Data[][] memory groups)
    {
        groups = new LibMigration.Data[][](1);
        groups[0] = mds;
    }
}
