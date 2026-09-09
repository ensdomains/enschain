// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

// solhint-disable no-console, private-vars-leading-underscore, state-visibility, func-name-mixedcase, contracts-v2/ordering, one-contract-per-file

import {console} from "forge-std/console.sol";

import {CAN_DO_EVERYTHING, CANNOT_UNWRAP} from "@ens/contracts/wrapper/INameWrapper.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {InvalidOwner, UnauthorizedCaller} from "~src/CommonErrors.sol";
import {WrappedErrorLib} from "~src/utils/WrappedErrorLib.sol";
import {LibLabel} from "~src/utils/LibLabel.sol";
import {LibMigration} from "~src/migration/libraries/LibMigration.sol";
import {IEnhancedAccessControl} from "~src/access-control/EnhancedAccessControl.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IRegistryEvents} from "~src/registry/interfaces/IRegistryEvents.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {REGISTRATION_ROLE_BITMAP} from "~src/registrar/ETHRegistrar.sol";
import {UnlockedMigrationController} from "~src/migration/UnlockedMigrationController.sol";
import {
    MigrationControllerFixture,
    MockResolver
} from "~test/fixtures/MigrationControllerFixture.sol";

contract UnlockedMigrationControllerTest is MigrationControllerFixture {
    UnlockedMigrationController migrationController;

    function setUp() external {
        deployMigrationControllerFixture();

        migrationController = new UnlockedMigrationController(
            nameWrapper,
            address(graveyard),
            ethRegistry,
            contractNamer
        );
        ethRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTER_RESERVED,
            address(migrationController)
        );
    }

    function test_constructor() external view {
        assertEq(address(migrationController.NAME_WRAPPER()), address(nameWrapper), "NAME_WRAPPER");
        assertEq(address(migrationController.GRAVEYARD()), address(graveyard), "GRAVEYARD");
        assertEq(address(migrationController.ETH_REGISTRY()), address(ethRegistry), "ETH_REGISTRY");
        assertEq(
            address(migrationController.CONTRACT_NAMER()),
            address(contractNamer),
            "CONTRACT_NAMER"
        );
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(migrationController),
                type(IERC1155Receiver).interfaceId
            ),
            "IERC1155Receiver"
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(migrationController),
                type(IERC721Receiver).interfaceId
            ),
            "IERC721Receiver"
        );
    }

    function test_onERC721Received_unauthorizedCaller() external {
        vm.expectRevert(abi.encodeWithSelector(UnauthorizedCaller.selector, actor));
        vm.prank(actor);
        migrationController.onERC721Received(address(0), address(0), 1, "");
    }

    function test_onERC721Received_invalidData() external {
        vm.expectRevert(abi.encodeWithSelector(LibMigration.InvalidData.selector));
        vm.prank(address(baseRegistrar));
        migrationController.onERC721Received(address(0), address(0), 1, "");
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

    function test_finishERC1155Migration_unauthorizedCaller() external {
        vm.expectRevert(abi.encodeWithSelector(UnauthorizedCaller.selector, actor));
        vm.prank(actor);
        migrationController.finishERC1155Migration(new uint256[](0), new LibMigration.Data[](0));
    }

    function test_unwrapped_safeTransferFrom_unauthorizedCaller() external {
        uint256 tokenId = dummy721.mint(actor);
        vm.expectRevert(abi.encodeWithSelector(UnauthorizedCaller.selector, dummy721));
        vm.prank(actor);
        dummy721.safeTransferFrom(actor, address(migrationController), tokenId); // wrong
    }

    function test_wrapped_safeTransferFrom_unauthorizedCaller() external {
        uint256 tokenId = dummy1155.mint(actor);
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(UnauthorizedCaller.selector, dummy1155))
        );
        vm.prank(actor);
        dummy1155.safeTransferFrom(actor, address(migrationController), tokenId, 1, ""); // wrong
    }

    function test_unwrapped_invalidData(bytes calldata v) external {
        vm.assume(v.length < LibMigration.MIN_DATA_SIZE);
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        vm.expectRevert(abi.encodeWithSelector(LibMigration.InvalidData.selector));
        vm.prank(testOwner);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            v // wrong
        );
    }

    function test_wrapped_invalidData(bytes calldata v) external {
        vm.assume(v.length < LibMigration.MIN_DATA_SIZE);
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
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

    function test_wrapped_invalidArrayLength() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        LibMigration.Data[] memory mds = new LibMigration.Data[](1);
        ids[0] = uint256(NameCoder.namehash(name, 0));
        mds[0] = _unlockedData(name);
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

    function test_unwrapped_invalidOwner() external {
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);
        md.owner = address(0); // wrong
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector));
        vm.prank(testOwner);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );
    }

    function test_wrapped_invalidOwner() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        LibMigration.Data memory md = _unlockedData(name);
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

    function test_unwrapped_invalidReceiver() external {
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);
        md.owner = address(ethRegistry); // not a IERC1155Receiver
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, md.owner)
        );
        vm.prank(testOwner);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );
    }

    function test_wrapped_invalidReceiver() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        LibMigration.Data memory md = _unlockedData(name);
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

    function test_unwrapped_nameDataMismatch() external {
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);
        md.label = "wrong";
        vm.expectRevert(abi.encodeWithSelector(LibMigration.NameDataMismatch.selector, tokenIdV1));
        vm.prank(testOwner);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );
    }

    function test_wrapped_nameDataMismatch() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _unlockedData(name);
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

    function test_wrapped_nameIsLocked() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CANNOT_UNWRAP);
        bytes32 node = NameCoder.namehash(name, 0);
        LibMigration.Data memory md = _unlockedData(name);
        vm.expectRevert(
            WrappedErrorLib.wrap(abi.encodeWithSelector(LibMigration.NameIsLocked.selector, node))
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

    function test_unwrapped_notReserved() external {
        premigrationController = address(0); // disable premigration
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ethRegistry.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                address(migrationController)
            )
        );
        vm.prank(testOwner);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );
    }

    function test_wrapped_notReserved() external {
        premigrationController = address(0); // disable premigration
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        LibMigration.Data memory md = _unlockedData(name);
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
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);

        assertFalse(ethRegistry.hasRoles(tokenIdV1, RegistryRolesLib.ROLE_WAS_RESERVED, testOwner));

        vm.prank(testOwner);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );

        assertTrue(ethRegistry.hasRoles(tokenIdV1, RegistryRolesLib.ROLE_WAS_RESERVED, testOwner));
    }

    function test_unwrapped_migrate() external {
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);
        uint256 tokenId = LibLabel.withVersion(tokenIdV1, 0);
        uint64 expectedExpiry =
            uint64(baseRegistrar.nameExpires(tokenIdV1)) + premigrationBonusPeriod;
        vm.expectEmit();
        emit IERC721.Transfer(testOwner, address(migrationController), tokenIdV1);
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
            REGISTRATION_ROLE_BITMAP | RegistryRolesLib.ROLE_WAS_RESERVED
        );
        vm.expectEmit();
        emit IRegistryEvents.SubregistryUpdated(
            tokenId,
            IRegistry(md.subregistry),
            address(migrationController)
        );
        vm.expectEmit();
        emit IRegistryEvents.ResolverUpdated(tokenId, md.resolver, address(migrationController));
        vm.prank(testOwner);
        uint256 g = gasleft();
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );
        console.log("Gas: %s", g - gasleft());

        assertEq(ethRegistry.getTokenId(tokenIdV1), tokenId, "tokenId");
        assertEq(ethRegistry.ownerOf(tokenId), md.owner, "owner");
        assertEq(ethRegistry.getExpiry(tokenId), expectedExpiry, "expiry");
        assertEq(ethRegistry.getResolver(md.label), md.resolver, "resolver");
        checkResolution(name, address(ensV2Resolver), md.resolver);
        assertEq(
            address(ethRegistry.getSubregistry(md.label)),
            address(md.subregistry),
            "subregistry"
        );
        assertEq(registryV1.resolver(NameCoder.namehash(name, 0)), address(0), "resolverV1");
        assertEq(registryV1.owner(NameCoder.namehash(name, 0)), address(graveyard), "graveyard");
    }

    function test_wrapped_migrate() external {
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        LibMigration.Data memory md = _unlockedData(name);
        uint256 tokenIdV1 = LibLabel.id(md.label);
        uint256 tokenId = LibLabel.withVersion(tokenIdV1, 0);
        uint64 expectedExpiry =
            uint64(baseRegistrar.nameExpires(tokenIdV1)) + premigrationBonusPeriod;
        bytes32 node = NameCoder.namehash(name, 0);
        vm.expectEmit();
        emit IERC1155.TransferSingle(
            testOwner,
            testOwner,
            address(migrationController),
            uint256(node),
            1
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
            REGISTRATION_ROLE_BITMAP | RegistryRolesLib.ROLE_WAS_RESERVED
        );
        vm.expectEmit();
        emit IRegistryEvents.SubregistryUpdated(
            tokenId,
            IRegistry(md.subregistry),
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
        assertEq(
            address(ethRegistry.getSubregistry(md.label)),
            address(md.subregistry),
            "subregistry"
        );
        assertEq(registryV1.resolver(node), address(0), "resolverV1");
        assertEq(registryV1.owner(NameCoder.namehash(name, 0)), address(graveyard), "graveyard");
    }

    function test_unwrapped_migrateViaApproval(bool all) external {
        (bytes memory name, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        LibMigration.Data memory md = _unlockedData(name);

        // give friend approval
        vm.prank(testOwner);
        if (all) {
            baseRegistrar.setApprovalForAll(friend, true);
        } else {
            baseRegistrar.approve(friend, tokenIdV1);
        }

        // friend initiates migration
        vm.prank(friend);
        baseRegistrar.safeTransferFrom(
            testOwner,
            address(migrationController),
            tokenIdV1,
            abi.encode(md)
        );

        uint256 tokenId = ethRegistry.getTokenId(LibLabel.id(md.label));
        assertEq(ethRegistry.ownerOf(tokenId), md.owner, "owner");
    }

    function test_wrapped_migrateViaApproval() external {
        /* bool all */
        bytes memory name = registerWrappedETH2LD(testLabel, CAN_DO_EVERYTHING);
        LibMigration.Data memory md = _unlockedData(name);
        bytes32 node = NameCoder.namehash(name, 0);

        // give friend approval
        vm.prank(testOwner);
        // if (all) {
        nameWrapper.setApprovalForAll(friend, true);

        // } else {
        //     nameWrapper.approve(friend, uint256(node));
        // }
        // see: V1Fixture.t.sol: `test_nameWrapper_approveBug()`

        // friend initiates migration
        vm.prank(friend);
        nameWrapper.safeTransferFrom(
            testOwner,
            address(migrationController),
            uint256(node),
            1,
            abi.encode(md)
        );

        uint256 tokenId = ethRegistry.getTokenId(LibLabel.id(md.label));
        assertEq(ethRegistry.ownerOf(tokenId), md.owner, "owner");
    }

    function test_wrapped_migrateBatch(uint8 count) external {
        vm.assume(count < 5);
        uint256[] memory ids = new uint256[](count);
        uint256[] memory amounts = new uint256[](count);
        address[] memory resolvers = new address[](count);
        LibMigration.Data[] memory mds = new LibMigration.Data[](count);
        for (uint256 i; i < count; ++i) {
            testDuration = uint64(vm.randomUint(1, 1000 days));
            bytes memory name = registerWrappedETH2LD(_label(i), CAN_DO_EVERYTHING);
            LibMigration.Data memory md = _unlockedData(name);
            resolvers[i] = md.resolver = address(new MockResolver());
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
            LibMigration.Data memory md = mds[i];
            uint256 tokenIdV1 = LibLabel.id(md.label);
            uint256 tokenId = ethRegistry.getTokenId(tokenIdV1);
            assertEq(ethRegistry.ownerOf(tokenId), md.owner, "owner");
            assertEq(
                ethRegistry.getExpiry(tokenId),
                baseRegistrar.nameExpires(tokenIdV1) + premigrationBonusPeriod,
                "expiry"
            );
            assertEq(ethRegistry.getResolver(md.label), md.resolver, "resolver");
            checkResolution(NameCoder.ethName(md.label), address(ensV2Resolver), resolvers[i]);
            assertEq(
                address(ethRegistry.getSubregistry(md.label)),
                address(md.subregistry),
                "subregistry"
            );
        }
    }

    function test_wrapped_migrateBatch_lastOneWrong(uint8 count) external {
        vm.assume(count > 1 && count < 5);
        uint256[] memory ids = new uint256[](count);
        uint256[] memory amounts = new uint256[](count);
        LibMigration.Data[] memory mds = new LibMigration.Data[](count);
        for (uint256 i; i < count; ++i) {
            bytes memory name =
                registerWrappedETH2LD(_label(i), i == count - 1 ? CANNOT_UNWRAP : CAN_DO_EVERYTHING);
            LibMigration.Data memory md = _unlockedData(name);
            mds[i] = md;
            ids[i] = uint256(NameCoder.namehash(name, 0));
            amounts[i] = 1;
        }
        vm.expectRevert(
            WrappedErrorLib.wrap(
                abi.encodeWithSelector(LibMigration.NameIsLocked.selector, ids[count - 1])
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
}
