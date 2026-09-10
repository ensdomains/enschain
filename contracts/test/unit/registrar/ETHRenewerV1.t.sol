// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {console} from "forge-std/Test.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IBaseRegistrar} from "@ens/contracts/ethregistrar/IBaseRegistrar.sol";

import {LibLabel} from "~src/utils/LibLabel.sol";
import {IRegistryEvents} from "~src/registry/interfaces/IRegistryEvents.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {IETHRenewer, RenewData} from "~src/registrar/interfaces/IETHRenewer.sol";
import {ETHRenewerV1} from "~src/registrar/ETHRenewerV1.sol";
import {MigrationControllerFixture} from "~test/fixtures/MigrationControllerFixture.sol";
import {StandardRentPriceOracleFixture} from "~test/fixtures/StandardRentPriceOracleFixture.sol";
import {MockERC20} from "~test/mocks/MockERC20.sol";
import {StandardRegistrar} from "~test/StandardRegistrar.sol";

// [gas analysis]
// test_renew(): 80798
// test_syncWrapper_unwrapped(): 25412
// test_syncWrapper_wrapped():
//   N | Gas
//   0 | 8904
//   1 | 24626
//   2 | 31342
//   3 | 42558
//   4 | 53787
//   5 | 65019

contract ETHRenewerV1Test is MigrationControllerFixture, StandardRentPriceOracleFixture {
    ETHRenewerV1 ethRenewerV1;

    bytes32 testReferrer = keccak256("referrer");
    MockERC20 testPaymentToken;

    function setUp() external {
        deployMigrationControllerFixture();
        deployStandardRentPriceOracleFixture();

        ethRenewerV1 = new ETHRenewerV1(
            address(this),
            ethRegistry,
            beneficiary,
            rentPriceOracle,
            StandardRegistrar.GRACE_PERIOD_V2,
            StandardRegistrar.BONUS_PERIOD,
            nameWrapper,
            address(wrappedController)
        );

        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_RENEW, address(ethRenewerV1));

        baseRegistrar.addController(address(ethRenewerV1));
        baseRegistrar.transferOwnership(address(ethRenewerV1));
        nameWrapper.renounceOwnership();

        // note: nameWrapper is still baseRegistrar controller, see: _activateV2()

        setupPaymentTokens(testOwner, address(ethRenewerV1));
        testPaymentToken = tokenUSDC;
        testDuration = ethRenewerV1.MIN_RENEW_DURATION();

        assertEq(
            StandardRegistrar.GRACE_PERIOD_V2 + StandardRegistrar.BONUS_PERIOD,
            gracePeriodV1,
            "invariant: graceV2 + bonus == graceV1"
        );
    }

    function test_constructor() external view {
        assertEq(ethRenewerV1.GRACE_PERIOD(), gracePeriodV1, "GRACE_PERIOD");
        assertEq(address(ethRenewerV1.NAME_WRAPPER()), address(nameWrapper), "NAME_WRAPPER");
        assertEq(address(ethRenewerV1.BASE_REGISTRAR()), address(baseRegistrar), "BASE_REGISTRAR");
        assertEq(
            address(ethRenewerV1.WRAPPED_CONTROLLER()),
            address(wrappedController),
            "WRAPPED_CONTROLLER"
        );
    }

    function test_transferRegistrarOwnership() external {
        ethRenewerV1.transferRegistrarOwnership(actor);
        assertEq(baseRegistrar.owner(), actor);
    }

    function test_transferRegistrarOwnership_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, actor));
        vm.prank(actor);
        ethRenewerV1.transferRegistrarOwnership(actor);
    }

    function test_setRegistrarResolver() external {
        assertEq(registryV1.resolver(NameCoder.ETH_NODE), address(ensV2Resolver));

        ethRenewerV1.setRegistrarResolver(address(1));

        assertEq(registryV1.resolver(NameCoder.ETH_NODE), address(1));
    }

    function test_setRegistrarResolver_notAuthorized() external {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, actor));
        vm.prank(actor);
        ethRenewerV1.setRegistrarResolver(address(1));
    }

    ////////////////////////////////////////////////////////////////////////
    // renew()
    ////////////////////////////////////////////////////////////////////////

    function test_isRenewable_unregistered() external view {
        assertFalse(ethRenewerV1.isRenewable(testLabel));
    }

    function test_renew() external {
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        uint256 tokenId = LibLabel.withVersion(tokenIdV1, 0);
        uint64 newExpiry = ethRegistry.getExpiry(tokenId) + testDuration;
        uint256 amount = ethRenewerV1.getRenewPrice(testLabel, testDuration, testPaymentToken);
        vm.expectEmit();
        emit IRegistryEvents.ExpiryUpdated(tokenId, newExpiry, address(ethRenewerV1));
        vm.expectEmit();
        emit IBaseRegistrar.NameRenewed(tokenIdV1, newExpiry - premigrationBonusPeriod);
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
        ethRenewerV1.renew(RenewData(testLabel, testDuration, testReferrer), testPaymentToken);
        g -= gasleft();
        console.log("Gas: %s", g);
    }

    function test_renew_registered(uint32 duration) external {
        vm.assume(duration >= ethRenewerV1.MIN_RENEW_DURATION());
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.REGISTERED), "status0");
        assertTrue(ethRenewerV1.isRenewable(testLabel), "isRenewable");
        assertEq(ethRenewerV1.getRemainingGracePeriod(testLabel), 0, "remaining");

        uint256 expiryV1 = baseRegistrar.nameExpires(tokenIdV1);
        uint64 expiryV2 = ethRegistry.getExpiry(tokenIdV1);
        testDuration = duration;
        this.renew();

        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.REGISTERED), "status"); // same
        assertEq(baseRegistrar.nameExpires(tokenIdV1), expiryV1 + duration, "expiryV1");
        assertEq(ethRegistry.getExpiry(tokenIdV1), expiryV2 + duration, "expiryV2");
        assertEq(
            baseRegistrar.nameExpires(tokenIdV1) + premigrationBonusPeriod,
            ethRegistry.getExpiry(tokenIdV1),
            "sync"
        );
    }

    function test_renew_duringGrace_outOfGrace(uint32 graceDebt) external {
        vm.assume(graceDebt < gracePeriodV1);
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);

        uint256 expiryV1 = baseRegistrar.nameExpires(tokenIdV1);
        uint64 expiryV2 = ethRegistry.getExpiry(tokenIdV1);

        vm.warp(expiryV1 + graceDebt);
        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.GRACE), "status0");
        assertTrue(ethRenewerV1.isRenewable(testLabel), "isRenewable");
        assertEq(
            ethRenewerV1.getRemainingGracePeriod(testLabel),
            gracePeriodV1 - graceDebt,
            "remaining"
        );

        testDuration = gracePeriodV1;
        this.renew();

        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.REGISTERED), "status");
        assertEq(ethRenewerV1.getRemainingGracePeriod(testLabel), 0, "remaining");
        assertEq(baseRegistrar.nameExpires(tokenIdV1), expiryV1 + testDuration, "expiryV1");
        assertEq(ethRegistry.getExpiry(tokenIdV1), expiryV2 + testDuration, "expiryV2");
        assertEq(
            baseRegistrar.nameExpires(tokenIdV1) + premigrationBonusPeriod,
            ethRegistry.getExpiry(tokenIdV1),
            "sync"
        );
    }

    function test_renew_duringGrace_stillInGrace(uint32 graceDebt, uint32 duration) external {
        vm.assume(
            duration >= ethRenewerV1.MIN_RENEW_DURATION() &&
            graceDebt >= duration &&
            graceDebt < gracePeriodV1
        );
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        uint256 expiryV1 = baseRegistrar.nameExpires(tokenIdV1);
        uint64 expiryV2 = ethRegistry.getExpiry(tokenIdV1);

        vm.warp(expiryV1 + graceDebt);
        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.GRACE), "status0");
        assertTrue(ethRenewerV1.isRenewable(testLabel), "isRenewable");

        testDuration = duration;
        this.renew();

        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.GRACE), "status"); // still
        assertEq(
            ethRenewerV1.getRemainingGracePeriod(testLabel),
            gracePeriodV1 - (graceDebt - duration),
            "remaining"
        );
        assertEq(baseRegistrar.nameExpires(tokenIdV1), expiryV1 + duration, "expiryV1");
        assertEq(ethRegistry.getExpiry(tokenIdV1), expiryV2 + duration, "expiryV2");
        assertEq(
            baseRegistrar.nameExpires(tokenIdV1) + premigrationBonusPeriod,
            ethRegistry.getExpiry(tokenIdV1),
            "sync"
        );
    }

    function test_renew_afterGrace() external {
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);

        vm.warp(baseRegistrar.nameExpires(tokenIdV1) + gracePeriodV1);
        assertEq(uint8(getStatusV1(tokenIdV1)), uint8(StatusV1.AVAILABLE), "status0");
        assertFalse(ethRenewerV1.isRenewable(testLabel), "isRenewable");
        assertEq(ethRenewerV1.getRemainingGracePeriod(testLabel), 0, "remaining");

        testDuration = ethRenewerV1.MIN_RENEW_DURATION();
        vm.expectRevert(abi.encodeWithSelector(IETHRenewer.NameNotRenewable.selector, testLabel));
        this.renew();
    }

    function test_renew_balanceChanges(uint32 during, uint32 duration) external {
        vm.assume(
            duration >= ethRenewerV1.MIN_RENEW_DURATION() && during < testDuration + gracePeriodV1
        );
        registerUnwrapped(testLabel);
        vm.warp(block.timestamp + during);
        uint256 owner0 = testPaymentToken.balanceOf(testOwner);
        uint256 beneficiary0 = testPaymentToken.balanceOf(beneficiary);
        uint256 amount = ethRenewerV1.getRenewPrice(testLabel, duration, testPaymentToken);
        testDuration = duration;
        this.renew();
        assertEq(owner0 - amount, testPaymentToken.balanceOf(testOwner), "owner");
        assertEq(beneficiary0 + amount, testPaymentToken.balanceOf(beneficiary), "beneficiary");
    }

    function test_renew_durationTooShort() external {
        registerUnwrapped(testLabel);
        uint64 min = ethRenewerV1.MIN_RENEW_DURATION();
        testDuration = min - 1;
        vm.expectRevert(
            abi.encodeWithSelector(IETHRenewer.DurationTooShort.selector, testDuration, min)
        );
        this.renew();
    }

    function test_renew_insufficientAllowance() external {
        registerUnwrapped(testLabel);
        vm.prank(testOwner);
        testPaymentToken.approve(address(ethRenewerV1), 0);
        uint256 amount = ethRenewerV1.getRenewPrice(testLabel, testDuration, testPaymentToken);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector,
                address(ethRenewerV1), // spender
                0, // allowance
                amount // needed
            )
        );
        this.renew();
    }

    function test_renew_insufficientBalance() external {
        registerUnwrapped(testLabel);
        testPaymentToken.nuke(testOwner);
        uint256 amount = ethRenewerV1.getRenewPrice(testLabel, testDuration, testPaymentToken);
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
            string memory label = _label(i);
            registerUnwrapped(label);
            uint64 duration = testDuration + uint64(i);
            rds[i] = RenewData(label, duration, testReferrer);
            total += ethRenewerV1.getRenewPrice(label, duration, testPaymentToken);
        }
        uint256 owner0 = testPaymentToken.balanceOf(testOwner);
        uint256 beneficiary0 = testPaymentToken.balanceOf(beneficiary);
        vm.prank(testOwner);
        uint256 g = gasleft();
        ethRenewerV1.renewBatch(rds, testPaymentToken);
        g -= gasleft();
        console.log("Gas: %s", g);
        assertEq(owner0 - total, testPaymentToken.balanceOf(testOwner), "payer");
        assertEq(beneficiary0 + total, testPaymentToken.balanceOf(beneficiary), "beneficiary");
    }

    function test_renewBatch_repeated() external {
        (, uint256 tokenIdV1) = registerUnwrapped(testLabel);
        RenewData[] memory rds = new RenewData[](2);
        for (uint256 i; i < rds.length; ++i) {
            rds[i] = RenewData(testLabel, testDuration, testReferrer);
        }
        uint256 expiry = baseRegistrar.nameExpires(tokenIdV1);
        vm.prank(testOwner);
        ethRenewerV1.renewBatch(rds, testPaymentToken);
        assertEq(baseRegistrar.nameExpires(tokenIdV1), expiry + testDuration * rds.length);
    }

    ////////////////////////////////////////////////////////////////////////
    // syncWrapper()
    ////////////////////////////////////////////////////////////////////////

    function test_syncWrapper_unwrapped() external {
        registerUnwrapped(testLabel);
        _activateV2(true);
        string[] memory labels = new string[](1);
        labels[0] = testLabel;
        uint256 g = gasleft();
        ethRenewerV1.syncWrapper(labels); // noop
        g -= gasleft();
        console.log("Gas: %s", g);
    }

    function test_syncWrapper_wrapped() external {
        uint256 k;
        console.log("N | Gas");
        for (uint256 n; n <= 5; ++n) {
            string[] memory labels = new string[](n);
            _activateV2(false);
            for (uint256 i; i < n; ++i) {
                string memory label = labels[i] = _label(k++);
                registerWrappedETH2LD(label, 0);
                vm.prank(address(ethControllerV1));
                baseRegistrar.renew(LibLabel.id(label), 10 ** i);
            }
            _activateV2(true);
            uint256 g = gasleft();
            ethRenewerV1.syncWrapper(labels);
            g -= gasleft();
            console.log("%s | %s", n, g);
            for (uint256 i; i < n; ++i) {
                uint256 tokenIdV1 = LibLabel.id(labels[i]);
                (, , uint64 expiry) =
                    nameWrapper.getData(
                        uint256(NameCoder.namehash(NameCoder.ETH_NODE, bytes32(tokenIdV1)))
                    );
                assertEq(baseRegistrar.nameExpires(tokenIdV1) + baseRegistrar.GRACE_PERIOD(), expiry);
            }
        }
    }

    function test_renew_autoSync() external {
        registerWrappedETH2LD(testLabel, 0);
        uint256 tokenIdV1 = LibLabel.id(testLabel);
        vm.prank(address(ethControllerV1));
        baseRegistrar.renew(tokenIdV1, 1);
        _activateV2(true);
        this.renew();
        (, , uint64 expiry) =
            nameWrapper.getData(uint256(NameCoder.namehash(NameCoder.ETH_NODE, bytes32(tokenIdV1))));
        assertEq(baseRegistrar.nameExpires(tokenIdV1) + baseRegistrar.GRACE_PERIOD(), expiry);
    }

    function test_renewBatch_autoSync(uint8 n) external {
        vm.assume(n < 5);
        RenewData[] memory rds = new RenewData[](n);
        for (uint256 i; i < n; ++i) {
            string memory label = _label(i);
            rds[i].label = label;
            rds[i].duration = 1000;
            registerWrappedETH2LD(label, 0);
            vm.prank(address(ethControllerV1));
            baseRegistrar.renew(LibLabel.id(label), 1);
        }
        _activateV2(true);
        vm.prank(testOwner);
        ethRenewerV1.renewBatch(rds, testPaymentToken);
        for (uint256 i; i < n; ++i) {
            uint256 tokenIdV1 = LibLabel.id(rds[i].label);
            (, , uint64 expiry) =
                nameWrapper.getData(
                    uint256(NameCoder.namehash(NameCoder.ETH_NODE, bytes32(tokenIdV1)))
                );
            assertEq(baseRegistrar.nameExpires(tokenIdV1) + baseRegistrar.GRACE_PERIOD(), expiry);
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function renew() external {
        vm.prank(testOwner);
        ethRenewerV1.renew(RenewData(testLabel, testDuration, testReferrer), testPaymentToken);
    }

    function _activateV2(bool on) internal {
        vm.prank(address(ethRenewerV1));
        if (on) {
            baseRegistrar.removeController(address(nameWrapper));
        } else {
            baseRegistrar.addController(address(nameWrapper));
        }
    }
}
