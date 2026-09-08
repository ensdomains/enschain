// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

// solhint-disable no-console, private-vars-leading-underscore, state-visibility, func-name-mixedcase, contracts-v2/ordering, one-contract-per-file

import {Test} from "forge-std/Test.sol";

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {EACBaseRolesLib} from "~src/access-control/EnhancedAccessControl.sol";
import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {IStandardRegistry} from "~src/registry/interfaces/IStandardRegistry.sol";
import {PermissionedRegistry} from "~src/registry/PermissionedRegistry.sol";
import {LibResolution} from "~src/universalResolver/libraries/LibResolution.sol";
import {LabelStore} from "~src/utils/LabelStore.sol";
import {IContractNamer} from "~src/reverse-registrar/interfaces/IContractNamer.sol";

contract LibResolutionTest is Test, ERC1155Holder {
    PermissionedRegistry rootRegistry;
    LabelStore labelStore;

    address resolverAddress = makeAddr("resolver");
    address actor = makeAddr("actor");

    function setUp() external {
        labelStore = new LabelStore(IContractNamer(address(0)));
        rootRegistry = _createRegistry();
    }

    function _expectFind(
        bytes memory name,
        uint256 resolverOffset,
        address parentRegistry,
        IRegistry[] memory registries,
        bytes memory canonicalName
    )
        internal
        view
    {
        (IRegistry registry, address resolver, bytes32 node, uint256 resolverOffset_) =
            LibResolution.findResolverUnsafe(rootRegistry, name, 0);
        assertEq(
            address(LibResolution.findExactRegistry(rootRegistry, name, 0)),
            address(registry),
            "exact"
        );
        assertEq(resolver, resolverAddress, "resolver");
        assertEq(node, NameCoder.namehash(name, 0), "node");
        assertEq(resolverOffset_, resolverOffset, "offset");
        assertEq(
            address(LibResolution.findParentRegistry(rootRegistry, name, 0)),
            parentRegistry,
            "parent"
        );
        {
            IRegistry[] memory regs = LibResolution.findRegistries(rootRegistry, name, 0);
            assertEq(registries.length, regs.length, "count");
            for (uint256 i; i < regs.length; ++i) {
                assertEq(
                    address(registries[i]),
                    address(regs[i]),
                    string.concat("registry[", vm.toString(i), "]")
                );
            }
        }
        uint256 offset;
        for (uint256 i; i < registries.length; ++i) {
            assertEq(
                address(LibResolution.findExactRegistry(rootRegistry, name, offset)),
                address(registries[i]),
                string.concat("exact[", vm.toString(i), "]")
            );
            (, offset) = NameCoder.nextLabel(name, offset);
        }
        assertEq(offset, name.length, "length");
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, registries[0]),
            canonicalName,
            "findCanonicalName"
        );
        if (canonicalName.length > 0) {
            assertEq(
                address(LibResolution.findCanonicalRegistry(rootRegistry, canonicalName)),
                address(registries[0]),
                "findCanonicalRegistry"
            );
        }
    }

    function test_findResolver_eth() external {
        bytes memory name = NameCoder.encode("eth");
        //     name:  eth
        // registry: <eth> <root>
        // resolver:   X
        vm.pauseGasMetering();
        PermissionedRegistry ethRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, resolverAddress);
        vm.resumeGasMetering();

        IRegistry[] memory v = new IRegistry[](2);
        v[0] = ethRegistry;
        v[1] = rootRegistry;
        _expectFind(name, 0, address(rootRegistry), v, name);
    }

    function test_findResolver_resolverOnParent() external {
        bytes memory name = NameCoder.encode("test.eth");
        //     name:  test . eth
        // registry: <test> <eth> <root>
        // resolver:   X
        vm.pauseGasMetering();
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, resolverAddress);
        vm.resumeGasMetering();

        IRegistry[] memory v = new IRegistry[](3);
        v[0] = testRegistry;
        v[1] = ethRegistry;
        v[2] = rootRegistry;
        _expectFind(name, 0, address(ethRegistry), v, name);
    }

    function test_findResolver_resolverOnRoot() external {
        bytes memory name = NameCoder.encode("sub.test.eth");
        //     name:  sub . test . eth
        // registry:       <test> <eth> <root>
        // resolver:                X
        vm.pauseGasMetering();
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, resolverAddress);
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        vm.resumeGasMetering();

        IRegistry[] memory v = new IRegistry[](4);
        v[1] = testRegistry;
        v[2] = ethRegistry;
        v[3] = rootRegistry;
        _expectFind(name, 9, address(testRegistry), v, ""); // 3sub4test
    }

    function test_findResolver_virtual() external {
        bytes memory name = NameCoder.encode("a.bb.test.eth");
        //     name:  a . bb . test . eth
        // registry:          <test> <eth> <root>
        // resolver:                   X
        vm.pauseGasMetering();
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, resolverAddress);
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        vm.resumeGasMetering();

        IRegistry[] memory v = new IRegistry[](5);
        v[2] = testRegistry;
        v[3] = ethRegistry;
        v[4] = rootRegistry;
        _expectFind(name, 10, address(0), v, ""); // 1a2bb4test
    }

    function test_findCanonicalName() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        PermissionedRegistry subRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        _register(testRegistry, "sub", address(this), subRegistry, address(0));
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, rootRegistry),
            NameCoder.encode(""),
            "<root>"
        );
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, ethRegistry),
            NameCoder.encode("eth"),
            "eth"
        );
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, testRegistry),
            NameCoder.encode("test.eth"),
            "test"
        );
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, subRegistry),
            NameCoder.encode("sub.test.eth"),
            "sub"
        );
    }

    function test_findCanonicalRegistry() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        PermissionedRegistry subRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        _register(testRegistry, "sub", address(this), subRegistry, address(0));
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode(""))),
            address(rootRegistry),
            "<root>"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("eth"))),
            address(ethRegistry),
            "eth"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.eth"))),
            address(testRegistry),
            "test"
        );
        assertEq(
            address(
                LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("sub.test.eth"))
            ),
            address(subRegistry),
            "sub"
        );
    }

    function test_findCanonicalRegistry_emptyName() external {
        vm.expectRevert(abi.encodeWithSelector(NameCoder.DNSDecodingFailed.selector, ""));
        this._findCanonicalRegistry("");
    }

    function test_findCanonicalRegistry_invalidName() external {
        bytes memory name = new bytes(2);
        vm.expectRevert(abi.encodeWithSelector(NameCoder.DNSDecodingFailed.selector, name));
        this._findCanonicalRegistry(name);
    }

    function _findCanonicalRegistry(bytes calldata name) external view {
        LibResolution.findCanonicalRegistry(rootRegistry, name);
    }

    function test_findCanonical_wrongRegistry() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        ethRegistry.setParent(IRegistry(address(0)), "eth"); // wrong
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, testRegistry),
            "",
            "findCanonicalName"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.eth"))),
            address(0),
            "findCanonicalRegistry"
        );
    }

    function test_findCanonical_wrongLabel() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        ethRegistry.setParent(IRegistry(address(0)), "xyz"); // wrong
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, testRegistry),
            "",
            "findCanonicalName"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.eth"))),
            address(0),
            "findCanonicalRegistry"
        );
    }

    function test_findCanonical_wrongChild() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        uint256 tokenId = _register(ethRegistry, "test", address(this), testRegistry, address(0));
        ethRegistry.setSubregistry(tokenId, IRegistry(address(0))); // wrong
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, testRegistry),
            "",
            "findCanonicalName"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.eth"))),
            address(0),
            "findCanonicalRegistry"
        );
    }

    function test_findCanonical_aliased() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, testRegistry),
            NameCoder.encode("test.eth"),
            "eth"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.eth"))),
            address(testRegistry),
            "eth:test.eth"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.xyz"))),
            address(0),
            "eth:test.xyz"
        );
        _register(rootRegistry, "xyz", address(this), ethRegistry, address(0));
        assertEq(
            LibResolution.findCanonicalName(rootRegistry, testRegistry),
            NameCoder.encode("test.xyz"),
            "xyz"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.xyz"))),
            address(testRegistry),
            "xyz:test.xyz"
        );
        assertEq(
            address(LibResolution.findCanonicalRegistry(rootRegistry, NameCoder.encode("test.eth"))),
            address(0),
            "xyz:test.eth"
        );
    }

    function test_findNearestRegistry() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));

        _findNearestRegistry("");
        _findNearestRegistry("eth");
        _findNearestRegistry("dne");
        _findNearestRegistry("dne.eth");
        _findNearestRegistry("test.eth");
        _findNearestRegistry("dne.test.eth");
        _findNearestRegistry("sub.dne.test.eth");
    }

    function _findNearestRegistry(string memory ens) internal view {
        bytes memory name = NameCoder.encode(ens);
        (IRegistry registry, uint256 offset) =
            LibResolution.findNearestRegistry(rootRegistry, name, 0);
        assertEq(
            address(registry),
            address(LibResolution.findExactRegistry(rootRegistry, name, offset)),
            ens
        );
    }

    function test_findNearestRegistry_specific() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        PermissionedRegistry subRegistry1 = _createRegistry();
        PermissionedRegistry subRegistry2 = _createRegistry();
        PermissionedRegistry subRegistry3 = _createRegistry();

        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "sub", address(this), subRegistry1, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));
        _register(testRegistry, "sub", address(this), subRegistry2, address(0));
        _register(subRegistry1, "sub", address(this), subRegistry3, address(0));

        {
            (IRegistry registry, uint256 offset) =
                LibResolution.findNearestRegistry(
                    rootRegistry,
                    NameCoder.encode("sub.dne.test.eth"),
                    0
                );
            assertEq(address(registry), address(testRegistry), "registry@1");
            assertEq(offset, 8, "offset@1"); // 3sub3dne
        }
        {
            (IRegistry registry, uint256 offset) =
                LibResolution.findNearestRegistry(
                    rootRegistry,
                    NameCoder.encode("dne.sub.test.eth"),
                    0
                );
            assertEq(address(registry), address(subRegistry2), "registry@2");
            assertEq(offset, 4, "offset@2"); // 3dne
        }
        {
            (IRegistry registry, uint256 offset) =
                LibResolution.findNearestRegistry(rootRegistry, NameCoder.encode("sub.dne.eth"), 0);
            assertEq(address(registry), address(ethRegistry), "registry@3");
            assertEq(offset, 8, "offset@3"); // 3sub3dne
        }
        {
            (IRegistry registry, uint256 offset) =
                LibResolution.findNearestRegistry(
                    rootRegistry,
                    NameCoder.encode("dne.sub.sub.eth"),
                    0
                );
            assertEq(address(registry), address(subRegistry3), "registry@3");
            assertEq(offset, 4, "offset@3"); // 3dne
        }
    }

    function test_findExactOwner() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", actor, testRegistry, address(0));

        _findExactOwner("", address(0));
        _findExactOwner("eth", address(this));
        _findExactOwner("dne", address(0));
        _findExactOwner("dne.eth", address(0));
        _findExactOwner("test.eth", actor);
        _findExactOwner("dne.test.eth", address(0));
    }

    function _findExactOwner(string memory ens, address expect) internal view {
        assertEq(LibResolution.findExactOwner(rootRegistry, NameCoder.encode(ens), 0), expect, ens);
    }

    function test_findNearestOwner() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();
        _register(rootRegistry, "eth", address(this), ethRegistry, address(0));
        _register(ethRegistry, "test", address(this), testRegistry, address(0));

        _findNearestOwner("");
        _findNearestOwner("eth");
        _findNearestOwner("dne");
        _findNearestOwner("dne.eth");
        _findNearestOwner("test.eth");
        _findNearestOwner("dne.test.eth");
        _findNearestOwner("sub.dne.test.eth");
    }

    function _findNearestOwner(string memory ens) internal view {
        bytes memory name = NameCoder.encode(ens);
        (address owner, uint256 offset) = LibResolution.findNearestOwner(rootRegistry, name, 0);
        assertEq(owner, LibResolution.findExactOwner(rootRegistry, name, offset), ens);
    }

    function test_findNearestOwner_specific() external {
        PermissionedRegistry ethRegistry = _createRegistry();
        PermissionedRegistry testRegistry = _createRegistry();

        _register(rootRegistry, "eth", address(1), ethRegistry, address(0));
        _register(ethRegistry, "sub", address(2), IRegistry(address(0)), address(0));
        _register(ethRegistry, "test", address(3), testRegistry, address(0));
        _register(testRegistry, "sub", address(4), IRegistry(address(0)), address(0));

        {
            bytes memory name = NameCoder.encode("sub.dne.eth");
            (address owner, uint256 offset) = LibResolution.findNearestOwner(rootRegistry, name, 0);
            assertEq(owner, address(1), "owner@1");
            assertEq(offset, 8, "offset@1"); // 3sub3dne
            assertEq(owner, LibResolution.findExactOwner(rootRegistry, name, offset), "exact@1");
        }
        {
            bytes memory name = NameCoder.encode("dne.sub.sub.eth");
            (address owner, uint256 offset) = LibResolution.findNearestOwner(rootRegistry, name, 0);
            assertEq(owner, address(2), "owner@2");
            assertEq(offset, 8, "offset@2"); // 3sub3dne
            assertEq(owner, LibResolution.findExactOwner(rootRegistry, name, offset), "exact@2");
        }
        {
            bytes memory name = NameCoder.encode("sub.dne.test.eth");
            (address owner, uint256 offset) = LibResolution.findNearestOwner(rootRegistry, name, 0);
            assertEq(owner, address(3), "owner@3");
            assertEq(offset, 8, "offset@3"); // 3sub3dne
            assertEq(owner, LibResolution.findExactOwner(rootRegistry, name, offset), "exact@3");
        }
        {
            bytes memory name = NameCoder.encode("dne.sub.test.eth");
            (address owner, uint256 offset) = LibResolution.findNearestOwner(rootRegistry, name, 0);
            assertEq(owner, address(4), "owner@4");
            assertEq(offset, 4, "offset@4"); // 3dne
            assertEq(owner, LibResolution.findExactOwner(rootRegistry, name, offset), "exact@4");
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _createRegistry() internal returns (PermissionedRegistry) {
        return new PermissionedRegistry(labelStore, address(this), EACBaseRolesLib.ALL_ROLES);
    }

    function _register(
        PermissionedRegistry parentRegistry,
        string memory label,
        address owner,
        IRegistry registry,
        address resolver
    )
        internal
        returns (uint256 tokenId)
    {
        tokenId = parentRegistry.register(
            label,
            owner,
            registry,
            resolver,
            EACBaseRolesLib.ALL_ROLES,
            uint64(block.timestamp + 1000)
        );
        if (ERC165Checker.supportsInterface(address(registry), type(IStandardRegistry).interfaceId)) {
            IStandardRegistry(address(registry)).setParent(parentRegistry, label);
        }
    }
}
