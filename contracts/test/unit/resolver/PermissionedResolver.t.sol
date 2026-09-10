// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IProxyAuthorization} from "@ensdomains/verifiable-factory/IProxyAuthorization.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {
    ENSIP19,
    CHAIN_ID_ETH,
    COIN_TYPE_ETH,
    COIN_TYPE_DEFAULT
} from "@ens/contracts/utils/ENSIP19.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";
import {IMulticallable} from "@ens/contracts/resolvers/IMulticallable.sol";
import {IABIResolver} from "@ens/contracts/resolvers/profiles/IABIResolver.sol";
import {IAddressResolver} from "@ens/contracts/resolvers/profiles/IAddressResolver.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {IContentHashResolver} from "@ens/contracts/resolvers/profiles/IContentHashResolver.sol";
import {IDataResolver} from "@ens/contracts/resolvers/profiles/IDataResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {IHasAddressResolver} from "@ens/contracts/resolvers/profiles/IHasAddressResolver.sol";
import {IInterfaceResolver} from "@ens/contracts/resolvers/profiles/IInterfaceResolver.sol";
import {INameResolver} from "@ens/contracts/resolvers/profiles/INameResolver.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";

import {IABISetter} from "~src/resolver/interfaces/setters/IABISetter.sol";
import {IAddressSetter} from "~src/resolver/interfaces/setters/IAddressSetter.sol";
import {IContenthashSetter} from "~src/resolver/interfaces/setters/IContenthashSetter.sol";
import {IDataSetter} from "~src/resolver/interfaces/setters/IDataSetter.sol";
import {IInterfaceSetter} from "~src/resolver/interfaces/setters/IInterfaceSetter.sol";
import {INameSetter} from "~src/resolver/interfaces/setters/INameSetter.sol";
import {ITextSetter} from "~src/resolver/interfaces/setters/ITextSetter.sol";
import {IEnhancedAccessControl} from "~src/access-control/interfaces/IEnhancedAccessControl.sol";
import {EACBaseRolesLib} from "~src/access-control/libraries/EACBaseRolesLib.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {IRecordResolver} from "~src/resolver/interfaces/IRecordResolver.sol";
import {IPermissionedResolver} from "~src/resolver/interfaces/IPermissionedResolver.sol";
import {
    IPermissionedResolverInitializable,
    Grant
} from "~src/resolver/interfaces/IPermissionedResolverInitializable.sol";
import {PermissionedResolverLib} from "~src/resolver/libraries/PermissionedResolverLib.sol";
import {PermissionedResolver} from "~src/resolver/PermissionedResolver.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";

bytes4 constant TEST_SELECTOR = 0x12345678;

