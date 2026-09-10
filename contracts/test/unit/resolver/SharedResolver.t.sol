// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Vm} from "forge-std/Test.sol";

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
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
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {
    ENSIP19,
    COIN_TYPE_ETH,
    COIN_TYPE_DEFAULT,
    CHAIN_ID_ETH
} from "@ens/contracts/utils/ENSIP19.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";

import {IABISetter} from "~src/resolver/interfaces/setters/IABISetter.sol";
import {IAddressSetter} from "~src/resolver/interfaces/setters/IAddressSetter.sol";
import {IContenthashSetter} from "~src/resolver/interfaces/setters/IContenthashSetter.sol";
import {IDataSetter} from "~src/resolver/interfaces/setters/IDataSetter.sol";
import {IInterfaceSetter} from "~src/resolver/interfaces/setters/IInterfaceSetter.sol";
import {INameSetter} from "~src/resolver/interfaces/setters/INameSetter.sol";
import {ITextSetter} from "~src/resolver/interfaces/setters/ITextSetter.sol";
import {IRecordResolver} from "~src/resolver/interfaces/IRecordResolver.sol";
import {ISharedResolver} from "~src/resolver/interfaces/ISharedResolver.sol";
import {SharedResolver} from "~src/resolver/SharedResolver.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";

bytes4 constant TEST_SELECTOR = 0x12345678;

