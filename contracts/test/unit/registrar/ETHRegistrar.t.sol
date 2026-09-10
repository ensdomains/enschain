// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {console} from "forge-std/Test.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {InvalidOwner} from "~src/CommonErrors.sol";
import {LibLabel} from "~src/utils/LibLabel.sol";
import {IRegistryEvents} from "~src/registry/interfaces/IRegistryEvents.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {IETHRegistrar} from "~src/registrar/interfaces/IETHRegistrar.sol";
import {IETHRenewer, RenewData} from "~src/registrar/interfaces/IETHRenewer.sol";
import {IRentPriceOracleProvider} from "~src/registrar/interfaces/IRentPriceOracleProvider.sol";
import {ETHRegistrar, REGISTRATION_ROLE_BITMAP} from "~src/registrar/ETHRegistrar.sol";
import {MockERC20, MockERC20Blacklist} from "~test/mocks/MockERC20.sol";
import {MigrationControllerFixture} from "~test/fixtures/MigrationControllerFixture.sol";
import {StandardRentPriceOracleFixture} from "~test/fixtures/StandardRentPriceOracleFixture.sol";
import {StandardRegistrar} from "~test/StandardRegistrar.sol";

// [gas analysis]
// test_commit(): 24420
// test_register(): 165841
// test_renew(): 32012

