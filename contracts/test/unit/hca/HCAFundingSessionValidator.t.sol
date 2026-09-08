// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// solhint-disable private-vars-leading-underscore, func-name-mixedcase

import {Test} from "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ERC1271_MAGICVALUE} from "nexus/types/Constants.sol";
import {Execution} from "nexus/types/DataTypes.sol";

import {
    HCAFundingSessionValidator,
    IRhinestoneClaimRouter
} from "~src/hca/HCAFundingSessionValidator.sol";
import {HCAOperationHashLib} from "~src/hca/libraries/HCAOperationHashLib.sol";
import {HCASignatureLib} from "~src/hca/libraries/HCASignatureLib.sol";
import {HCASmartSessionLib} from "~src/hca/libraries/HCASmartSessionLib.sol";

contract HCAFundingSessionValidatorTest is Test {
    struct ClaimFixture {
        uint256 nonce;
        uint256 deadline;
        uint256 sourceAmount;
        uint256 destinationAmount;
        uint256 fillExpiry;
        uint128 minGas;
        bytes32 originOpsHash;
        bytes32 destinationOpsHash;
        bytes32 qualifierHash;
    }

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 constant PERMIT2_NAME_HASH = keccak256("Permit2");
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant TOKEN_TYPEHASH = keccak256("Token(address token,uint256 amount)");
    bytes32 constant OPS_TYPEHASH = keccak256("Ops(address to,uint256 value,bytes data)");
    bytes32 constant OP_TYPEHASH =
        keccak256("Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)");
    bytes32 constant TARGET_TYPEHASH =
        keccak256(
            "Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)Token(address token,uint256 amount)"
        );
    bytes32 constant MANDATE_TYPEHASH =
        keccak256(
            "Mandate(Target target,uint128 minGas,Op originOps,Op destOps,bytes32 q)Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)Token(address token,uint256 amount)"
        );
    bytes32 constant PERMIT_TYPEHASH =
        keccak256(
            "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,Mandate mandate)Mandate(Target target,uint128 minGas,Op originOps,Op destOps,bytes32 q)Op(bytes32 vt,Ops[] ops)Ops(address to,uint256 value,bytes data)Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)Token(address token,uint256 amount)TokenPermissions(address token,uint256 amount)"
        );

    bytes32 constant SMART_SESSION_DOMAIN_TYPEHASH =
        0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3;
    bytes32 constant SMART_SESSION_NAME_HASH =
        0x909aaff4c04d02fd420ef163a6d750c002b0a00dc41a031ba039e3fdb4732133;
    bytes32 constant SMART_SESSION_VERSION_HASH =
        0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6;
    bytes32 constant SIGNED_SESSION_TYPEHASH =
        0x984917e689987af96289e12c5f5e934fcdf1df4186108f69ff7e8c3df950ce33;
    bytes32 constant CHAIN_SESSION_TYPEHASH =
        0xabc350ff4773ba356e85e2d2ee58d7d7511767acdb108b59058f5b4a5afc074b;
    bytes32 constant MULTI_CHAIN_SESSION_TYPEHASH =
        0xb4323194e4ca3723804b96dc7a0960bde1afff2b080b8b288fdc264c82e21357;
    bytes32 constant DEFAULT_SIGNED_PERMISSIONS_HASH =
        0x242b79d1322c5e6b12b617584cc2d5766cf18be6feb6acfa469ccf289e11e504;

    address constant SMART_SESSION_EMISSARY = 0xad568B3F825A8d5FFc06DD3253526B64D810Ae89;
    address constant OWNABLE_SESSION_VALIDATOR = 0x000000000013fdB5234E4E3162a810F54d9f7E98;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint256 constant OWNER_KEY = 0xA11CE;
    uint256 constant SESSION_KEY = 0x5E5510;
    uint96 constant TOTAL_SOURCE_BUDGET = 40_000_000;
    uint96 constant COMMIT_SOURCE_COST = 10_000_000;
    uint96 constant REVEAL_SOURCE_COST = TOTAL_SOURCE_BUDGET - COMMIT_SOURCE_COST;
    uint64 constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint64 constant ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;

    address owner = vm.addr(OWNER_KEY);
    address sessionKey = vm.addr(SESSION_KEY);
    address nexus = makeAddr("source-nexus");
    address sourceToken = makeAddr("source-token");
    address arbitrumSourceToken = makeAddr("arbitrum-source-token");
    address destinationHca = makeAddr("destination-hca");
    address destinationToken = makeAddr("destination-token");
    address intentExecutor = makeAddr("intent-executor");
    address router = makeAddr("rhinestone-router");
    address arbiter = makeAddr("across-arbiter");

    HCAFundingSessionValidator validator;
    HCAFundingSessionValidator.SessionConfig config;

    function setUp() public {
        vm.chainId(BASE_SEPOLIA_CHAIN_ID);
        validator = new HCAFundingSessionValidator(intentExecutor, PERMIT2, router);
        _setActiveArbiter(arbiter);
        config = HCAFundingSessionValidator.SessionConfig({permissionId: bytes32(0), owner: owner, validUntil: uint48(
            block.timestamp + 1 days
        ), sessionKey: sessionKey, sourceToken: sourceToken, destinationRecipient: destinationHca, destinationToken: destinationToken, destinationChainId: 11_155_111, maxSourceAmount: TOTAL_SOURCE_BUDGET, maxDestinationAmount: 2_000_000});
        config.permissionId = _permissionId(config);
        vm.prank(nexus);
        validator.onInstall(abi.encode(config));
    }

    function test_rejectsInvalidConstructorDependencies() public {
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        new HCAFundingSessionValidator(address(0), PERMIT2, router);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        new HCAFundingSessionValidator(intentExecutor, address(0), router);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        new HCAFundingSessionValidator(intentExecutor, PERMIT2, address(0));
    }

    function test_reportsInstallationAndModuleState() public {
        assertTrue(validator.isInitialized(nexus));
        HCAFundingSessionValidator.SessionConfig memory installed = validator.sessionConfig(nexus);
        assertEq(installed.permissionId, config.permissionId);
        assertEq(installed.owner, config.owner);
        assertEq(installed.sessionKey, config.sessionKey);
        assertTrue(validator.isModuleType(1));
        assertFalse(validator.isModuleType(2));

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        vm.prank(nexus);
        validator.onInstall(abi.encode(config));

        vm.prank(nexus);
        validator.onUninstall("");
        assertFalse(validator.isInitialized(nexus));
    }

    function test_rejectsInvalidOrExpiredInstallation() public {
        HCAFundingSessionValidator.SessionConfig memory invalidConfig = config;
        invalidConfig.destinationRecipient = address(0);
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        vm.prank(makeAddr("invalid-nexus"));
        validator.onInstall(abi.encode(invalidConfig));

        HCAFundingSessionValidator.SessionConfig memory expiredConfig = config;
        expiredConfig.validUntil = uint48(block.timestamp);
        vm.expectRevert(HCAFundingSessionValidator.SessionExpired.selector);
        vm.prank(makeAddr("expired-nexus"));
        validator.onInstall(abi.encode(expiredConfig));
    }

    function test_rejectsMalformedFundingEnvelopes() public {
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(bytes32(0), "");

        bytes memory zeroLengthProofEnvelope =
            abi.encodePacked(
                bytes1(uint8(4)),
                config.permissionId,
                bytes2(0),
                new bytes(65 + 410 + 1)
            );
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(bytes32(0), zeroLengthProofEnvelope);

        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        proof.hashesAndChainIds = new HCASmartSessionLib.HashAndChainId[](0);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsUninstalledAccount() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        vm.prank(makeAddr("uninstalled-nexus"));
        validator.isValidSignatureWithSender(
            PERMIT2,
            digest,
            _envelope(proof, digest, claim, operation)
        );
    }

    function test_rejectsPermissionIdNotBoundToSession() public {
        vm.prank(nexus);
        validator.onUninstall("");
        config.permissionId = keccak256("unbound-permission");
        vm.prank(nexus);
        validator.onInstall(abi.encode(config));

        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsInvalidSessionSignature() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);
        bytes memory envelope = _envelope(proof, digest, claim, operation);
        envelope[33 + _packAuthorization(proof).length] ^= 0x01;

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, envelope);
    }

    function test_rejectsOperationThatDoesNotMatchClaim() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory claimedOperation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) =
            _claim(claimedOperation, COMMIT_SOURCE_COST, 100_000, 1);
        bytes memory suppliedOperation = _fundingOperation(COMMIT_SOURCE_COST + 1, true);

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, uint8(10))
        );
        _validate(digest, _envelope(proof, digest, claim, suppliedOperation));
    }

    function test_rejectsClaimWithDifferentDigest() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, ) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);
        bytes32 differentDigest = keccak256("different-permit2-digest");

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, uint8(9))
        );
        _validate(differentDigest, _envelope(proof, differentDigest, claim, operation));
    }

    function test_rejectsInvalidClaimFields() public {
        _expectClaimByteMismatch(1, 0, 0x00);
        _expectClaimByteMismatch(3, 84, 0x02);
        _expectClaimWordMismatch(4, 117);
        _expectClaimByteMismatch(6, 200, 0x00);
        _expectClaimByteMismatch(7, 233, 0x02);
        _expectClaimWordMismatch(8, 266);
    }

    function test_rejectsExpiredClaimDeadline() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, uint8(2))
        );
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsInvalidFundingCalls() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);

        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: sourceToken, value: 0, callData: abi.encodeCall(
            IERC20.transferFrom,
            (owner, makeAddr("wrong-nexus"), COMMIT_SOURCE_COST)
        )});
        bytes memory wrongRecipientOperation =
            _packOperation(HCAOperationHashLib.ERC7579_ERC1271_MODE, executions);
        (bytes memory claim, bytes32 digest) =
            _claim(wrongRecipientOperation, COMMIT_SOURCE_COST, 100_000, 1);
        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, wrongRecipientOperation));

        executions[0].callData = hex"deadbeef";
        bytes memory unknownCallOperation =
            _packOperation(HCAOperationHashLib.ERC7579_ERC1271_MODE, executions);
        (claim, digest) = _claim(unknownCallOperation, COMMIT_SOURCE_COST, 100_000, 2);
        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, unknownCallOperation));

        bytes memory zeroPullOperation = _fundingOperation(0, false);
        (claim, digest) = _claim(zeroPullOperation, COMMIT_SOURCE_COST, 100_000, 3);
        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, zeroPullOperation));
    }

    function test_rejectsMalformedFundingCalls() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory validOperation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) =
            _claim(validOperation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.InvalidOperation.selector);
        _validate(digest, _envelope(proof, digest, claim, hex"00"));

        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: sourceToken, value: 0, callData: hex"dead"});
        bytes memory shortSelectorOperation =
            _packOperation(HCAOperationHashLib.ERC7579_ERC1271_MODE, executions);
        (claim, digest) = _claim(shortSelectorOperation, COMMIT_SOURCE_COST, 100_000, 2);
        vm.expectRevert(HCAFundingSessionValidator.InvalidOperation.selector);
        _validate(digest, _envelope(proof, digest, claim, shortSelectorOperation));

        executions[0].callData = abi.encodePacked(IERC20.transferFrom.selector);
        bytes memory shortArgumentsOperation =
            _packOperation(HCAOperationHashLib.ERC7579_ERC1271_MODE, executions);
        (claim, digest) = _claim(shortArgumentsOperation, COMMIT_SOURCE_COST, 100_000, 3);
        vm.expectRevert(HCAFundingSessionValidator.InvalidOperation.selector);
        _validate(digest, _envelope(proof, digest, claim, shortArgumentsOperation));

        executions[0].callData = abi.encodeWithSelector(
            IERC20Permit.permit.selector,
            makeAddr("wrong-owner"),
            nexus,
            TOTAL_SOURCE_BUDGET,
            config.validUntil,
            uint8(27),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
        bytes memory invalidPermitOperation =
            _packOperation(HCAOperationHashLib.ERC7579_ERC1271_MODE, executions);
        (claim, digest) = _claim(invalidPermitOperation, COMMIT_SOURCE_COST, 100_000, 4);
        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, invalidPermitOperation));
    }

    function test_acceptsCompactOwnerRecoveryId() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        proof.ownerV -= 27;
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        assertEq(_validate(digest, _envelope(proof, digest, claim, operation)), ERC1271_MAGICVALUE);
    }

    function test_rejectsInvalidOwnerRecoveryData() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        proof.ownerV = 33;
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));

        proof = _ownerProof(config);
        proof.ownerR = bytes32(0);
        proof.ownerS = bytes32(0);
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_internalGuardsRejectTruncatedData() public {
        HCAFundingSessionValidatorHarness harness =
            new HCAFundingSessionValidatorHarness(intentExecutor, PERMIT2, router);

        vm.expectRevert(HCAFundingSessionValidator.InvalidOperation.selector);
        harness.validateFundingOperationHarness(nexus, nexus, hex"00");

        vm.expectRevert(HCAFundingSessionValidator.ClaimPolicyFailed.selector);
        harness.validatePermit2ClaimHarness(bytes32(0), hex"00", nexus);

        vm.expectRevert(HCAFundingSessionValidator.ClaimPolicyFailed.selector);
        harness.readWordHarness(hex"00", 0);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        harness.recoverHarness(bytes32(0), hex"00");
    }

    function test_reusesOneOwnerAuthorizationForCommitAndRevealClaims() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);

        bytes memory commitOperation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory commitClaim, bytes32 commitDigest) =
            _claim(commitOperation, COMMIT_SOURCE_COST, 100_000, 1);
        assertEq(
            _validate(commitDigest, _envelope(proof, commitDigest, commitClaim, commitOperation)),
            ERC1271_MAGICVALUE
        );

        bytes memory revealOperation = _fundingOperation(REVEAL_SOURCE_COST, false);
        (bytes memory revealClaim, bytes32 revealDigest) =
            _claim(revealOperation, REVEAL_SOURCE_COST, 1_000_000, 2);
        assertEq(
            _validate(revealDigest, _envelope(proof, revealDigest, revealClaim, revealOperation)),
            ERC1271_MAGICVALUE
        );
    }

    function test_reusesOwnerAuthorizationAfterRouterUpdatesArbiter() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        arbiter = makeAddr("replacement-across-arbiter");
        _setActiveArbiter(arbiter);

        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        assertEq(_validate(digest, _envelope(proof, digest, claim, operation)), ERC1271_MAGICVALUE);
    }

    function test_rejectsClaimWhenRouterHasNoActiveArbiter() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        _setActiveArbiter(address(0));

        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, uint8(1))
        );
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_reusesOneOwnerAuthorizationAcrossSourceChains() public {
        HCAFundingSessionValidator.SessionConfig memory arbitrumConfig = config;
        arbitrumConfig.sourceToken = arbitrumSourceToken;
        arbitrumConfig.permissionId = _permissionId(arbitrumConfig);
        assertNotEq(config.permissionId, arbitrumConfig.permissionId);

        HCAFundingSessionValidator.FundingAuthorizationProof memory proof =
            _ownerProof(config, arbitrumConfig);

        bytes memory baseOperation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory baseClaim, bytes32 baseDigest) =
            _claim(baseOperation, COMMIT_SOURCE_COST, 100_000, 1);
        assertEq(
            _validate(baseDigest, _envelope(proof, baseDigest, baseClaim, baseOperation)),
            ERC1271_MAGICVALUE
        );

        vm.chainId(ARBITRUM_SEPOLIA_CHAIN_ID);
        vm.prank(nexus);
        validator.onUninstall("");
        vm.prank(nexus);
        validator.onInstall(abi.encode(arbitrumConfig));
        config = arbitrumConfig;
        sourceToken = arbitrumSourceToken;
        proof.sessionToEnableIndex = 2;
        bytes memory arbitrumOperation = _fundingOperation(REVEAL_SOURCE_COST, false);
        (bytes memory arbitrumClaim, bytes32 arbitrumDigest) =
            _claim(arbitrumOperation, REVEAL_SOURCE_COST, 1_000_000, 2);
        assertEq(
            _validate(
                arbitrumDigest,
                _envelope(proof, arbitrumDigest, arbitrumClaim, arbitrumOperation)
            ),
            ERC1271_MAGICVALUE
        );
    }

    function test_rejectsClaimWithoutReusableOwnerAuthorization() public {
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);
        bytes memory envelopeWithoutOwnerProof =
            abi.encodePacked(
                bytes1(uint8(0)),
                config.permissionId,
                _sessionSignature(digest),
                claim,
                operation
            );

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, envelopeWithoutOwnerProof);
    }

    function test_rejectsPullAboveSignedPermit2Claim() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST + 1, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_permissionAlwaysRequiresItsOwnerProof() public view {
        assertFalse(validator.isPermissionEnabled(nexus, config.permissionId));
    }

    function test_acceptsIntentExecutorPrecheck() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.prank(nexus);
        assertEq(
            validator.isValidSignatureWithSender(
                intentExecutor,
                digest,
                _envelope(proof, digest, claim, operation)
            ),
            ERC1271_MAGICVALUE
        );
    }

    function test_acceptsERC1271WithEmissaryExecutionFallbackMode() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation =
            _fundingOperation(
                COMMIT_SOURCE_COST,
                true,
                sourceToken,
                PERMIT2,
                HCAOperationHashLib.ERC7579_ERC1271_EMISSARY_EXECUTION_MODE
            );
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        assertEq(_validate(digest, _envelope(proof, digest, claim, operation)), ERC1271_MAGICVALUE);
    }

    function test_rejectsUnsupportedExecutionMode() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation =
            _fundingOperation(
                COMMIT_SOURCE_COST,
                true,
                sourceToken,
                PERMIT2,
                bytes32(uint256(0xDEAD))
            );
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.InvalidOperation.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsUnauthorizedSignatureCaller() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.UnauthorizedCaller.selector);
        vm.prank(nexus);
        validator.isValidSignatureWithSender(
            makeAddr("unauthorized-caller"),
            digest,
            _envelope(proof, digest, claim, operation)
        );
    }

    function test_rejectsExpiredSession() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        vm.warp(config.validUntil + 1);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.SessionExpired.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsInvalidOwnerAuthorization() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        proof.ownerR = bytes32(uint256(proof.ownerR) + 1);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsAuthorizationForAnotherSelectedChain() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        proof.hashesAndChainIds[proof.sessionToEnableIndex].chainId = ARBITRUM_SEPOLIA_CHAIN_ID;
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsFundingCallsToAnotherTarget() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation =
            _fundingOperation(COMMIT_SOURCE_COST, true, makeAddr("arbitrary-target"), PERMIT2);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsPermit2ApprovalForAnotherSpender() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation =
            _fundingOperation(COMMIT_SOURCE_COST, true, sourceToken, makeAddr("spender"));
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);

        vm.expectRevert(HCAFundingSessionValidator.FundingPolicyFailed.selector);
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsClaimForAnotherRecipient() public {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) = _claim(operation, COMMIT_SOURCE_COST, 100_000, 1);
        claim[149] = bytes1(uint8(claim[149]) ^ 1);

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, uint8(5))
        );
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function test_rejectsUserOperationsAndDirectExecution() public {
        PackedUserOperation memory userOp;
        assertEq(validator.validateUserOp(userOp, bytes32(0)), 1);

        HCAFundingSessionValidator.Operation memory operation;
        vm.expectRevert(HCAFundingSessionValidator.InvalidSession.selector);
        validator.verifyExecution(nexus, bytes32(0), "", operation);
    }

    function _validate(bytes32 digest, bytes memory envelope) internal returns (bytes4 result) {
        vm.prank(nexus);
        return validator.isValidSignatureWithSender(PERMIT2, digest, envelope);
    }

    function _setActiveArbiter(address activeArbiter) internal {
        vm.mockCall(
            router,
            abi.encodeCall(
                IRhinestoneClaimRouter.getClaimAdapter,
                (validator.RHINESTONE_PROTOCOL_VERSION(), validator.ACROSS_PERMIT2_CLAIM_SELECTOR())
            ),
            abi.encode(activeArbiter, bytes12(0))
        );
    }

    function _expectClaimByteMismatch(uint8 field, uint256 offset, bytes1 value) internal {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) =
            _claim(operation, COMMIT_SOURCE_COST, 100_000, field);
        claim[offset] = value;

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, field)
        );
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function _expectClaimWordMismatch(uint8 field, uint256 offset) internal {
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof = _ownerProof(config);
        bytes memory operation = _fundingOperation(COMMIT_SOURCE_COST, true);
        (bytes memory claim, bytes32 digest) =
            _claim(operation, COMMIT_SOURCE_COST, 100_000, field);
        for (uint256 i; i < 32; ++i) {
            claim[offset + i] = 0;
        }

        vm.expectRevert(
            abi.encodeWithSelector(HCAFundingSessionValidator.ClaimFieldMismatch.selector, field)
        );
        _validate(digest, _envelope(proof, digest, claim, operation));
    }

    function _fundingOperation(uint256 pullAmount, bool includePermit)
        internal
        view
        returns (bytes memory)
    {
        return _fundingOperation(pullAmount, includePermit, sourceToken, PERMIT2);
    }

    function _fundingOperation(
        uint256 pullAmount,
        bool includePermit,
        address target,
        address approvalSpender
    )
        internal
        view
        returns (bytes memory)
    {
        return
            _fundingOperation(
                pullAmount,
                includePermit,
                target,
                approvalSpender,
                HCAOperationHashLib.ERC7579_ERC1271_MODE
            );
    }

    function _fundingOperation(
        uint256 pullAmount,
        bool includePermit,
        address target,
        address approvalSpender,
        bytes32 mode
    )
        internal
        view
        returns (bytes memory)
    {
        Execution[] memory executions = new Execution[](includePermit ? 3 : 1);
        uint256 offset;
        if (includePermit) {
            executions[offset++] = Execution({target: target, value: 0, callData: abi.encodeWithSelector(
                IERC20Permit.permit.selector,
                owner,
                nexus,
                TOTAL_SOURCE_BUDGET,
                config.validUntil,
                uint8(27),
                bytes32(uint256(1)),
                bytes32(uint256(2))
            )});
            executions[offset++] = Execution({target: target, value: 0, callData: abi.encodeCall(
                IERC20.approve,
                (approvalSpender, type(uint256).max)
            )});
        }
        executions[offset++] = Execution({target: target, value: 0, callData: abi.encodeCall(
            IERC20.transferFrom,
            (owner, nexus, pullAmount)
        )});
        return _packOperation(mode, executions);
    }

    function _claim(
        bytes memory operationData,
        uint256 sourceAmount,
        uint256 destinationAmount,
        uint256 nonce
    )
        internal
        view
        returns (bytes memory claimData, bytes32 digest)
    {
        ClaimFixture memory claim =
            ClaimFixture({nonce: nonce, deadline: block.timestamp + 1 hours, sourceAmount: sourceAmount, destinationAmount: destinationAmount, fillExpiry: block.timestamp +
            30 minutes, minGas: 1_000_000, originOpsHash: _operationHash(operationData), destinationOpsHash: keccak256(
                abi.encode("destination", nonce)
            ), qualifierHash: keccak256(abi.encode("qualifier", nonce))});
        claimData = bytes.concat(
            abi.encodePacked(
                arbiter,
                claim.nonce,
                claim.deadline,
                uint8(1),
                bytes32(uint256(uint160(sourceToken))),
                claim.sourceAmount
            ),
            abi.encodePacked(
                destinationHca,
                uint256(config.destinationChainId),
                claim.fillExpiry,
                uint8(1),
                bytes32(uint256(uint160(destinationToken))),
                claim.destinationAmount
            ),
            abi.encodePacked(
                claim.minGas,
                claim.originOpsHash,
                claim.destinationOpsHash,
                claim.qualifierHash
            )
        );
        assertEq(claimData.length, 410);
        digest = _permit2Digest(claim);
    }

    function _permit2Digest(ClaimFixture memory claim) internal view returns (bytes32) {
        bytes32 tokenPermissionsHash =
            keccak256(
                abi.encodePacked(
                    keccak256(
                        abi.encode(TOKEN_PERMISSIONS_TYPEHASH, sourceToken, claim.sourceAmount)
                    )
                )
            );
        bytes32 tokenOutHash =
            keccak256(
                abi.encodePacked(
                    keccak256(abi.encode(TOKEN_TYPEHASH, destinationToken, claim.destinationAmount))
                )
            );
        bytes32 targetHash =
            keccak256(
                abi.encode(
                    TARGET_TYPEHASH,
                    destinationHca,
                    tokenOutHash,
                    uint256(config.destinationChainId),
                    claim.fillExpiry
                )
            );
        bytes32 mandateHash =
            keccak256(
                abi.encode(
                    MANDATE_TYPEHASH,
                    targetHash,
                    claim.minGas,
                    claim.originOpsHash,
                    claim.destinationOpsHash,
                    claim.qualifierHash
                )
            );
        bytes32 permitHash =
            keccak256(
                abi.encode(
                    PERMIT_TYPEHASH,
                    tokenPermissionsHash,
                    arbiter,
                    claim.nonce,
                    claim.deadline,
                    mandateHash
                )
            );
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, PERMIT2_NAME_HASH, block.chainid, PERMIT2));
        return MessageHashUtils.toTypedDataHash(domainSeparator, permitHash);
    }

    function _ownerProof(HCAFundingSessionValidator.SessionConfig memory sessionConfig)
        internal
        view
        returns (HCAFundingSessionValidator.FundingAuthorizationProof memory proof)
    {
        return _ownerProof(sessionConfig, sessionConfig);
    }

    function _ownerProof(
        HCAFundingSessionValidator.SessionConfig memory baseConfig,
        HCAFundingSessionValidator.SessionConfig memory arbitrumConfig
    )
        internal
        view
        returns (HCAFundingSessionValidator.FundingAuthorizationProof memory proof)
    {
        bytes32 baseSessionDigest = _signedSessionHash(baseConfig);
        bytes32 arbitrumSessionDigest = _signedSessionHash(arbitrumConfig);

        proof.sessionToEnableIndex = 1;
        proof.hashesAndChainIds = new HCASmartSessionLib.HashAndChainId[](3);
        proof.hashesAndChainIds[0] = HCASmartSessionLib.HashAndChainId({chainId: uint64(
            baseConfig.destinationChainId
        ), sessionDigest: keccak256("destination-session")});
        proof.hashesAndChainIds[1] = HCASmartSessionLib.HashAndChainId({chainId: BASE_SEPOLIA_CHAIN_ID, sessionDigest: baseSessionDigest});
        proof.hashesAndChainIds[2] = HCASmartSessionLib.HashAndChainId({chainId: ARBITRUM_SEPOLIA_CHAIN_ID, sessionDigest: arbitrumSessionDigest});

        bytes32[] memory chainSessionHashes = new bytes32[](proof.hashesAndChainIds.length);
        for (uint256 i; i < proof.hashesAndChainIds.length; ++i) {
            HCASmartSessionLib.HashAndChainId memory item = proof.hashesAndChainIds[i];
            chainSessionHashes[i] = keccak256(
                abi.encode(CHAIN_SESSION_TYPEHASH, item.chainId, item.sessionDigest)
            );
        }
        bytes32 structHash =
            keccak256(
                abi.encode(
                    MULTI_CHAIN_SESSION_TYPEHASH,
                    keccak256(abi.encodePacked(chainSessionHashes))
                )
            );
        bytes32 domainSeparator =
            keccak256(
                abi.encode(
                    SMART_SESSION_DOMAIN_TYPEHASH,
                    SMART_SESSION_NAME_HASH,
                    SMART_SESSION_VERSION_HASH
                )
            );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (proof.ownerV, proof.ownerR, proof.ownerS) = vm.sign(OWNER_KEY, digest);
    }

    function _signedSessionHash(HCAFundingSessionValidator.SessionConfig memory sessionConfig)
        internal
        view
        returns (bytes32)
    {
        bytes memory validatorInitData = _sessionValidatorInitData(sessionConfig.sessionKey);
        return
            keccak256(
                abi.encode(
                    SIGNED_SESSION_TYPEHASH,
                    nexus,
                    type(uint256).max,
                    uint256(0),
                    DEFAULT_SIGNED_PERMISSIONS_HASH,
                    _authorizationSalt(sessionConfig),
                    OWNABLE_SESSION_VALIDATOR,
                    keccak256(validatorInitData),
                    SMART_SESSION_EMISSARY
                )
            );
    }

    function _envelope(
        HCAFundingSessionValidator.FundingAuthorizationProof memory proof,
        bytes32 permit2Digest,
        bytes memory claimData,
        bytes memory operationData
    )
        internal
        view
        returns (bytes memory)
    {
        bytes memory proofData = _packAuthorization(proof);
        return
            abi.encodePacked(
                bytes1(uint8(4)),
                config.permissionId,
                proofData,
                _sessionSignature(permit2Digest),
                claimData,
                operationData
            );
    }

    function _packAuthorization(HCAFundingSessionValidator.FundingAuthorizationProof memory proof)
        internal
        pure
        returns (bytes memory packed)
    {
        packed = abi.encodePacked(proof.sessionToEnableIndex, uint8(proof.hashesAndChainIds.length));
        for (uint256 i; i < proof.hashesAndChainIds.length; ++i) {
            HCASmartSessionLib.HashAndChainId memory item = proof.hashesAndChainIds[i];
            packed = bytes.concat(packed, abi.encodePacked(item.chainId, item.sessionDigest));
        }
        return bytes.concat(packed, abi.encodePacked(proof.ownerR, proof.ownerS, proof.ownerV));
    }

    function _sessionSignature(bytes32 permit2Digest) internal view returns (bytes memory) {
        bytes32 accountBoundHash =
            MessageHashUtils.toEthSignedMessageHash(
                abi.encodePacked(bytes32(uint256(uint160(nexus))), permit2Digest)
            );
        bytes32 personalDigest = MessageHashUtils.toEthSignedMessageHash(accountBoundHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, personalDigest);
        return abi.encodePacked(r, s, v + 4);
    }

    function _permissionId(HCAFundingSessionValidator.SessionConfig memory sessionConfig)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    OWNABLE_SESSION_VALIDATOR,
                    _sessionValidatorInitData(sessionConfig.sessionKey),
                    _authorizationSalt(sessionConfig)
                )
            );
    }

    function _authorizationSalt(HCAFundingSessionValidator.SessionConfig memory sessionConfig)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    sessionConfig.owner,
                    sessionConfig.validUntil,
                    sessionConfig.sourceToken,
                    sessionConfig.destinationRecipient,
                    sessionConfig.destinationToken,
                    sessionConfig.destinationChainId,
                    sessionConfig.maxSourceAmount,
                    sessionConfig.maxDestinationAmount
                )
            );
    }

    function _sessionValidatorInitData(address signer) internal pure returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = signer;
        return abi.encode(uint256(1), owners);
    }

    function _packOperation(bytes32 mode, Execution[] memory executions)
        internal
        pure
        returns (bytes memory packed)
    {
        packed = abi.encodePacked(bytes2(mode), uint8(executions.length));
        for (uint256 i; i < executions.length; ++i) {
            Execution memory execution = executions[i];
            assertEq(execution.value, 0);
            assertLe(execution.callData.length, type(uint24).max);
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

    function _operationHash(bytes memory operationData) internal pure returns (bytes32) {
        if (operationData.length < 3) {
            revert HCAOperationHashLib.InvalidOperationEncoding();
        }
        bytes2 modePrefix;
        assembly ("memory-safe") {
            modePrefix := mload(add(operationData, 0x20))
        }
        bytes32 mode = bytes32(modePrefix);
        uint256 count = uint8(operationData[2]);
        bytes32[] memory executionHashes = new bytes32[](count);
        uint256 cursor = 3;
        for (uint256 i; i < count; ++i) {
            if (operationData.length < cursor + 23) {
                revert HCAOperationHashLib.InvalidOperationEncoding();
            }
            address target;
            assembly ("memory-safe") {
                target := shr(96, mload(add(add(operationData, 0x20), cursor)))
            }
            uint256 callDataLength =
                (uint256(uint8(operationData[cursor + 20])) << 16) |
                (uint256(uint8(operationData[cursor + 21])) << 8) |
                uint256(uint8(operationData[cursor + 22]));
            cursor += 23;
            if (operationData.length < cursor + callDataLength) {
                revert HCAOperationHashLib.InvalidOperationEncoding();
            }
            bytes32 callDataHash;
            assembly ("memory-safe") {
                callDataHash := keccak256(add(add(operationData, 0x20), cursor), callDataLength)
            }
            executionHashes[i] = keccak256(
                abi.encode(OPS_TYPEHASH, target, uint256(0), callDataHash)
            );
            cursor += callDataLength;
        }
        if (cursor != operationData.length) {
            revert HCAOperationHashLib.InvalidOperationEncoding();
        }
        return
            keccak256(abi.encode(OP_TYPEHASH, mode, keccak256(abi.encodePacked(executionHashes))));
    }
}


contract HCAFundingSessionValidatorHarness is HCAFundingSessionValidator {
    constructor(address intentExecutor, address permit2, address router)
        HCAFundingSessionValidator(intentExecutor, permit2, router)
    {}

    function validateFundingOperationHarness(
        address account,
        address configAccount,
        bytes calldata operationData
    )
        external
        view
        returns (uint256)
    {
        if (operationData.length < 3) {
            revert InvalidOperation();
        }
        HCAOperationHashLib.DecodedOperation memory operation =
            HCAOperationHashLib.decode(operationData);
        if (!HCAOperationHashLib.isSupportedMode(operation.mode)) {
            revert InvalidOperation();
        }
        return _validateFundingOperation(account, _sessions[configAccount], operation);
    }

    function validatePermit2ClaimHarness(bytes32 digest, bytes calldata data, address configAccount)
        external
        view
        returns (uint256)
    {
        return _validatePermit2Claim(digest, data, _sessions[configAccount]);
    }

    function readWordHarness(bytes calldata data, uint256 offset) external pure returns (bytes32) {
        return _readWord(data, offset);
    }

    function recoverHarness(bytes32 digest, bytes calldata signature)
        external
        pure
        returns (address)
    {
        address signer = HCASignatureLib.recover(digest, signature);
        if (signer == address(0)) {
            revert InvalidSession();
        }
        return signer;
    }
}
