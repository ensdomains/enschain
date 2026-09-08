// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {console} from "forge-std/console.sol";

import {
    INameWrapper,
    OperationProhibited,
    CANNOT_UNWRAP,
    CAN_DO_EVERYTHING,
    CANNOT_APPROVE,
    CANNOT_BURN_FUSES,
    CANNOT_TRANSFER,
    CANNOT_SET_RESOLVER,
    CANNOT_CREATE_SUBDOMAIN,
    PARENT_CANNOT_CONTROL,
    CAN_EXTEND_EXPIRY
} from "@ens/contracts/wrapper/NameWrapper.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {InvalidOwner, UnauthorizedCaller} from "~src/CommonErrors.sol";
import {LibLabel} from "~src/utils/LibLabel.sol";
import {ILabelStore} from "~src/utils/interfaces/ILabelStore.sol";
import {LibMigration} from "~src/migration/libraries/LibMigration.sol";
import {WrappedErrorLib} from "~src/utils/WrappedErrorLib.sol";
import {LockedMigrationController} from "~src/migration/LockedMigrationController.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IStandardRegistry} from "~src/registry/interfaces/IStandardRegistry.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {LibRegistry} from "~src/universalResolver/libraries/LibRegistry.sol";
import {IEnhancedAccessControl} from "~src/access-control/interfaces/IEnhancedAccessControl.sol";
import {EACBaseRolesLib} from "~src/access-control/libraries/EACBaseRolesLib.sol";
import {IWrapperRegistry} from "~src/registry/interfaces/IWrapperRegistry.sol";
import {
    IWrapperRegistryInitializable
} from "~src/registry/interfaces/IWrapperRegistryInitializable.sol";
import {WrapperRegistry} from "~src/registry/WrapperRegistry.sol";
import {IRegistryEvents} from "~src/registry/interfaces/IRegistryEvents.sol";
import {PublicResolverV2} from "~src/resolver/PublicResolverV2.sol";
import {IAddressSet} from "~src/utils/interfaces/IAddressSet.sol";
import {MigrationControllerFixture} from "~test/fixtures/MigrationControllerFixture.sol";

