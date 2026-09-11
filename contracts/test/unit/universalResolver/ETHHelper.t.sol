// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {ETHHelper} from "~src/universalResolver/ETHHelper.sol";
import {LibLabel} from "~src/utils/LibLabel.sol";
import {MigrationControllerFixture} from "~test/fixtures/MigrationControllerFixture.sol";
import {StandardRegistrar} from "~test/StandardRegistrar.sol";

contract ETHHelperTest is MigrationControllerFixture {
    ETHHelper ethHelper;

    function setUp() external {
        deployMigrationControllerFixture();

        ethHelper = new ETHHelper(
            nameWrapper,
            rootRegistry,
            contractNamer,
            StandardRegistrar.GRACE_PERIOD_V2
        );
    }

    function test_getState_unregistered() external view {
        (ETHHelper.State memory state, uint256 blockNumber, uint64 timestamp) =
            ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.AVAILABLE), "status");
        assertEq(state.owner, address(0), "owner");
        assertEq(state.manager, address(0), "manager");
        assertEq(address(state.subregistry), address(0), "registry");
        assertEq(state.expiry, 0, "expiry");
        assertEq(state.tokenId, LibLabel.withVersion(LibLabel.id("test"), 0), "tokenId");
        assertEq(blockNumber, block.number, "block");
        assertEq(timestamp, block.timestamp, "time");
    }

    function test_getState_unwrapped() external {
        (, uint256 tokenIdV1) = registerUnwrapped("test");
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.UNWRAPPED), "status");
        assertEq(state.owner, testOwner, "owner");
        assertEq(state.manager, testOwner, "manager");
        assertEq(address(state.subregistry), address(0), "registry");
        assertEq(state.expiry, block.timestamp + testDuration, "expiry");
        assertEq(state.tokenId, tokenIdV1, "tokenId");
    }

    function test_getState_wrapped() external {
        bytes memory name = registerWrappedETH2LD("test", 0);
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.WRAPPED), "status");
        assertEq(state.owner, testOwner, "owner");
        assertEq(state.manager, address(nameWrapper), "manager");
        assertEq(address(state.subregistry), address(0), "registry");
        assertEq(state.expiry, block.timestamp + testDuration, "expiry");
        assertEq(state.tokenId, uint256(NameCoder.namehash(name, 0)), "tokenId");
    }

    function test_getState_registered() external {
        uint64 expiry = uint64(block.timestamp) + testDuration;
        uint256 tokenId =
            ethRegistry.register("test", address(testOwner), testRegistry, address(0), 0, expiry);
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.REGISTERED), "status");
        assertEq(state.owner, testOwner, "owner");
        assertEq(state.manager, address(0), "manager");
        assertEq(address(state.subregistry), address(testRegistry), "registry");
        assertEq(state.expiry, expiry, "expiry");
        assertEq(state.tokenId, tokenId, "tokenId");
    }

    function test_getState_graceV1_start() external {
        uint64 expiry = uint64(block.timestamp) + testDuration;
        registerUnwrapped("test");
        vm.warp(expiry);
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.GRACE_V1), "status");
        assertEq(state.expiry, expiry + StandardRegistrar.BONUS_PERIOD, "expiry");
        assertEq(state.owner, address(0), "owner");
    }

    function test_getState_graceV1_end() external {
        uint64 expiry = uint64(block.timestamp) + testDuration;
        registerUnwrapped("test");
        vm.warp(expiry + gracePeriodV1 - 1);
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.GRACE_V1), "status");
        assertEq(state.expiry, expiry + StandardRegistrar.BONUS_PERIOD, "expiry");
        assertEq(state.owner, address(0), "owner");
    }

    function test_getState_graceV2_start() external {
        uint64 expiry = uint64(block.timestamp) + testDuration;
        ethRegistry.register("test", address(testOwner), testRegistry, address(0), 0, expiry);
        vm.warp(expiry);
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.GRACE_V2), "status");
        assertEq(state.expiry, expiry, "expiry");
    }

    function test_getState_graceV2_end() external {
        uint64 expiry = uint64(block.timestamp) + testDuration;
        ethRegistry.register("test", address(testOwner), testRegistry, address(0), 0, expiry);
        vm.warp(expiry + StandardRegistrar.GRACE_PERIOD_V2 - 1);
        (ETHHelper.State memory state, , ) = ethHelper.getState("test");
        assertEq(uint8(state.status), uint8(ETHHelper.Status.GRACE_V2), "status");
        assertEq(state.expiry, expiry, "expiry");
    }
}
