// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

// solhint-disable no-console, private-vars-leading-underscore, state-visibility, func-name-mixedcase, contracts-v2/ordering, one-contract-per-file

import {Test, Vm} from "forge-std/Test.sol";

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import {LibLabel} from "~src/utils/LibLabel.sol";
import {IEnhancedAccessControl} from "~src/access-control/interfaces/IEnhancedAccessControl.sol";
import {EACBaseRolesLib} from "~src/access-control/libraries/EACBaseRolesLib.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IRegistryEvents} from "~src/registry/interfaces/IRegistryEvents.sol";
import {IOwnedRegistry} from "~src/registry/interfaces/IOwnedRegistry.sol";
import {IStandardRegistry} from "~src/registry/interfaces/IStandardRegistry.sol";
import {ITemporalRegistry} from "~src/registry/interfaces/ITemporalRegistry.sol";
import {ITokenizedRegistry} from "~src/registry/interfaces/ITokenizedRegistry.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {IRegistryURIRenderer} from "~src/registry/interfaces/IRegistryURIRenderer.sol";
import {PermissionedRegistry} from "~src/registry/PermissionedRegistry.sol";
import {LabelStore, ILabelStore} from "~src/utils/LabelStore.sol";

uint256 constant DEFAULT_ROLE_BITMAP = EACBaseRolesLib.ALL_ROLES;