contract LockedMigrationControllerTest is MigrationControllerFixture {
    LockedMigrationController migrationController;
    PublicResolverV2 publicResolver;
    WrapperRegistry wrapperRegistryImpl;

    function setUp() external {
        deployMigrationControllerFixture();

        publicResolver = new PublicResolverV2(nameWrapper, rootRegistry, contractNamer);

        vm.expectEmit();
        emit IRegistryEvents.RegistryCreated();
        wrapperRegistryImpl = new WrapperRegistry(
            nameWrapper,
            address(graveyard),
            verifiableFactory,
            address(ensV1Resolver),
            registryUpgradeSet,
            labelStore,
            publicResolverSet,
            address(publicResolver),
            address(this) // namer
        );

        migrationController = new LockedMigrationController(
            nameWrapper,
            address(graveyard),
            ethRegistry,
            verifiableFactory,
            address(wrapperRegistryImpl),
            publicResolverSet,
            address(publicResolver),
            contractNamer
        );

        ethRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTER_RESERVED,
            address(migrationController)
        );
    }

    function test_constructor_controller() external view {
        assertEq(address(migrationController.GRAVEYARD()), address(graveyard), "GRAVEYARD");
        assertEq(address(migrationController.NAME_WRAPPER()), address(nameWrapper), "NAME_WRAPPER");
        assertEq(address(migrationController.ETH_REGISTRY()), address(ethRegistry), "ETH_REGISTRY");
        assertEq(
            address(migrationController.VERIFIABLE_FACTORY()),
            address(verifiableFactory),
            "VERIFIABLE_FACTORY"
        );
        assertEq(
            migrationController.WRAPPER_REGISTRY_IMPL(),
            address(wrapperRegistryImpl),
            "WRAPPER_REGISTRY_IMPL"
        );
        assertEq(
            address(migrationController.CONTRACT_NAMER()),
            address(contractNamer),
            "CONTRACT_NAMER"
        );

        assertEq(migrationController.getWrappedName(), NameCoder.encode("eth"), "getWrappedName");
        assertEq(migrationController.getWrappedNode(), NameCoder.ETH_NODE, "getWrappedNode");
    }

    function test_constructor_registry() external view {
        assertEq(address(wrapperRegistryImpl.GRAVEYARD()), address(graveyard), "GRAVEYARD");
        assertEq(address(wrapperRegistryImpl.NAME_WRAPPER()), address(nameWrapper), "NAME_WRAPPER");
        assertEq(
            address(wrapperRegistryImpl.VERIFIABLE_FACTORY()),
            address(verifiableFactory),
            "VERIFIABLE_FACTORY"
        );
        assertEq(wrapperRegistryImpl.V1_RESOLVER(), address(ensV1Resolver), "V1_RESOLVER");
    }

    function test_supportsInterface_controller() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(migrationController),
                type(IERC1155Receiver).interfaceId
            ),
            "IERC1155Receiver"
        );
    }

    function test_supportsInterface_registry() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(migrationController),
                type(IERC1155Receiver).interfaceId
            ),
            "IERC1155Receiver"
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(wrapperRegistryImpl),
                type(IWrapperRegistry).interfaceId
            ),
            "IWrapperRegistry"
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(wrapperRegistryImpl),
                type(IWrapperRegistryInitializable).interfaceId
            ),
            "IWrapperRegistryInitializable"
        );
    }

    function test_implementationIsNameable() external view {
        assertTrue(wrapperRegistryImpl.isContractNamer(address(this)));
    }

    function test_wrapperRegistryUpgrade_revertsForUnapprovedTarget() external {
        WrapperRegistry registry = _deployWrapperRegistryProxy();
        WrapperRegistryV2Mock newImplementation = _newWrapperRegistryV2Mock();

        vm.expectRevert(
            abi.encodeWithSelector(
                IWrapperRegistry.UpgradeTargetNotApproved.selector,
                address(newImplementation)
            )
        );
        vm.prank(testOwner);
        registry.upgradeToAndCall(address(newImplementation), "");
    }

    function test_wrapperRegistryUpgrade_allowsApprovedTarget() external {
        WrapperRegistry registry = _deployWrapperRegistryProxy();
        WrapperRegistryV2Mock newImplementation = _newWrapperRegistryV2Mock();

        registryUpgradeSet.approve(address(newImplementation), true);

        vm.prank(testOwner);
        registry.upgradeToAndCall(address(newImplementation), "");

        assertEq(WrapperRegistryV2Mock(address(registry)).version(), 2, "version");
    }

    function test_wrapperRegistryUpgrade_requiresUpgradeRole() external {
        WrapperRegistry registry = _deployWrapperRegistryProxy();
        WrapperRegistryV2Mock newImplementation = _newWrapperRegistryV2Mock();

        registryUpgradeSet.approve(address(newImplementation), true);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_UPGRADE,
                actor
            )
        );
        vm.prank(actor);
        registry.upgradeToAndCall(address(newImplementation), "");
    }

    function test_MIN_DATA_SIZE() external pure {
        LibMigration.Data memory md;
        assertLt(abi.encode(md).length, LibMigration.MIN_DATA_SIZE, "empty");
        md.label = new string(1); // shortest
        assertEq(abi.encode(md).length, LibMigration.MIN_DATA_SIZE, "short");
    }

    function test_finishERC1155Migration_unauthorizedCaller() external {
        vm.expectRevert(abi.encodeWithSelector(UnauthorizedCaller.selector, actor));
        vm.prank(actor);
        migrationController.finishERC1155Migration(new uint256[](0), new LibMigration.Data[](0));
    }

    function test_safeTransferFrom_unauthorizedCaller() external {
        uint256 tokenId = dummy1155.mint(actor);
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(UnauthorizedCaller.selector, dummy1155))
        );
        vm.prank(actor);
        dummy1155.safeTransferFrom(actor, address(migrationController), tokenId, 1, ""); // wrong
    }

    function test_onERC1155Received_unauthorizedCaller() external {
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(UnauthorizedCaller.selector, actor))
        );
        vm.prank(actor);
        migrationController.onERC1155Received(address(0), address(0), 1, 1, "");
    }

    function test_onERC1155Received_invalidData() external {
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(LibMigration.InvalidData.selector))
        );
        vm.prank(address(nameWrapper));
        migrationController.onERC1155Received(address(0), address(0), 1, 1, "");
    }

    function test_migrate_invalidData(bytes calldata v) external {
        vm.assume(v.length < LibMigration.MIN_DATA_SIZE);
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(LibMigration.InvalidData.selector))
        );
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            v // wrong
        );
    }

    function test_migrate_invalidArrayLength() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        LibMigration.Data[] memory mds = new LibMigration.Data[](1);
        ids[0] = uint256(NameCoder.namehash(name, 0));
        mds[0] = _lockedData(name);
        amounts[0] = 1;
        bytes memory payload = abi.encode(mds);
        uint256 fakeLength = 0;
        assembly {
            mstore(add(payload, 64), fakeLength) // wrong
        }
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(
                    IERC1155Errors.ERC1155InvalidArrayLength.selector,
                    ids.length,
                    fakeLength
                )
            )
        );
        vm.prank(testOwner);
        nameWrapper.safeBatchTransferFrom(
            testOwner,
            address(migrationController),
            ids,
            amounts,
            payload
        );
    }

    function test_migrate_invalidOwner() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        LibMigration.Data memory md = _lockedData(name);
        md.owner = address(0); // wrong
        vm.expectRevert(WrappedErrorLib.wrap(abi.encodeWithSelector(InvalidOwner.selector)));
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            abi.encode(md)
        );
    }

    function test_migrate_invalidReceiver() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        LibMigration.Data memory md = _lockedData(name);
        md.owner = address(ethRegistry); // not a IERC1155Receiver
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, md.owner)
            )
        );
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            abi.encode(md)
        );
    }

    function test_migrate_nameDataMismatch() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);
        md.label = "wrong";
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(LibMigration.NameDataMismatch.selector, node)
            )
        );
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );
    }

    function test_migrate_nameNotLocked() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(LibMigration.NameNotLocked.selector, node))
        );
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );
    }

    function test_migrate_notReserved() external {
        premigrationController = address(0); // disable premigration
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        LibMigration.Data memory md = _lockedData(name);
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(
                    IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                    ethRegistry.ROOT_RESOURCE(),
                    RegistryRolesLib.ROLE_REGISTRAR,
                    address(migrationController)
                )
            )
        );
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            abi.encode(md)
        );
    }

    function test_checkIfMigrated() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        LibMigration.Data memory md = _lockedData(name);
        uint256 tokenIdV1 = LibLabel.id(md.label);

        assertFalse(ethRegistry.hasRoles(tokenIdV1, RegistryRolesLib.ROLE_WAS_RESERVED, testOwner));

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            abi.encode(md)
        );

        assertTrue(ethRegistry.hasRoles(tokenIdV1, RegistryRolesLib.ROLE_WAS_RESERVED, testOwner));
    }

    function test_migrate() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        checkResolution(name, address(ensV2Resolver), address(ensV1Resolver));
        LibMigration.Data memory md = _lockedData(name);
        bytes32 node = NameCoder.namehash(name, 0);
        uint256 salt = uint256(node);
        uint256 tokenIdV1 = LibLabel.id(md.label);
        uint256 tokenId = LibLabel.withVersion(tokenIdV1, 0);
        address expectedRegistry =
            _computeVerifiableFactoryAddress(address(migrationController), salt);
        uint64 expectedExpiry =
            uint64(baseRegistrar.nameExpires(tokenIdV1)) + premigrationBonusPeriod;
        address virtualOwner = address(ethRegistry);
        vm.expectEmit();
        emit IERC1155.TransferSingle(
            testOwner,
            testOwner,
            address(migrationController),
            uint256(node),
            1
        );
        vm.expectEmit();
        emit ENS.NewResolver(node, address(0));
        // emit IERC1967.Upgraded()
        vm.expectEmit();
        emit IRegistryEvents.RegistryCreated();
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(
            0 /*ROOT_RESOURCE*/,
            virtualOwner,
            0 /*old roles*/,
            RegistryRolesLib.ROLE_UPGRADE |
            RegistryRolesLib.ROLE_UPGRADE_ADMIN |
            RegistryRolesLib.ROLE_REGISTRAR |
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_RENEW |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN
        );
        // emit Initializable.Initialized()
        vm.expectEmit();
        emit IVerifiableFactory.ProxyDeployed(
            address(migrationController),
            expectedRegistry,
            salt,
            address(wrapperRegistryImpl)
        );
        vm.expectEmit();
        emit IRegistryEvents.LabelRegistered(
            tokenId,
            bytes32(tokenIdV1),
            md.label,
            md.owner,
            expectedExpiry,
            address(migrationController)
        );
        vm.expectEmit();
        emit IERC1155.TransferSingle(address(migrationController), address(0), md.owner, tokenId, 1);
        vm.expectEmit();
        emit IPermissionedRegistry.TokenResource(tokenId, tokenId);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(
            tokenId,
            md.owner,
            0 /*old roles*/,
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
            RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN |
            RegistryRolesLib.ROLE_WAS_RESERVED
        );
        vm.expectEmit();
        emit IRegistryEvents.SubregistryUpdated(
            tokenId,
            IRegistry(expectedRegistry),
            address(migrationController)
        );
        vm.expectEmit();
        emit IRegistryEvents.ResolverUpdated(tokenId, md.resolver, address(migrationController));
        vm.prank(testOwner);
        uint256 g = gasleft();
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );
        console.log("Gas: %s", g - gasleft());

        assertEq(ethRegistry.getTokenId(tokenIdV1), tokenId, "tokenId");
        assertEq(ethRegistry.ownerOf(tokenId), md.owner, "owner");
        assertEq(ethRegistry.getExpiry(tokenId), expectedExpiry, "expiry");
        assertEq(ethRegistry.getResolver(md.label), md.resolver, "resolver");
        checkResolution(name, address(ensV2Resolver), md.resolver);
        IWrapperRegistry subregistry =
            IWrapperRegistry(address(ethRegistry.getSubregistry(md.label)));
        assertTrue(
            ERC165Checker.supportsInterface(address(subregistry), type(IWrapperRegistry).interfaceId),
            "IWrapperRegistry"
        );
        assertTrue(
            subregistry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(ethRegistry)),
            "ROLE_REGISTRAR"
        );
        assertEq(
            subregistry.roleCount(subregistry.ROOT_RESOURCE()) &
            (RegistryRolesLib.ROLE_SET_PARENT * 15),
            0,
            "ROLE_SET_PARENT"
        );
        assertEq(subregistry.getWrappedNode(), node, "getWrappedNode");
        assertEq(subregistry.getWrappedName(), name, "getWrappedName");
        assertEq(LibRegistry.findCanonicalName(rootRegistry, subregistry), name, "findCanonicalName");
    }

    function test_migrateBatch(uint8 count) external {
        vm.assume(count < 5);
        uint256[] memory ids = new uint256[](count);
        uint256[] memory amounts = new uint256[](count);
        LibMigration.Data[] memory mds = new LibMigration.Data[](count);
        for (uint256 i; i < count; ++i) {
            bytes memory name = registerWrappedETH2LD(_label(i), CANNOT_UNWRAP);
            LibMigration.Data memory md = _lockedData(name);
            md.resolver = address(uint160(i));
            mds[i] = md;
            ids[i] = uint256(NameCoder.namehash(name, 0));
            amounts[i] = 1;
        }
        vm.prank(testOwner);
        nameWrapper.safeBatchTransferFrom(
            testOwner,
            address(migrationController),
            ids,
            amounts,
            abi.encode(mds)
        );
        for (uint256 i; i < count; ++i) {
            string memory label = _label(i);
            uint256 tokenId = ethRegistry.getTokenId(LibLabel.id(label));
            assertEq(ethRegistry.ownerOf(tokenId), testOwner, "owner");
            assertEq(ethRegistry.getResolver(label), address(uint160(i)), "resolver");
            assertTrue(
                ERC165Checker.supportsInterface(
                    address(ethRegistry.getSubregistry(label)),
                    type(IWrapperRegistry).interfaceId
                ),
                "IWrapperRegistry"
            );
        }
    }

    function test_migrateBatch_lastOneWrong(uint8 count) external {
        vm.assume(count > 1 && count < 5);
        uint256[] memory ids = new uint256[](count);
        uint256[] memory amounts = new uint256[](count);
        LibMigration.Data[] memory mds = new LibMigration.Data[](count);
        for (uint256 i; i < count; ++i) {
            bytes memory name =
                registerWrappedETH2LD(_label(i), i == count - 1 ? CAN_DO_EVERYTHING : CANNOT_UNWRAP);
            LibMigration.Data memory md = _lockedData(name);
            mds[i] = md;
            ids[i] = uint256(NameCoder.namehash(name, 0));
            amounts[i] = 1;
        }
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(LibMigration.NameNotLocked.selector, ids[count - 1])
            )
        );
        vm.prank(testOwner);
        nameWrapper.safeBatchTransferFrom(
            testOwner,
            address(migrationController),
            ids,
            amounts,
            abi.encode(mds)
        );
    }

    function test_migrate_setApprovalForAll() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );

        IPermissionedRegistry registry =
            IPermissionedRegistry(address(ethRegistry.getSubregistry(md.label)));

        assertEq(registry.roles(registry.ROOT_RESOURCE(), actor), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                actor
            )
        );
        vm.prank(actor);
        registry.register(testLabel, actor, testRegistry, testResolver, 0, _soon());

        vm.prank(testOwner);
        ethRegistry.setApprovalForAll(actor, true);

        assertEq(
            registry.roles(registry.ROOT_RESOURCE(), actor),
            registry.roles(registry.ROOT_RESOURCE(), testOwner)
        );

        vm.prank(actor);
        registry.register(testLabel, actor, testRegistry, testResolver, 0, _soon());
    }

    function test_migrate_transferRegistryControl() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );

        IWrapperRegistry registry = IWrapperRegistry(address(ethRegistry.getSubregistry(md.label)));
        address virtualOwner = address(ethRegistry);

        vm.prank(testOwner);
        registry.setApprovalForAll(actor, true);

        uint256 rootRoles = registry.roles(registry.ROOT_RESOURCE(), virtualOwner);
        assertEq(registry.roles(registry.ROOT_RESOURCE(), testOwner), rootRoles, "before:owner");
        assertEq(registry.roles(registry.ROOT_RESOURCE(), friend), 0, "before:friend");
        assertEq(registry.roles(registry.ROOT_RESOURCE(), actor), 0, "before:actor");

        // owner cannot grant admin
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                registry.ROOT_RESOURCE(),
                rootRoles,
                testOwner
            )
        );
        vm.prank(testOwner);
        registry.grantRootRoles(rootRoles, friend);

        // owner can grant non-owner roles
        vm.prank(testOwner);
        ethRegistry.grantRoles(LibLabel.id(md.label), RegistryRolesLib.ROLE_SET_RESOLVER, friend);

        uint256 tokenId = ethRegistry.findTokenId(md.label);

        // safe transfer rejected because of outstanding grants
        vm.expectRevert(
            abi.encodeWithSelector(
                IPermissionedRegistry.TransferUnsafeWithMultipleAssignees.selector,
                tokenId,
                testOwner
            )
        );
        vm.prank(testOwner);
        ethRegistry.safeTransferFrom(testOwner, friend, tokenId, 1, "");

        // unsafe transfer is required
        vm.prank(testOwner);
        ethRegistry.unsafeTransfer(friend, tokenId, "");

        // effective roles have "transferred"
        assertEq(registry.roles(registry.ROOT_RESOURCE(), testOwner), 0, "after:owner");
        assertEq(registry.roles(registry.ROOT_RESOURCE(), friend), rootRoles, "after:friend");
        assertEq(registry.roles(registry.ROOT_RESOURCE(), actor), 0, "after:actor");

        // underlying virtual owner roles are unchanged
        assertEq(registry.roles(registry.ROOT_RESOURCE(), virtualOwner), rootRoles, "virtual");
    }

    function test_migrate_lockedResolver() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);

        address frozenResolver = makeAddr("frozenResolver");
        vm.prank(testOwner);
        nameWrapper.setResolver(node, frozenResolver);
        vm.prank(testOwner);
        nameWrapper.setFuses(node, uint16(CANNOT_UNWRAP | CANNOT_SET_RESOLVER));
        assertNotEq(md.resolver, frozenResolver, "diff");

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );

        uint256 tokenId = ethRegistry.getTokenId(LibLabel.id(md.label));
        assertEq(ethRegistry.getResolver(md.label), frozenResolver, "frozen");
        checkResolution(name, frozenResolver, frozenResolver);
        assertFalse(ethRegistry.hasRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, testOwner));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                tokenId,
                RegistryRolesLib.ROLE_SET_RESOLVER,
                testOwner
            )
        );
        vm.prank(testOwner);
        ethRegistry.setResolver(tokenId, testResolver);
    }

    function test_migrate_lockedResolver_publicResolver() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);

        address oldPublicResolver = makeAddr("oldPublicResolver");
        vm.prank(testOwner);
        nameWrapper.setResolver(node, oldPublicResolver);
        vm.prank(testOwner);
        nameWrapper.setFuses(node, uint16(CANNOT_UNWRAP | CANNOT_SET_RESOLVER));
        assertNotEq(md.resolver, oldPublicResolver, "diff");

        // add as approved PublicResolver
        publicResolverSet.approve(oldPublicResolver, true);

        assertFalse(publicResolver.canModifyName(node, testOwner), "before");

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );

        assertTrue(publicResolver.canModifyName(node, testOwner), "after");

        assertEq(ethRegistry.getResolver(md.label), address(publicResolver), "prV2");
        checkResolution(name, address(oldPublicResolver), address(publicResolver));
    }

    function test_migrate_lockedTransfer() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP | CANNOT_TRANSFER);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _lockedData(name);

        vm.expectRevert(abi.encodeWithSelector(OperationProhibited.selector, node));
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );
    }

    function test_migrate_lockedFuses() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP | CANNOT_BURN_FUSES);
        LibMigration.Data memory md = _lockedData(name);

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            abi.encode(md)
        );

        uint256 tokenId = ethRegistry.getTokenId(LibLabel.id(md.label));
        assertEq(
            ethRegistry.roles(tokenId, testOwner) & EACBaseRolesLib.ADMIN_ROLES,
            RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN,
            "token"
        );
        IWrapperRegistry registry = IWrapperRegistry(address(ethRegistry.getSubregistry(md.label)));
        address virtualOwner = address(ethRegistry);
        assertEq(
            registry.roles(registry.ROOT_RESOURCE(), virtualOwner) & EACBaseRolesLib.ADMIN_ROLES,
            0,
            "registry"
        );
    }

    function test_migrate_cannotCreateChildren() external {
        bytes memory name =
            registerWrappedETH2LD(testLabel, CANNOT_UNWRAP | CANNOT_CREATE_SUBDOMAIN);
        LibMigration.Data memory md = _lockedData(name);

        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name, 0)),
            1,
            abi.encode(md)
        );

        uint256 tokenId = ethRegistry.getTokenId(LibLabel.id(md.label));
        assertFalse(ethRegistry.hasRoles(tokenId, RegistryRolesLib.ROLE_REGISTRAR, testOwner));

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ethRegistry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                testOwner
            )
        );
        vm.prank(testOwner);
        ethRegistry.register(
            string.concat(testLabel, testLabel),
            testOwner,
            IRegistry(address(0)),
            address(0),
            0,
            _soon()
        );
    }

    function test_migrate_cannotCreateChildren_cannotRevive() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node2 = NameCoder.namehash(name2, 0);
        bytes memory name3 = createWrappedChild(name2, "sub", PARENT_CANNOT_CONTROL);

        // burn fuse
        vm.prank(testOwner);
        nameWrapper.setFuses(node2, uint16(CANNOT_CREATE_SUBDOMAIN));

        // migrate 2LD
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node2),
            1,
            abi.encode(data2)
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));

        // migrate 3LD
        LibMigration.Data memory data3 = _unlockedData(name3);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(registry2),
            uint256(NameCoder.namehash(name3, 0)),
            1,
            abi.encode(data3)
        );

        // can renew
        uint256 tokenId = registry2.findTokenId(data3.label);
        uint64 newExpiry = registry2.getExpiry(tokenId) + 1;
        vm.prank(testOwner);
        registry2.renew(tokenId, newExpiry);

        vm.warp(newExpiry);
        assertEq(uint8(registry2.getStatus(tokenId)), uint8(IPermissionedRegistry.Status.AVAILABLE));

        // cannot revive
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.LabelExpired.selector, tokenId));
        vm.prank(testOwner);
        registry2.renew(tokenId, _soon());
    }

    function test_migrate_canCreateChildren_canRevive() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node2 = NameCoder.namehash(name2, 0);
        bytes memory name3 = createWrappedChild(name2, "sub", PARENT_CANNOT_CONTROL);

        // migrate 2LD (CANNOT_CREATE_SUBDOMAIN not burned -> ROLE_REGISTRAR retained)
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node2),
            1,
            abi.encode(data2)
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));

        // migrate 3LD
        LibMigration.Data memory data3 = _unlockedData(name3);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(registry2),
            uint256(NameCoder.namehash(name3, 0)),
            1,
            abi.encode(data3)
        );

        // let it expire
        uint256 tokenId = registry2.findTokenId(data3.label);
        uint64 expiry = registry2.getExpiry(tokenId);
        vm.warp(expiry);
        assertEq(uint8(registry2.getStatus(tokenId)), uint8(IPermissionedRegistry.Status.AVAILABLE));

        // can revive: root role holder may revive because CANNOT_CREATE_SUBDOMAIN was not burned
        uint64 newExpiry = _soon();
        vm.prank(address(ethRegistry));
        registry2.renew(tokenId, newExpiry);
        assertEq(uint8(registry2.getStatus(tokenId)), uint8(IPermissionedRegistry.Status.REGISTERED));
        assertEq(registry2.getExpiry(tokenId), newExpiry);
    }

    function test_migrate_canExtendExpiry() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3 =
            this.createWrappedChild(
                name2,
                "sub",
                CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | CAN_EXTEND_EXPIRY
            );

        // migrate 2LD
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name2, 0)),
            1,
            abi.encode(data2)
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));

        // migrate 3LD
        LibMigration.Data memory data3 = _lockedData(name3);
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            friend,
            address(registry2),
            uint256(NameCoder.namehash(name3, 0)),
            1,
            abi.encode(data3)
        );

        uint256 tokenId = registry2.getTokenId(LibLabel.id(data3.label));
        assertTrue(registry2.hasRoles(tokenId, RegistryRolesLib.ROLE_RENEW, friend), "ROLE_RENEW");

        uint64 expiry = registry2.getExpiry(tokenId);
        vm.prank(friend);
        registry2.renew(tokenId, expiry + 1);
    }

    function test_migrate_emancipated_canExtendExpiry() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3 =
            this.createWrappedChild(name2, "sub", PARENT_CANNOT_CONTROL | CAN_EXTEND_EXPIRY);
        vm.prank(friend);
        bytes memory name3plain = this.createWrappedChild(name2, "plain", PARENT_CANNOT_CONTROL);

        // migrate 2LD
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name2, 0)),
            1,
            abi.encode(data2)
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));

        // migrate emancipated 3LD with CAN_EXTEND_EXPIRY
        LibMigration.Data memory data3 = _lockedData(name3);
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            friend,
            address(registry2),
            uint256(NameCoder.namehash(name3, 0)),
            1,
            abi.encode(data3)
        );

        uint256 tokenId = registry2.getTokenId(LibLabel.id(data3.label));
        assertTrue(
            registry2.hasRoles(
                tokenId,
                RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_RENEW_ADMIN,
                friend
            ),
            "ROLE_RENEW + ROLE_RENEW_ADMIN"
        );

        uint64 expiry = registry2.getExpiry(tokenId);
        vm.prank(friend);
        registry2.renew(tokenId, expiry + 1);

        // migrate emancipated 3LD without CAN_EXTEND_EXPIRY
        LibMigration.Data memory data3plain = _lockedData(name3plain);
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            friend,
            address(registry2),
            uint256(NameCoder.namehash(name3plain, 0)),
            1,
            abi.encode(data3plain)
        );

        uint256 tokenIdPlain = registry2.getTokenId(LibLabel.id(data3plain.label));
        assertFalse(
            registry2.hasRoles(tokenIdPlain, RegistryRolesLib.ROLE_RENEW, friend),
            "no ROLE_RENEW"
        );
    }

    function test_migrate_lockedChildren() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3 =
            this.createWrappedChild(name2, "sub", CANNOT_UNWRAP | PARENT_CANNOT_CONTROL);
        vm.prank(friend);
        bytes memory name3unmigrated =
            this.createWrappedChild(name2, "unmigrated", CANNOT_UNWRAP | PARENT_CANNOT_CONTROL);

        // migrate 2LD
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name2, 0)),
            1,
            abi.encode(data2)
        );
        assertEq(
            ethRegistry.ownerOf(ethRegistry.getTokenId(LibLabel.id(data2.label))),
            data2.owner,
            "owner2"
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));
        assertTrue(
            ERC165Checker.supportsInterface(address(registry2), type(IWrapperRegistry).interfaceId),
            "registry2"
        );

        // migrate 3LD
        LibMigration.Data memory data3 = _lockedData(name3);
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            friend,
            address(registry2),
            uint256(NameCoder.namehash(name3, 0)),
            1,
            abi.encode(data3)
        );
        assertEq(registry2.getResolver(data3.label), data3.resolver, "resolver3");
        checkResolution(name3, address(ensV2Resolver), data3.resolver);
        assertEq(
            registry2.ownerOf(registry2.getTokenId(LibLabel.id(data3.label))),
            data3.owner,
            "owner3"
        );
        IRegistry registry3 = registry2.getSubregistry(data3.label);
        assertTrue(
            ERC165Checker.supportsInterface(address(registry3), type(IWrapperRegistry).interfaceId),
            "registry3"
        );

        // check migrated 3LD child
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.LabelAlreadyRegistered.selector, data3.label)
        );
        vm.prank(friend);
        registry2.register(data3.label, testOwner, IRegistry(address(0)), address(0), 0, _soon());

        // check unmigrated 3LD child
        vm.expectRevert(abi.encodeWithSelector(LibMigration.NameRequiresMigration.selector));
        vm.prank(friend);
        registry2.register(
            NameCoder.firstLabel(name3unmigrated),
            friend,
            IRegistry(address(0)),
            address(0),
            0,
            _soon()
        );

        vm.prank(friend);
        nameWrapper.setResolver(NameCoder.namehash(name3unmigrated, 0), testResolver);
        checkResolution(name3unmigrated, testResolver, address(ensV1Resolver));
    }

    function test_migrate_detachedChildren_wrapped() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3 = this.createWrappedChild(name2, "sub", PARENT_CANNOT_CONTROL);
        vm.prank(friend);
        bytes memory name3unmigrated =
            this.createWrappedChild(name2, "unmigrated", PARENT_CANNOT_CONTROL);

        // migrate 2LD
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(NameCoder.namehash(name2, 0)),
            1,
            abi.encode(data2)
        );
        assertEq(
            ethRegistry.ownerOf(ethRegistry.getTokenId(LibLabel.id(data2.label))),
            data2.owner,
            "owner2"
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));
        assertTrue(
            ERC165Checker.supportsInterface(address(registry2), type(IWrapperRegistry).interfaceId),
            "registry2"
        );

        // migrate 3LD
        LibMigration.Data memory data3 = _lockedData(name3);
        data3.subregistry = testRegistry; // override
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            friend,
            address(registry2),
            uint256(NameCoder.namehash(name3, 0)),
            1,
            abi.encode(data3)
        );
        assertEq(registry2.getResolver(data3.label), data3.resolver, "resolver3");
        checkResolution(name3, address(ensV2Resolver), data3.resolver);
        assertEq(
            registry2.ownerOf(registry2.getTokenId(LibLabel.id(data3.label))),
            data3.owner,
            "owner3"
        );
        assertEq(address(registry2.getSubregistry(data3.label)), address(testRegistry), "registry3");
        assertEq(registryV1.owner(NameCoder.namehash(name3, 0)), address(graveyard), "graveyard3");

        // check migrated 3LD child
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.LabelAlreadyRegistered.selector, data3.label)
        );
        vm.prank(friend);
        registry2.register(data3.label, testOwner, IRegistry(address(0)), address(0), 0, _soon());

        // check unmigrated 3LD child
        vm.expectRevert(abi.encodeWithSelector(LibMigration.NameRequiresMigration.selector));
        vm.prank(friend);
        registry2.register(
            NameCoder.firstLabel(name3unmigrated),
            friend,
            IRegistry(address(0)),
            address(0),
            0,
            _soon()
        );

        vm.prank(friend);
        nameWrapper.setResolver(NameCoder.namehash(name3unmigrated, 0), testResolver);
        checkResolution(name3unmigrated, testResolver, address(ensV1Resolver));
    }

    function test_migrate_detachedChildren_unwrapped() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3 = this.createWrappedChild(name2, "sub", PARENT_CANNOT_CONTROL);
        bytes32 parentNode = NameCoder.namehash(name2, 0);
        bytes32 subNode = NameCoder.namehash(name3, 0);
        bytes32 subLabelHash = keccak256(bytes("sub"));

        // unwrap the emancipated child before the parent is migrated
        vm.prank(friend);
        nameWrapper.unwrap(parentNode, subLabelHash, friend);
        (address ownerAfterUnwrap, uint32 fusesAfterUnwrap, ) =
            nameWrapper.getData(uint256(subNode));
        assertEq(ownerAfterUnwrap, address(0), "wrapper owner cleared on unwrap");
        assertEq(
            fusesAfterUnwrap & PARENT_CANNOT_CONTROL,
            PARENT_CANNOT_CONTROL,
            "PCC fuse persists across burn"
        );
        assertEq(registryV1.owner(subNode), friend, "v1 registry owner is friend after unwrap");

        // migrate 2LD parent
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(parentNode),
            1,
            abi.encode(data2)
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));
        address virtualOwner = address(ethRegistry);

        // the registry itself holds ROLE_REGISTRAR on registry2 by default,
        // so they could otherwise re-register the unwrapped emancipated subname in v2
        assertTrue(
            registry2.hasRoles(
                registry2.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                virtualOwner
            ),
            "testOwner has ROLE_REGISTRAR on registry2"
        );
        vm.expectRevert(abi.encodeWithSelector(LibMigration.NameRequiresMigration.selector));
        vm.prank(testOwner);
        registry2.register("sub", testOwner, IRegistry(address(0)), address(0), 0, _soon());

        // resolver lookup falls through to v1
        assertEq(
            registry2.getResolver("sub"),
            address(ensV1Resolver),
            "unwrapped emancipated subname resolves through V1"
        );

        // legitimate subname owner can still migrate via re-wrap (preserves PCC automatically)
        vm.prank(friend);
        registryV1.setApprovalForAll(address(nameWrapper), true);
        vm.prank(friend);
        nameWrapper.wrap(name3, friend, address(0));
        (address rewrappedOwner, uint32 rewrappedFuses, ) = nameWrapper.getData(uint256(subNode));
        assertEq(rewrappedOwner, friend, "re-wrap restores wrapper ownership");
        assertEq(
            rewrappedFuses & PARENT_CANNOT_CONTROL,
            PARENT_CANNOT_CONTROL,
            "re-wrap restores PCC from preserved storage"
        );

        LibMigration.Data memory data3 = _unlockedData(name3);
        data3.owner = friend; // override
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            friend,
            address(registry2),
            uint256(subNode),
            1,
            abi.encode(data3)
        );
        assertEq(registry2.getResolver(data3.label), data3.resolver, "resolver3 after migration");
        assertEq(
            registry2.ownerOf(registry2.getTokenId(LibLabel.id(data3.label))),
            friend,
            "owner3 after migration"
        );
        assertEq(
            address(registry2.getSubregistry(data3.label)),
            address(testRegistry),
            "subregistry3 after migration"
        );
        assertEq(registryV1.owner(subNode), address(graveyard), "v1 graveyarded after migration");
    }

    function test_migrate_detachedChildren_unwrappedAndAbandoned() external {
        bytes memory name2 = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        vm.prank(friend);
        bytes memory name3 = this.createWrappedChild(name2, "sub", PARENT_CANNOT_CONTROL);
        bytes32 parentNode = NameCoder.namehash(name2, 0);
        bytes32 subNode = NameCoder.namehash(name3, 0);
        bytes32 subLabelHash = keccak256(bytes("sub"));

        // friend unwraps the emancipated child to themselves, then abandons it
        // by clearing the v1 registry record
        vm.prank(friend);
        nameWrapper.unwrap(parentNode, subLabelHash, friend);
        vm.prank(friend);
        registryV1.setOwner(subNode, address(0));
        assertEq(registryV1.owner(subNode), address(0), "v1 record cleared");
        (, uint32 fusesAfterAbandon, ) = nameWrapper.getData(uint256(subNode));
        assertEq(
            fusesAfterAbandon & PARENT_CANNOT_CONTROL,
            PARENT_CANNOT_CONTROL,
            "PCC fuse still set even after abandonment"
        );

        // migrate parent
        LibMigration.Data memory data2 = _lockedData(name2);
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(parentNode),
            1,
            abi.encode(data2)
        );
        IWrapperRegistry registry2 =
            IWrapperRegistry(address(ethRegistry.getSubregistry(data2.label)));

        // abandoned orphan must not lock the label forever — guard treats the empty
        // v1 record as relinquishment and allows fresh registration in v2
        vm.prank(testOwner);
        uint256 tokenId =
            registry2.register("sub", testOwner, IRegistry(address(0)), address(0), 0, _soon());
        assertEq(registry2.ownerOf(tokenId), testOwner, "label registered to new owner");
    }

    function test_migrate_frozenTokenApproval() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node = NameCoder.namehash(name, 0);

        // give approval
        vm.prank(testOwner);
        nameWrapper.approve(address(this), uint256(node));
        assertEq(nameWrapper.getApproved(uint256(node)), address(this), "approved");

        // freeze approval
        vm.prank(testOwner);
        nameWrapper.setFuses(node, uint16(CANNOT_APPROVE));

        LibMigration.Data memory data = _lockedData(name);
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(LibMigration.FrozenTokenApproval.selector, node)
            )
        );
        vm.prank(testOwner);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(data)
        );
    }

    function _deployWrapperRegistryProxy() internal returns (WrapperRegistry) {
        bytes memory name = NameCoder.ethName(testLabel);
        bytes32 node = NameCoder.namehash(name, 0);
        uint256 salt = uint256(node);
        address proxyAddress =
            verifiableFactory.deployProxy(
                address(wrapperRegistryImpl),
                salt,
                abi.encodeCall(
                    IWrapperRegistryInitializable.initialize,
                    (node, ethRegistry, testLabel, RegistryRolesLib.ROLE_UPGRADE)
                )
            );
        ethRegistry.register(testLabel, testOwner, IRegistry(proxyAddress), address(0), 0, _soon());
        return WrapperRegistry(proxyAddress);
    }

    function _newWrapperRegistryV2Mock() internal returns (WrapperRegistryV2Mock) {
        return
            new WrapperRegistryV2Mock(
                nameWrapper,
                address(graveyard),
                verifiableFactory,
                address(ensV1Resolver),
                registryUpgradeSet,
                labelStore,
                publicResolverSet,
                address(publicResolver),
                address(this)
            );
    }
}


contract WrapperRegistryV2Mock is WrapperRegistry {
    constructor(
        INameWrapper nameWrapper,
        address graveyard,
        IVerifiableFactory verifiableFactory,
        address ensV1Resolver,
        IAddressSet upgradeSet,
        ILabelStore labelStore,
        IAddressSet publicResolverSet,
        address publicResolver,
        address namer
    )
        WrapperRegistry(
            nameWrapper,
            graveyard,
            verifiableFactory,
            ensV1Resolver,
            upgradeSet,
            labelStore,
            publicResolverSet,
            publicResolver,
            namer
        )
    {}

    function version() public pure returns (uint256) {
        return 2;
    }
}
