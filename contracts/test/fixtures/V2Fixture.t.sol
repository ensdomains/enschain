// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {V2Fixture} from "./V2Fixture.sol";

contract V2FixtureTest is V2Fixture {
    address user = makeAddr("user");

    function setUp() external {
        deployV2Fixture();
    }

    function test_computeVerifiableFactoryAddress(uint256 salt) external {
        assertEq(
            verifiableFactory.deployProxy(address(this), salt, ""),
            _computeVerifiableFactoryAddress(address(this), salt)
        );
    }
}