contract PermissionedRegistryTest is Test, ERC1155Holder, IRegistryURIRenderer {
    MockPermissionedRegistry registry;
    LabelStore labelStore;

    address user1 = makeAddr("user1");
    address user2 = makeAddr("user2");
    address actor = makeAddr("actor");

    address testOwner = user1;
    string testLabel = "test";
    uint256 testRoles = 0;
    address testResolver = makeAddr("resolver");
    uint64 testExpiry = uint64(block.timestamp + 1000);
    IRegistry testRegistry = IRegistry(makeAddr("registry"));

    function setUp() external {
        labelStore = new LabelStore(IContractNamer(address(0)));

        vm.expectEmit();
        emit IRegistryEvents.RegistryCreated();
        registry = new MockPermissionedRegistry(labelStore, address(this), DEFAULT_ROLE_BITMAP);
    }

    function test_initForProxyImplementation() external {
        vm.expectEmit();
        emit IRegistryEvents.RegistryCreated();
        new PermissionedRegistry(labelStore, address(0), 0);
    }

    function test_constructor() external view {
        assertEq(address(registry.LABEL_STORE()), address(labelStore), "LABEL_STORE");

        assertTrue(registry.hasRootRoles(DEFAULT_ROLE_BITMAP, address(this)));
    }

    function test_supportsInterface() external view {
        assertTrue(registry.supportsInterface(type(IRegistry).interfaceId), "IRegistry");
        assertTrue(
            registry.supportsInterface(type(IStandardRegistry).interfaceId),
            "IStandardRegistry"
        );
        assertTrue(registry.supportsInterface(type(IOwnedRegistry).interfaceId), "IOwnedRegistry");
        assertTrue(
            registry.supportsInterface(type(ITokenizedRegistry).interfaceId),
            "ITokenizedRegistry"
        );
        assertTrue(
            registry.supportsInterface(type(ITemporalRegistry).interfaceId),
            "ITemporalRegistry"
        );
        assertTrue(
            registry.supportsInterface(type(IPermissionedRegistry).interfaceId),
            "IPermissionedRegistry"
        );
        assertTrue(registry.supportsInterface(type(IContractNamer).interfaceId), "IContractNamer");
    }

    ////////////////////////////////////////////////////////////////////////
    // register()
    ////////////////////////////////////////////////////////////////////////

    function test_register() external {
        uint256 labelId = LibLabel.id(testLabel);
        uint256 tokenId = LibLabel.withVersion(labelId, 0);
        vm.expectEmit();
        emit ILabelStore.Label(bytes32(labelId), testLabel);
        vm.expectEmit();
        emit IRegistryEvents.LabelRegistered(
            tokenId,
            bytes32(labelId),
            testLabel,
            testOwner,
            testExpiry,
            address(this)
        );
        vm.expectEmit();
        emit IERC1155.TransferSingle(address(this), address(0), testOwner, tokenId, 1);
        vm.expectEmit();
        emit IPermissionedRegistry.TokenResource(tokenId, tokenId);
        vm.expectEmit();
        emit IRegistryEvents.SubregistryUpdated(tokenId, testRegistry, address(this));
        vm.expectEmit();
        emit IRegistryEvents.ResolverUpdated(tokenId, testResolver, address(this));
        assertEq(this._register(), tokenId, "token");
        assertEq(registry.getExpiry(tokenId), testExpiry, "expiry");
        assertEq(registry.ownerOf(tokenId), testOwner, "owner");
        assertEq(registry.getResolver(testLabel), testResolver, "resolver");
        assertEq(address(registry.getSubregistry(testLabel)), address(testRegistry), "registry");
        assertTrue(registry.hasRoles(tokenId, testRoles, testOwner), "roles");
        assertEq(labelStore.getLabel(tokenId), testLabel, "label");
    }

    function test_register_expired() external {
        uint256 tokenId = this._register();
        vm.warp(testExpiry);
        testExpiry += testExpiry;
        this._register();
        assertEq(registry.latestOwnerOf(tokenId), address(0));
    }

    // is this needed?
    function test_register_roles(uint256) external {
        testRoles = _randomRoleBitmap(true, true);
        assertTrue(registry.hasRoles(this._register(), testRoles, testOwner));
    }

    function test_register_withNullResolver() external {
        testResolver = address(0);
        vm.recordLogs();
        this._register();
        _expectNoEmit(vm.getRecordedLogs(), IRegistryEvents.ResolverUpdated.selector);
    }

    function test_register_withNullRegistry() external {
        testRegistry = IRegistry(address(0));
        vm.recordLogs();
        this._register();
        _expectNoEmit(vm.getRecordedLogs(), IRegistryEvents.SubregistryUpdated.selector);
    }

    function test_register_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                actor
            )
        );
        vm.prank(actor);
        this._register();
        // retry with permissions
        registry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, actor);
        vm.prank(actor);
        this._register();
    }

    function test_register_cannotSetPastExpiry() external {
        vm.warp(2);
        testExpiry = uint64(block.timestamp) - 1;
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.CannotSetPastExpiry.selector, testExpiry)
        );
        this._register();
    }

    function test_register_tooShort() external {
        testLabel = "";
        vm.expectRevert(abi.encodeWithSelector(NameCoder.LabelIsEmpty.selector));
        this._register();
    }

    function test_register_tooLong() external {
        testLabel = new string(256);
        vm.expectRevert(abi.encodeWithSelector(NameCoder.LabelIsTooLong.selector, testLabel));
        this._register();
    }

    function test_register_alreadyRegistered() external {
        this._register();
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.LabelAlreadyRegistered.selector, testLabel)
        );
        this._register();
    }

    ////////////////////////////////////////////////////////////////////////
    // reserve() == register() with null owner
    ////////////////////////////////////////////////////////////////////////

    function test_reserve() external {
        uint256 labelId = LibLabel.id(testLabel);
        vm.expectEmit();
        emit ILabelStore.Label(bytes32(labelId), testLabel);
        vm.expectEmit();
        emit IRegistryEvents.LabelReserved(
            LibLabel.withVersion(labelId, 0),
            bytes32(labelId),
            testLabel,
            testExpiry,
            address(this)
        );
        uint256 tokenId = this._reserve();
        IPermissionedRegistry.State memory state = registry.getState(tokenId);
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.RESERVED), "reserved");
        assertEq(state.latestOwner, address(0), "owner");
        assertEq(state.expiry, testExpiry, "expiry");
        assertEq(registry.getResolver(testLabel), testResolver, "resolver");
        assertEq(address(registry.getSubregistry(testLabel)), address(0), "registry");
        assertEq(labelStore.getLabel(tokenId), testLabel, "label");
    }

    function test_reserve_canSetPastExpiry() external {
        vm.warp(2);
        testExpiry = 1;
        this._reserve();
    }

    function test_reserve_cannotSetPastExpiryAtGenesis() external {
        testExpiry = 0; // genesis
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.CannotSetPastExpiry.selector, testExpiry)
        );
        this._reserve();
    }

    function test_reserve_alreadyReserved() external {
        this._reserve();
        registry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, actor);
        vm.expectRevert(
            abi.encodeWithSelector(IPermissionedRegistry.LabelAlreadyReserved.selector, testLabel)
        );
        vm.prank(actor);
        this._reserve();
    }

    function test_reserve_alreadyRegistered() external {
        this._register();
        registry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_REGISTER_RESERVED,
            actor
        );
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.LabelAlreadyRegistered.selector, testLabel)
        );
        vm.prank(actor);
        this._reserve();
    }

    function test_reserve_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                actor
            )
        );
        vm.prank(actor);
        this._reserve();
        // retry with permissions
        registry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, actor);
        vm.prank(actor);
        this._reserve();
    }

    function test_reserve_withRoles() external {
        testRoles = RegistryRolesLib.ROLE_SET_RESOLVER;
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                registry.ROOT_RESOURCE(),
                testRoles,
                address(this)
            )
        );
        this._reserve();
    }

    function test_reserve_then_register() external {
        this._reserve();
        this._register();
    }

    function test_reserve_then_register_notAuthorized() external {
        this._reserve();
        registry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, actor); // insufficient
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTER_RESERVED,
                actor
            )
        );
        vm.prank(actor);
        this._register();
        // retry with permissions
        registry.grantRootRoles(RegistryRolesLib.ROLE_REGISTER_RESERVED, actor);
        vm.prank(actor);
        this._register();
    }

    ////////////////////////////////////////////////////////////////////////
    // renew()
    ////////////////////////////////////////////////////////////////////////

    function test_renew_registered() external {
        uint256 tokenId = this._register();
        ++testExpiry;
        vm.expectEmit();
        emit IRegistryEvents.ExpiryUpdated(tokenId, testExpiry, address(this));
        registry.renew(tokenId, testExpiry);
        assertEq(registry.getExpiry(tokenId), testExpiry);
    }

    function test_renew_reserved() external {
        uint256 tokenId = this._reserve();
        ++testExpiry;
        registry.renew(tokenId, testExpiry);
        assertEq(registry.getExpiry(tokenId), testExpiry);
    }

    function test_renew_available() external {
        uint256 tokenId = registry.getTokenId(LibLabel.id(testLabel));
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.LabelExpired.selector, tokenId));
        registry.renew(tokenId, testExpiry);
    }

    function test_renew_expiredReservation_asRoot() external {
        uint256 tokenId = this._reserve();
        vm.warp(testExpiry);
        testExpiry += testExpiry;

        registry.renew(tokenId, testExpiry);
        assertEq(registry.getExpiry(tokenId), testExpiry);
    }

    function test_renew_expiredRegistration_asRoot() external {
        uint256 tokenId = this._register();
        vm.warp(testExpiry);
        testExpiry += testExpiry;
        registry.renew(tokenId, testExpiry);
        assertEq(registry.getExpiry(tokenId), testExpiry);
    }

    function test_renew_expiredRegistration_asOwner() external {
        testRoles = RegistryRolesLib.ROLE_RENEW;
        uint256 tokenId = this._register();
        vm.warp(testExpiry);
        testExpiry += testExpiry;
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.LabelExpired.selector, tokenId));
        vm.prank(testOwner);
        registry.renew(tokenId, testExpiry);
    }

    function test_renew_notAuthorized() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.getResource(tokenId),
                RegistryRolesLib.ROLE_RENEW,
                actor
            )
        );
        vm.prank(actor);
        registry.renew(tokenId, testExpiry);
        // retry with permissions
        registry.grantRootRoles(RegistryRolesLib.ROLE_RENEW, actor);
        vm.prank(actor);
        registry.renew(tokenId, testExpiry);
    }

    function test_renew_cannotReduceExpiry() external {
        uint256 tokenId = this._register();
        testExpiry -= 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IStandardRegistry.CannotReduceExpiry.selector,
                testExpiry + 1,
                testExpiry
            )
        );
        registry.renew(tokenId, testExpiry);
    }

    function test_renew_self() external {
        testRoles = RegistryRolesLib.ROLE_RENEW;
        uint256 tokenId = this._register();
        vm.prank(testOwner);
        registry.renew(tokenId, testExpiry);
    }

    function test_renew_self_notAuthorized() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.getResource(tokenId),
                RegistryRolesLib.ROLE_RENEW,
                testOwner
            )
        );
        vm.prank(testOwner);
        registry.renew(tokenId, testExpiry);
        // retry with permissions
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_RENEW, actor);
        vm.prank(actor);
        registry.renew(tokenId, testExpiry);
    }

    ////////////////////////////////////////////////////////////////////////
    // unregister()
    ////////////////////////////////////////////////////////////////////////

    function test_unregister_available() external {
        uint256 tokenId = registry.getTokenId(LibLabel.id(testLabel));
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.LabelExpired.selector, tokenId));
        registry.unregister(tokenId);
    }

    function test_unregister_registered() external {
        uint256 tokenId = this._register();
        vm.expectEmit();
        emit IRegistryEvents.LabelUnregistered(tokenId, address(this));
        vm.expectEmit();
        emit IERC1155.TransferSingle(address(this), testOwner, address(0), tokenId, 1);
        registry.unregister(tokenId);
        assertEq(
            uint8(registry.getState(tokenId).status),
            uint8(IPermissionedRegistry.Status.AVAILABLE),
            "status"
        );
        assertEq(registry.ownerOf(tokenId), address(0), "owner");
        assertEq(registry.getExpiry(tokenId), block.timestamp, "expiry");
        assertEq(registry.getResolver(testLabel), address(0), "resolver");
        assertEq(address(registry.getSubregistry(testLabel)), address(0), "subregistry");
    }

    function test_unregister_reserved() external {
        uint256 tokenId = this._reserve();
        vm.recordLogs();
        vm.expectEmit();
        emit IRegistryEvents.LabelUnregistered(tokenId, address(this));
        registry.unregister(tokenId);
        _expectNoEmit(vm.getRecordedLogs(), IERC1155.TransferSingle.selector);
    }

    function test_unregister_self() external {
        testRoles = RegistryRolesLib.ROLE_UNREGISTER;
        uint256 tokenId = this._register();
        vm.prank(testOwner);
        registry.unregister(tokenId);
    }

    function test_unregister_notAuthorized() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                tokenId,
                RegistryRolesLib.ROLE_UNREGISTER,
                actor
            )
        );
        vm.prank(actor);
        registry.unregister(tokenId);
        // retry with permissions
        registry.grantRootRoles(RegistryRolesLib.ROLE_UNREGISTER, actor);
        vm.prank(actor);
        registry.unregister(tokenId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Transitions that require multiple actions
    ////////////////////////////////////////////////////////////////////////

    // REGISTERED => REGISTERED
    function test_register_then_register() external {
        uint256 tokenId = this._register();
        registry.unregister(tokenId); // #1
        this._register(); // #2
    }

    // REGISTERED => RESERVED
    function test_register_then_reserve() external {
        uint256 tokenId = this._register();
        registry.unregister(tokenId); // #1
        this._reserve(); // #2
    }

    // RESERVED => RESERVED
    function test_reserve_then_reserve() external {
        uint256 tokenId = this._reserve();
        registry.unregister(tokenId); // #1
        --testExpiry;
        this._reserve(); // #2
    }

    ////////////////////////////////////////////////////////////////////////
    // setParent() and getParent()
    ////////////////////////////////////////////////////////////////////////

    function test_setParent() external {
        vm.expectEmit();
        emit IRegistryEvents.ParentUpdated(testRegistry, testLabel, address(this));
        registry.setParent(testRegistry, testLabel);
        (IRegistry parent, string memory label) = registry.getParent();
        assertEq(address(parent), address(testRegistry), "parent");
        assertEq(label, testLabel, "label");
    }

    function test_setParent_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_SET_PARENT,
                user1
            )
        );
        vm.prank(user1);
        registry.setParent(IRegistry(address(1)), "abc");
    }

    ////////////////////////////////////////////////////////////////////////
    // setSubregistry() and getSubregistry()
    ////////////////////////////////////////////////////////////////////////

    function test_setSubregistry() external {
        testRoles = RegistryRolesLib.ROLE_SET_SUBREGISTRY;
        uint256 tokenId = this._register();
        vm.expectEmit();
        emit IRegistryEvents.SubregistryUpdated(tokenId, testRegistry, testOwner);
        vm.prank(testOwner);
        registry.setSubregistry(tokenId, testRegistry);
        vm.assertEq(address(registry.getSubregistry(testLabel)), address(testRegistry));
        vm.warp(testExpiry);
        vm.assertEq(address(registry.getSubregistry(testLabel)), address(0), "after");
    }

    function test_setSubregistry_asRoot() external {
        uint256 tokenId = this._register();
        vm.expectRevert();
        vm.prank(testOwner);
        registry.setSubregistry(tokenId, testRegistry);
        // retry with permissions
        registry.setSubregistry(tokenId, testRegistry);
    }

    function test_setSubregistry_whileReserved() external {
        uint256 tokenId = this._reserve();
        registry.setSubregistry(tokenId, testRegistry);
    }

    function test_setSubregistry_notAuthorized() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.getResource(tokenId),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY,
                testOwner
            )
        );
        vm.prank(testOwner);
        registry.setSubregistry(tokenId, testRegistry);
        // retry with permissions
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_SUBREGISTRY, testOwner);
        vm.prank(testOwner);
        registry.setSubregistry(tokenId, testRegistry);
    }

    ////////////////////////////////////////////////////////////////////////
    // setResolver() and getResolver()
    ////////////////////////////////////////////////////////////////////////

    function test_setResolver() external {
        testRoles = RegistryRolesLib.ROLE_SET_RESOLVER;
        uint256 tokenId = this._register();
        vm.recordLogs();
        vm.prank(testOwner);
        registry.setResolver(tokenId, testResolver);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "logs");
        _assertResolverUpdated(logs[0], tokenId, testResolver, testOwner);
        vm.assertEq(registry.getResolver(testLabel), testResolver, "before");
        vm.warp(testExpiry);
        vm.assertEq(registry.getResolver(testLabel), address(0), "after");
    }

    function test_setResolver_asRoot() external {
        uint256 tokenId = this._register();
        vm.expectRevert();
        vm.prank(testOwner);
        registry.setResolver(tokenId, testResolver);
        // retry with permissions
        registry.setResolver(tokenId, testResolver);
    }

    function test_setResolver_whileReserved() external {
        uint256 tokenId = this._reserve();
        registry.setResolver(tokenId, testResolver);
    }

    function test_setResolver_notAuthorized() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.getResource(tokenId),
                RegistryRolesLib.ROLE_SET_RESOLVER,
                testOwner
            )
        );
        vm.prank(testOwner);
        registry.setResolver(tokenId, testResolver);
        // retry with permissions
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, testOwner);
        vm.prank(testOwner);
        registry.setResolver(tokenId, testResolver);
    }

    ////////////////////////////////////////////////////////////////////////
    // ERC-1155 (operations require exact tokenId)
    ////////////////////////////////////////////////////////////////////////

    function test_ownerOf() external {
        assertEq(registry.ownerOf(0), address(0), "dne");
        uint256 tokenId = this._register();
        assertEq(registry.ownerOf(tokenId), testOwner, "exact");
        assertEq(registry.ownerOf(tokenId + 1), address(0), "+1");
        vm.warp(testExpiry);
        assertEq(registry.ownerOf(tokenId), address(0), "expired");
    }

    // cleared after burn
    function test_latestOwnerOf() external {
        assertEq(registry.latestOwnerOf(0), address(0), "dne");
        uint256 tokenId = this._register();
        assertEq(registry.latestOwnerOf(tokenId), testOwner, "registered");
        registry.unregister(tokenId);
        assertEq(registry.latestOwnerOf(tokenId), address(0), "unregistered");
        tokenId = this._register();
        vm.warp(testExpiry);
        assertEq(registry.latestOwnerOf(tokenId), testOwner, "expired");
    }

    function test_balanceOf() external {
        assertEq(registry.balanceOf(address(0), 0), 0, "zero");
        assertEq(
            registry.balanceOf(testOwner, LibLabel.withVersion(LibLabel.id(testLabel), 0)),
            0,
            "available"
        );
        uint256 tokenId = this._register();
        assertEq(registry.balanceOf(testOwner, tokenId), 1, "registered");
        assertEq(registry.balanceOf(testOwner, LibLabel.withVersion(tokenId, 1)), 0, "next");
        registry.unregister(tokenId);
        assertEq(registry.balanceOf(testOwner, tokenId), 0, "unregistered");
    }

    function test_balanceOfBatch() external {
        address[] memory acs = new address[](3);
        uint256[] memory ids = new uint256[](3);
        ids[0] = ids[1] = this._register();
        ids[2] = ids[0] + 1;
        acs[0] = acs[2] = testOwner;
        uint256[] memory bals = registry.balanceOfBatch(acs, ids);
        assertEq(bals[0], 1);
        assertEq(bals[1], 0, "wrong owner");
        assertEq(bals[2], 0, "wrong token");
    }

    function test_balanceOfBatch_arrayLength() external {
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidArrayLength.selector, 1, 0)
        );
        registry.balanceOfBatch(new address[](0), new uint256[](1));
    }

    function test_safeTransferFrom() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256 tokenId = this._register();
        StrictERC1155Holder r = new StrictERC1155Holder(false);
        vm.expectEmit();
        emit IERC1155.TransferSingle(user1, user1, address(r), tokenId, 1);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenId, user1, testRoles, 0); // revoke (transfer 1/2)
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenId, address(r), 0, testRoles); // grant (transfer 2/2)
        vm.prank(user1);
        registry.safeTransferFrom(user1, address(r), tokenId, 1, "");
    }

    function test_safeTransferFrom_noop() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256 tokenId = this._register();
        vm.expectEmit();
        emit IERC1155.TransferSingle(user1, user1, user2, tokenId, 0);
        vm.recordLogs();
        vm.prank(user1);
        registry.safeTransferFrom(user1, user2, tokenId, 0, "");
        _expectNoEmit(vm.getRecordedLogs(), IEnhancedAccessControl.EACRolesChanged.selector);
    }

    function test_safeTransferFrom_multiple(uint256 amount) external {
        vm.assume(amount >= 2);
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector,
                user1,
                1,
                amount,
                tokenId
            )
        );
        vm.prank(user1);
        registry.safeTransferFrom(user1, user2, tokenId, amount, "");
    }

    function test_safeTransferFrom_invalidReceiver() external {
        uint256 tokenId = this._register();
        address to; // wrong
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, to));
        vm.prank(user1);
        registry.safeTransferFrom(user1, to, tokenId, 1, "");
    }

    function test_safeTransferFrom_invalidSender() external {
        uint256 tokenId = this._register();
        address from; // wrong
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidSender.selector, from));
        vm.prank(user1);
        registry.__safeTransferFrom(from, user2, tokenId, 1, "");
    }

    function test_safeTransferFrom_missingApproval() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155MissingApprovalForAll.selector,
                user2,
                user1
            )
        );
        vm.prank(user2);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    function test_safeTransferFrom_notAuthorized() external {
        uint256 tokenId = this._register();
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenId, user1)
        );
        vm.prank(user1);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    function test_safeTransferFrom_notAuthorized_setApprovalForAll() external {
        uint256 tokenId = this._register();
        vm.prank(user1);
        registry.setApprovalForAll(user2, true);
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenId, user1)
        );
        vm.prank(user2);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    function test_safeTransferFrom_rootAuthorizedTokenWithoutRoles() external {
        // ROLE_CAN_TRANSFER_ADMIN must be on the token for the transfer to occur
        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, address(this)));
        uint256 tokenId = this._register();
        assertEq(registry.ownerOf(tokenId), user1);
        vm.prank(user1);
        registry.setApprovalForAll(address(this), true);
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenId, user1)
        );
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    function test_safeTransferFrom_rootOwnedTokenWithoutRoles() external {
        // ROLE_CAN_TRANSFER_ADMIN must be on the token for the transfer to occur
        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, address(this)));
        testOwner = address(this); // mint to account with root
        uint256 tokenId = this._register();
        assertEq(registry.roles(tokenId, address(this)), 0); // no token roles
        vm.expectRevert(
            abi.encodeWithSelector(
                IStandardRegistry.TransferDisallowed.selector,
                tokenId,
                address(this)
            )
        );
        registry.safeTransferFrom(address(this), user2, tokenId, 1, "");
    }

    function test_safeTransferFrom_rootOwnedTokenWhileExpired() external {
        // ROLE_CAN_TRANSFER_ADMIN must be on the token for the transfer to occur
        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, address(this)));
        testOwner = address(this); // mint to account with root
        uint256 tokenId = this._register();
        vm.warp(testExpiry);
        assertEq(registry.ownerOf(tokenId), address(0)); // expired
        vm.expectRevert(
            abi.encodeWithSelector(
                IStandardRegistry.TransferDisallowed.selector,
                tokenId,
                address(this)
            )
        );
        registry.safeTransferFrom(address(this), user2, tokenId, 1, "");
    }

    function test_safeBatchTransferFrom() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = this._register();
        testLabel = string.concat(testLabel, testLabel);
        tokenIds[1] = this._register();
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1;
        amounts[1] = 1;
        StrictERC1155Holder r = new StrictERC1155Holder(true);
        vm.expectEmit();
        emit IERC1155.TransferBatch(user1, user1, address(r), tokenIds, amounts);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenIds[0], user1, testRoles, 0);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenIds[0], address(r), 0, testRoles);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenIds[1], user1, testRoles, 0);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenIds[1], address(r), 0, testRoles);
        vm.prank(user1);
        registry.safeBatchTransferFrom(user1, address(r), tokenIds, amounts, "");
    }

    function test_safeBatchTransferFrom_noop() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = this._register();
        testLabel = string.concat(testLabel, testLabel);
        tokenIds[1] = this._register();
        uint256[] memory amounts = new uint256[](2);
        vm.prank(user1);
        registry.safeBatchTransferFrom(user1, user2, tokenIds, amounts, "");
    }

    function test_safeBatchTransferFrom_noopAfterTransfer() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = tokenIds[1] = this._register();
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenIds[1], user1)
        );
        vm.prank(user1);
        registry.safeBatchTransferFrom(user1, user2, tokenIds, amounts, "");
    }

    function test_safeBatchTransferFrom_twiceToSelf() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = tokenIds[1] = this._register();
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amounts[1] = 1;
        vm.prank(user1);
        registry.safeBatchTransferFrom(user1, user1, tokenIds, amounts, "");
    }

    function test_safeBatchTransferFrom_oneError() external {
        uint256[] memory tokenIds = new uint256[](2);
        tokenIds[0] = this._register(); // no transfer role
        testLabel = string.concat(testLabel, testLabel);
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        tokenIds[1] = this._register();
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1;
        amounts[1] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenIds[0], user1)
        );
        vm.prank(user1);
        registry.safeBatchTransferFrom(user1, user2, tokenIds, amounts, "");
    }

    function test_safeBatchTransferFrom_invalidReceiver() external {
        this._register();
        uint256[] memory v;
        address to; // wrong
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, to));
        vm.prank(user1);
        registry.safeBatchTransferFrom(user1, to, v, v, "");
    }

    function test_safeBatchTransferFrom_invalidSender() external {
        this._register();
        uint256[] memory v;
        address from; // wrong
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidSender.selector, from));
        vm.prank(user1);
        registry.__safeBatchTransferFrom(from, user2, v, v, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // getState()
    ////////////////////////////////////////////////////////////////////////

    function test_getState_available() external view {
        uint256 tokenId = registry.getTokenId(LibLabel.id(testLabel));
        IPermissionedRegistry.State memory state = registry.getState(tokenId);
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.AVAILABLE), "status");
        assertEq(state.expiry, 0, "expiry");
        assertEq(state.latestOwner, address(0), "owner");
        assertEq(state.tokenId, tokenId, "tokenId");
        assertEq(state.resource, tokenId + 1, "resource"); // next
        _checkStateGetters(state);
    }

    function test_getState_reserved() external {
        uint256 tokenId = this._reserve();
        IPermissionedRegistry.State memory state = registry.getState(tokenId);
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.RESERVED), "status");
        assertEq(state.expiry, testExpiry, "expiry");
        assertEq(state.latestOwner, address(0), "owner");
        assertEq(state.tokenId, tokenId, "tokenId");
        assertEq(state.resource, tokenId, "resource");
        _checkStateGetters(state);
    }

    function test_getState_registered() external {
        uint256 tokenId = this._register();
        IPermissionedRegistry.State memory state = registry.getState(tokenId);
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.REGISTERED), "status");
        assertEq(state.expiry, testExpiry, "expiry");
        assertEq(state.latestOwner, testOwner, "owner");
        assertEq(state.tokenId, tokenId, "tokenId");
        assertEq(state.resource, tokenId, "resource");
        _checkStateGetters(state);
    }

    function test_getState_expired() external {
        uint256 tokenId = this._register();
        vm.warp(testExpiry);
        IPermissionedRegistry.State memory state = registry.getState(tokenId);
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.AVAILABLE), "status");
        assertEq(state.expiry, testExpiry, "expiry");
        assertEq(state.latestOwner, testOwner, "owner");
        assertEq(state.tokenId, tokenId, "tokenId");
        assertEq(state.resource, tokenId + 1, "resource"); // next
        _checkStateGetters(state);
    }

    function test_getState_unregistered() external {
        uint256 tokenId = this._register();
        registry.unregister(tokenId);
        IPermissionedRegistry.State memory state = registry.getState(tokenId);
        assertEq(uint8(state.status), uint8(IPermissionedRegistry.Status.AVAILABLE), "status");
        assertEq(state.expiry, block.timestamp, "expiry");
        assertEq(state.latestOwner, address(0), "owner");
        assertEq(state.tokenId, tokenId + 1, "tokenId"); // burned
        assertEq(state.resource, tokenId + 2, "resource"); // next
        _checkStateGetters(state);
    }

    function _checkStateGetters(IPermissionedRegistry.State memory state) internal view {
        if (state.status != IPermissionedRegistry.Status.AVAILABLE) {
            assertEq(registry.ownerOf(state.tokenId), state.latestOwner, "ownerOf");
        }
        assertEq(registry.latestOwnerOf(state.tokenId), state.latestOwner, "latestOwnerOf");
        assertEq(registry.getExpiry(state.tokenId), state.expiry, "getExpiry");
        assertEq(registry.getTokenId(state.tokenId), state.tokenId, "getTokenId");
        assertEq(registry.getResource(state.tokenId), state.resource, "getResource");
        assertEq(uint8(registry.getStatus(state.tokenId)), uint8(state.status), "getStatus");
    }

    ////////////////////////////////////////////////////////////////////////
    // anyId
    ////////////////////////////////////////////////////////////////////////

    function test_renew_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        registry.renew(LibLabel.withVersion(tokenId, version), testExpiry + 1);
    }

    function test_unregister_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        registry.unregister(LibLabel.withVersion(tokenId, version));
    }

    function test_setSubregistry_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        registry.setSubregistry(LibLabel.withVersion(tokenId, version), testRegistry);
    }

    function test_setResolver_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        registry.setResolver(LibLabel.withVersion(tokenId, version), testResolver);
    }

    function test_getExpiry_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        assertEq(registry.getExpiry(LibLabel.withVersion(tokenId, version)), testExpiry);
    }

    function test_getOwner_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        assertEq(registry.getOwner(LibLabel.withVersion(tokenId, version)), testOwner);
    }

    function test_getStatus_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        uint256 anyId = LibLabel.withVersion(tokenId, version);
        assertEq(uint8(registry.getStatus(anyId)), uint8(IPermissionedRegistry.Status.REGISTERED));
        vm.warp(testExpiry);
        assertEq(uint8(registry.getStatus(anyId)), uint8(IPermissionedRegistry.Status.AVAILABLE));
    }

    function test_getState_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        assertEq(registry.getState(LibLabel.withVersion(tokenId, version)).tokenId, tokenId);
    }

    function test_getTokenId_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        assertEq(registry.getTokenId(LibLabel.withVersion(tokenId, version)), tokenId);
    }

    function test_getResource_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        assertEq(
            registry.getResource(LibLabel.withVersion(tokenId, version)),
            registry.getResource(tokenId)
        );
    }

    function test_getResource_rootNeverExpires() external view {
        assertEq(registry.getResource(registry.ROOT_RESOURCE()), registry.ROOT_RESOURCE());
    }

    function test_grantRoles_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        registry.grantRoles(
            LibLabel.withVersion(tokenId, version),
            RegistryRolesLib.ROLE_RENEW,
            user2
        );
    }

    function test_revokeRoles_anyId(uint32 version) external {
        uint256 tokenId = this._register();
        registry.revokeRoles(
            LibLabel.withVersion(tokenId, version),
            RegistryRolesLib.ROLE_RENEW,
            user2
        );
    }

    function test_roles_anyId(uint32 version) external {
        testRoles = EACBaseRolesLib.ALL_ROLES;
        uint256 tokenId = this._register();
        uint256 anyId = LibLabel.withVersion(tokenId, version);
        assertEq(registry.roles(anyId, testOwner), testRoles);
        vm.warp(testExpiry);
        assertEq(registry.roles(anyId, testOwner), 0);
    }

    function test_roleCount_anyId(uint32 version) external {
        testRoles = EACBaseRolesLib.ALL_ROLES;
        uint256 tokenId = this._register();
        uint256 anyId = LibLabel.withVersion(tokenId, version);
        assertEq(registry.roleCount(anyId), testRoles);
        vm.warp(testExpiry);
        assertEq(registry.roleCount(anyId), 0);
    }

    function test_hasRoles_anyId(uint32 version) external {
        testRoles = EACBaseRolesLib.ALL_ROLES;
        uint256 tokenId = this._register();
        uint256 anyId = LibLabel.withVersion(tokenId, version);
        assertTrue(registry.hasRoles(anyId, testRoles, testOwner));
        vm.warp(testExpiry);
        assertFalse(registry.hasRoles(anyId, testRoles, testOwner));
    }

    function test_hasAssignees_anyId(uint32 version) external {
        testRoles = EACBaseRolesLib.ALL_ROLES;
        uint256 tokenId = this._register();
        uint256 anyId = LibLabel.withVersion(tokenId, version);
        assertTrue(registry.hasAssignees(anyId, testRoles));
        vm.warp(testExpiry);
        assertFalse(registry.hasAssignees(anyId, testRoles));
    }

    function test_getAssigneeCount_anyId(uint32 version) external {
        testRoles = EACBaseRolesLib.ALL_ROLES;
        uint256 tokenId = this._register();
        uint256 anyId = LibLabel.withVersion(tokenId, version);
        (uint256 counts, ) = registry.getAssigneeCount(anyId, testRoles);
        assertEq(counts, testRoles);
        vm.warp(testExpiry);
        (counts, ) = registry.getAssigneeCount(anyId, testRoles);
        assertEq(counts, 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Low-level Interfaces
    ////////////////////////////////////////////////////////////////////////

    function test_findExpiry() external {
        assertEq(registry.findExpiry(testLabel), 0);
        uint256 tokenId = this._register();
        assertEq(registry.findExpiry(testLabel), testExpiry);
        registry.unregister(tokenId);
        assertEq(registry.findExpiry(testLabel), block.timestamp, "burn");
        this._register();
        assertEq(registry.findExpiry(testLabel), testExpiry, "again");
    }

    function test_findTokenId() external {
        assertEq(registry.findTokenId(testLabel), LibLabel.withVersion(LibLabel.id(testLabel), 0));
        uint256 tokenId = this._register();
        assertEq(registry.findTokenId(testLabel), tokenId);
        registry.unregister(tokenId);
        assertEq(registry.findTokenId(testLabel), tokenId + 1, "burn");
        tokenId = this._register();
        assertEq(registry.findTokenId(testLabel), tokenId, "again");
    }

    function test_findOwner() external {
        assertEq(registry.findOwner(testLabel), address(0));
        uint256 tokenId = this._register();
        assertEq(registry.findOwner(testLabel), testOwner);
        registry.unregister(tokenId);
        assertEq(registry.findOwner(testLabel), address(0), "burn");
        tokenId = this._register();
        assertEq(registry.findOwner(testLabel), testOwner, "again");
    }

    ////////////////////////////////////////////////////////////////////////
    // Token Regeneration
    ////////////////////////////////////////////////////////////////////////

    function test_burn_invalidSender() external {
        address from; // wrong
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidSender.selector, from));
        registry.__burn(from, 0, 0);
    }

    function test_regenerate_mintBurn() external {
        IPermissionedRegistry.State memory s0 = registry.getState(this._register());
        registry.unregister(s0.tokenId);
        IPermissionedRegistry.State memory s1 = registry.getState(this._register());
        registry.unregister(s1.tokenId);
        IPermissionedRegistry.State memory s2 = registry.getState(this._register());
        registry.unregister(s2.tokenId);
        assertEq(s0.tokenId + 1, s1.tokenId, "token:01");
        assertEq(s0.resource + 1, s1.resource, "resource:01");
        assertEq(s1.tokenId + 1, s2.tokenId, "token:12");
        assertEq(s1.resource + 1, s2.resource, "resource:12");
    }

    function test_regenerate_safeTransferFrom(uint256) external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN | _randomRoleBitmap(true, true);
        uint256 tokenId = this._register();
        IPermissionedRegistry.State memory s0 = registry.getState(tokenId);
        assertEq(s0.latestOwner, user1, "before:owner");
        assertTrue(registry.hasRoles(tokenId, testRoles, user1), "before:user1");
        assertFalse(registry.hasRoles(tokenId, testRoles, user2), "before:user2");
        vm.prank(user1);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
        IPermissionedRegistry.State memory s1 = registry.getState(tokenId);
        assertEq(s1.latestOwner, user2, "after:owner");
        assertFalse(registry.hasRoles(tokenId, testRoles, user1), "after:user1");
        assertTrue(registry.hasRoles(tokenId, testRoles, user2), "after:user2");
        assertEq(s0.tokenId, s1.tokenId, "token"); // unchanged
        assertEq(s0.resource, s1.resource, "resource"); // unchanged
    }

    function test_regenerate_eac() external {
        IPermissionedRegistry.State memory s0 = registry.getState(this._register());
        registry.grantRoles(s0.tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2); // regen
        IPermissionedRegistry.State memory s1 = registry.getState(s0.tokenId);
        registry.revokeRoles(s0.tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2); // regen
        IPermissionedRegistry.State memory s2 = registry.getState(s0.tokenId);
        assertEq(s0.tokenId + 1, s1.tokenId, "token:01");
        assertEq(s0.resource, s1.resource, "resource:01");
        assertEq(s0.latestOwner, s1.latestOwner, "owner:01");
        assertEq(s1.tokenId + 1, s2.tokenId, "token:12");
        assertEq(s1.resource, s2.resource, "resource:12");
        assertEq(s1.latestOwner, s2.latestOwner, "owner:12");
    }

    ////////////////////////////////////////////////////////////////////////
    // EAC Override: grantRoles() and revokeRoles()
    ////////////////////////////////////////////////////////////////////////

    function test_grantRoles_asOwner(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(false, true);

        testRoles = roleBitmap << 128; // admin
        uint256 tokenId = this._register();

        vm.expectEmit();
        emit IRegistryEvents.TokenRegenerated(tokenId, tokenId + 1);
        vm.prank(testOwner);
        assertTrue(registry.grantRoles(tokenId, roleBitmap, user2));
    }

    function test_grantRoles_asRoot(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(false, true);

        uint256 tokenId = this._register();

        assertTrue(registry.grantRoles(tokenId, roleBitmap, testOwner));
    }

    function test_grantRoles_withAdminAsOwner(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(true, false);

        uint256 tokenId = this._register();

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                tokenId, // same as resource
                roleBitmap,
                testOwner
            )
        );
        vm.prank(testOwner);
        registry.grantRoles(tokenId, roleBitmap, user2);
    }

    function test_grantRoles_withAdminAsOwnerAndRoot(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(true, false);

        testOwner = address(this); // mint to account with root
        uint256 tokenId = this._register();

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                tokenId, // same as resource
                roleBitmap,
                address(this)
            )
        );
        registry.grantRoles(tokenId, roleBitmap, user2);
    }

    function test_grantRoles_whileUnregistered(uint256 anyId) external {
        vm.assume(anyId > 0);
        uint256 roleBitmap = _randomRoleBitmap(true, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                LibLabel.withVersion(anyId, 1), // next
                roleBitmap,
                address(this)
            )
        );
        registry.grantRoles(anyId, roleBitmap, user2);
    }

    function test_grantRoles_whileExpired(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(true, true);

        uint256 tokenId = this._register();
        vm.warp(testExpiry);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                tokenId + 1, // next
                roleBitmap,
                address(this)
            )
        );
        registry.grantRoles(tokenId, roleBitmap, user2);
    }

    function test_grantRoles_whileReserved(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(true, true);

        uint256 tokenId = this._reserve();

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                tokenId, // same as resource
                roleBitmap,
                address(this)
            )
        );
        registry.grantRoles(tokenId, roleBitmap, user2);
    }

    function test_revokeRoles_asOwnerHavingAdmin(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(false, true);
        uint256 adminRoleBitmap = roleBitmap << 128;

        testRoles = adminRoleBitmap | roleBitmap; // both
        uint256 tokenId = this._register();

        // revoke normal role
        vm.expectEmit();
        emit IRegistryEvents.TokenRegenerated(tokenId, tokenId + 1);
        vm.prank(testOwner);
        assertTrue(registry.revokeRoles(tokenId, roleBitmap, testOwner));

        // revoke admin role
        vm.prank(testOwner);
        assertTrue(registry.revokeRoles(tokenId, adminRoleBitmap, testOwner));
    }

    function test_revokeRoles_asOwnerLackingAdmin(uint256) external {
        testRoles = _randomRoleBitmap(false, true);

        uint256 tokenId = this._register();

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotRevokeRoles.selector,
                tokenId, // same as resource
                testRoles,
                testOwner
            )
        );
        vm.prank(testOwner);
        registry.revokeRoles(tokenId, testRoles, testOwner);
    }

    function test_revokeRoles_asRoot(uint256) external {
        testRoles = _randomRoleBitmap(true, true);

        uint256 tokenId = this._register();

        assertTrue(registry.revokeRoles(tokenId, testRoles, testOwner));
    }

    function test_revokeRoles_whileExpired(uint256) external {
        testRoles = _randomRoleBitmap(true, true);

        uint256 tokenId = this._register();
        vm.warp(testExpiry);

        assertFalse(registry.revokeRoles(tokenId, testRoles, testOwner));
    }

    function test_revokeRoles_whileReserved(uint256) external {
        uint256 roleBitmap = _randomRoleBitmap(true, true);

        uint256 tokenId = this._reserve();

        assertFalse(registry.revokeRoles(tokenId, roleBitmap, testOwner));
    }

    ////////////////////////////////////////////////////////////////////////
    // EAC Override: setApprovalForAll()
    ////////////////////////////////////////////////////////////////////////

    function test_setApprovalForAll_invalidOperator() external {
        address to; // wrong
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidOperator.selector, to));
        registry.setApprovalForAll(to, true);
    }

    function test_setApprovalForAll_roles(uint256) external {
        testRoles = _randomRoleBitmap(true, false);
        uint256 tokenId = this._register();
        testRoles >>= 128; // convert to normal

        vm.prank(testOwner);
        registry.setApprovalForAll(user2, true);

        vm.prank(user2);
        registry.grantRoles(tokenId, testRoles, actor);
        vm.prank(user2);
        registry.revokeRoles(tokenId, testRoles, actor);
        assertEq(registry.roles(tokenId, actor), 0);

        vm.prank(testOwner);
        registry.setApprovalForAll(user2, false);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                tokenId, // same as resource
                testRoles,
                user2
            )
        );
        vm.prank(user2);
        registry.grantRoles(tokenId, testRoles, actor);
    }

    function test_setApprovalForAll_revokeRoles() external {
        testRoles = EACBaseRolesLib.ALL_ROLES;
        uint256 tokenId = this._register();

        vm.prank(testOwner);
        registry.setApprovalForAll(user2, true);

        // approval roles are aliased and not an actual assignee
        (uint256 counts, ) = registry.getAssigneeCount(tokenId, testRoles);
        assertEq(counts, EACBaseRolesLib.ALL_ROLES * 1); // not * 2
        assertEq(registry.roles(tokenId, testOwner), testRoles, "before:owner"); // real
        assertEq(registry.roles(tokenId, user2), testRoles, "before:approved"); // alias

        // cant revoke aliased roles
        vm.prank(user2);
        assertFalse(registry.revokeRoles(tokenId, testRoles, user2));

        // can revoke real roles via approval
        vm.prank(user2);
        assertTrue(registry.revokeRoles(tokenId, testRoles, testOwner));

        // since roles are aliased, revoking real roles => aliased roles
        (counts, ) = registry.getAssigneeCount(tokenId, testRoles);
        assertEq(counts, 0);
        assertEq(registry.roles(tokenId, testOwner), 0, "after:owner");
        assertEq(registry.roles(tokenId, user2), 0, "after:approved");
    }

    function test_setApprovalForAll_blendedRoles() external {
        testRoles = RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN;
        uint256 tokenId = this._register();

        // user2 has token roles via approval
        vm.prank(testOwner);
        registry.setApprovalForAll(user2, true);

        // user2 has token roles via grant
        vm.prank(testOwner);
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2);

        // user2 has root roles
        registry.grantRootRoles(RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN, user2);

        // user2 effectively has roles from all sources
        assertTrue(
            registry.hasRoles(
                tokenId,
                RegistryRolesLib.ROLE_SET_RESOLVER |
                RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
                RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN,
                user2
            )
        );
    }

    function test_setApprovalForAll_setResolver() external {
        testRoles = RegistryRolesLib.ROLE_SET_RESOLVER;
        uint256 tokenId = this._register();

        // without approval
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                tokenId, // same as resource
                testRoles,
                user2
            )
        );
        vm.prank(user2);
        registry.setResolver(tokenId, testResolver);

        vm.prank(testOwner);
        registry.setApprovalForAll(user2, true);

        // with approval
        vm.prank(user2);
        registry.setResolver(tokenId, testResolver);
    }

    function test_setApprovalForAll_setSubregistry() external {
        testRoles = RegistryRolesLib.ROLE_SET_SUBREGISTRY;
        uint256 tokenId = this._register();

        // without approval
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                tokenId, // same as resource
                testRoles,
                user2
            )
        );
        vm.prank(user2);
        registry.setSubregistry(tokenId, testRegistry);

        vm.prank(testOwner);
        registry.setApprovalForAll(user2, true);

        // with approval
        vm.prank(user2);
        registry.setSubregistry(tokenId, testRegistry);
    }

    ////////////////////////////////////////////////////////////////////////
    // IContractNamer
    ////////////////////////////////////////////////////////////////////////

    function test_isContractNamer() external {
        assertTrue(registry.isContractNamer(address(this)));

        assertFalse(registry.isContractNamer(user1), "before");
        registry.grantRootRoles(RegistryRolesLib.ROLE_CAN_NAME, user1);
        assertTrue(registry.isContractNamer(user1), "granted");
        registry.revokeRootRoles(RegistryRolesLib.ROLE_CAN_NAME, user1);
        assertFalse(registry.isContractNamer(user1), "revoked");
    }

    ////////////////////////////////////////////////////////////////////////
    // setURI(), getURI(), and uri()
    ////////////////////////////////////////////////////////////////////////

    function test_uri_unset() external view {
        assertEq(registry.uri(0), "");
        assertEq(registry.uri(1), "");
    }

    function test_getURI(string memory uri, address renderer) external {
        registry.setURI(uri, IRegistryURIRenderer(renderer));

        (string memory uri_, IRegistryURIRenderer renderer_) = registry.getURI();
        assertEq(uri_, uri, "uri");
        assertEq(address(renderer_), renderer, "renderer");
    }

    function test_setURI_onlyURI() external {
        string memory uri = "ipfs://base/{id}";
        registry.setURI(uri, IRegistryURIRenderer(address(0)));

        uint256 tokenId = this._register();
        assertEq(registry.uri(0), uri);
        assertEq(registry.uri(tokenId), uri);
    }

    // IRegistryURIRenderer
    function renderURI(IRegistry, uint256 tokenId) external pure returns (string memory) {
        return vm.toString(tokenId);
    }

    function test_setURI_withRenderer() external {
        IRegistryURIRenderer renderer = IRegistryURIRenderer(address(this)); // see: renderURI()
        registry.setURI("<ignored>", renderer);

        uint256 tokenId = this._register();
        assertEq(registry.uri(0), renderer.renderURI(registry, 0));
        assertEq(registry.uri(tokenId), renderer.renderURI(registry, tokenId));
    }

    function test_setURI_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                registry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_SET_URI,
                actor
            )
        );
        vm.prank(actor);
        registry.setURI("", IRegistryURIRenderer(address(0)));
    }

    ////////////////////////////////////////////////////////////////////////
    // Specific Cases
    ////////////////////////////////////////////////////////////////////////

    // scenerio: how to transfer a registry control
    function test_transferRegistryControl() external {
        uint256 roleBitmap = registry.roles(registry.ROOT_RESOURCE(), address(this));
        // 1. grant same roles
        registry.grantRootRoles(roleBitmap, user1);
        assertTrue(registry.hasRootRoles(roleBitmap, user1), "granted");
        assertEq(registry.roleCount(registry.ROOT_RESOURCE()), EACBaseRolesLib.ALL_ROLES * 2);
        // 2. revoke our roles
        registry.revokeRootRoles(roleBitmap, address(this));
        assertFalse(registry.hasRootRoles(roleBitmap, address(this)), "revoked");
        // 3. registry is transferred
        assertEq(registry.roleCount(registry.ROOT_RESOURCE()), EACBaseRolesLib.ALL_ROLES * 1);
    }

    // scenerio:
    // 1. user2 buys token from an exchange from user1
    // 2. user1 detects and frontruns a revoke() that cripples the token
    // 3. user2 receives crippled token => angry!
    function test_transferAbortsAfterRevoke() external {
        testRoles =
            RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN;
        uint256 tokenId = this._register();
        // make token available for sale
        vm.prank(user1);
        registry.setApprovalForAll(actor, true);
        // step #1: user2 buys token
        // => transaction detected in mempool
        // step #2: front-run
        vm.prank(user1);
        registry.revokeRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN, user1);
        // token has now regenerated
        uint256 newTokenId = registry.getTokenId(tokenId);
        assertNotEq(tokenId, newTokenId, "regen");
        // step #3: safeTransferFrom() executes and fails
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector,
                user1,
                0,
                1,
                tokenId
            )
        );
        vm.prank(actor);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    // scenerio: BET-430
    // 1. token has max assignees (15)
    // 2. transfer needs to transferRoles without blowing up
    function test_transferWithMaxAssignees() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256 tokenId = this._register();
        // step #1: fill assignees
        for (uint256 i; i <= 14; ++i) {
            registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, address(uint160(~i)));
        }
        vm.expectRevert();
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2); // => max assignees
        tokenId = registry.getTokenId(tokenId); // token has regenerated
        // step #2: transfer doesn't fail
        vm.prank(user1);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    // scenerio:
    // 1. token expires, role modification is frozen
    // 2. transfer while expired, hasRoles() still exists
    function test_transferWhileExpired() external {
        testRoles = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256 tokenId = this._register();
        // step #1: token expires
        vm.warp(testExpiry);
        // step #2: transfer while expired
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenId, user1)
        );
        vm.prank(user1);
        registry.safeTransferFrom(user1, user2, tokenId, 1, "");
    }

    // scenerio: BET-594
    // if EACRolesChanged is emit after callback execution, it is out of order
    // 1. role A is granted => regenerate
    // 2. callback triggers another action
    // 3. role B is granted => regenerate (during callback)
    // 4. EACRolesChanged is emit for B
    // 5. EACRolesChanged is emit for A
    function test_reentrantCallbackEventOrdering_grantRoles() external {
        ReentrantReceiver r = new ReentrantReceiver(registry);

        uint256 role = RegistryRolesLib.ROLE_SET_RESOLVER;

        testOwner = address(r);
        testRoles = RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN;
        uint256 tokenId = this._register();

        // make it so we grant another role during callback
        r.setReceiverCalldata(
            abi.encodeCall(PermissionedRegistry.grantRoles, (tokenId, role, actor))
        );

        // grant => burn+mint => grant again
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenId, user2, 0, role); // grant 1
        vm.expectEmit();
        emit IRegistryEvents.TokenRegenerated(tokenId, tokenId + 1);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenId, actor, 0, role); // grant 2
        vm.expectEmit();
        emit IRegistryEvents.TokenRegenerated(tokenId + 1, tokenId + 2);
        vm.prank(address(r));
        registry.grantRoles(tokenId, role, user2);
    }

    // same as above except for revoke
    function test_reentrantCallbackEventOrdering_revokeRoles() external {
        ReentrantReceiver r = new ReentrantReceiver(registry);

        uint256 role1 = RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;
        uint256 role2 = RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN;

        testOwner = address(r);
        testRoles = role1 | role2;
        uint256 tokenId = this._register();

        // make it so we revoke another role during callback
        r.setReceiverCalldata(
            abi.encodeCall(PermissionedRegistry.revokeRoles, (tokenId, role2, testOwner))
        );

        // revoke => burn+mint => revoke again
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenId, testOwner, testRoles, role2); // revoke 1
        vm.expectEmit();
        emit IRegistryEvents.TokenRegenerated(tokenId, tokenId + 1);
        vm.expectEmit();
        emit IEnhancedAccessControl.EACRolesChanged(tokenId, testOwner, role2, 0); // revoke 2
        vm.expectEmit();
        emit IRegistryEvents.TokenRegenerated(tokenId + 1, tokenId + 2);
        vm.prank(testOwner);
        registry.revokeRoles(tokenId, role1, testOwner);
    }

    // scenerio: emanicipation concern: root can revoke token
    function test_rootRevokeToken(uint8 role) external {
        vm.assume(role >= 32 && role < 64);
        testRoles = 1 << (role << 2); // every admin role
        uint256 tokenId = this._register();
        assertTrue(registry.revokeRoles(tokenId, testRoles, testOwner));
    }

    ////////////////////////////////////////////////////////////////////////
    // Internals
    ////////////////////////////////////////////////////////////////////////

    // only changes on burn, grant, or revoke
    function test_tokenVersionId() external {
        uint256 tokenId = LibLabel.id(testLabel);
        assertEq(registry.getEntry(tokenId).tokenVersionId, 0, "dne");
        tokenId = this._register();
        assertEq(registry.getEntry(tokenId).tokenVersionId, 0, "register");
        vm.warp(testExpiry);
        testExpiry += testExpiry;
        assertEq(registry.getEntry(tokenId).tokenVersionId, 0, "expired");
        tokenId = this._register(); // here
        assertEq(registry.getEntry(tokenId).tokenVersionId, 1, "reregister");
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2); // here
        assertEq(registry.getEntry(tokenId).tokenVersionId, 2, "grant");
        registry.revokeRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2); // here
        assertEq(registry.getEntry(tokenId).tokenVersionId, 3, "revoke");
        registry.unregister(tokenId); // here
        assertEq(registry.getEntry(tokenId).tokenVersionId, 4, "unregistered");
    }

    // only changes after burn
    function test_eacVersionId() external {
        uint256 tokenId = LibLabel.id(testLabel);
        assertEq(registry.getEntry(tokenId).eacVersionId, 0, "dne");
        tokenId = this._register();
        assertEq(registry.getEntry(tokenId).eacVersionId, 0, "register");
        vm.warp(testExpiry);
        testExpiry += testExpiry;
        assertEq(registry.getEntry(tokenId).eacVersionId, 0, "expired");
        tokenId = this._register(); // here
        assertEq(registry.getEntry(tokenId).eacVersionId, 1, "reregister");
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2);
        assertEq(registry.getEntry(tokenId).eacVersionId, 1, "grant");
        registry.revokeRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user2);
        assertEq(registry.getEntry(tokenId).eacVersionId, 1, "revoke");
        registry.unregister(tokenId); // here
        assertEq(registry.getEntry(tokenId).eacVersionId, 2, "unregistered");
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _register() external returns (uint256) {
        vm.prank(msg.sender); // propagate
        return
            registry.register(
                testLabel,
                testOwner,
                testRegistry,
                testResolver,
                testRoles,
                testExpiry
            );
    }

    function _reserve() external returns (uint256) {
        vm.prank(msg.sender); // propagate
        return
            registry.register(
                testLabel,
                address(0),
                IRegistry(address(0)),
                testResolver,
                testRoles,
                testExpiry
            );
    }

    function _expectNoEmit(Vm.Log[] memory logs, bytes32 topic0) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            assertNotEq(logs[i].topics[0], topic0, "found unexpected event");
        }
    }

    function _assertResolverUpdated(
        Vm.Log memory log,
        uint256 tokenId,
        address resolver,
        address sender
    )
        internal
        pure
    {
        assertEq(log.topics.length, 4, "topic count");
        assertEq(log.topics[0], IRegistryEvents.ResolverUpdated.selector, "topic0");
        assertEq(log.topics[1], bytes32(tokenId), "tokenId");
        assertEq(log.topics[2], bytes32(uint256(uint160(resolver))), "resolver");
        assertEq(log.topics[3], bytes32(uint256(uint160(sender))), "sender");
        assertEq(log.data.length, 0, "data");
    }

    /// @dev Randomly pick a role corresponding to the enable regions.
    //       If both regions are enabled, pick 1-2 roles.
    function _randomRoleBitmap(bool admin, bool normal) internal returns (uint256 roleBitmap) {
        if (admin && normal) {
            roleBitmap = 1 << (vm.randomUint(0, 63) << 2);
            if (vm.randomBool()) {
                roleBitmap |= 1 << (vm.randomUint(0, 63) << 2);
            }
        } else if (normal) {
            roleBitmap = 1 << (vm.randomUint(0, 31) << 2);
        } else if (admin) {
            roleBitmap = 1 << (vm.randomUint(32, 63) << 2);
        } else {
            revert("bug");
        }
    }
}


