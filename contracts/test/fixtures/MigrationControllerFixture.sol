// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {Graveyard} from "~src/migration/Graveyard.sol";
import {ENSV1Resolver} from "~src/resolver/ENSV1Resolver.sol";
import {ENSV2Resolver} from "~src/resolver/ENSV2Resolver.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {LibMigration} from "~src/migration/libraries/LibMigration.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {PermissionedAddressSet} from "~src/utils/PermissionedAddressSet.sol";
import {V1Fixture} from "~test/fixtures/V1Fixture.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";
import {StandardRegistrar} from "~test/StandardRegistrar.sol";

// forge test test/unit/migration/UnlockedMigrationController.t.sol -vv
// forge test test/unit/migration/LockedMigrationController.t.sol -vv

// [initial gas analysis]
// * Unwrapped: 160300
// * Unlocked: 179367
// * Locked: 658489 (~500k for VerifiedFactory => WrapperRegistry)

// [after graveyard]
// * Unwrapped: 193011 (+32K)
// * Unlocked: 183292 (+4K)
// * Locked: 665863 (+7K)

/// @dev Reusable testing fixture for migration.
contract MigrationControllerFixture is V1Fixture, V2Fixture {
    ENSV1Resolver ensV1Resolver;
    ENSV2Resolver ensV2Resolver;
    Graveyard graveyard;
    MockERC721 dummy721;
    MockERC1155 dummy1155;
    PermissionedAddressSet registryUpgradeSet;
    PermissionedAddressSet publicResolverSet;

    string testLabel = "test";
    address testResolver;
    IRegistry testRegistry = IRegistry(makeAddr("registry"));
    address premigrationController = makeAddr("premigrationController");
    uint64 premigrationBonusPeriod = StandardRegistrar.BONUS_PERIOD;

    address actor = makeAddr("actor");
    address friend = makeAddr("friend");

    function deployMigrationControllerFixture() public {
        deployV1Fixture();
        deployV2Fixture();

        ethRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW,
            premigrationController
        );

        ensV1Resolver = new ENSV1Resolver(batchGatewayProvider, contractNamer, registryV1);
        ensV2Resolver = new ENSV2Resolver(
            batchGatewayProvider,
            contractNamer,
            rootRegistry,
            address(0)
        );

        graveyard = new Graveyard(nameWrapper, contractNamer);

        registryUpgradeSet = new PermissionedAddressSet(address(this));
        publicResolverSet = new PermissionedAddressSet(address(this));

        baseRegistrar.setResolver(address(ensV2Resolver));
        baseRegistrar.addController(address(graveyard));

        dummy721 = new MockERC721();
        dummy1155 = new MockERC1155();
        testResolver = address(new MockResolver());
    }

    /// @dev Ensure premigration has occurred.
    function registerUnwrapped(string memory label)
        public
        override
        returns (bytes memory name, uint256 tokenId)
    {
        (name, tokenId) = super.registerUnwrapped(label);
        if (address(premigrationController) != address(0)) {
            vm.prank(premigrationController);
            ethRegistry.register(
                label,
                address(0), // reserve
                IRegistry(address(0)),
                address(ensV1Resolver), // fallback
                0,
                uint64(baseRegistrar.nameExpires(tokenId)) + premigrationBonusPeriod
            );
        }
    }

    /// @dev Check resolver and fallback logic.
    function checkResolution(bytes memory name, address resolverV1, address resolverV2) public view {
        assertEq(findResolverV1(name), resolverV1, "findResolverV1");
        assertEq(findResolverV2(name), resolverV2, "findResolverV2");
        if (resolverV2 == address(ensV1Resolver)) {
            (address r, ) = ensV1Resolver.getResolver(name);
            assertEq(r, resolverV1, "compositeV1");
        } else if (resolverV1 == address(ensV2Resolver)) {
            (address r, ) = ensV2Resolver.getResolver(name);
            assertEq(r, resolverV2, "compositeV2");
            assertEq(registryV1.resolver(NameCoder.namehash(name, 0)), address(0), "resolverV1");
        }
    }

    function _label(uint256 i) internal view returns (string memory) {
        return string.concat(testLabel, vm.toString(i));
    }

    function _soon() internal view returns (uint64) {
        return uint64(block.timestamp + 1000);
    }

    function _unlockedData(bytes memory name) internal view returns (LibMigration.Data memory) {
        return
            LibMigration.Data({label: NameCoder.firstLabel(name), owner: testOwner, subregistry: testRegistry, resolver: testResolver});
    }

    function _lockedData(bytes memory name) internal view returns (LibMigration.Data memory) {
        return
            LibMigration.Data({
                label: NameCoder.firstLabel(name),
                owner: nameWrapper.ownerOf(uint256(NameCoder.namehash(name, 0))),
                subregistry: IRegistry(address(0)), // ignored by LockedMigrationController
                resolver: testResolver
            });
    }
}


contract MockERC721 is ERC721 {
    uint256 _id;
    constructor() ERC721("", "") {}
    function mint(address to) external returns (uint256) {
        _mint(to, _id);
        return _id++;
    }
}


contract MockERC1155 is ERC1155 {
    uint256 _id;
    constructor() ERC1155("") {}
    function mint(address to) external returns (uint256) {
        _mint(to, _id, 1, "");
        return _id++;
    }
}


contract MockResolver {}
