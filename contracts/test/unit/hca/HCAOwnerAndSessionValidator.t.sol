// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// solhint-disable private-vars-leading-underscore, func-name-mixedcase

import {Test} from "forge-std/Test.sol";

import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ERC1271_MAGICVALUE} from "nexus/types/Constants.sol";
import {Execution} from "nexus/types/DataTypes.sol";

import {HCAOwnerAndSessionValidator} from "~src/hca/HCAOwnerAndSessionValidator.sol";
import {HCAOperationHashLib} from "~src/hca/libraries/HCAOperationHashLib.sol";
import {HCASmartSessionLib} from "~src/hca/libraries/HCASmartSessionLib.sol";
import {IETHRegistrar} from "~src/registrar/interfaces/IETHRegistrar.sol";
import {IPermissionedRegistry} from "~src/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";

import {MockStandaloneHCA} from "../../mocks/MockStandaloneHCAStack.sol";

/// @title HCA Owner and Session Validator Tests
/// @notice Exercises owner signatures, session permissions, and registration policies.
contract HCAOwnerAndSessionValidatorTest is Test {
    string internal constant PERMISSIONED_REGISTRY_ARTIFACT =
        "src/registry/PermissionedRegistry.sol:PermissionedRegistry";

    struct ClaimFixture {
        uint256 nonce;
        uint256 deadline;
        uint256 sourceAmount;
        uint256 destinationAmount;
        uint256 fillExpiry;
        uint128 minGas;
        address recipient;
        uint256 targetChainId;
        bytes32 originOpsHash;
        bytes32 destinationOpsHash;
        bytes32 qualifierHash;
    }

    struct SessionEnableProofFixture {
        address sessionKey;
        uint48 validUntil;
        uint96 sessionNonce;
        address resolver;
        address refundToken;
        uint96 maxRefundExchangeRate;
        uint48 maxRefundGasOverhead;
        uint96 maxRefundAmount;
        uint8 sessionToEnableIndex;
        HCASmartSessionLib.HashAndChainId[] hashesAndChainIds;
        bytes32 ownerR;
        bytes32 ownerS;
        uint8 ownerV;
    }

    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

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

    uint256 constant SOURCE_CHAIN_ID = 84_532;
    uint256 constant SESSION_KEY = 0x5E5510;
    uint256 constant OWNER_KEY = 0x0A11CE;

    address owner = vm.addr(OWNER_KEY);
    address sessionSigner = vm.addr(SESSION_KEY);
    address intentExecutor = makeAddr("intent-executor");
    address ethRegistrar = makeAddr("eth-registrar");
    address sourceToken = makeAddr("source-token");
    address paymentToken = makeAddr("payment-token");
    address gasRefundPaymaster = makeAddr("refund-paymaster");

    HCAOwnerAndSessionValidatorEnableHarness validator;
    IPermissionedRegistry ethRegistry;
    MockStandaloneHCA hca;

    function setUp() public {
        hca = new MockStandaloneHCA(owner);
        ethRegistry = IPermissionedRegistry(
            deployCode(
                PERMISSIONED_REGISTRY_ARTIFACT,
                abi.encode(address(0), address(this), RegistryRolesLib.ROLE_REGISTRAR_ADMIN)
            )
        );
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, ethRegistrar);
        VerifiableFactory factory = new VerifiableFactory();
        validator = new HCAOwnerAndSessionValidatorEnableHarness(
            makeAddr("reverse-adapter"),
            makeAddr("addr-reverse-adapter"),
            makeAddr("resolver-implementation"),
            address(ethRegistry),
            address(factory),
            intentExecutor,
            gasRefundPaymaster
        );
    }

    function test_validator_rejectsUnsupportedResolverCall() public {
        bytes4 selector = bytes4(keccak256("unsupported()"));

        vm.expectRevert(
            abi.encodeWithSelector(
                HCAOwnerAndSessionValidator.ActionNotAllowed.selector,
                address(0),
                selector
            )
        );
        validator.checkResolverCallHarness(abi.encodeWithSelector(selector));
    }

    function test_validator_acceptsFirstPermit2RouteWithMultiChainSessionAuthorization()
        public
        view
    {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        bytes memory operationData = _withHybridMode(_initialCommitOperation(permissionId, proof));
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);
        bytes memory proofData = _packProof(proof);
        bytes memory envelope =
            abi.encodePacked(
                bytes1(uint8(4)),
                permissionId,
                proofData,
                SOURCE_CHAIN_ID,
                claimData,
                operationData,
                _signRhinestoneMessage(SESSION_KEY, digest)
            );

        assertEq(hca.validate(validator, digest, envelope), ERC1271_MAGICVALUE);
    }

    function test_validator_rejectsInvalidFirstPermit2Operations() public {
        _assertFirstPermit2OperationRevert(
            abi.encodePacked(bytes2(HCAOperationHashLib.ERC7579_ERC1271_MODE), uint8(0)),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );

        bytes memory operationData = _commitOperation(bytes32("commitment"));
        operationData[1] = bytes1(uint8(4));
        _assertFirstPermit2OperationRevert(
            operationData,
            HCAOwnerAndSessionValidator.InvalidOperationEncoding.selector
        );

        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: abi.encodePacked(
            IETHRegistrar.register.selector,
            bytes2(0)
        )});
        _assertFirstPermit2OperationRevert(
            _encodeExecutions(executions),
            HCAOwnerAndSessionValidator.PolicyRuleFailed.selector
        );
    }

    function test_validator_rejectsMalformedFirstUseEnvelopes() public {
        bytes memory envelope = new bytes(130);
        envelope[0] = 0xFF;
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, bytes32(0), envelope);

        envelope[0] = 0x04;
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, bytes32(0), envelope);

        envelope = new bytes(545);
        envelope[0] = 0x04;
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, bytes32(0), envelope);

        envelope = new bytes(130);
        envelope[0] = 0x05;
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, bytes32(0), envelope);

        envelope = new bytes(219);
        envelope[0] = 0x05;
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, bytes32(0), envelope);

        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        bytes memory operationData = _initialCommitOperation(permissionId, proof);
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);
        envelope = _initialEnvelope(permissionId, proof, claimData, operationData, digest);
        envelope = _slice(envelope, 0, envelope.length - operationData.length);
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, digest, envelope);
    }

    function test_validator_rejectsInvalidFirstUseProofAndSessionSignature() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        bytes memory operationData = _initialCommitOperation(permissionId, proof);
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(keccak256("wrong-permission"), proof, claimData, operationData, digest)
        );

        proof.hashesAndChainIds = new HCASmartSessionLib.HashAndChainId[](0);
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(permissionId, proof, claimData, operationData, digest)
        );

        (proof, permissionId) = _multiChainEnableProof();
        proof.sessionToEnableIndex = uint8(proof.hashesAndChainIds.length);
        operationData = _initialCommitOperation(permissionId, proof);
        (claimData, digest) = _claim(operationData, address(hca), block.chainid);
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(permissionId, proof, claimData, operationData, digest)
        );
        (proof, permissionId) = _multiChainEnableProof();
        operationData = _initialCommitOperation(permissionId, proof);
        (claimData, digest) = _claim(operationData, address(hca), block.chainid);
        bytes memory envelope =
            _initialEnvelope(permissionId, proof, claimData, operationData, digest);
        _replaceSignature(envelope, _signRhinestoneMessage(0xBAD, digest));
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(validator, digest, envelope);
    }

    function test_validator_rejectsFirstPermit2RouteWithInvalidOwnerAuthorization() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        proof.ownerR = bytes32(uint256(proof.ownerR) + 1);
        bytes memory operationData = _initialCommitOperation(permissionId, proof);
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(permissionId, proof, claimData, operationData, digest)
        );
    }

    function test_validator_rejectsFirstPermit2RouteForAnotherSelectedChain() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        proof.hashesAndChainIds[proof.sessionToEnableIndex].chainId = uint64(SOURCE_CHAIN_ID);
        bytes memory operationData = _initialCommitOperation(permissionId, proof);
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(permissionId, proof, claimData, operationData, digest)
        );
    }

    function test_validator_rejectsFirstPermit2RouteWithStaleSessionNonce() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        hca.setSessionNonce(1);
        bytes memory operationData = _initialCommitOperation(permissionId, proof);
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(permissionId, proof, claimData, operationData, digest)
        );
    }

    function test_validator_acceptsFirstSameChainRouteWithMultiChainSessionAuthorization()
        public
        view
    {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund =
            HCAOwnerAndSessionValidator.GasRefund({token: proof.refundToken, exchangeRate: proof.maxRefundExchangeRate, overhead: (uint256(
                    proof.maxRefundAmount
                ) <<
                128) |
            proof.maxRefundGasOverhead});
        bytes memory operationData = _initialRefundCommitOperation(permissionId, proof);
        uint256 nonce = 71;
        bytes32 digest =
            validator.singleChainDigestWithRefundHarness(
                address(hca),
                nonce,
                operationData,
                gasRefund
            );

        assertEq(
            hca.validate(
                validator,
                digest,
                _initialRefundEnvelope(permissionId, proof, nonce, gasRefund, operationData, digest)
            ),
            ERC1271_MAGICVALUE
        );
    }

    function test_validator_rejectsInvalidFirstSameChainDigestAndSignature() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund =
            HCAOwnerAndSessionValidator.GasRefund({token: proof.refundToken, exchangeRate: proof.maxRefundExchangeRate, overhead: (uint256(
                    proof.maxRefundAmount
                ) <<
                128) |
            proof.maxRefundGasOverhead});
        bytes memory operationData = _initialRefundCommitOperation(permissionId, proof);
        uint256 nonce = 81;
        bytes32 digest =
            validator.singleChainDigestWithRefundHarness(
                address(hca),
                nonce,
                operationData,
                gasRefund
            );
        bytes memory envelope =
            _initialRefundEnvelope(permissionId, proof, nonce, gasRefund, operationData, digest);

        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSessionData.selector);
        hca.validate(validator, keccak256("wrong-digest"), envelope);

        _replaceSignature(envelope, _signRhinestoneMessage(0xBAD, digest));
        vm.expectRevert(HCAOwnerAndSessionValidator.InvalidSigner.selector);
        hca.validate(validator, digest, envelope);
    }

    function test_validator_rejectsFirstSameChainRouteAboveAuthorizedRefund() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund =
            HCAOwnerAndSessionValidator.GasRefund({token: proof.refundToken, exchangeRate: proof.maxRefundExchangeRate, overhead: (uint256(
                    proof.maxRefundAmount + 1
                ) <<
                128) |
            proof.maxRefundGasOverhead});
        bytes memory operationData = _initialRefundCommitOperation(permissionId, proof);
        uint256 nonce = 72;
        bytes32 digest =
            validator.singleChainDigestWithRefundHarness(
                address(hca),
                nonce,
                operationData,
                gasRefund
            );

        vm.expectRevert(HCAOwnerAndSessionValidator.GasRefundNotAllowed.selector);
        hca.validate(
            validator,
            digest,
            _initialRefundEnvelope(permissionId, proof, nonce, gasRefund, operationData, digest)
        );
    }

    function test_validator_rejectsFirstSameChainFundingPullToAnotherAccount() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund =
            HCAOwnerAndSessionValidator.GasRefund({token: proof.refundToken, exchangeRate: proof.maxRefundExchangeRate, overhead: (uint256(
                    proof.maxRefundAmount
                ) <<
                128) |
            proof.maxRefundGasOverhead});
        bytes memory operationData =
            _initialRefundCommitOperation(permissionId, proof, makeAddr("another-account"));
        uint256 nonce = 73;
        bytes32 digest =
            validator.singleChainDigestWithRefundHarness(
                address(hca),
                nonce,
                operationData,
                gasRefund
            );

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        hca.validate(
            validator,
            digest,
            _initialRefundEnvelope(permissionId, proof, nonce, gasRefund, operationData, digest)
        );
    }

    function test_validator_rejectsFirstSameChainFundingWithoutTransfer() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);

        _assertInitialRefundPolicyFailure(
            permissionId,
            proof,
            74,
            _encodeExecutions(_withoutExecution(executions, 1))
        );
    }

    function test_validator_rejectsFirstSameChainFundingWhenCallsAreNotAdjacent() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);
        Execution memory transfer = executions[1];
        executions[1] = executions[2];
        executions[2] = transfer;

        _assertInitialRefundPolicyFailure(permissionId, proof, 75, _encodeExecutions(executions));
    }

    function test_validator_rejectsFirstSameChainFundingWithMismatchedAmounts() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);
        executions[1].callData = abi.encodeWithSelector(
            IERC20.transferFrom.selector,
            owner,
            address(hca),
            19_000_000
        );

        _assertInitialRefundPolicyFailure(permissionId, proof, 76, _encodeExecutions(executions));
    }

    function test_validator_rejectsFirstSameChainFundingWithZeroAmount() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);
        executions[0].callData = abi.encodeWithSelector(
            IERC20Permit.permit.selector,
            owner,
            address(hca),
            0,
            block.timestamp + 1 hours,
            uint8(27),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
        executions[1].callData = abi.encodeWithSelector(
            IERC20.transferFrom.selector,
            owner,
            address(hca),
            0
        );

        _assertInitialRefundPolicyFailure(permissionId, proof, 77, _encodeExecutions(executions));
    }

    function test_validator_rejectsFirstSameChainFundingWithDuplicatePermit() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);
        Execution[] memory duplicated = new Execution[](executions.length + 1);
        duplicated[0] = executions[0];
        for (uint256 i; i < executions.length; ++i) {
            duplicated[i + 1] = executions[i];
        }

        _assertInitialRefundPolicyFailure(permissionId, proof, 78, _encodeExecutions(duplicated));
    }

    function test_validator_rejectsFirstSameChainFundingFromAnotherOwner() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);
        executions[0].callData = abi.encodeWithSelector(
            IERC20Permit.permit.selector,
            makeAddr("another-owner"),
            address(hca),
            20_000_000,
            block.timestamp + 1 hours,
            uint8(27),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );

        _assertInitialRefundPolicyFailure(permissionId, proof, 79, _encodeExecutions(executions));
    }

    function test_validator_rejectsFirstSameChainFundingForAnotherSpender() public {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        Execution[] memory executions = _initialRefundExecutions(permissionId, proof);
        executions[0].callData = abi.encodeWithSelector(
            IERC20Permit.permit.selector,
            owner,
            makeAddr("another-spender"),
            20_000_000,
            block.timestamp + 1 hours,
            uint8(27),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );

        _assertInitialRefundPolicyFailure(permissionId, proof, 80, _encodeExecutions(executions));
    }

    function _assertFirstPermit2OperationRevert(bytes memory operationData, bytes4 revertSelector)
        internal
    {
        (SessionEnableProofFixture memory proof, bytes32 permissionId) = _multiChainEnableProof();
        (bytes memory claimData, bytes32 digest) =
            _claim(operationData, address(hca), block.chainid);

        vm.expectRevert(revertSelector);
        hca.validate(
            validator,
            digest,
            _initialEnvelope(permissionId, proof, claimData, operationData, digest)
        );
    }
    function _commitOperation(bytes32 commitment) internal view returns (bytes memory) {
        Execution[] memory executions = new Execution[](1);
        executions[0] = Execution({target: ethRegistrar, value: 0, callData: abi.encodeWithSelector(
            IETHRegistrar.commit.selector,
            commitment
        )});
        return _encodeExecutions(executions);
    }

    function _initialCommitOperation(bytes32 permissionId, SessionEnableProofFixture memory proof)
        internal
        view
        returns (bytes memory)
    {
        permissionId;
        proof;
        return _commitOperation(bytes32("commitment"));
    }

    function _initialEnvelope(
        bytes32 permissionId,
        SessionEnableProofFixture memory proof,
        bytes memory claimData,
        bytes memory operationData,
        bytes32 digest
    )
        internal
        pure
        returns (bytes memory)
    {
        bytes memory proofData = _packProof(proof);
        return
            abi.encodePacked(
                bytes1(uint8(4)),
                permissionId,
                proofData,
                SOURCE_CHAIN_ID,
                claimData,
                operationData,
                _signRhinestoneMessage(SESSION_KEY, digest)
            );
    }

    function _initialRefundCommitOperation(
        bytes32 permissionId,
        SessionEnableProofFixture memory proof
    )
        internal
        view
        returns (bytes memory)
    {
        return _initialRefundCommitOperation(permissionId, proof, address(hca));
    }

    function _initialRefundCommitOperation(
        bytes32 permissionId,
        SessionEnableProofFixture memory proof,
        address fundingRecipient
    )
        internal
        view
        returns (bytes memory)
    {
        Execution[] memory executions = new Execution[](4);
        executions[0] = Execution({target: paymentToken, value: 0, callData: abi.encodeWithSelector(
            IERC20Permit.permit.selector,
            owner,
            address(hca),
            20_000_000,
            block.timestamp + 1 hours,
            uint8(27),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        )});
        executions[1] = Execution({target: paymentToken, value: 0, callData: abi.encodeWithSelector(
            IERC20.transferFrom.selector,
            owner,
            fundingRecipient,
            20_000_000
        )});
        executions[2] = Execution({target: paymentToken, value: 0, callData: abi.encodeWithSelector(
            IERC20.approve.selector,
            gasRefundPaymaster,
            proof.maxRefundAmount
        )});
        executions[3] = Execution({target: ethRegistrar, value: 0, callData: abi.encodeWithSelector(
            IETHRegistrar.commit.selector,
            bytes32("commitment")
        )});
        permissionId;
        return _encodeExecutions(executions);
    }

    function _initialRefundEnvelope(
        bytes32 permissionId,
        SessionEnableProofFixture memory proof,
        uint256 nonce,
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund,
        bytes memory operationData,
        bytes32 digest
    )
        internal
        pure
        returns (bytes memory)
    {
        bytes memory proofData = _packProof(proof);
        return
            abi.encodePacked(
                bytes1(uint8(5)),
                permissionId,
                proofData,
                nonce,
                gasRefund.token,
                uint96(gasRefund.exchangeRate),
                uint96(gasRefund.overhead >> 128),
                uint48(uint128(gasRefund.overhead)),
                operationData,
                _signRhinestoneMessage(SESSION_KEY, digest)
            );
    }

    function _initialRefundExecutions(bytes32 permissionId, SessionEnableProofFixture memory proof)
        internal
        view
        returns (Execution[] memory)
    {
        (, Execution[] memory executions) =
            _decodeOperation(_initialRefundCommitOperation(permissionId, proof));
        return executions;
    }

    function _withoutExecution(Execution[] memory executions, uint256 removedIndex)
        internal
        pure
        returns (Execution[] memory remaining)
    {
        remaining = new Execution[](executions.length - 1);
        uint256 next;
        for (uint256 i; i < executions.length; ++i) {
            if (i != removedIndex) {
                remaining[next++] = executions[i];
            }
        }
    }

    function _encodeExecutions(Execution[] memory executions) internal pure returns (bytes memory) {
        bytes memory packed =
            abi.encodePacked(
                bytes2(HCAOperationHashLib.ERC7579_ERC1271_MODE),
                uint8(executions.length)
            );
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
        return packed;
    }

    function _assertInitialRefundPolicyFailure(
        bytes32 permissionId,
        SessionEnableProofFixture memory proof,
        uint256 nonce,
        bytes memory operationData
    )
        internal
    {
        HCAOwnerAndSessionValidator.GasRefund memory gasRefund =
            HCAOwnerAndSessionValidator.GasRefund({token: proof.refundToken, exchangeRate: proof.maxRefundExchangeRate, overhead: (uint256(
                    proof.maxRefundAmount
                ) <<
                128) |
            proof.maxRefundGasOverhead});
        bytes32 digest =
            validator.singleChainDigestWithRefundHarness(
                address(hca),
                nonce,
                operationData,
                gasRefund
            );

        vm.expectRevert(HCAOwnerAndSessionValidator.PolicyRuleFailed.selector);
        hca.validate(
            validator,
            digest,
            _initialRefundEnvelope(permissionId, proof, nonce, gasRefund, operationData, digest)
        );
    }

    function _withHybridMode(bytes memory operationData) internal pure returns (bytes memory) {
        operationData[1] = bytes1(uint8(6));
        return operationData;
    }

    function _multiChainEnableProof()
        internal
        view
        returns (SessionEnableProofFixture memory proof, bytes32 permissionId)
    {
        proof.sessionKey = sessionSigner;
        proof.validUntil = uint48(block.timestamp + 1 days);
        proof.sessionNonce = 0;
        proof.refundToken = paymentToken;
        proof.maxRefundExchangeRate = 5_000_000_000;
        proof.maxRefundGasOverhead = 100_000;
        proof.maxRefundAmount = 25_000_000;
        proof.sessionToEnableIndex = 1;

        address[] memory sessionOwners = new address[](1);
        sessionOwners[0] = sessionSigner;
        bytes memory validatorInitData = abi.encode(uint256(1), sessionOwners);
        bytes32 salt =
            keccak256(
                abi.encode(
                    proof.sessionNonce,
                    proof.validUntil,
                    proof.resolver,
                    proof.refundToken,
                    proof.maxRefundExchangeRate,
                    proof.maxRefundGasOverhead,
                    proof.maxRefundAmount
                )
            );
        permissionId = keccak256(abi.encode(OWNABLE_SESSION_VALIDATOR, validatorInitData, salt));
        bytes32 destinationSessionDigest =
            keccak256(
                abi.encode(
                    SIGNED_SESSION_TYPEHASH,
                    address(hca),
                    type(uint256).max,
                    uint256(0),
                    DEFAULT_SIGNED_PERMISSIONS_HASH,
                    salt,
                    OWNABLE_SESSION_VALIDATOR,
                    keccak256(validatorInitData),
                    SMART_SESSION_EMISSARY
                )
            );
        proof.hashesAndChainIds = new HCASmartSessionLib.HashAndChainId[](2);
        proof.hashesAndChainIds[0] = HCASmartSessionLib.HashAndChainId({chainId: uint64(
            SOURCE_CHAIN_ID
        ), sessionDigest: keccak256("source session")});
        proof.hashesAndChainIds[1] = HCASmartSessionLib.HashAndChainId({chainId: uint64(
            block.chainid
        ), sessionDigest: destinationSessionDigest});

        bytes32[] memory chainSessionHashes = new bytes32[](2);
        for (uint256 i; i < 2; ++i) {
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (proof.ownerV, proof.ownerR, proof.ownerS) = vm.sign(OWNER_KEY, digest);
    }

    function _packProof(SessionEnableProofFixture memory proof)
        internal
        pure
        returns (bytes memory packed)
    {
        packed = abi.encodePacked(
            proof.sessionKey,
            proof.validUntil,
            proof.sessionNonce,
            proof.resolver,
            proof.refundToken,
            proof.maxRefundExchangeRate,
            proof.maxRefundGasOverhead,
            proof.maxRefundAmount,
            proof.sessionToEnableIndex,
            uint8(proof.hashesAndChainIds.length)
        );
        for (uint256 i; i < proof.hashesAndChainIds.length; ++i) {
            HCASmartSessionLib.HashAndChainId memory item = proof.hashesAndChainIds[i];
            packed = bytes.concat(packed, abi.encodePacked(item.chainId, item.sessionDigest));
        }
        return bytes.concat(packed, abi.encodePacked(proof.ownerR, proof.ownerS, proof.ownerV));
    }

    function _claim(bytes memory operationData, address recipient, uint256 targetChainId)
        internal
        view
        returns (bytes memory claimData, bytes32 digest)
    {
        ClaimFixture memory claim =
            ClaimFixture({nonce: 42, deadline: block.timestamp + 1 hours, sourceAmount: 20_000_000, destinationAmount: 900_000, fillExpiry: block.timestamp +
            30 minutes, minGas: 1_000_000, recipient: recipient, targetChainId: targetChainId, originOpsHash: keccak256(
                "origin operation"
            ), destinationOpsHash: _operationHash(operationData), qualifierHash: keccak256(
                "qualifier"
            )});

        claimData = bytes.concat(
            abi.encodePacked(
                intentExecutor,
                claim.nonce,
                claim.deadline,
                uint8(1),
                bytes32(uint256(uint160(sourceToken))),
                claim.sourceAmount
            ),
            abi.encodePacked(
                claim.recipient,
                claim.targetChainId,
                claim.fillExpiry,
                uint8(1),
                bytes32(uint256(uint160(paymentToken))),
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

        digest = _permitDigest(claim);
    }

    function _permitDigest(ClaimFixture memory claim) internal view returns (bytes32 digest) {
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
                    keccak256(abi.encode(TOKEN_TYPEHASH, paymentToken, claim.destinationAmount))
                )
            );
        bytes32 targetHash =
            keccak256(
                abi.encode(
                    TARGET_TYPEHASH,
                    claim.recipient,
                    tokenOutHash,
                    claim.targetChainId,
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
                    intentExecutor,
                    claim.nonce,
                    claim.deadline,
                    mandateHash
                )
            );
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, PERMIT2_NAME_HASH, SOURCE_CHAIN_ID, PERMIT2));
        digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, permitHash));
    }

    function _operationHash(bytes memory operationData) internal pure returns (bytes32) {
        (bytes32 mode, Execution[] memory executions) = _decodeOperation(operationData);
        bytes32[] memory executionHashes = new bytes32[](executions.length);
        for (uint256 i; i < executions.length; ++i) {
            executionHashes[i] = keccak256(
                abi.encode(
                    OPS_TYPEHASH,
                    executions[i].target,
                    executions[i].value,
                    keccak256(executions[i].callData)
                )
            );
        }
        return
            keccak256(abi.encode(OP_TYPEHASH, mode, keccak256(abi.encodePacked(executionHashes))));
    }

    function _decodeOperation(bytes memory operationData)
        internal
        pure
        returns (bytes32 mode, Execution[] memory executions)
    {
        if (operationData.length < 3) {
            revert HCAOperationHashLib.InvalidOperationEncoding();
        }
        bytes2 modePrefix;
        assembly ("memory-safe") {
            modePrefix := mload(add(operationData, 0x20))
        }
        mode = bytes32(modePrefix);
        uint256 count = uint8(operationData[2]);
        executions = new Execution[](count);
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
            executions[i] = Execution({target: target, value: 0, callData: _slice(
                operationData,
                cursor,
                callDataLength
            )});
            cursor += callDataLength;
        }
        if (cursor != operationData.length) {
            revert HCAOperationHashLib.InvalidOperationEncoding();
        }
    }

    function _envelope(
        bytes32 permissionId,
        bytes memory claimData,
        bytes memory operationData,
        bytes32 digest
    )
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                bytes1(uint8(3)),
                permissionId,
                SOURCE_CHAIN_ID,
                claimData,
                operationData,
                _signRhinestoneMessage(SESSION_KEY, digest)
            );
    }

    function _slice(bytes memory data, uint256 start, uint256 length)
        internal
        pure
        returns (bytes memory result)
    {
        result = new bytes(length);
        for (uint256 i; i < result.length; ++i) {
            result[i] = data[start + i];
        }
    }

    function _signRhinestoneMessage(uint256 privateKey, bytes32 digest)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 personalDigest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, personalDigest);
        return abi.encodePacked(r, s, v + 4);
    }

    function _replaceSignature(bytes memory envelope, bytes memory signature) internal pure {
        uint256 signatureOffset = envelope.length - signature.length;
        for (uint256 i; i < signature.length; ++i) {
            envelope[signatureOffset + i] = signature[i];
        }
    }
}


/// @title HCA Owner and Session Validator Enable Harness
/// @notice Exposes internal digest construction for session-enable unit tests.
contract HCAOwnerAndSessionValidatorEnableHarness is HCAOwnerAndSessionValidator {
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

    /// @notice Exposes resolver call policy validation.
    /// @param callData ABI-encoded resolver call data.
    function checkResolverCallHarness(bytes calldata callData) external pure {
        _checkResolverCall(callData);
    }
}