contract MockPermissionedRegistry is PermissionedRegistry {
    constructor(ILabelStore labelStore, address rootAccount, uint256 roleBitmap)
        PermissionedRegistry(labelStore, rootAccount, roleBitmap)
    {}
    function getEntry(uint256 anyId) external view returns (PermissionedRegistry.Entry memory) {
        return _entry(anyId);
    }
    function __safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    )
        external
    {
        _safeTransferFrom(from, to, id, value, data);
    }
    function __safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    )
        external
    {
        _safeBatchTransferFrom(from, to, ids, values, data);
    }
    function __burn(address from, uint256 id, uint256 value) external {
        _burn(from, id, value);
    }
}


contract ReentrantReceiver is ERC1155Holder {
    PermissionedRegistry immutable REGISTRY;
    bytes _data;
    constructor(PermissionedRegistry registry) {
        REGISTRY = registry;
    }
    function setReceiverCalldata(bytes calldata data) external {
        _data = data;
    }
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes memory data
    )
        public
        override
        returns (bytes4)
    {
        if (from == address(0)) {
            // during mint(), eg. token regeneration(), mutate the registry
            bytes memory v = _data;
            if (v.length > 0) {
                delete _data; // consume calldata
                bool ok;
                (ok, v) = address(REGISTRY).call(v); // execute it
                if (!ok) {
                    assembly {
                        revert(add(v, 32), mload(v)) // propagate
                    }
                }
            }
        }
        return super.onERC1155Received(operator, from, id, value, data);
    }
}


contract StrictERC1155Holder is ERC1155Holder {
    bool immutable BATCH;
    constructor(bool batch) {
        BATCH = batch;
    }
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes memory data
    )
        public
        override
        returns (bytes4)
    {
        require(!BATCH);
        return super.onERC1155Received(operator, from, id, value, data);
    }
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    )
        public
        override
        returns (bytes4)
    {
        require(BATCH);
        return super.onERC1155BatchReceived(operator, from, ids, values, data);
    }
}
