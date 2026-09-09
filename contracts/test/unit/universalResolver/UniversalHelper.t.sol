// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {BytesUtils} from "@ens/contracts/utils/BytesUtils.sol";

import {IRegistry} from "~src/registry/interfaces/IRegistry.sol";
import {V2Fixture} from "~test/fixtures/V2Fixture.sol";

// NOTE: most of these tests are covered by LibResolution.t.sol
contract UniversalHelperTest is V2Fixture {
    function setUp() external {
        deployV2Fixture();
    }

    function test_findExactOwner() external {
        assertEq(universalHelper.findExactOwner(NameCoder.encode("")), address(0));
        assertEq(universalHelper.findExactOwner(NameCoder.encode("eth")), address(this));
        ethRegistry.register(
            "test",
            address(1),
            IRegistry(address(0)),
            address(0),
            0,
            type(uint64).max
        );
        assertEq(universalHelper.findExactOwner(NameCoder.encode("test.eth")), address(1));
        assertEq(universalHelper.findExactOwner(NameCoder.encode("sub.test.eth")), address(0));
    }

    function test_findNearestOwner() external view {
        _findNearestOwner("");
        _findNearestOwner("eth");
        _findNearestOwner("test.eth");
        _findNearestOwner("sub.test.eth");
    }

    function _findNearestOwner(string memory ens) internal view {
        bytes memory name = NameCoder.encode(ens);
        (address owner, uint256 offset) = universalHelper.findNearestOwner(name);
        assertEq(
            owner,
            universalHelper.findExactOwner(BytesUtils.substring(name, offset, name.length - offset))
        );
    }

    function test_findCanonicalName() external view {
        assertEq(universalHelper.findCanonicalName(rootRegistry), NameCoder.encode(""));
        assertEq(universalHelper.findCanonicalName(ethRegistry), NameCoder.encode("eth"));
    }

    function test_findCanonicalRegistry() external view {
        assertEq(
            address(universalHelper.findCanonicalRegistry(NameCoder.encode(""))),
            address(rootRegistry)
        );
        assertEq(
            address(universalHelper.findCanonicalRegistry(NameCoder.encode("eth"))),
            address(ethRegistry)
        );
    }

    function test_findNearestRegistry() external view {
        _findNearestRegistry("");
        _findNearestRegistry("eth");
        _findNearestRegistry("test.eth");
        _findNearestRegistry("sub.test.eth");
    }

    function _findNearestRegistry(string memory ens) internal view {
        bytes memory name = NameCoder.encode(ens);
        (IRegistry registry, uint256 offset) = universalHelper.findNearestRegistry(name);
        assertEq(
            address(registry),
            address(
                universalHelper.findExactRegistry(
                    BytesUtils.substring(name, offset, name.length - offset)
                )
            )
        );
    }

    function test_findExactRegistry() external view {
        assertEq(
            address(universalHelper.findExactRegistry(NameCoder.encode(""))),
            address(rootRegistry)
        );
        assertEq(
            address(universalHelper.findExactRegistry(NameCoder.encode("eth"))),
            address(ethRegistry)
        );
    }

    function test_findParentRegistry() external view {
        assertEq(address(universalHelper.findParentRegistry(NameCoder.encode(""))), address(0));
        assertEq(
            address(universalHelper.findParentRegistry(NameCoder.encode("eth"))),
            address(rootRegistry)
        );
    }

    function test_findRegistries() external view {
        IRegistry[] memory v = universalHelper.findRegistries(NameCoder.encode("eth"));
        assertEq(address(v[0]), address(ethRegistry));
        assertEq(address(v[1]), address(rootRegistry));
    }
}
