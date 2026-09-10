// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

// solhint-disable no-console, private-vars-leading-underscore, state-visibility, func-name-mixedcase, contracts-v2/ordering, one-contract-per-file

import {Test} from "forge-std/Test.sol";

import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {IProxyAuthorization} from "@ensdomains/verifiable-factory/IProxyAuthorization.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {InvalidOwner} from "~src/CommonErrors.sol";
import {EACBaseRolesLib} from "~src/access-control/EnhancedAccessControl.sol";
import {IEnhancedAccessControl} from "~src/access-control/interfaces/IEnhancedAccessControl.sol";
import {
    IEACGrantInitializable,
    Grant
} from "~src/access-control/interfaces/IEACGrantInitializable.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IRegistryEvents} from "~src/registry/interfaces/IRegistryEvents.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {UserRegistry} from "~src/registry/UserRegistry.sol";
import {LabelStore, ILabelStore} from "~src/utils/LabelStore.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";

contract UserRegistryTest is Test, ERC1155Holder {
    // Contracts
    VerifiableFactory factory;
    LabelStore labelStore;
    UserRegistry implementation;
    UserRegistry proxy;

    // Test accounts
    address admin = makeAddr("admin");
    address user1 = makeAddr("user1");
    address user2 = makeAddr("user2");

    function setUp() public {
        factory = new VerifiableFactory();
        labelStore = new LabelStore(IContractNamer(address(0)));

        // Deploy the implementation
        vm.expectEmit();
        emit IRegistryEvents.RegistryCreated();
        implementation = new UserRegistry(labelStore, address(this));

        // Create initialization data
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(admin, EACBaseRolesLib.ALL_ROLES);

        // Deploy the proxy using the factory
        bytes memory initData = abi.encodeCall(IEACGrantInitializable.initialize, (grants));
        vm.expectEmit();
        emit IRegistryEvents.RegistryCreated();
        vm.prank(admin);
        proxy = UserRegistry(
            factory.deployProxy(address(implementation), uint256(keccak256(initData)), initData)
        );
    }

    function test_implementationIsNameable() external view {
        assertTrue(implementation.isContractNamer(address(this)));
    }

    function test_initialize_unowned() external {
        bytes memory initData = abi.encodeCall(IEACGrantInitializable.initialize, (new Grant[](0)));
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector));
        factory.deployProxy(address(implementation), uint256(keccak256(initData)), initData);
    }

    function test_initialize_with_grants() external {
        Grant[] memory grants = new Grant[](3);
        grants[0] = Grant(admin, EACBaseRolesLib.ALL_ROLES);
        grants[1] = Grant(user1, EACBaseRolesLib.ALL_ROLES >> 128);
        grants[2] = Grant(user2, 1);

        bytes memory initData = abi.encodeCall(IEACGrantInitializable.initialize, (grants));
        UserRegistry r =
            UserRegistry(
                factory.deployProxy(address(implementation), uint256(keccak256(initData)), initData)
            );

        for (uint256 i; i < grants.length; ++i) {
            assertEq(r.roles(r.ROOT_RESOURCE(), grants[i].account), grants[i].roleBitmap);
        }
    }

    function test_initialization() public view {
        // Verify the proxy was deployed correctly
        assertEq(
            factory.verifyContract(address(proxy)),
            address(implementation),
            "Proxy should be verified"
        );

        // Verify admin has the expected roles
        assertTrue(
            proxy.hasRootRoles(RegistryRolesLib.ROLE_UPGRADE, admin),
            "Admin should have upgrade role"
        );
        assertTrue(
            proxy.hasRootRoles(RegistryRolesLib.ROLE_UPGRADE_ADMIN, admin),
            "Admin should have upgrade admin role"
        );
        assertTrue(
            proxy.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, admin),
            "Admin should have registrar role"
        );

        // Verify other users don't have roles
        assertFalse(
            proxy.hasRootRoles(RegistryRolesLib.ROLE_UPGRADE, user1),
            "User1 should not have upgrade role"
        );
        assertFalse(
            proxy.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, user1),
            "User1 should not have registrar role"
        );
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(address(proxy), type(IRegistry).interfaceId),
            "IRegistry"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(proxy), type(IProxyAuthorization).interfaceId),
            "IProxyAuthorization"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(proxy), type(IEACGrantInitializable).interfaceId),
            "IEACGrantInitializable"
        );
    }

    function test_domain_registration() public {
        // Set up a domain name to register
        string memory label = "tanrikulu";

        // Register a domain as admin
        vm.prank(admin);
        uint256 tokenId =
            proxy.register(
                label,
                user1,
                IRegistry(address(0)),
                address(0),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
                uint64(block.timestamp + 365 days)
            );

        // Verify the domain was registered correctly
        assertEq(proxy.ownerOf(tokenId), user1, "Domain should be owned by user1");

        // Verify roles were granted to the owner
        assertTrue(
            proxy.hasRoles(tokenId, RegistryRolesLib.ROLE_SET_SUBREGISTRY, user1),
            "User1 should have SET_SUBREGISTRY role"
        );
        assertTrue(
            proxy.hasRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, user1),
            "User1 should have SET_RESOLVER role"
        );

        // Verify the domain resolves correctly
        assertEq(
            address(proxy.getSubregistry(label)),
            address(0),
            "Subregistry should be zero address"
        );
        assertEq(proxy.getResolver(label), address(0), "Resolver should be zero address");
    }

    function test_domain_management() public {
        // Register a domain
        vm.prank(admin);
        uint256 tokenId =
            proxy.register(
                "mdtdomain",
                user1,
                IRegistry(address(0)),
                address(0),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
                uint64(block.timestamp + 365 days)
            );

        // User1 sets a resolver
        address resolver = address(0x123);
        vm.prank(user1);
        proxy.setResolver(tokenId, resolver);

        // Verify resolver was set
        assertEq(proxy.getResolver("mdtdomain"), resolver, "Resolver should be set");

        // User1 sets a subregistry
        vm.prank(user1);
        proxy.setSubregistry(tokenId, IRegistry(address(0x456)));

        // Verify subregistry was set
        assertEq(
            address(proxy.getSubregistry("mdtdomain")),
            address(0x456),
            "Subregistry should be set"
        );
    }

    function test_role_management() public {
        // Admin grants ROLE_REGISTRAR to user1
        vm.prank(admin);
        proxy.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, user1);

        // Verify user1 has ROLE_REGISTRAR
        assertTrue(
            proxy.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, user1),
            "User1 should have registrar role"
        );

        // User1 should be able to register domains now
        vm.prank(user1);
        uint256 tokenId =
            proxy.register(
                "user1domain",
                user2,
                IRegistry(address(0)),
                address(0),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
                uint64(block.timestamp + 365 days)
            );

        // Verify registration was successful
        assertEq(proxy.ownerOf(tokenId), user2, "Domain should be owned by user2");
    }

    function test_Revert_unauthorized_registration() public {
        // User1 tries to register a domain without ROLE_REGISTRAR
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                implementation.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                user1
            )
        );
        vm.prank(user1);
        proxy.register(
            "unauthorizeddomain",
            user1,
            IRegistry(address(0)),
            address(0),
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
            uint64(block.timestamp + 365 days)
        );
    }

    function test_Revert_unauthorized_role_grant() public {
        // User1 tries to grant roles without permission
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                implementation.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_REGISTRAR,
                user1
            )
        );
        vm.prank(user1);
        proxy.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, user2);
    }

    function testFuzz_domain_registration(string memory label, uint64 duration) public {
        // Skip empty labels and ensure reasonable duration
        vm.assume(bytes(label).length > 0 && bytes(label).length <= 255);
        duration = uint64(bound(duration, 1 days, 10 * 365 days));

        uint64 expires = uint64(block.timestamp) + duration;

        // Register a domain as admin
        vm.prank(admin);
        uint256 tokenId =
            proxy.register(
                label,
                user1,
                IRegistry(address(0)),
                address(0),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
                expires
            );

        // Verify registration
        assertEq(proxy.ownerOf(tokenId), user1, "Domain should be owned by user1");
        assertEq(proxy.getExpiry(tokenId), expires, "Expiry should match");
    }

    // Test for contract upgradeability
    function test_upgrade() public {
        // Deploy a new implementation
        UserRegistryV2Mock newImplementation = new UserRegistryV2Mock(labelStore, address(this));

        // Upgrade the proxy
        vm.prank(admin);
        proxy.upgradeToAndCall(address(newImplementation), "");

        // Test the new functionality
        UserRegistryV2Mock upgradedProxy = UserRegistryV2Mock(address(proxy));
        assertEq(upgradedProxy.version(), 2, "Version should be 2 after upgrade");
    }

    function test_Revert_unauthorized_upgrade() public {
        // Deploy a new implementation
        UserRegistryV2Mock newImplementation = new UserRegistryV2Mock(labelStore, address(this));

        // User1 tries to upgrade without permission
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                implementation.ROOT_RESOURCE(),
                RegistryRolesLib.ROLE_UPGRADE,
                user1
            )
        );
        vm.prank(user1);
        proxy.upgradeToAndCall(address(newImplementation), "");
    }

    function test_domain_expiry() public {
        // Register a domain with short expiry
        vm.prank(admin);
        uint256 tokenId =
            proxy.register(
                "expiredomain",
                user1,
                IRegistry(address(0)),
                address(0),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
                uint64(block.timestamp + 1 days)
            );

        // Verify it exists
        assertEq(proxy.ownerOf(tokenId), user1, "Domain should be owned by user1");

        // Advance time past expiry
        vm.warp(block.timestamp + 2 days);

        // Verify domain is expired
        assertEq(proxy.ownerOf(tokenId), address(0), "Expired domain should have no owner");
        assertEq(
            address(proxy.getSubregistry("expiredomain")),
            address(0),
            "Expired domain should have no subregistry"
        );

        // Should be able to register it again
        vm.prank(admin);
        uint256 newTokenId =
            proxy.register(
                "expiredomain",
                user2,
                IRegistry(address(0)),
                address(0),
                RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
                uint64(block.timestamp + 1 days)
            );

        // Verify new registration
        assertEq(proxy.ownerOf(newTokenId), user2, "Domain should be owned by user2");
    }
}


// Mock V2 contract for testing upgrades
contract UserRegistryV2Mock is UserRegistry {
    constructor(ILabelStore labelStore, address namer) UserRegistry(labelStore, namer) {}

    function version() public pure returns (uint256) {
        return 2;
    }
}
