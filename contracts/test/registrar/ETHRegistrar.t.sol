// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import "src/registry/ETHRegistry.sol";
import "src/registry/RegistryDatastore.sol";
import {ETHRegistrar, InsufficientValue, CommitmentTooNew, CommitmentTooOld} from "src/registrar/ETHRegistrar.sol";
import {DummyOracle} from "src/registrar/DummyOracle.sol";
import {ExponentialPremiumPriceOracle} from "src/registrar/ExponentialPremiumPriceOracle.sol";
import {IPriceOracle} from "src/registrar/IPriceOracle.sol";
import {AggregatorInterface} from "src/registrar/StablePriceOracle.sol";

contract TestETHRegistrar is Test, ERC1155Holder {
    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    RegistryDatastore datastore;
    ETHRegistry registry;
    ETHRegistrar registrar;
    DummyOracle usdPriceOracle;
    IPriceOracle priceOracle;
    uint256 currentTime = 1725513923;
    uint256 minCommitAge = 1 minutes;
    uint256 startingBalance;

    receive() external payable {}

    function setUp() public {
        startingBalance = address(this).balance;
        // Warp time to roughly current time
        vm.warp(currentTime);

        datastore = new RegistryDatastore();
        registry = new ETHRegistry(datastore);
        usdPriceOracle = new DummyOracle(1);
        uint256[] memory prices = new uint256[](5);
        prices[0] = 1;
        prices[1] = 2;
        prices[2] = 3;
        prices[3] = 4;
        prices[4] = 5;
        priceOracle = new ExponentialPremiumPriceOracle(
            AggregatorInterface(address(usdPriceOracle)),
            prices,
            1000000000000000000,
            365
        );
        registrar = new ETHRegistrar(registry, priceOracle, 1 minutes, 7 days);
        // Grant access to the registry to this contract
        registry.grantRole(registry.REGISTRAR_ROLE(), address(this));
        // Grant access to the registry to the registrar
        registry.grantRole(registry.REGISTRAR_ROLE(), address(registrar));
    }

    function test_commit() public {
        bytes32 expectedCommitment = keccak256("test");
        registrar.commit(expectedCommitment);
        assertEq(registrar.commitments(expectedCommitment), block.timestamp);
    }

    function test_commit_event() public {
        bytes32 commitment = keccak256("test");

        vm.expectEmit(true, true, true, true);
        emit ETHRegistrar.CommitmentMade(commitment);

        registrar.commit(commitment);
    }

    function test_register() public {
        bytes32 secret = keccak256("secret");
        string memory label = "test";
        uint64 duration = 365 days;
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        registrar.commit(commitment);
        vm.warp(currentTime + minCommitAge);
        IPriceOracle.Price memory price = registrar.rentPrice(label, duration);
        registrar.register{value: price.base + price.premium}(
            label,
            address(this),
            duration,
            secret
        );
        assertEq(
            registry.ownerOf(uint256(keccak256(bytes(label)))),
            address(this)
        );
    }

    function test_register_uncommitted() public {
        bytes32 secret = keccak256("secret");
        string memory label = "test";
        uint64 duration = 365 days;
        IPriceOracle.Price memory price = registrar.rentPrice(label, duration);
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        vm.expectRevert(
            abi.encodeWithSelector(CommitmentTooOld.selector, commitment)
        );
        registrar.register{value: price.base + price.premium}(
            label,
            address(this),
            duration,
            secret
        );
    }

    function test_register_valueProvidedNotEnough() public {
        bytes32 secret = keccak256("secret");
        string memory label = "test";
        uint64 duration = 365 days;
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        registrar.commit(commitment);
        vm.warp(currentTime + minCommitAge);
        vm.expectRevert(InsufficientValue.selector);
        registrar.register{value: 1}(label, address(this), duration, secret);
    }

    function test_register_excessValue() public {
        bytes32 secret = keccak256("secret");
        string memory label = "test";
        uint64 duration = 365 days;
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        registrar.commit(commitment);
        vm.warp(currentTime + minCommitAge);
        IPriceOracle.Price memory price = registrar.rentPrice(label, duration);
        registrar.register{value: price.base + price.premium + 10000}(
            label,
            address(this),
            duration,
            secret
        );

        assertEq(address(registrar).balance, price.base + price.premium);
        assertEq(
            address(this).balance,
            startingBalance - (price.base + price.premium)
        );
    }

    function test_register_emitsEvent() public {
        bytes32 secret = keccak256("secret");
        string memory label = "test";
        uint64 duration = 365 days;
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        registrar.commit(commitment);
        vm.warp(currentTime + minCommitAge);
        IPriceOracle.Price memory price = registrar.rentPrice(label, duration);

        vm.expectEmit(address(registrar));
        emit ETHRegistrar.NameRegistered(
            label,
            keccak256(bytes(label)),
            address(this),
            price.base,
            price.premium,
            uint64(block.timestamp) + duration
        );

        registrar.register{value: price.base + price.premium}(
            label,
            address(this),
            duration,
            secret
        );
    }

    function test_renew() public {
        bytes32 secret = keccak256("secret");
        string memory label = "test";
        uint64 duration = 365 days;
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        registrar.commit(commitment);
        vm.warp(currentTime + minCommitAge);
        IPriceOracle.Price memory price = registrar.rentPrice(label, duration);
        registrar.register{value: price.base + price.premium}(
            label,
            address(this),
            duration,
            secret
        );
        vm.warp(currentTime + minCommitAge + duration);
        IPriceOracle.Price memory price2 = registrar.rentPrice(label, duration);
        registrar.renew{value: price2.base + price2.premium}(label, duration);
        (uint64 currentExpiry, ) = registry.nameData(
            uint256(keccak256(bytes(label)))
        );
        assertEq(currentExpiry, uint64(block.timestamp) + duration);
    }

    function test_withdraw() public {
        // Setup: Register a name to add funds to the contract
        bytes32 secret = keccak256("secret");
        string memory label = "withdrawtest";
        uint64 duration = 365 days;
        bytes32 commitment = registrar.makeCommitment(
            label,
            address(this),
            duration,
            secret
        );
        registrar.commit(commitment);
        vm.warp(currentTime + minCommitAge);
        IPriceOracle.Price memory price = registrar.rentPrice(label, duration);
        registrar.register{value: price.base + price.premium}(
            label,
            address(this),
            duration,
            secret
        );

        // Get the initial balance of the contract
        uint256 initialBalance = address(registrar).balance;
        assertGt(initialBalance, 0, "Contract should have a balance");

        // Get the initial balance of the owner
        address owner = registrar.owner();
        uint256 ownerInitialBalance = owner.balance;

        // Call withdraw as the owner
        vm.prank(address(0x1234));
        registrar.withdraw();

        // Check that the contract balance is now 0
        assertEq(
            address(registrar).balance,
            0,
            "Contract balance should be 0 after withdrawal"
        );

        // Check that the owner's balance increased by the contract's initial balance
        assertEq(
            owner.balance,
            ownerInitialBalance + initialBalance,
            "Owner should receive the full contract balance"
        );
    }
}