contract SharedResolverTest is V2Fixture {
    SharedResolver resolver;

    address actor = makeAddr("actor");
    address friend = makeAddr("friend");

    bytes rootName;
    bytes dneName;
    bytes testName;
    bytes32 testNode;
    bytes otherName;

    function setUp() external {
        deployV2Fixture();

        resolver = new SharedResolver(rootRegistry, contractNamer);

        rootName = NameCoder.encode("");
        dneName = NameCoder.encode("dne");
        testName = _register("test");
        testNode = NameCoder.namehash(testName, 0);
        otherName = _register("other");
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(ISharedResolver).interfaceId),
            "ISharedResolver"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IContractNamer).interfaceId),
            "IContractNamer"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IExtendedResolver).interfaceId),
            "IExtendedResolver"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IERC7996).interfaceId),
            "IERC7996"
        );
        assertTrue(
            ERC165Checker.supportsInterface(address(resolver), type(IMulticallable).interfaceId),
            "IMulticallable"
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
        assertTrue(resolver.supportsFeature(ResolverFeatures.RESOLVE_MULTICALL), "RESOLVE_MULTICALL");
    }

    function test_ownerOf() external view {
        assertEq(resolver.ownerOf(rootName), address(0), "null");
        assertEq(resolver.ownerOf(dneName), address(0), "unreg");
        assertEq(resolver.ownerOf(testName), address(this), "test");
        assertEq(resolver.ownerOf(otherName), address(this), "other");
    }

    function test_canModifyName_null() external view {
        assertFalse(resolver.canModifyName(rootName, address(0)), "null");
        assertFalse(resolver.canModifyName(rootName, address(this)), "this");
        assertFalse(resolver.canModifyName(rootName, address(actor)), "actor");
    }

    function test_canModifyName_unregistered() external view {
        assertFalse(resolver.canModifyName(dneName, address(0)), "null");
        assertFalse(resolver.canModifyName(dneName, address(this)), "this");
        assertFalse(resolver.canModifyName(dneName, address(actor)), "actor");
    }

    function test_canModifyName_registered() external view {
        assertFalse(resolver.canModifyName(testName, address(0)), "null");
        assertTrue(resolver.canModifyName(testName, address(this)), "this");
        assertFalse(resolver.canModifyName(testName, address(actor)), "actor");
    }

    function test_approve_name() external {
        assertFalse(resolver.isApproved(testName, address(this), friend), "before:approved");
        assertFalse(resolver.canModifyName(testName, address(friend)), "before:modify");

        vm.expectEmit();
        emit IRecordResolver.Linked(uint256(testNode), testNode, testName);
        vm.expectEmit();
        emit ISharedResolver.ApprovalUpdated(uint256(testNode), address(this), friend, true);
        resolver.approve(testName, friend, true);

        assertTrue(resolver.isApproved(testName, address(this), friend), "approved:testName");
        assertTrue(resolver.canModifyName(testName, address(friend)), "modify:friend");
        assertFalse(resolver.canModifyName(testName, address(actor)), "modify:actor");

        vm.expectEmit();
        emit ISharedResolver.ApprovalUpdated(uint256(testNode), address(this), friend, false);
        resolver.approve(testName, friend, false);

        assertFalse(resolver.isApproved(testName, address(this), friend), "revoked:approved");
        assertFalse(resolver.canModifyName(testName, address(friend)), "revoked:modify");
    }

    function test_approve_any() external {
        assertFalse(resolver.isApproved(rootName, address(this), friend), "before:null");
        assertFalse(resolver.isApproved(testName, address(this), friend), "before:approved");
        assertFalse(resolver.canModifyName(testName, address(friend)), "before:modify");

        vm.expectEmit();
        emit ISharedResolver.ApprovalUpdated(0, address(this), friend, true);
        resolver.approve(rootName, friend, true);

        assertTrue(resolver.isApproved(rootName, address(this), friend), "approved:null");
        assertFalse(resolver.canModifyName(rootName, address(this)), "modify:null");

        assertFalse(resolver.isApproved(testName, address(this), friend), "approved:test");
        assertTrue(resolver.canModifyName(testName, address(friend)), "modify:friend");
        assertFalse(resolver.canModifyName(testName, address(actor)), "modify:actor");

        assertTrue(resolver.canModifyName(otherName, address(friend)), "modify:other");

        vm.expectEmit();
        emit ISharedResolver.ApprovalUpdated(0, address(this), friend, false);
        resolver.approve(rootName, friend, false);

        assertFalse(resolver.isApproved(rootName, address(this), friend), "revoked:null");
        assertFalse(resolver.isApproved(testName, address(this), friend), "revoked:approved");
        assertFalse(resolver.canModifyName(testName, address(friend)), "revoked:modify");
        assertFalse(resolver.canModifyName(otherName, address(friend)), "revoked:other");
    }

    function test_approve_name_alreadyLinked() external {
        resolver.setName(testName, "");
        vm.recordLogs();
        vm.expectEmit();
        emit ISharedResolver.ApprovalUpdated(uint256(testNode), address(this), friend, true);
        resolver.approve(testName, friend, true);
        _expectNoEmit(vm.getRecordedLogs(), IRecordResolver.Linked.selector);
    }

    function test_checkAuth_alreadyLinked() external {
        vm.expectEmit();
        emit IRecordResolver.Linked(uint256(testNode), testNode, testName);
        resolver.setName(testName, "a");

        vm.recordLogs();
        resolver.setName(testName, "b");
        _expectNoEmit(vm.getRecordedLogs(), IRecordResolver.Linked.selector);
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

    function test_resolve_anyNode(bytes32 node) external {
        string memory name = "nick.eth";

        resolver.setName(testName, name);

        assertEq(
            resolver.resolve(testName, abi.encodeCall(INameResolver.name, (node))),
            abi.encode(name)
        );
    }

    function test_resolve_multicall_unsupported() external view {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(TEST_SELECTOR);

        bytes[] memory results = new bytes[](1);
        results[0] = abi.encodeWithSelector(
            IRecordResolver.UnsupportedResolverProfile.selector,
            TEST_SELECTOR
        );

        assertEq(
            resolver.resolve(testName, abi.encodeCall(IMulticallable.multicall, (calls))),
            abi.encode(results)
        );
    }

    function test_resolve_emptyMulticall() external view {
        assertEq(
            resolver.resolve(testName, abi.encodeCall(IMulticallable.multicall, (new bytes[](0)))),
            abi.encode(new bytes[](0))
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // setABI()
    ////////////////////////////////////////////////////////////////////////

    function test_setABI(uint8 bit, bytes calldata data) external {
        uint256 contentType = 1 << bit;

        vm.expectEmit();
        emit IABISetter.ABIUpdated(uint256(testNode), contentType);
        resolver.setABI(testName, contentType, data);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IABIResolver.ABI, (bytes32(0), ~uint256(0)))),
            data.length > 0 ? abi.encode(contentType, data) : abi.encode(0, "")
        );
    }

    function test_setABI_invalidContentType_noBits() external {
        uint256 contentTypes; // wrong
        vm.expectRevert(abi.encodeWithSelector(IABISetter.InvalidContentType.selector, contentTypes));
        resolver.setABI(testName, contentTypes, "");
    }

    function test_setABI_invalidContentType_manyBits() external {
        uint256 contentTypes = 3; // wrong
        vm.expectRevert(abi.encodeWithSelector(IABISetter.InvalidContentType.selector, contentTypes));
        resolver.setABI(testName, contentTypes, "");
    }

    function test_setABI_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setABI(testName, 1, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setAddress()
    ////////////////////////////////////////////////////////////////////////

    function test_setAddress(uint256 coinType) external {
        bytes memory a =
            vm.randomBytes(ENSIP19.isEVMCoinType(coinType) ? 20 : vm.randomUint(1, 1000));

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), coinType))
            ),
            abi.encode(false),
            "before"
        );

        vm.expectEmit();
        emit IAddressSetter.AddressUpdated(uint256(testNode), coinType, a);
        resolver.setAddress(testName, coinType, a);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddressResolver.addr, (bytes32(0), coinType))),
            abi.encode(a),
            "resolve"
        );

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), coinType))
            ),
            abi.encode(true),
            "after"
        );
    }

    function test_setAddress_mainnet(address addr) external {
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

        resolver.setAddress(testName, COIN_TYPE_DEFAULT, a);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddressResolver.addr, (bytes32(0), coinType))),
            abi.encode(a),
            "addr(*)"
        );
        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddrResolver.addr, (bytes32(0)))),
            abi.encode(addr),
            "addr()"
        );

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), coinType))
            ),
            abi.encode(false),
            "hasAddr(*)"
        );
        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), COIN_TYPE_DEFAULT))
            ),
            abi.encode(true),
            "hasAddr(default)"
        );
    }

    function test_setAddress_invalidEVMAddress(uint32 chain, bytes calldata a) external {
        vm.assume(chain > 0 && chain < COIN_TYPE_DEFAULT && a.length != 0 && a.length != 20);
        uint256 coinType = _coinTypeFromChain(chain);

        vm.expectRevert(abi.encodeWithSelector(IAddressSetter.InvalidEVMAddress.selector, a));
        resolver.setAddress(testName, coinType, a);
    }

    function test_setAddress_zeroEVMAddress() external {
        uint256 coinType = COIN_TYPE_ETH;

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), coinType))
            ),
            abi.encode(false),
            "before"
        );

        resolver.setAddress(testName, coinType, abi.encodePacked(address(0)));

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IAddrResolver.addr, (bytes32(0)))),
            abi.encode(address(0)),
            "resolve"
        );

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), coinType))
            ),
            abi.encode(true),
            "after"
        );
    }

    function test_setAddress_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setAddress(testName, 0, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setContenthash()
    ////////////////////////////////////////////////////////////////////////

    function test_setContenthash(bytes calldata hash) external {
        vm.expectEmit();
        emit IContenthashSetter.ContenthashUpdated(uint256(testNode), hash);
        resolver.setContenthash(testName, hash);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0)))),
            abi.encode(hash)
        );
    }

    function test_setContenthash_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setContenthash(testName, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setData()
    ////////////////////////////////////////////////////////////////////////

    function test_setData(string calldata key, bytes calldata value) external {
        vm.expectEmit();
        emit IDataSetter.DataUpdated(uint256(testNode), key, key, value);
        resolver.setData(testName, key, value);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IDataResolver.data, (bytes32(0), key))),
            abi.encode(value)
        );
    }

    function test_setData_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setData(testName, "", "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setInterface()
    ////////////////////////////////////////////////////////////////////////

    function test_setInterface(bytes4 interfaceId, address impl) external {
        vm.expectEmit();
        emit IInterfaceSetter.InterfaceUpdated(uint256(testNode), interfaceId, impl);
        resolver.setInterface(testName, interfaceId, impl);

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IInterfaceResolver.interfaceImplementer, (bytes32(0), interfaceId))
            ),
            abi.encode(impl)
        );
    }

    function test_setInterface_viaAddr() external {
        MockInterface c = new MockInterface();
        assertTrue(c.supportsInterface(TEST_SELECTOR));

        resolver.setAddress(testName, COIN_TYPE_ETH, abi.encodePacked(c));

        assertEq(
            _resolveWithUR(
                testName,
                abi.encodeCall(IInterfaceResolver.interfaceImplementer, (bytes32(0), TEST_SELECTOR))
            ),
            abi.encode(c)
        );
    }

    function test_setInterface_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setInterface(testName, bytes4(0), address(0));
    }

    ////////////////////////////////////////////////////////////////////////
    // setName()
    ////////////////////////////////////////////////////////////////////////

    function test_setName(string calldata primaryName) external {
        vm.expectEmit();
        emit INameSetter.NameUpdated(uint256(testNode), primaryName);
        resolver.setName(testName, primaryName);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(INameResolver.name, (bytes32(0)))),
            abi.encode(primaryName)
        );
    }

    function test_setName_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setName(testName, "");
    }

    ////////////////////////////////////////////////////////////////////////
    // setText()
    ////////////////////////////////////////////////////////////////////////

    function test_setText(string calldata key, string calldata value) external {
        vm.expectEmit();
        emit ITextSetter.TextUpdated(uint256(testNode), key, key, value);
        resolver.setText(testName, key, value);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(ITextResolver.text, (bytes32(0), key))),
            abi.encode(value)
        );
    }

    function test_setText_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.setText(testName, "", "");
    }

    ////////////////////////////////////////////////////////////////////////
    // clear()
    ////////////////////////////////////////////////////////////////////////

    function test_clear() external {
        string memory name = "nick.eth";

        resolver.setName(testName, name);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(INameResolver.name, (bytes32(0)))),
            abi.encode(name)
        );

        resolver.clear(testName);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(INameResolver.name, (bytes32(0)))),
            abi.encode("")
        );
    }

    function test_clear_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, testName));
        vm.prank(actor);
        resolver.clear(testName);
    }

    ////////////////////////////////////////////////////////////////////////
    // multicall()
    ////////////////////////////////////////////////////////////////////////

    function test_multicall(bool checked) external {
        string memory s = "abc";
        bytes memory v = abi.encodePacked(friend);

        bytes[] memory m = new bytes[](6);
        m[0] = abi.encodeCall(IAddressSetter.setAddress, (testName, COIN_TYPE_DEFAULT, v));
        m[1] = abi.encodeCall(IContenthashSetter.setContenthash, (testName, v));
        m[2] = abi.encodeCall(IDataSetter.setData, (testName, s, v));
        m[3] = abi.encodeCall(IInterfaceSetter.setInterface, (testName, TEST_SELECTOR, friend));
        m[4] = abi.encodeCall(INameSetter.setName, (testName, s));
        m[5] = abi.encodeCall(ITextSetter.setText, (testName, s, s));

        if (checked) {
            resolver.multicallWithNodeCheck(keccak256("dne"), m);
        } else {
            resolver.multicall(m);
        }

        bytes[] memory calls = new bytes[](m.length + 3);
        calls[0] = abi.encodeCall(IAddressResolver.addr, (bytes32(0), COIN_TYPE_DEFAULT));
        calls[1] = abi.encodeCall(IContentHashResolver.contenthash, (bytes32(0)));
        calls[2] = abi.encodeCall(IDataResolver.data, (bytes32(0), s));
        calls[3] = abi.encodeCall(
            IInterfaceResolver.interfaceImplementer,
            (bytes32(0), TEST_SELECTOR)
        );
        calls[4] = abi.encodeCall(INameResolver.name, (bytes32(0)));
        calls[5] = abi.encodeCall(ITextResolver.text, (bytes32(0), s));
        //
        calls[6] = abi.encodeCall(IAddrResolver.addr, (bytes32(0)));
        calls[7] = abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), COIN_TYPE_DEFAULT));
        calls[8] = abi.encodeCall(IHasAddressResolver.hasAddr, (bytes32(0), 0));

        bytes[] memory results = new bytes[](calls.length);
        results[0] = abi.encode(v);
        results[1] = abi.encode(v);
        results[2] = abi.encode(v);
        results[3] = abi.encode(friend);
        results[4] = abi.encode(s);
        results[5] = abi.encode(s);
        //
        results[6] = abi.encode(friend);
        results[7] = abi.encode(true);
        results[8] = abi.encode(false);

        assertEq(
            _resolveWithUR(testName, abi.encodeCall(IMulticallable.multicall, (calls))),
            abi.encode(results)
        );
    }

    function test_multicall_oneError_notAuthorized() external {
        bytes[] memory m = new bytes[](2);
        m[0] = abi.encodeCall(INameSetter.setName, (testName, ""));
        m[1] = abi.encodeCall(INameSetter.setName, (dneName, "")); // wrong

        vm.expectRevert(abi.encodeWithSelector(ISharedResolver.CannotModifyName.selector, dneName));
        resolver.multicall(m);
    }

    function test_multicall_oneError_unknown() external {
        bytes[] memory m = new bytes[](2);
        m[0] = abi.encodeCall(INameSetter.setName, (testName, ""));
        m[1] = abi.encodeWithSelector(TEST_SELECTOR); // wrong

        vm.expectRevert();
        resolver.multicall(m);
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

    function _register(string memory label) internal returns (bytes memory) {
        ethRegistry.register(
            label,
            address(this),
            IRegistry(address(0)),
            address(resolver),
            0,
            type(uint64).max
        );
        return NameCoder.ethName(label);
    }

    function _expectNoEmit(Vm.Log[] memory logs, bytes32 topic0) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            assertNotEq(logs[i].topics[0], topic0, "found unexpected event");
        }
    }
}


contract MockInterface is ERC165 {
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == TEST_SELECTOR || super.supportsInterface(interfaceId);
    }
}
