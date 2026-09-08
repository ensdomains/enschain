// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {RegistryUtils} from "@ens/contracts/universalResolver/RegistryUtils.sol";

import {PermissionedRegistry} from "~src/registry/PermissionedRegistry.sol";
import {EACBaseRolesLib} from "~src/access-control/libraries/EACBaseRolesLib.sol";
import {LibRegistry} from "~src/universalResolver/libraries/LibRegistry.sol";
import {V1Fixture} from "~test/fixtures/V1Fixture.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";

contract FindResolverTest is V1Fixture, V2Fixture {
    uint256 constant N = 10;
    string constant LABEL = "a";

    function setUp() external {
        deployV1Fixture();
        deployV2Fixture();

        PermissionedRegistry parent = rootRegistry;
        bytes32 node;
        bytes32 labelHash = keccak256(bytes(LABEL));
        for (uint160 i; i < N; ++i) {
            PermissionedRegistry child =
                new PermissionedRegistry(labelStore, address(this), EACBaseRolesLib.ALL_ROLES);
            address resolver = address(i + 1);
            parent.register(
                LABEL,
                address(this),
                child,
                resolver,
                EACBaseRolesLib.ALL_ROLES,
                type(uint64).max
            );
            parent = child;
            registryV1.setSubnodeRecord(node, labelHash, address(this), resolver, 0);
            node = NameCoder.namehash(node, labelHash);
        }
    }

    function test_findResolver() external view {
        bytes memory name = new bytes(1);
        for (uint160 i; i < N; ++i) {
            bytes memory childName = name;
            for (uint256 j; j < 3; j++) {
                (address resolver1, bytes32 node1, uint256 offset1) =
                    RegistryUtils.findResolver(registryV1, childName, 0);
                (, address resolver2, bytes32 node2, uint256 offset2) =
                    LibRegistry.findResolver(rootRegistry, childName, 0);
                assertEq(resolver1, address(i), "resolver[i]");
                assertEq(resolver1, resolver2, "resolver");
                assertEq(node1, node2, "node");
                assertEq(offset1, offset2, "offset");
                childName = NameCoder.addLabel(childName, string.concat(LABEL, LABEL));
            }
            name = NameCoder.addLabel(name, LABEL);
        }
    }
}
