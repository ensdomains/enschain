// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {ResolverCaller} from "@ens/contracts/universalResolver/ResolverCaller.sol";
import {
    DummyShapeshiftResolver
} from "@ens/contracts/universalResolver/mocks/DummyShapeshiftResolver.sol";

import {AliasResolver} from "~src/resolver/AliasResolver.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";

contract AliasResolverTest is V2Fixture {
    AliasResolver aliasResolver;
    DummyShapeshiftResolver ssResolver;

    address actor = makeAddr("actor");

    function setUp() external {
        deployV2Fixture();
        aliasResolver = new AliasResolver(rootRegistry, batchGatewayProvider, contractNamer);
        ssResolver = new DummyShapeshiftResolver();

        rootRegistry.register(
            "com",
            address(this),
            IRegistry(address(0)),
            address(aliasResolver),
            0,
            uint64(block.timestamp + 1 days)
        );

        ethRegistry.register(
            "test",
            address(this),
            IRegistry(address(0)),
            address(ssResolver),
            0,
            uint64(block.timestamp + 1 days)
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Init
    ////////////////////////////////////////////////////////////////////////

    function test_constructor() external view {
        assertEq(address(aliasResolver.ROOT_REGISTRY()), address(rootRegistry), "ROOT_REGISTRY");
        assertEq(
            address(aliasResolver.BATCH_GATEWAY_PROVIDER()),
            address(batchGatewayProvider),
            "BATCH_GATEWAY_PROVIDER"
        );
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(
                address(aliasResolver),
                type(IExtendedResolver).interfaceId
            ),
            "IExtendedResolver"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // getAlias() and setAlias()
    ////////////////////////////////////////////////////////////////////////

    function test_setAlias() external {
        bytes memory name = NameCoder.encode("com");
        bytes memory newName = NameCoder.encode("test.eth");
        aliasResolver.setAlias(name, newName);

        assertEq(aliasResolver.getAlias(name), newName);
        assertEq(
            aliasResolver.getAlias(NameCoder.addLabel(name, "nick")),
            NameCoder.addLabel(newName, "nick")
        );
    }

    function test_setAlias_unowned() external {
        bytes memory name = NameCoder.encode("xyz");
        vm.expectRevert(abi.encodeWithSelector(AliasResolver.CannotModifyName.selector, name));
        aliasResolver.setAlias(name, NameCoder.encode("test.eth"));
    }

    function test_setAlias_wrongOwner() external {
        bytes memory name = NameCoder.encode("com");
        vm.expectRevert(abi.encodeWithSelector(AliasResolver.CannotModifyName.selector, name));
        vm.prank(actor);
        aliasResolver.setAlias(name, NameCoder.encode("test.eth"));
    }

    ////////////////////////////////////////////////////////////////////////
    // resolve()
    ////////////////////////////////////////////////////////////////////////

    function test_resolve_unreachable() external {
        bytes memory name = NameCoder.encode("nick.com");
        vm.expectRevert(abi.encodeWithSelector(ResolverCaller.UnreachableName.selector, name));
        aliasResolver.resolve(name, abi.encodeCall(IAddrResolver.addr, (bytes32(0))));
    }

    function test_resolve(bool extended) external {
        aliasResolver.setAlias(NameCoder.encode("com"), NameCoder.encode("test.eth"));

        address addr = makeAddr("addr");
        ssResolver.setExtended(extended);
        ssResolver.setResponse(
            abi.encodeCall(
                IAddrResolver.addr,
                (NameCoder.namehash(NameCoder.encode("nick.test.eth"), 0))
            ),
            abi.encode(addr)
        );
        assertEq(
            abi.decode(
                aliasResolver.resolve(
                    NameCoder.encode("nick.com"),
                    abi.encodeCall(IAddrResolver.addr, (bytes32(0)))
                ),
                (address)
            ),
            addr
        );
    }
}
