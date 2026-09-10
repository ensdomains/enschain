// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IMulticallable} from "@ens/contracts/resolvers/IMulticallable.sol";
import {CloneProxyBytecode} from "@ensdomains/verifiable-factory/CloneProxyBytecode.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {Grant} from "../../access-control/interfaces/IEACGrantInitializable.sol";
import {EACBaseRolesLib} from "../../access-control/libraries/EACBaseRolesLib.sol";
import {IPermissionedResolver} from "../../resolver/interfaces/IPermissionedResolver.sol";
import {
    IPermissionedResolverInitializable
} from "../../resolver/interfaces/IPermissionedResolverInitializable.sol";
import {IABISetter} from "../../resolver/interfaces/setters/IABISetter.sol";
import {IAddressSetter} from "../../resolver/interfaces/setters/IAddressSetter.sol";
import {IContenthashSetter} from "../../resolver/interfaces/setters/IContenthashSetter.sol";
import {IDataSetter} from "../../resolver/interfaces/setters/IDataSetter.sol";
import {IInterfaceSetter} from "../../resolver/interfaces/setters/IInterfaceSetter.sol";
import {INameSetter} from "../../resolver/interfaces/setters/INameSetter.sol";
import {ITextSetter} from "../../resolver/interfaces/setters/ITextSetter.sol";

import {HCAExecutionLib} from "./HCAExecutionLib.sol";

/// @title HCA Resolver Policy Library
/// @notice Validates resolver calls, deployments, and implementation bindings for HCA sessions.
/// @dev Uses the canonical permissioned-resolver interfaces for every accepted call.
library HCAResolverPolicyLib {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice A target/action pair is outside the resolver policy.
    /// @dev Error selector: `0xde1834f2`
    /// @param target The forbidden execution target.
    /// @param selector The forbidden function selector.
    error ActionNotAllowed(address target, bytes4 selector);

    /// @notice A resolver policy argument check failed.
    /// @dev Error selector: `0xe50c42ea`
    error PolicyRuleFailed();

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Requires a used resolver to be an exact pending deployment or a verified proxy.
    /// @dev Fails closed when the factory cannot verify a deployed resolver.
    /// @param resolver The resolver bound to the session.
    /// @param usesResolver Whether the operation uses the resolver.
    /// @param deploysResolver Whether the operation deploys the resolver.
    /// @param implementation The permitted resolver implementation.
    /// @param factory The permitted verifiable factory.
    function checkBinding(
        address resolver,
        bool usesResolver,
        bool deploysResolver,
        address implementation,
        address factory
    )
        internal
        view
    {
        if (!usesResolver) {
            return;
        }
        if (resolver == address(0)) {
            revert PolicyRuleFailed();
        }
        if (resolver.code.length == 0) {
            if (!deploysResolver) {
                revert PolicyRuleFailed();
            }
            return;
        }
        if (deploysResolver) {
            revert PolicyRuleFailed();
        }

        try IVerifiableFactory(factory).verifyContract(resolver) returns (
            address verifiedImplementation
        ) {
            if (verifiedImplementation != implementation) {
                revert PolicyRuleFailed();
            }
        } catch {
            revert PolicyRuleFailed();
        }
    }

    /// @notice Validates one direct or nested resolver call.
    /// @dev Recurses through the standard resolver multicall and rejects unknown selectors.
    /// @param callData ABI-encoded resolver call data.
    function checkCall(bytes memory callData) internal pure {
        bytes4 callSelector = HCAExecutionLib.selector(callData);
        if (callSelector == IMulticallable.multicall.selector) {
            _checkCalls(abi.decode(HCAExecutionLib.callArgs(callData), (bytes[])));
            return;
        }
        if (!_isRecordSelector(callSelector)) {
            revert ActionNotAllowed(address(0), callSelector);
        }
    }

    /// @notice Validates an exact deployment of the resolver bound to a session.
    /// @dev Requires full resolver access for both the HCA and its owner at initialization and
    ///      permits only supported resolver record setters in the initializer multicall.
    /// @param account The HCA that calls the factory.
    /// @param owner The HCA owner that receives resolver access.
    /// @param resolver The resolver address bound to the session.
    /// @param callData ABI-encoded factory call data.
    /// @param implementation The permitted resolver implementation.
    /// @param factory The permitted verifiable factory.
    /// @param proxyLogic The factory's proxy logic.
    function checkDeployment(
        address account,
        address owner,
        address resolver,
        bytes memory callData,
        address implementation,
        address factory,
        address proxyLogic
    )
        internal
        pure
    {
        (address callImplementation, uint256 salt, bytes memory initData) =
            abi.decode(HCAExecutionLib.callArgs(callData), (address, uint256, bytes));
        if (
            callImplementation != implementation ||
            HCAExecutionLib.selector(initData) !=
            IPermissionedResolverInitializable.initialize.selector
        ) {
            revert PolicyRuleFailed();
        }

        (Grant[] memory grants, bytes[] memory calls) =
            abi.decode(HCAExecutionLib.callArgs(initData), (Grant[], bytes[]));
        if (
            grants.length != 2 ||
            grants[0].account != account ||
            grants[0].roleBitmap != EACBaseRolesLib.ALL_ROLES ||
            grants[1].account != owner ||
            grants[1].roleBitmap != EACBaseRolesLib.ALL_ROLES
        ) {
            revert PolicyRuleFailed();
        }
        _checkCalls(calls);

        bytes memory expectedInitData =
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, calls));
        bytes memory expectedCallData =
            abi.encodeCall(IVerifiableFactory.deployProxy, (implementation, salt, expectedInitData));

        if (
            keccak256(callData) != keccak256(expectedCallData) ||
            resolverAddress(account, salt, factory, proxyLogic) != resolver
        ) {
            revert PolicyRuleFailed();
        }
    }

    /// @notice Computes the resolver proxy address for an HCA and user salt.
    /// @dev Mirrors the factory's caller-bound salt and clone bytecode derivation.
    /// @param account The HCA that deploys the resolver proxy.
    /// @param salt The user salt supplied to the factory.
    /// @param factory The permitted verifiable factory.
    /// @param proxyLogic The factory's proxy logic.
    /// @return resolver The counterfactual resolver address.
    function resolverAddress(address account, uint256 salt, address factory, address proxyLogic)
        internal
        pure
        returns (address resolver)
    {
        bytes32 outerSalt = keccak256(abi.encode(account, salt));
        return
            Create2.computeAddress(
                outerSalt,
                keccak256(CloneProxyBytecode.creationCode(proxyLogic, outerSalt)),
                factory
            );
    }

    /// @dev Validates nested resolver calls.
    function _checkCalls(bytes[] memory calls) private pure {
        for (uint256 i; i < calls.length; ++i) {
            checkCall(calls[i]);
        }
    }

    /// @dev Returns whether a selector is a resolver record setter accepted by the policy.
    function _isRecordSelector(bytes4 callSelector) private pure returns (bool) {
        return
            callSelector == IPermissionedResolver.linkToRecord.selector ||
            callSelector == IPermissionedResolver.linkToNode.selector ||
            callSelector == IABISetter.setABI.selector ||
            callSelector == IAddressSetter.setAddress.selector ||
            callSelector == IContenthashSetter.setContenthash.selector ||
            callSelector == IDataSetter.setData.selector ||
            callSelector == IInterfaceSetter.setInterface.selector ||
            callSelector == INameSetter.setName.selector ||
            callSelector == ITextSetter.setText.selector;
    }
}