contract ETHRegistrarTest is MigrationControllerFixture, StandardRentPriceOracleFixture {
    ETHRegistrar ethRegistrar;

    bytes32 testReferrer = keccak256("referrer");
    bytes32 testSecret = keccak256("secret");
    MockERC20 testPaymentToken;
    uint64 testCommitDelay;

    function setUp() external {
        deployMigrationControllerFixture();
        deployStandardRentPriceOracleFixture();

        ethRegistrar = new ETHRegistrar(
            address(this),
            ethRegistry,
            beneficiary,
            rentPriceOracle,
            StandardRegistrar.GRACE_PERIOD_V2,
            StandardRegistrar.MIN_COMMITMENT_AGE,
            StandardRegistrar.MAX_COMMITMENT_AGE,
            StandardRegistrar.MIN_REGISTER_DURATION
        );

        ethRegistry.grantRootRoles(
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW,
            address(ethRegistrar)
        );

        setupPaymentTokens(testOwner, address(ethRegistrar));
        testPaymentToken = tokenUSDC;
        testDuration = ethRegistrar.MIN_REGISTER_DURATION();
        testCommitDelay = ethRegistrar.MIN_COMMITMENT_AGE();

        uint256 t =
            Math.max(gracePeriodV1, ethRegistrar.GRACE_PERIOD()) + rentPriceOracle.PREMIUM_PERIOD();
        if (block.timestamp < t) {
            vm.warp(t); // avoid timestamp issues
        }
    }

    function test_supportsInterface() external view {
        assertTrue(
            ERC165Checker.supportsInterface(address(ethRegistrar), type(IETHRegistrar).interfaceId),
            "IETHRegistrar"
        );
        assertTrue(
            ERC165Checker.supportsInterface(
                address(ethRegistrar),
                type(IRentPriceOracleProvider).interfaceId
            ),
            "IRentPriceOracleProvider"
        );
    }

    function test_constructor() external view {
        assertEq(ethRegistrar.GRACE_PERIOD(), StandardRegistrar.GRACE_PERIOD_V2, "GRACE_PERIOD");
        assertEq(
            ethRegistrar.MIN_COMMITMENT_AGE(),
            StandardRegistrar.MIN_COMMITMENT_AGE,
            "MIN_COMMITMENT_AGE"
        );
        assertEq(
            ethRegistrar.MAX_COMMITMENT_AGE(),
            StandardRegistrar.MAX_COMMITMENT_AGE,
            "MAX_COMMITMENT_AGE"
        );
        assertEq(
            ethRegistrar.MIN_REGISTER_DURATION(),
            StandardRegistrar.MIN_REGISTER_DURATION,
            "MIN_REGISTER_DURATION"
        );
    }

    function test_constructor_emptyRange() external {
        vm.expectRevert(abi.encodeWithSelector(ETHRegistrar.MaxCommitmentAgeTooLow.selector));
        new ETHRegistrar(
            address(this),
            ethRegistry,
            beneficiary,
            rentPriceOracle,
            0,
            1, // minCommitmentAge
            1, // maxCommitmentAge
            0
        );
    }

    function test_constructor_invalidRange() external {
        vm.expectRevert(abi.encodeWithSelector(ETHRegistrar.MaxCommitmentAgeTooLow.selector));
        new ETHRegistrar(
            address(this),
            ethRegistry,
            beneficiary,
            rentPriceOracle,
            0,
            1, // minCommitmentAge
            0, // maxCommitmentAge
            0
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Commit / Reveal
    ////////////////////////////////////////////////////////////////////////

    function test_commit() external {
        bytes32 commitment = _makeCommitment();
        assertEq(
            commitment,
            keccak256(
                abi.encode(
                    testLabel,
                    testOwner,
                    testSecret,
                    testRegistry,
                    testResolver,
                    testDuration,
                    testReferrer
                )
            ),
            "hash"
        );
        vm.expectEmit();
        emit IETHRegistrar.CommitmentMade(commitment);
        uint256 g = gasleft();
        ethRegistrar.commit(commitment);
        g -= gasleft();
        console.log("Gas: %s", g);
        assertEq(ethRegistrar.commitmentAt(commitment), block.timestamp, "time");
    }

    function test_commitmentAt() external {
        bytes32 commitment = bytes32(uint256(1));
        assertEq(ethRegistrar.commitmentAt(commitment), 0, "before");
        ethRegistrar.commit(commitment);
        assertEq(ethRegistrar.commitmentAt(commitment), block.timestamp, "after");
    }

    function test_commit_unexpiredCommitment() external {
        bytes32 commitment = bytes32(uint256(1));
        ethRegistrar.commit(commitment);
        vm.expectRevert(
            abi.encodeWithSelector(IETHRegistrar.UnexpiredCommitmentExists.selector, commitment)
        );
        ethRegistrar.commit(commitment);
    }

    function test_commit_consumed() external {
        bytes32 commitment = _makeCommitment();
        this.register();
        assertEq(ethRegistrar.commitmentAt(commitment), 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // register()
    ////////////////////////////////////////////////////////////////////////

    function test_isAvailable_unregistered() external view {
        assertTrue(ethRegistrar.isAvailable(testLabel));
    }

    function test_register_gas() external {
        delete testRegistry;
        delete testResolver;
        labelStore.setLabel(testLabel);

        ethRegistrar.commit(_makeCommitment());
        vm.warp(block.timestamp + testCommitDelay);

        vm.prank(testOwner);
        uint256 g = gasleft();
        ethRegistrar.register(
            testLabel,
            testOwner,
            testSecret,
            testRegistry,
            testResolver,
            testDuration,
            testPaymentToken,
            testReferrer
        );
        g -= gasleft();
        console.log("Gas: %s", g);
    }

    function test_register(uint32 available, uint32 duration) external {
        vm.assume(
            duration >= ethRegistrar.MIN_REGISTER_DURATION() &&
            available < 2 * rentPriceOracle.PREMIUM_PERIOD()
        );
        vm.warp(ethRegistry.getExpiry(this.register()) + ethRegistrar.GRACE_PERIOD() + available);

        testDuration = duration;
        (uint256 base, uint256 premium) =
            rentPriceOracle.getRegisterPrice(
                testLabel,
                available + testCommitDelay, // commit-reveal
                testDuration,
                testPaymentToken
            );
        uint256 labelId = LibLabel.id(testLabel);
        uint256 tokenId = LibLabel.withVersion(labelId, 1);
        uint64 expiry =
            uint64(block.timestamp) + testDuration + testCommitDelay;
        vm.expectEmit();
        emit IRegistryEvents.LabelRegistered(
            tokenId,
            bytes32(labelId),
            testLabel,
            testOwner,
            expiry,
            address(ethRegistrar)
        );
        vm.expectEmit();
        emit IETHRegistrar.NameRegistered(
            tokenId,
            testLabel,
            testOwner,
            testRegistry,
            testResolver,
            testDuration,
            testPaymentToken,
            testReferrer,
            base,
            premium
        );
        assertEq(this.register(), tokenId, "token");
        assertEq(ethRegistry.ownerOf(tokenId), testOwner, "owner");
        assertEq(ethRegistry.getExpiry(tokenId), expiry, "expiry");
        assertTrue(ethRegistry.hasRoles(tokenId, REGISTRATION_ROLE_BITMAP, testOwner), "roles");
        assertFalse(ethRegistrar.isAvailable(testLabel), "isAvailable");
    }

    function test_register_balanceChanges(uint32 available, uint32 duration) external {
        vm.assume(
            duration >= ethRegistrar.MIN_REGISTER_DURATION() &&
            available < 2 * rentPriceOracle.PREMIUM_PERIOD()
        );
        vm.warp(ethRegistry.getExpiry(this.register()) + ethRegistrar.GRACE_PERIOD() + available);
        uint256 owner0 = testPaymentToken.balanceOf(testOwner);
        uint256 beneficiary0 = testPaymentToken.balanceOf(beneficiary);
        (uint256 base, uint256 premium) =
            rentPriceOracle.getRegisterPrice(
                testLabel,
                available + testCommitDelay, // commit-reveal
                duration,
                testPaymentToken
            );
        testDuration = duration;
        this.register();
        uint256 amount = base + premium;
        assertEq(owner0 - amount, testPaymentToken.balanceOf(testOwner), "owner");
        assertEq(beneficiary0 + amount, testPaymentToken.balanceOf(beneficiary), "beneficiary");
    }

    function test_register_whileRegistered(uint32 duration) external {
        vm.assume(duration < testDuration);
        uint256 tokenId = this.register();
        vm.warp(block.timestamp + duration);
        assertEq(
            uint8(ethRegistry.getStatus(tokenId)),
            uint8(IPermissionedRegistry.Status.REGISTERED),
            "status"
        );
        assertFalse(ethRegistrar.isAvailable(testLabel), "isAvailable");
        assertEq(ethRegistrar.getRemainingGracePeriod(testLabel), 0, "remaining");
    }

    function test_register_duringGrace(uint32 graceDebt) external {
        vm.assume(graceDebt < ethRegistrar.GRACE_PERIOD());
        uint256 tokenId = this.register();
        vm.warp(ethRegistry.getExpiry(tokenId) + graceDebt);
        assertEq(
            uint8(ethRegistry.getStatus(tokenId)),
            uint8(IPermissionedRegistry.Status.AVAILABLE),
            "status"
        );
        assertFalse(ethRegistrar.isAvailable(testLabel), "isAvailable");
        assertEq(
            ethRegistrar.getRemainingGracePeriod(testLabel),
            ethRegistrar.GRACE_PERIOD() - graceDebt,
            "remaining"
        );
    }

    function test_register_afterGrace(uint32 available) external {
        vm.assume(available < rentPriceOracle.PREMIUM_PERIOD() * 2);
        uint256 tokenId = this.register();
        vm.warp(ethRegistry.getExpiry(tokenId) + ethRegistrar.GRACE_PERIOD() + available);
        assertEq(
            uint8(ethRegistry.getStatus(tokenId)),
            uint8(IPermissionedRegistry.Status.AVAILABLE),
            "status"
        );
        assertTrue(ethRegistrar.isAvailable(testLabel), "isAvailable");
        assertEq(ethRegistrar.getRemainingGracePeriod(testLabel), 0, "remaining");
        this.register();
    }

    function test_register_afterPremium() external {
        uint256 tokenId = this.register();
        vm.warp(
            ethRegistry.getExpiry(tokenId) +
            ethRegistrar.GRACE_PERIOD() + rentPriceOracle.PREMIUM_PERIOD()
        );
        (, uint256 premium) =
            rentPriceOracle.getRegisterPrice(
                testLabel,
                type(uint64).max,
                testDuration,
                testPaymentToken
            );
        this.register();
        assertEq(premium, 0, "premium");
    }

    function test_register_insufficientAllowance() external {
        vm.prank(testOwner);
        tokenUSDC.approve(address(ethRegistrar), 0);
        (uint256 base, uint256 premium) =
            ethRegistrar.getRegisterPrice(testLabel, testDuration, testPaymentToken);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(ethRegistrar), // spender
                0, // allowance
                base + premium // needed
            )
        );
        this.register();
    }

    function test_register_insufficientBalance() external {
        testPaymentToken.nuke(testOwner);
        (uint256 base, uint256 premium) =
            rentPriceOracle.getRegisterPrice(
                testLabel,
                type(uint64).max,
                testDuration,
                testPaymentToken
            );
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector,
                testOwner, // sender
                0, // balance
                base + premium // needed
            )
        );
        this.register();
    }

    function test_register_commitmentTooNew() external {
        uint64 dt = 1;
        testCommitDelay = ethRegistrar.MIN_COMMITMENT_AGE() - dt;
        uint256 t = block.timestamp + testCommitDelay;
        vm.expectRevert(
            abi.encodeWithSelector(
                IETHRegistrar.CommitmentTooNew.selector,
                _makeCommitment(),
                t + dt,
                t
            )
        );
        this.register();
    }

    function test_register_commitmentTooOld() external {
        uint64 dt = 1;
        testCommitDelay = ethRegistrar.MAX_COMMITMENT_AGE() + dt;
        uint256 t = block.timestamp + testCommitDelay;
        vm.expectRevert(
            abi.encodeWithSelector(
                IETHRegistrar.CommitmentTooOld.selector,
                _makeCommitment(),
                t - dt,
                t
            )
        );
        this.register();
    }

    function test_register_durationTooShort(uint32 duration) external {
        uint64 min = ethRegistrar.MIN_REGISTER_DURATION();
        vm.assume(duration < min);
        testDuration = duration;
        vm.expectRevert(abi.encodeWithSelector(IETHRenewer.DurationTooShort.selector, duration, min));
        this.register();
    }

    function test_register_nullOwner() external {
        testOwner = address(0);
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector));
        this.register();
    }

    function test_register_registered() external {
        this.register();
        vm.expectRevert(abi.encodeWithSelector(IETHRegistrar.NameNotAvailable.selector, testLabel));
        this.register();
    }

    function test_register_premigrated(uint32 during) external {
        vm.assume(during < testDuration + gracePeriodV1);
        registerUnwrapped(testLabel);
        vm.warp(block.timestamp + during);
        assertFalse(ethRegistrar.isAvailable(testLabel), "isAvailable");
        assertFalse(ethRegistrar.isRenewable(testLabel), "isRenewable");
        vm.expectRevert(abi.encodeWithSelector(IETHRegistrar.NameNotAvailable.selector, testLabel));
        this.register();
    }

    ////////////////////////////////////////////////////////////////////////
    // renew()
    ////////////////////////////////////////////////////////////////////////

    function test_isRenewable_unregistered() external view {
        assertFalse(ethRegistrar.isRenewable(testLabel));
    }

    function test_renew(uint32 duration) external {
        vm.assume(duration >= ethRegistrar.MIN_RENEW_DURATION());
        uint256 tokenId = this.register();
        testDuration = duration;
        uint64 newExpiry = ethRegistry.getExpiry(tokenId) + testDuration;
        uint256 amount = ethRegistrar.getRenewPrice(testLabel, testDuration, testPaymentToken);
        vm.expectEmit();
        emit IRegistryEvents.ExpiryUpdated(tokenId, newExpiry, address(ethRegistrar));
        vm.expectEmit();
        emit IETHRenewer.NameRenewed(
            tokenId,
            testLabel,
            testDuration,
            newExpiry,
            testPaymentToken,
            testReferrer,
            amount
        );
        vm.prank(testOwner);
        uint256 g = gasleft();
        ethRegistrar.renew(RenewData(testLabel, testDuration, testReferrer), testPaymentToken);
        g -= gasleft();
        console.log("Gas: %s", g);
        assertEq(ethRegistry.getExpiry(tokenId), newExpiry);
    }

    function test_renew_balanceChanges(uint32 duration) external {
        vm.assume(duration >= ethRegistrar.MIN_RENEW_DURATION());
        this.register();
        uint256 owner0 = testPaymentToken.balanceOf(testOwner);
        uint256 beneficiary0 = testPaymentToken.balanceOf(beneficiary);
        uint256 amount = ethRegistrar.getRenewPrice(testLabel, duration, testPaymentToken);
        testDuration = duration;
        this.renew();
        assertEq(owner0 - amount, testPaymentToken.balanceOf(testOwner), "owner");
        assertEq(beneficiary0 + amount, testPaymentToken.balanceOf(beneficiary), "beneficiary");
    }

    function test_renew_available() external {
        vm.expectRevert(abi.encodeWithSelector(IETHRenewer.NameNotRenewable.selector, testLabel));
        this.renew();
    }

    function test_renew_duringGrace(uint32 graceDebt) external {
        vm.assume(graceDebt < ethRegistrar.GRACE_PERIOD());
        uint256 tokenId = this.register();
        vm.warp(ethRegistry.getExpiry(tokenId) + graceDebt);
        this.renew();
    }

    function test_renew_afterGrace() external {
        uint256 tokenId = this.register();
        vm.warp(ethRegistry.getExpiry(tokenId) + ethRegistrar.GRACE_PERIOD());
        vm.expectRevert(abi.encodeWithSelector(IETHRenewer.NameNotRenewable.selector, testLabel));
        this.renew();
    }

    function test_renew_durationTooShort() external {
        uint64 min = ethRegistrar.MIN_RENEW_DURATION();
        this.register();
        testDuration = min - 1;
        vm.expectRevert(
            abi.encodeWithSelector(IETHRenewer.DurationTooShort.selector, testDuration, min)
        );
        this.renew();
    }

    function test_renew_insufficientAllowance() external {
        this.register();
        vm.prank(testOwner);
        testPaymentToken.approve(address(ethRegistrar), 0);
        uint256 amount = ethRegistrar.getRenewPrice(testLabel, testDuration, testPaymentToken);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(ethRegistrar), // spender
                0, // allowance
                amount // needed
            )
        );
        this.renew();
    }

    function test_renew_insufficientBalance() external {
        this.register();
        testPaymentToken.nuke(testOwner);
        uint256 amount = ethRegistrar.getRenewPrice(testLabel, testDuration, testPaymentToken);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector,
                testOwner, // sender
                0, // balance
                amount // needed
            )
        );
        this.renew();
    }

    function test_renewBatch(uint8 n) external {
        vm.assume(n < 10);
        RenewData[] memory rds = new RenewData[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            testLabel = _label(i);
            this.register();
            uint64 duration = testDuration + uint64(i);
            rds[i] = RenewData(testLabel, duration, testReferrer);
            total += ethRegistrar.getRenewPrice(testLabel, duration, testPaymentToken);
        }
        uint256 owner0 = testPaymentToken.balanceOf(testOwner);
        uint256 beneficiary0 = testPaymentToken.balanceOf(beneficiary);
        vm.prank(testOwner);
        ethRegistrar.renewBatch(rds, testPaymentToken);
        assertEq(owner0 - total, testPaymentToken.balanceOf(testOwner), "payer");
        assertEq(beneficiary0 + total, testPaymentToken.balanceOf(beneficiary), "beneficiary");
    }

    function test_renewBatch_repeated() external {
        uint256 tokenId = this.register();
        RenewData[] memory rds = new RenewData[](2);
        for (uint256 i; i < rds.length; ++i) {
            rds[i] = RenewData(testLabel, testDuration, testReferrer);
        }
        uint64 expiry = ethRegistry.getExpiry(tokenId);
        vm.prank(testOwner);
        ethRegistrar.renewBatch(rds, testPaymentToken);
        assertEq(ethRegistry.getExpiry(tokenId), expiry + testDuration * rds.length);
    }

    ////////////////////////////////////////////////////////////////////////
    // Payment Processing
    ////////////////////////////////////////////////////////////////////////

    function test_voidReturn_acceptedBySafeERC20() external {
        // register
        testPaymentToken = tokenVoid;
        this.register();

        // renew
        this.renew();
    }

    function test_falseReturn_rejectedBySafeERC20() external {
        // register
        testPaymentToken = tokenFalse;
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, tokenFalse)
        );
        this.register();

        // renew
        testPaymentToken = tokenUSDC;
        this.register();
        testPaymentToken = tokenFalse;
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, tokenFalse)
        );
        this.renew();
    }

    function test_blacklisted_payer() external {
        tokenBlack.setBlacklisted(testOwner, true);

        // register
        testPaymentToken = tokenBlack;
        vm.expectRevert(abi.encodeWithSelector(MockERC20Blacklist.Blacklisted.selector, testOwner));
        this.register();

        // renew
        testPaymentToken = tokenUSDC;
        this.register();
        testPaymentToken = tokenBlack;
        vm.expectRevert(abi.encodeWithSelector(MockERC20Blacklist.Blacklisted.selector, testOwner));
        this.renew();
    }

    function test_blacklisted_beneficiary() external {
        tokenBlack.setBlacklisted(beneficiary, true);

        // register
        testPaymentToken = tokenBlack;
        vm.expectRevert(abi.encodeWithSelector(MockERC20Blacklist.Blacklisted.selector, beneficiary));
        this.register();

        // renew
        testPaymentToken = tokenUSDC;
        this.register();
        testPaymentToken = tokenBlack;
        vm.expectRevert(abi.encodeWithSelector(MockERC20Blacklist.Blacklisted.selector, beneficiary));
        this.renew();
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _makeCommitment() internal view returns (bytes32) {
        return
            ethRegistrar.makeCommitment(
                testLabel,
                testOwner,
                testSecret,
                testRegistry,
                testResolver,
                testDuration,
                testReferrer
            );
    }

    function register() external returns (uint256 tokenId) {
        ethRegistrar.commit(_makeCommitment());
        vm.warp(block.timestamp + testCommitDelay);
        vm.prank(testOwner);
        tokenId = ethRegistrar.register(
            testLabel,
            testOwner,
            testSecret,
            testRegistry,
            testResolver,
            testDuration,
            testPaymentToken,
            testReferrer
        );
    }

    function renew() external {
        vm.prank(testOwner);
        ethRegistrar.renew(RenewData(testLabel, testDuration, testReferrer), testPaymentToken);
    }
}
