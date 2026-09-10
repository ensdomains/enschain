// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

// solhint-disable no-console, private-vars-leading-underscore, state-visibility, func-name-mixedcase, contracts-v2/ordering, one-contract-per-file

import {Test} from "forge-std/Test.sol";

import {ENS} from "@ens/contracts/registry/ENS.sol";
import {DNSSEC} from "@ens/contracts/dnssec-oracle/DNSSEC.sol";
import {HexUtils} from "@ens/contracts/utils/HexUtils.sol";
import {GatewayProvider} from "@ens/contracts/ccipRead/GatewayProvider.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {
    DummyShapeshiftResolver
} from "@ens/contracts/universalResolver/mocks/DummyShapeshiftResolver.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import {EACBaseRolesLib} from "~src/access-control/EnhancedAccessControl.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {PermissionedRegistry} from "~src/registry/PermissionedRegistry.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";
import {DNSTLDResolver} from "~src/dns/DNSTLDResolver.sol";
import {LabelStore} from "~src/utils/LabelStore.sol";

contract DNSTLDResolverTest is Test, ERC1155Holder {
    PermissionedRegistry rootRegistry;
    MockDNS dns;

    address resolver = makeAddr("resolver");

    function setUp() external {
        rootRegistry = new PermissionedRegistry(
            new LabelStore(IContractNamer(address(0))),
            address(this),
            EACBaseRolesLib.ALL_ROLES
        );
        dns = new MockDNS(rootRegistry);
    }

    function test_parseResolver_address() external view {
        assertEq(
            dns.parseResolver("0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"),
            0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
        );
    }

    function testFuzz_parseResolver_address(address a) external view {
        assertEq(dns.parseResolver(abi.encodePacked("0x", HexUtils.addressToHex(a))), a);
    }

    function test_parseResolver_name(bool extended) external {
        string memory label = "test";
        DummyShapeshiftResolver r = new DummyShapeshiftResolver();
        r.setExtended(extended);
        r.setResponse(
            abi.encodeCall(IAddrResolver.addr, (NameCoder.namehash(NameCoder.encode(label), 0))),
            abi.encode(resolver)
        );
        rootRegistry.register(
            label,
            address(0),
            IRegistry(address(0)),
            address(r),
            0,
            uint64(block.timestamp) + 86400
        );
        assertEq(dns.parseResolver(bytes(label)), resolver);
    }

    function test_parseResolver_name_offchain(bool extended) external {
        string memory label = "test";
        DummyShapeshiftResolver r = new DummyShapeshiftResolver();
        r.setExtended(extended);
        r.setOffchain(true);
        r.setResponse(
            abi.encodeCall(IAddrResolver.addr, (NameCoder.namehash(NameCoder.encode(label), 0))),
            abi.encode(resolver)
        );
        rootRegistry.register(
            label,
            address(0),
            IRegistry(address(0)),
            address(r),
            0,
            uint64(block.timestamp) + 86400
        );
        assertEq(dns.parseResolver(bytes(label)), address(0));
    }
}


contract MockDNS is DNSTLDResolver {
    constructor(IPermissionedRegistry rootRegistry)
        DNSTLDResolver(
            ENS(address(0)),
            address(0),
            rootRegistry,
            DNSSEC(address(0)),
            new GatewayProvider(address(1), new string[](0)),
            new GatewayProvider(address(1), new string[](0)),
            IContractNamer(address(0))
        )
    {}
    function parseResolver(bytes memory v) external view returns (address) {
        return _parseResolver(v);
    }
}