contract PermissionedResolverTest is V2Fixture {
    uint256 constant DEFAULT_ROLES = EACBaseRolesLib.ALL_ROLES;

    PermissionedResolver implementation;
    PermissionedResolver resolver;

    address owner = makeAddr("owner");
    address actor = makeAddr("actor");
    address friend = makeAddr("friend");

    bytes testName;
    bytes otherName;
    bytes dneName;
    bytes rootName;

    address testAddr = makeAddr("test");
    bytes testAddress = abi.encodePacked(testAddr);

    function setUp() external {
        deployV2Fixture();

        vm.expectEmit();
        emit IRecordResolver.ResolverCreated();
        implementation = new PermissionedResolver(address(this));

        testName = NameCoder.encode("test.eth");
        otherName = NameCoder.encode("other.eth");
        dneName = NameCoder.encode("dne");
        rootName = NameCoder.encode("");

        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(owner, DEFAULT_ROLES);
        bytes memory initData =
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, new bytes[](0)));
        vm.expectEmit();
        emit IRecordResolver.ResolverCreated();
        resolver = PermissionedResolver(
            verifiableFactory.deployProxy(
                address(implementation),
                uint256(keccak256(initData)),
                initData
            )
        );

        // set as wildcard resolver
        rootRegistry.setResolver(rootRegistry.findTokenId("eth"), address(resolver));
    }

    function test_initialize() external view {
        assertTrue(resolver.hasRootRoles(DEFAULT_ROLES, owner));
    }

    function test_initialize_unowned() external {
        bytes memory initData =
            abi.encodeCall(
                IPermissionedResolverInitializable.initialize,
                (new Grant[](0), new bytes[](0))
            );
        PermissionedResolver r =
            PermissionedResolver(
                verifiableFactory.deployProxy(
                    address(implementation),
                    uint256(keccak256(initData)),
                    initData
                )
            );
        assertEq(r.roleCount(r.ROOT_RESOURCE()), 0);
    }

    function test_initalize_with_setters() external {
        bytes[] memory m = new bytes[](2);
        m[0] = abi.encodeCall(PermissionedResolver.setName, (testName, "A"));
        m[1] = abi.encodeCall(PermissionedResolver.setContenthash, (testName, "B"));

        bytes memory initData =
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (new Grant[](0), m));
        PermissionedResolver r =
            PermissionedResolver(
                verifiableFactory.deployProxy(
                    address(implementation),
                    uint256(keccak256(initData)),
                    initData
                )
            );

        assertEq(
            r.resolve(testName, abi.encodeCall(INameResolver.name, bytes32(0))),
            abi.encode("A")
        );
        assertEq(
            r.resolve(testName, abi.encodeCall(IContentHashResolver.contenthash, bytes32(0))),
            abi.encode("B")
        );
    }

    function test_initalize_with_grants() external {
        Grant[] memory grants = new Grant[](3);
        grants[0] = Grant(owner, EACBaseRolesLib.ALL_ROLES);
        grants[1] = Grant(friend, EACBaseRolesLib.ALL_ROLES >> 128);
        grants[1] = Grant(actor, 1);

        bytes memory initData =
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, new bytes[](0)));
        PermissionedResolver r =
            PermissionedResolver(
                verifiableFactory.deployProxy(
                    address(implementation),
                    uint256(keccak256(initData)),
                    initData
                )
            );

        for (uint256 i; i < grants.length; ++i) {
            assertEq(r.roles(r.ROOT_RESOURCE(), grants[i].account), grants[i].roleBitmap);
        }
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(resolver),
                type(IPermissionedResolver).interfaceId
            ),
            "IPermissionedResolver"
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(resolver),
                type(IPermissionedResolverInitializable).interfaceId
            ),
            "IPermissionedResolverInitializable"
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(resolver),
                type(IEnhancedAccessControl).interfaceId
            ),
            "IEnhancedAccessControl"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IExtendedResolver).interfaceId),
            "IExtendedResolver"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IContractNamer).interfaceId),
            "IContractNamer"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IMulticallable).interfaceId),
            "IMulticallable"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IERC7996).interfaceId),
            "IERC7996"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(UUPSUpgradeable).interfaceId),
            "UUPSUpgradeable"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IProxyAuthorization).interfaceId),
            "IProxyAuthorization"
        );

        // setters
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IABISetter).interfaceId),
            "IABISetter"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IAddressSetter).interfaceId),
            "IAddressSetter"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IContenthashSetter).interfaceId),
            "IContenthashSetter"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IDataSetter).interfaceId),
            "IDataSetter"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IInterfaceSetter).interfaceId),
            "IInterfaceSetter"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(INameSetter).interfaceId),
            "INameSetter"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(ITextSetter).interfaceId),
            "ITextSetter"
        );
    }

    function test_supportsFeature() external view {
        assertTrue(resolver.supportsFeature(ResolverFeatures.RESOLVE_MULTICALL));
    }

    ////////////////////////////////////////////////////////////////////////
    // Upgrade
    ////////////////////////////////////////////////////////////////////////

    function test_canUpgradeFrom() external view {
        assertTrue(resolver.canUpgradeFrom(address(0))); // accepts
        assertTrue(resolver.canUpgradeFrom(address(1))); // any address
    }

    function test_upgrade() external {
        MockUpgrade upgrade = new MockUpgrade();
        vm.prank(owner);
        resolver.upgradeToAndCall(address(upgrade), "");
        assertEq(resolver.resolve(testName, ""), upgrade.resolve(testName, ""));
    }

    function test_upgrade_notAuthorized() external {
        MockUpgrade upgrade = new MockUpgrade();
        assertTrue(resolver.canUpgradeFrom(address(upgrade)));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                resolver.ROOT_RESOURCE(),
                PermissionedResolverLib.ROLE_UPGRADE,
                friend
            )
        );
        vm.prank(friend);
        resolver.upgradeToAndCall(address(upgrade), "");
    }

    ////////////////////////////////////////////////////////////////////////
    // linkToNode() and linkToRecord()
    ////////////////////////////////////////////////////////////////////////

    function test_unknownRecord() external view {
        assertEq(resolver.getRecordId(NameCoder.namehash(testName, 0)), 0);
    }

    function test_ensureRecord() external {
        vm.prank(owner);
        resolver.setName(testName, "");
        assertEq(resolver.getRecordId(NameCoder.namehash(testName, 0)), 1);

        vm.prank(owner);
        resolver.setName(otherName, "");
        assertEq(resolver.getRecordId(NameCoder.namehash(otherName, 0)), 2);
    }

    function test_linkToNode() external {
        vm.prank(owner);
        resolver.setName(testName, "NAME");

        vm.expectEmit();
        emit IRecordResolver.Linked(1, NameCoder.namehash(otherName, 0), otherName);
        vm.prank(owner);
        resolver.linkToNode(otherName, NameCoder.namehash(testName, 0));

        assertEq(
            resolver.getRecordId(NameCoder.namehash(testName, 0)),
            resolver.getRecordId(NameCoder.namehash(otherName, 0))
        );
        assertEq(
            resolver.resolve(otherName, abi.encodeCall(INameResolver.name, bytes32(0))),
            abi.encode("NAME")
        );
    }

    function test_link_unknownRecord() external {
        vm.expectRevert(abi.encodeWithSelector(IRecordResolver.InvalidRecord.selector));
        vm.prank(owner);
        resolver.linkToNode(testName, keccak256("dne"));
    }

    function test_linkToNode_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                resolver.ROOT_RESOURCE(),
                PermissionedResolverLib.ROLE_LINK,
                actor
            )
        );
        vm.prank(actor);
        resolver.linkToNode(testName, keccak256("any"));
    }

    function test_link_unlinkTwice() external {
        vm.prank(owner);
        resolver.linkToRecord(testName, 0);
        vm.prank(owner);
        resolver.linkToRecord(testName, 0);
    }

    function test_linkToRecord() external {
        uint256 recordId;
        vm.startPrank(owner);
        resolver.setName(testName, "NAME");
        recordId = resolver.getRecordId(NameCoder.namehash(testName, 0));
        resolver.linkToRecord(testName, 0);
        vm.stopPrank();

        assertNotEq(resolver.getRecordId(NameCoder.namehash(testName, 0)), recordId);

        vm.expectEmit();
        emit IRecordResolver.Linked(recordId, NameCoder.namehash(testName, 0), testName);
        vm.prank(owner);
        resolver.linkToRecord(testName, recordId);

        assertEq(resolver.getRecordId(NameCoder.namehash(testName, 0)), recordId);
        assertEq(
            resolver.resolve(testName, abi.encodeCall(INameResolver.name, bytes32(0))),
            abi.encode("NAME")
        );
    }

    function test_linkToRecord_unknownRecord() external {
        uint256 recordCount = resolver.getRecordCount();
        vm.expectRevert(abi.encodeWithSelector(IRecordResolver.InvalidRecord.selector));
        vm.prank(owner);
        resolver.linkToRecord(testName, recordCount + 1);
    }

    function test_linkToRecord_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                resolver.ROOT_RESOURCE(),
                PermissionedResolverLib.ROLE_LINK,
                actor
            )
        );
        vm.prank(actor);
        resolver.linkToRecord(testName, 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // getRecordId() and getRecordCount()
    ////////////////////////////////////////////////////////////////////////

    function test_getRecordId() external {
        bytes32 node1 = NameCoder.namehash(testName, 0);
        bytes32 node2 = NameCoder.namehash(otherName, 0);

        assertEq(resolver.getRecordId(node1), 0, "unset");
        assertEq(resolver.getRecordId(node2), 0, "unset2");

        vm.prank(owner);
        resolver.setName(testName, "");
        assertEq(resolver.getRecordId(node1), 1, "new");

        vm.prank(owner);
        resolver.linkToNode(otherName, node1);
        assertEq(resolver.getRecordId(node2), 1, "link");

        vm.prank(owner);
        resolver.linkToRecord(testName, 0);
        assertEq(resolver.getRecordId(node1), 0, "unlink");

        vm.prank(owner);
        resolver.linkToRecord(otherName, 0);
        assertEq(resolver.getRecordId(node2), 0, "unlink2");
    }

    function test_getRecordCount() external {
        assertEq(resolver.getRecordCount(), 0, "empty");

        vm.prank(owner);
        resolver.setName(testName, "");
        assertEq(resolver.getRecordCount(), 1, "new");

        vm.prank(owner);
        resolver.linkToRecord(testName, 0);
        assertEq(resolver.getRecordCount(), 1, "unlink");

        vm.prank(owner);
        resolver.setName(otherName, "");
        assertEq(resolver.getRecordCount(), 2, "new2");

        vm.prank(owner);
        resolver.linkToNode(dneName, NameCoder.namehash(otherName, 0));
        assertEq(resolver.getRecordCount(), 2, "link");
    }

    ////////////////////////////////////////////////////////////////////////
    // EAC grantRoles() is disabled
    ////////////////////////////////////////////////////////////////////////

    function test_grantRoles_disabled(uint256 resource, uint8 roleBit, address account) external {
        vm.assume(resource > 0 && roleBit < 64);
        uint256 roleBitmap = 1 << (roleBit << 2);

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                resource,
                roleBitmap,
                account
            )
        );
        vm.prank(owner);
        resolver.grantRoles(resource, roleBitmap, account);
    }

    ////////////////////////////////////////////////////////////////////////
    // decodeSetter()
    ////////////////////////////////////////////////////////////////////////

    function test_decodeSetter_setABI(uint8 contentTypeBit) external view {
        uint256 contentType = 1 << contentTypeBit;

        (bytes memory arg, uint256 resource, uint256 roleBitmap) =
            resolver.decodeSetter(abi.encodeCall(PermissionedResolver.setABI, ("", contentType, "")));
        assertEq(arg, abi.encodePacked(contentType), "arg");
        assertEq(resource, uint256(keccak256(arg)), "resource");
        assertEq(roleBitmap, PermissionedResolverLib.ROLE_SET_ABI, "role");
    }

    function test_decodeSetter_setAddress(uint256 coinType) external view {
        (bytes memory arg, uint256 resource, uint256 roleBitmap) =
            resolver.decodeSetter(
                abi.encodeCall(PermissionedResolver.setAddress, ("", coinType, ""))
            );
        assertEq(arg, abi.encodePacked(coinType), "arg");
        assertEq(resource, uint256(keccak256(arg)), "resource");
        assertEq(roleBitmap, PermissionedResolverLib.ROLE_SET_ADDRESS, "role");
    }

    function test_decodeSetter_setData(string calldata key) external view {
        (bytes memory arg, uint256 resource, uint256 roleBitmap) =
            resolver.decodeSetter(abi.encodeCall(PermissionedResolver.setData, ("", key, "")));
        assertEq(arg, bytes(key), "arg");
        assertEq(resource, uint256(keccak256(arg)), "resource");
        assertEq(roleBitmap, PermissionedResolverLib.ROLE_SET_DATA, "role");
    }

    function test_decodeSetter_setInterface(bytes4 interfaceId) external view {
        (bytes memory arg, uint256 resource, uint256 roleBitmap) =
            resolver.decodeSetter(
                abi.encodeCall(PermissionedResolver.setInterface, ("", interfaceId, address(0)))
            );
        assertEq(arg, abi.encodePacked(interfaceId), "arg");
        assertEq(resource, uint256(keccak256(arg)), "resource");
        assertEq(roleBitmap, PermissionedResolverLib.ROLE_SET_INTERFACE, "role");
    }

    function test_decodeSetter_setText(string calldata key) external view {
        (bytes memory arg, uint256 resource, uint256 roleBitmap) =
            resolver.decodeSetter(abi.encodeCall(PermissionedResolver.setText, ("", key, "")));
        assertEq(arg, bytes(key), "arg");
        assertEq(resource, uint256(keccak256(arg)), "resource");
        assertEq(roleBitmap, PermissionedResolverLib.ROLE_SET_TEXT, "role");
    }

    function test_decodeSetter_unknown() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IRecordResolver.UnsupportedResolverProfile.selector,
                TEST_SELECTOR
            )
        );
        resolver.decodeSetter(abi.encodeWithSelector(TEST_SELECTOR));
    }

    ////////////////////////////////////////////////////////////////////////
    // setABI()
    ////////////////////////////////////////////////////////////////////////

    function test_setABI(uint8 contentTypeBit, bytes calldata data) external {
        uint256 contentType = 1 << contentTypeBit;

        vm.expectEmit();
        emit IABISetter.ABIUpdated(1, contentType);
        vm.prank(owner);
        resolver.setABI(testName, contentType, data);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IABIResolver.ABI, (bytes32(0), contentType))),
            data.length > 0 ? abi.encode(contentType, data) : abi.encode(0, "")
        );
    }

    function test_setABI_lastBit() external {
        uint256 contentType = 1 << 255;

        vm.prank(owner);
        resolver.setABI(testName, contentType, "A");

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IABIResolver.ABI, (bytes32(0), ~uint256(0)))),
            abi.encode(contentType, "A")
        );
    }

    function test_setABI_invalidContentType_noBits() external {
        uint256 contentType;
        vm.expectRevert(abi.encodeWithSelector(IABISetter.InvalidContentType.selector, contentType));
        vm.prank(owner);
        resolver.setABI(testName, contentType, "");
    }

    function test_setABI_invalidContentType_manyBits() external {
        uint256 contentType = 3;
        vm.expectRevert(abi.encodeWithSelector(IABISetter.InvalidContentType.selector, contentType));
        vm.prank(owner);
        resolver.setABI(testName, contentType, "");
    }

    function test_setABI_notAuthorized(uint8 contentTypeBit) external {
        uint256 contentType = 1 << contentTypeBit;

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(contentType),
                PermissionedResolverLib.ROLE_SET_ABI,
                actor
            )
        );
        vm.prank(actor);
        resolver.setABI(testName, contentType, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setAddress()
    ////////////////////////////////////////////////////////////////////////

    function test_setAddress(uint256 coinType) external {
        bytes memory a =
            vm.randomBytes(ENSIP19.isEVMCoinType(coinType) ? 20 : vm.randomUint(1, 1000));

        assertFalse(_hasAddr(testName, coinType));

        vm.expectEmit();
        emit IAddressSetter.AddressUpdated(1, coinType, a);
        vm.prank(owner);
        resolver.setAddress(testName, coinType, a);

        assertTrue(_hasAddr(testName, coinType));

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddressResolver.addr, (bytes32(0), coinType))),
            abi.encode(a)
        );
    }

    function test_setAddress_mainnet(address addr) external {
        vm.prank(owner);
        resolver.setAddress(testName, COIN_TYPE_ETH, abi.encodePacked(addr));

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddrResolver.addr, (bytes32(0)))),
            abi.encode(addr)
        );
    }

    function test_setAddress_default(uint32 chain, address addr) external {
        vm.assume(chain > 0 && chain < COIN_TYPE_DEFAULT && addr != address(0));
        uint256 coinType = _coinTypeFromChain(chain);
        bytes memory a = abi.encodePacked(addr);

        // set default address
        vm.prank(owner);
        resolver.setAddress(testName, COIN_TYPE_DEFAULT, a);

        assertTrue(_hasAddr(testName, COIN_TYPE_DEFAULT), "set");
        assertFalse(_hasAddr(testName, coinType), "specific");

        // get specific address
        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddressResolver.addr, (bytes32(0), coinType))),
            abi.encode(a)
        );
    }

    function test_setAddress_default_fallbacks() external {
        vm.startPrank(owner);
        resolver.setAddress(testName, COIN_TYPE_DEFAULT, abi.encodePacked(address(1)));
        resolver.setAddress(testName, COIN_TYPE_DEFAULT | 1, abi.encodePacked(address(0))); // zero
        resolver.setAddress(testName, COIN_TYPE_DEFAULT | 2, abi.encodePacked(address(2)));
        resolver.setAddress(testName, COIN_TYPE_DEFAULT | 3, ""); // empty
        vm.stopPrank();

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IAddressResolver.addr, (bytes32(0), COIN_TYPE_DEFAULT | 1))
            ),
            abi.encode(abi.encodePacked(address(0))),
            "zero"
        );
        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IAddressResolver.addr, (bytes32(0), COIN_TYPE_DEFAULT | 2))
            ),
            abi.encode(abi.encodePacked(address(2))),
            "override"
        );
        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IAddressResolver.addr, (bytes32(0), COIN_TYPE_DEFAULT | 3))
            ),
            abi.encode(abi.encodePacked(address(1))),
            "fallback"
        );
    }

    function test_setAddress_zeroEVM() external {
        assertFalse(_hasAddr(testName, COIN_TYPE_ETH), "unset");

        vm.prank(owner);
        resolver.setAddress(testName, COIN_TYPE_ETH, abi.encodePacked(address(0)));

        assertTrue(_hasAddr(testName, COIN_TYPE_ETH), "set");

        vm.prank(owner);
        resolver.setAddress(testName, COIN_TYPE_ETH, "");

        assertFalse(_hasAddr(testName, COIN_TYPE_ETH), "clear");
    }

    function test_setAddress_invalidEVMAddress(uint32 chain, bytes calldata a) external {
        vm.assume(chain > 0 && chain < COIN_TYPE_DEFAULT && a.length != 0 && a.length != 20);
        uint256 coinType = _coinTypeFromChain(chain);

        vm.expectRevert(abi.encodeWithSelector(IAddressSetter.InvalidEVMAddress.selector, a));
        vm.prank(owner);
        resolver.setAddress(testName, coinType, a);
    }

    function test_setAddress_notAuthorized(uint256 coinType) external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(coinType),
                PermissionedResolverLib.ROLE_SET_ADDRESS,
                actor
            )
        );
        vm.prank(actor);
        resolver.setAddress(testName, coinType, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setContenthash()
    ////////////////////////////////////////////////////////////////////////

    function test_setContenthash(bytes calldata hash) external {
        vm.expectEmit();
        emit IContenthashSetter.ContenthashUpdated(1, hash);
        vm.prank(owner);
        resolver.setContenthash(testName, hash);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0)))),
            abi.encode(hash)
        );
    }

    function test_setContenthash_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                resolver.ROOT_RESOURCE(),
                PermissionedResolverLib.ROLE_SET_CONTENTHASH,
                actor
            )
        );
        vm.prank(actor);
        resolver.setContenthash(testName, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setData()
    ////////////////////////////////////////////////////////////////////////

    function test_setData(string calldata key, bytes calldata value) external {
        vm.expectEmit();
        emit IDataSetter.DataUpdated(1, key, key, value);
        vm.prank(owner);
        resolver.setData(testName, key, value);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IDataResolver.data, (bytes32(0), key))),
            abi.encode(value)
        );
    }

    function test_setData_notAuthorized(string calldata key) external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(key),
                PermissionedResolverLib.ROLE_SET_DATA,
                actor
            )
        );
        vm.prank(actor);
        resolver.setData(testName, key, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setInterface()
    ////////////////////////////////////////////////////////////////////////

    function test_setInterface(bytes4 interfaceId, address implementer) external {
        vm.assume(!resolver.supportsInterface(interfaceId));

        vm.expectEmit();
        emit IInterfaceSetter.InterfaceUpdated(1, interfaceId, implementer);
        vm.prank(owner);
        resolver.setInterface(testName, interfaceId, implementer);

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IInterfaceResolver.interfaceImplementer, (bytes32(0), interfaceId))
            ),
            abi.encode(implementer)
        );
    }

    function test_interfaceImplementer_withPointer() external {
        MockInterface c = new MockInterface();
        assertTrue(ERC165Checker.supportsInterface(address(c), TEST_SELECTOR));

        vm.prank(owner);
        resolver.setAddress(testName, COIN_TYPE_ETH, abi.encodePacked(c));

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IInterfaceResolver.interfaceImplementer, (bytes32(0), TEST_SELECTOR))
            ),
            abi.encode(c)
        );
    }

    function test_setInterface_notAuthorized(bytes4 interfaceId) external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(interfaceId),
                PermissionedResolverLib.ROLE_SET_INTERFACE,
                actor
            )
        );
        vm.prank(actor);
        resolver.setInterface(testName, interfaceId, address(0));
    }

    ////////////////////////////////////////////////////////////////////////
    // setName()
    ////////////////////////////////////////////////////////////////////////

    function test_setName(string calldata name) external {
        vm.expectEmit();
        emit INameSetter.NameUpdated(1, name);
        vm.prank(owner);
        resolver.setName(testName, name);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(INameResolver.name, (bytes32(0)))),
            abi.encode(name)
        );
    }

    function test_setName_notAuthorized() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                resolver.ROOT_RESOURCE(),
                PermissionedResolverLib.ROLE_SET_NAME,
                actor
            )
        );
        vm.prank(actor);
        resolver.setName(testName, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setText()
    ////////////////////////////////////////////////////////////////////////

    function test_setText(string calldata key, string calldata value) external {
        vm.expectEmit();
        emit ITextSetter.TextUpdated(1, key, key, value);
        vm.prank(owner);
        resolver.setText(testName, key, value);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(ITextResolver.text, (bytes32(0), key))),
            abi.encode(value)
        );
    }

    function test_setText_notAuthorized(string calldata key) external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(key),
                PermissionedResolverLib.ROLE_SET_TEXT,
                actor
            )
        );
        vm.prank(actor);
        resolver.setText(testName, key, "");
    }

    function test_setText_anyPart(string calldata key) external {
        // friend cannot change testName
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(key),
                PermissionedResolverLib.ROLE_SET_TEXT,
                friend
            )
        );
        vm.prank(friend);
        resolver.setText(testName, key, "A");

        // give friend setText(*) on any record
        vm.prank(owner);
        assertTrue(resolver.grantRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, friend), "granted");

        // friend can change same setter of testName
        vm.prank(friend);
        resolver.setText(testName, key, "B");

        // friend can change same setter of otherName
        vm.prank(friend);
        resolver.setText(otherName, key, "C");

        // friend can change diff setter of otherName
        vm.prank(friend);
        resolver.setText(otherName, string.concat(key, "2"), "D");
    }

    function test_setText_onePart(string calldata key, string calldata key2) external {
        vm.assume(keccak256(bytes(key)) != keccak256(bytes(key2)));

        // friend cannot setText(key)
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(key),
                PermissionedResolverLib.ROLE_SET_TEXT,
                friend
            )
        );
        vm.prank(friend);
        resolver.setText(testName, key, "A");

        // give friend setText(key)
        vm.expectEmit();
        emit IPermissionedResolver.ResourceArgument(
            PermissionedResolverLib.resource(key),
            bytes(key)
        );
        vm.prank(owner);
        assertTrue(
            resolver.grantSetterRoles(
                abi.encodeCall(PermissionedResolver.setText, ("", key, "")),
                friend
            ),
            "granted"
        );

        // friend can change setText(key)
        vm.prank(friend);
        resolver.setText(testName, key, "B");

        // friend can change setText(key) on any name
        vm.prank(friend);
        resolver.setText(otherName, key, "C");

        // friend cannot change setText(key2)
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(key2),
                PermissionedResolverLib.ROLE_SET_TEXT,
                friend
            )
        );
        vm.prank(friend);
        resolver.setText(testName, key2, "D");
    }

    ////////////////////////////////////////////////////////////////////////
    // resolve()
    ////////////////////////////////////////////////////////////////////////

    function test_resolve_noCalldata() external {
        vm.expectRevert(
            abi.encodeWithSelector(IRecordResolver.UnsupportedResolverProfile.selector, bytes4(0))
        );
        resolver.resolve(testName, "");
    }

    function test_resolve_unsupported() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                IRecordResolver.UnsupportedResolverProfile.selector,
                TEST_SELECTOR
            )
        );
        resolver.resolve(testName, abi.encodeWithSelector(TEST_SELECTOR));
    }

    ////////////////////////////////////////////////////////////////////////
    // multicall()
    ////////////////////////////////////////////////////////////////////////

    function test_multicall_setters(bool checked, string calldata name, bytes calldata hash)
        external
    {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(PermissionedResolver.setName, (testName, name));
        calls[1] = abi.encodeCall(PermissionedResolver.setContenthash, (testName, hash));

        vm.prank(owner);
        if (checked) {
            resolver.multicallWithNodeCheck(keccak256("ignored"), calls);
        } else {
            resolver.multicall(calls);
        }

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(INameResolver.name, bytes32(0))),
            abi.encode(name),
            "name"
        );
        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IContentHashResolver.contenthash, bytes32(0))),
            abi.encode(hash),
            "contenthash"
        );
    }

    function test_multicall_setters_notAuthorized() external {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(PermissionedResolver.setName, (testName, ""));

        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                resolver.ROOT_RESOURCE(),
                PermissionedResolverLib.ROLE_SET_NAME,
                actor
            )
        );
        vm.prank(actor);
        resolver.multicall(calls);
    }

    function test_multicall_getters() external {
        vm.startPrank(owner);
        resolver.setABI(testName, 1, "A");
        resolver.setAddress(testName, COIN_TYPE_DEFAULT, testAddress);
        resolver.setContenthash(testName, "B");
        resolver.setData(testName, "DATA", "C");
        resolver.setInterface(testName, TEST_SELECTOR, testAddr);
        resolver.setName(testName, "D");
        resolver.setText(testName, "TEXT", "E");
        vm.stopPrank();

        bytes[] memory calls = new bytes[](8);
        calls[0] = abi.encodeCall(IABIResolver.ABI, (bytes32(0), ~uint256(0)));
        calls[1] = abi.encodeCall(IAddressResolver.addr, (bytes32(0), COIN_TYPE_ETH));
        calls[2] = abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0)));
        calls[3] = abi.encodeCall(IDataResolver.data, (bytes32(0), "DATA"));
        calls[4] = abi.encodeCall(
            IInterfaceResolver.interfaceImplementer,
            (bytes32(0), TEST_SELECTOR)
        );
        calls[5] = abi.encodeCall(INameResolver.name, (bytes32(0)));
        calls[6] = abi.encodeCall(ITextResolver.text, (bytes32(0), "TEXT"));
        //
        calls[7] = abi.encodeCall(IAddrResolver.addr, (bytes32(0)));

        bytes[] memory answers = new bytes[](calls.length);
        answers[0] = abi.encode(1, "A");
        answers[1] = abi.encode(testAddress);
        answers[2] = abi.encode("B");
        answers[3] = abi.encode("C");
        answers[4] = abi.encode(testAddr);
        answers[5] = abi.encode("D");
        answers[6] = abi.encode("E");
        //
        answers[7] = abi.encode(testAddr);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IMulticallable.multicall, (calls))),
            abi.encode(answers)
        );
    }

    function test_multicall_getters_withError() external {
        bytes[] memory m = new bytes[](1);
        m[0] = abi.encodeWithSelector(TEST_SELECTOR);

        vm.expectRevert();
        resolver.multicall(m);
    }

    ////////////////////////////////////////////////////////////////////////
    // Default Record
    ////////////////////////////////////////////////////////////////////////

    function test_default_setABI(uint8 contentTypeBit, bytes calldata data) external {
        uint256 contentType = 1 << contentTypeBit;

        vm.prank(owner);
        resolver.setABI(rootName, contentType, data);

        assertEq(
            resolver.resolve(dneName, abi.encodeCall(IABIResolver.ABI, (bytes32(0), contentType))),
            data.length > 0 ? abi.encode(contentType, data) : abi.encode(0, "")
        );
    }

    function test_default_setAddress(uint256 coinType) external {
        bytes memory a =
            vm.randomBytes(ENSIP19.isEVMCoinType(coinType) ? 20 : vm.randomUint(1, 1000));

        vm.prank(owner);
        resolver.setAddress(rootName, coinType, a);

        assertEq(
            resolver.resolve(dneName, abi.encodeCall(IAddressResolver.addr, (bytes32(0), coinType))),
            abi.encode(a)
        );
    }

    function test_default_setContenthash(bytes calldata hash) external {
        vm.prank(owner);
        resolver.setContenthash(rootName, hash);

        assertEq(
            resolver.resolve(dneName, abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0)))),
            abi.encode(hash)
        );
    }

    function test_default_setData(string calldata key, bytes calldata value) external {
        vm.prank(owner);
        resolver.setData(rootName, key, value);

        assertEq(
            resolver.resolve(dneName, abi.encodeCall(IDataResolver.data, (bytes32(0), key))),
            abi.encode(value)
        );
    }

    function test_default_setInterface(bytes4 interfaceId, address implementer) external {
        vm.prank(owner);
        resolver.setInterface(rootName, interfaceId, implementer);

        assertEq(
            resolver.resolve(
                dneName,
                abi.encodeCall(IInterfaceResolver.interfaceImplementer, (bytes32(0), interfaceId))
            ),
            abi.encode(implementer)
        );
    }

    function test_default_setName(string calldata name) external {
        vm.prank(owner);
        resolver.setName(rootName, name);

        assertEq(
            resolver.resolve(dneName, abi.encodeCall(INameResolver.name, (bytes32(0)))),
            abi.encode(name)
        );
    }

    function test_default_setText(string calldata key, string calldata value) external {
        vm.prank(owner);
        resolver.setText(rootName, key, value);

        assertEq(
            resolver.resolve(dneName, abi.encodeCall(ITextResolver.text, (bytes32(0), key))),
            abi.encode(value)
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // IContractNamer
    ////////////////////////////////////////////////////////////////////////

    function test_implementationIsNameable() external view {
        assertTrue(implementation.isContractNamer(address(this)));
    }

    function test_isContractNamer() external {
        assertTrue(resolver.isContractNamer(owner), "owner");
        assertFalse(resolver.isContractNamer(friend), "before");

        vm.prank(owner);
        resolver.grantRootRoles(PermissionedResolverLib.ROLE_CAN_NAME, friend);
        assertTrue(resolver.isContractNamer(friend), "granted");

        vm.prank(owner);
        resolver.revokeRootRoles(PermissionedResolverLib.ROLE_CAN_NAME, friend);
        assertFalse(resolver.isContractNamer(friend), "revoked");
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _coinTypeFromChain(uint32 chain) internal pure returns (uint256) {
        return chain == CHAIN_ID_ETH ? COIN_TYPE_ETH : (COIN_TYPE_DEFAULT | chain);
    }

    function _resolveWithUR(bytes memory name, bytes memory data)
        public
        view
        returns (bytes memory result)
    {
        address resolver_;
        (result, resolver_) = universalResolver.resolve(name, data);
        assertEq(resolver_, address(resolver), "resolver");
    }

    function _hasAddr(bytes memory name, uint256 coinType) internal view returns (bool) {
        return
            abi.decode(
                _resolveWithUR(
                    name,
                    abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), coinType))
                ),
                (bool)
            );
    }
}


contract MockUpgrade is IExtendedResolver, UUPSUpgradeable, IProxyAuthorization {
    function resolve(bytes calldata, bytes calldata) external pure returns (bytes memory) {
        return abi.encode(address(0x1234));
    }
    function canUpgradeFrom(address) external pure returns (bool) {
        return true;
    }
    function _authorizeUpgrade(address) internal override {}
}


contract MockInterface is ERC165 {
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == TEST_SELECTOR || super.supportsInterface(interfaceId);
    }
}
