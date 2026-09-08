// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {CCIPBatcher} from "@ens/contracts/ccipRead/CCIPBatcher.sol";
import {CCIPReader} from "@ens/contracts/ccipRead/CCIPReader.sol";
import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {IMulticallable} from "@ens/contracts/resolvers/IMulticallable.sol";
import {IAddressResolver} from "@ens/contracts/resolvers/profiles/IAddressResolver.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {INameResolver} from "@ens/contracts/resolvers/profiles/INameResolver.sol";
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {IUniversalResolver} from "@ens/contracts/universalResolver/IUniversalResolver.sol";
import {BytesUtils} from "@ens/contracts/utils/BytesUtils.sol";
import {ENSIP19, COIN_TYPE_ETH} from "@ens/contracts/utils/ENSIP19.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {ResolverProfileRewriterLib} from "../resolver/libraries/ResolverProfileRewriterLib.sol";

import {IENSIP15} from "./interfaces/IENSIP15.sol";
import {INormalizedUniversalResolver} from "./interfaces/INormalizedUniversalResolver.sol";
import {
    INormalizedUniversalResolverExtended
} from "./interfaces/INormalizedUniversalResolverExtended.sol";
import {IUniversalResolverExtended} from "./interfaces/IUniversalResolverExtended.sol";
import {LibENSIP15} from "./libraries/LibENSIP15.sol";

/// @dev `AbstractUniversalResolver` implementation with ENSIP-15 support.
///      see: https://github.com/ensdomains/ens-contracts/blob/staging/contracts/universalResolver/AbstractUniversalResolver.sol
abstract contract AbstractNormalizedUniversalResolver is
    IUniversalResolver,
    IUniversalResolverExtended,
    INormalizedUniversalResolver,
    INormalizedUniversalResolverExtended,
    CCIPBatcher,
    ERC165
{
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct ReverseArgs {
        bytes lookupAddress; // parsed input address
        uint256 coinType; // parsed coinType
        string[] gateways; // supplied gateways
        address resolver; // valid reverse resolver
        IENSIP15 ensip15; // normalization implementation
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice Shared batch gateway provider.
    IGatewayProvider public immutable BATCH_GATEWAY_PROVIDER;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param _batchGatewayProvider The batch gateway provider.
    constructor(IGatewayProvider _batchGatewayProvider) CCIPReader(DEFAULT_UNSAFE_CALL_GAS) {
        BATCH_GATEWAY_PROVIDER = _batchGatewayProvider;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC165)
        returns (bool)
    {
        return
            type(IUniversalResolver).interfaceId == interfaceId ||
            type(IUniversalResolverExtended).interfaceId == interfaceId ||
            type(INormalizedUniversalResolver).interfaceId == interfaceId ||
            type(INormalizedUniversalResolverExtended).interfaceId == interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IUniversalResolver
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory, address)
    {
        return resolveWithGateways(name, data, BATCH_GATEWAY_PROVIDER.gateways());
    }

    /// @inheritdoc INormalizedUniversalResolver
    function resolveWithNormalization(bytes calldata name, bytes calldata data, IENSIP15 ensip15)
        external
        view
        returns (bytes memory, address)
    {
        return
            resolveWithGatewaysAndNormalization(
                name,
                data,
                BATCH_GATEWAY_PROVIDER.gateways(),
                ensip15
            );
    }

    /// @notice Same as `BATCH_GATEWAY_PROVIDER()` for backwards-compatability with ENSv1.
    function batchGatewayProvider() external view returns (IGatewayProvider) {
        return BATCH_GATEWAY_PROVIDER;
    }

    /// @notice CCIP-Read callback for `_callResolver()` from calling the resolver successfully.
    // solhint-disable-next-line
    function resolveDirectCallback(bytes memory response, bytes calldata extraData) external view {
        (bool extended, bytes4 callSelector, bytes4 callbackFunction, bytes memory extraData_) =
            abi.decode(extraData, (bool, bytes4, bytes4, bytes));
        if (response.length == 0) {
            revert UnsupportedResolverProfile(callSelector);
        }
        if (extended) {
            response = abi.decode(response, (bytes)); // unwrap resolve()
        }
        ccipRead(address(this), abi.encodeWithSelector(callbackFunction, response, extraData_));
    }

    /// @notice CCIP-Read callback for `_callResolver()` from calling the batch gateway successfully.
    // solhint-disable-next-line
    function resolveBatchCallback(bytes calldata response, bytes calldata extraData) external view {
        Lookup[] memory lookups = abi.decode(response, (Batch)).lookups;
        (bool extended, bool multi, bytes4 callbackFunction, bytes memory extraData_) =
            abi.decode(extraData, (bool, bool, bytes4, bytes));
        bytes memory answer;
        if (multi) {
            answer = abi.encode(_toResponseArray(lookups, extended));
        } else {
            Lookup memory lu = lookups[0];
            answer = lu.data;
            if ((lu.flags & FLAG_BATCH_ERROR) != 0) {
                assembly {
                    revert(add(answer, 32), mload(answer)) // propagate batch gateway errors
                }
            } else if ((lu.flags & FLAG_CALL_ERROR) != 0) {
                _propagateResolverError(answer);
            } else if (answer.length == 0) {
                revert UnsupportedResolverProfile(bytes4(lu.call));
            }
            if (extended) {
                answer = abi.decode(answer, (bytes)); // unwrap resolve()
            }
        }
        ccipRead(address(this), abi.encodeWithSelector(callbackFunction, answer, extraData_));
    }

    /// @inheritdoc IUniversalResolverExtended
    function resolveWithResolver(
        address resolver,
        bytes calldata name,
        bytes calldata data,
        string[] calldata gateways
    )
        external
        view
        returns (bytes memory)
    {
        ResolverInfo memory info;
        info.name = name;
        info.node = NameCoder.namehash(name, 0);
        info.resolver = resolver;
        _checkResolver(info);
        _callResolver(
            info,
            data,
            gateways,
            this.resolveCallback.selector, // ==> step 2
            abi.encode(resolver, "")
        );
    }

    /// @inheritdoc IUniversalResolver
    function reverse(bytes calldata lookupAddress, uint256 coinType)
        external
        view
        returns (string memory, address, address)
    {
        return
            reverseWithGatewaysAndNormalization(
                lookupAddress,
                coinType,
                BATCH_GATEWAY_PROVIDER.gateways(),
                IENSIP15(address(0))
            );
    }

    /// @inheritdoc INormalizedUniversalResolver
    function reverseWithNormalization(
        bytes calldata lookupAddress,
        uint256 coinType,
        IENSIP15 ensip15
    )
        external
        view
        returns (string memory, address, address)
    {
        return
            reverseWithGatewaysAndNormalization(
                lookupAddress,
                coinType,
                BATCH_GATEWAY_PROVIDER.gateways(),
                ensip15
            );
    }

    /// @inheritdoc IUniversalResolverExtended
    function reverseWithGateways(
        bytes calldata lookupAddress,
        uint256 coinType,
        string[] memory gateways
    )
        external
        view
        returns (string memory, address, address)
    {
        return
            reverseWithGatewaysAndNormalization(
                lookupAddress,
                coinType,
                gateways,
                IENSIP15(address(0))
            );
    }

    /// @notice CCIP-Read callback for `reverseWithGateways()`.
    // solhint-disable-next-line
    function reverseNameCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (string memory primary, address, address)
    {
        ReverseArgs memory args = abi.decode(extraData, (ReverseArgs));
        primary = abi.decode(response, (string));
        if (bytes(primary).length == 0) {
            return ("", address(0), args.resolver);
        }
        bytes memory name = NameCoder.encode(primary);
        if (address(args.ensip15) != address(0)) {
            bool wasNorm;
            (wasNorm, name) = normalize(name, args.ensip15);
            if (!wasNorm) {
                revert PrimaryNameNotNormalized(primary);
            }
        }
        ResolverInfo memory info = requireResolver(name);
        _callResolver(
            info,
            args.coinType == COIN_TYPE_ETH
                ? abi.encodeCall(IAddrResolver.addr, (info.node))
                : abi.encodeCall(IAddressResolver.addr, (info.node, args.coinType)),
            args.gateways,
            this.reverseAddressCallback.selector, // ==> step 3
            abi.encode(args, primary, info.resolver)
        );
    }

    /// @notice CCIP-Read callback for `resolveWithGateways()`.
    // solhint-disable-next-line
    function resolveCallback(bytes calldata response, bytes calldata extraData)
        external
        pure
        returns (bytes memory, address)
    {
        (address resolver, bytes memory name) = abi.decode(extraData, (address, bytes));
        if (name.length > 0) {
            revert NormalizationChangedName(name, response, resolver);
        }
        return (response, resolver);
    }

    /// @dev CCIP-Read callback for `reverseNameCallback()`.
    // solhint-disable-next-line
    function reverseAddressCallback(bytes calldata response, bytes calldata extraData)
        external
        pure
        returns (string memory primary, address resolver, address reverseResolver)
    {
        ReverseArgs memory args;
        (args, primary, resolver) = abi.decode(extraData, (ReverseArgs, string, address));
        bytes memory primaryAddress;
        if (args.coinType == COIN_TYPE_ETH) {
            address addr = abi.decode(response, (address));
            primaryAddress = abi.encodePacked(addr);
        } else {
            primaryAddress = abi.decode(response, (bytes));
        }
        if (!BytesUtils.equals(args.lookupAddress, primaryAddress)) {
            revert ReverseAddressMismatch(primary, primaryAddress);
        }
        reverseResolver = args.resolver;
    }

    /// @notice CCIP-Read callback for `_callResolver()` from calling the resolver unsuccessfully.
    // solhint-disable-next-line
    function resolveDirectCallbackError(bytes calldata response, bytes calldata) external pure {
        _propagateResolverError(response);
    }

    /// @inheritdoc INormalizedUniversalResolver
    function isENSv2() external pure virtual returns (bool);

    /// @inheritdoc IUniversalResolver
    function findResolver(bytes memory name)
        public
        view
        virtual
        returns (address, bytes32, uint256);

    /// @inheritdoc INormalizedUniversalResolver
    function normalize(bytes memory name, IENSIP15 ensip15)
        public
        view
        returns (bool, bytes memory)
    {
        return LibENSIP15.normalize(name, ensip15);
    }

    /// @inheritdoc IUniversalResolverExtended
    function requireResolver(bytes memory name) public view returns (ResolverInfo memory info) {
        (info.resolver, info.node, info.offset) = findResolver(name);
        info.name = name;
        _checkResolver(info);
    }

    /// @inheritdoc IUniversalResolverExtended
    function resolveWithGateways(bytes calldata name, bytes calldata data, string[] memory gateways)
        public
        view
        returns (bytes memory, address)
    {
        ResolverInfo memory info = requireResolver(name);
        _callResolver(
            info,
            data,
            gateways,
            this.resolveCallback.selector, // ==> step 2
            abi.encode(info.resolver, "")
        );
    }

    /// @inheritdoc INormalizedUniversalResolverExtended
    function resolveWithGatewaysAndNormalization(
        bytes calldata name,
        bytes calldata data,
        string[] memory gateways,
        IENSIP15 ensip15
    )
        public
        view
        returns (bytes memory, address)
    {
        (bool wasNorm, bytes memory norm) = normalize(name, ensip15);
        ResolverInfo memory info = requireResolver(norm);
        _callResolver(
            info,
            ResolverProfileRewriterLib.replaceNode(data, info.node),
            gateways,
            this.resolveCallback.selector, // ==> step 2
            abi.encode(info.resolver, wasNorm ? bytes("") : norm)
        );
    }

    /// @inheritdoc INormalizedUniversalResolverExtended
    function reverseWithGatewaysAndNormalization(
        bytes calldata lookupAddress,
        uint256 coinType,
        string[] memory gateways,
        IENSIP15 ensip15
    )
        public
        view
        returns (string memory, address, address)
    {
        // https://docs.ens.domains/ensip/19
        ResolverInfo memory info =
            requireResolver(
                NameCoder.encode(ENSIP19.reverseName(lookupAddress, coinType)) // reverts EmptyAddress
            );
        _callResolver(
            info,
            abi.encodeCall(INameResolver.name, (info.node)),
            gateways,
            this.reverseNameCallback.selector, // ==> step 2
            abi.encode(ReverseArgs(lookupAddress, coinType, gateways, info.resolver, ensip15))
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Asserts that the resolver information is valid.
    function _checkResolver(ResolverInfo memory info) internal view {
        if (info.resolver == address(0)) {
            revert ResolverNotFound(info.name);
        } else if (
            ERC165Checker.supportsERC165InterfaceUnchecked(
                info.resolver,
                type(IExtendedResolver).interfaceId
            )
        ) {
            info.extended = true;
        } else if (info.offset != 0) {
            revert ResolverNotFound(info.name); // immediate resolver requires exact match
        } else if (info.resolver.code.length == 0) {
            revert ResolverNotContract(info.name, info.resolver);
        }
    }

    /// @dev Efficiently call a resolver (see: `ResolverCaller`).
    ///      If ENSIP-22 is supported, performs a direct call.
    ///      Otherwise, uses the batch gateway.
    /// @param info The resolver to call.
    /// @param data The resolution calldata.
    /// @param gateways The list of batch gateway URLs to use.
    /// @param callbackFunction The function selector to call after resolution.
    /// @param extraData The contextual data passed to `callbackFunction`.
    function _callResolver(
        ResolverInfo memory info,
        bytes memory data,
        string[] memory gateways,
        bytes4 callbackFunction,
        bytes memory extraData
    )
        internal
        view
    {
        bool multi = bytes4(data) == IMulticallable.multicall.selector;
        if (
            ERC165Checker.supportsERC165InterfaceUnchecked(info.resolver, type(IERC7996).interfaceId) &&
            (!multi ||
                (info.extended &&
                    IERC7996(info.resolver).supportsFeature(ResolverFeatures.RESOLVE_MULTICALL)))
        ) {
            ccipRead(
                address(info.resolver),
                info.extended
                    ? abi.encodeCall(IExtendedResolver.resolve, (info.name, data))
                    : data,
                this.resolveDirectCallback.selector,
                this.resolveDirectCallbackError.selector,
                abi.encode(info.extended, bytes4(data), callbackFunction, extraData)
            );
        }
        bytes[] memory calls;
        if (multi) {
            assembly {
                mstore(add(data, 4), sub(mload(data), 4)) // truncate
                data := add(data, 4)
            }
            calls = abi.decode(data, (bytes[]));
        } else {
            calls = new bytes[](1);
            calls[0] = data;
        }
        if (info.extended) {
            for (uint256 i; i < calls.length; ++i) {
                calls[i] = abi.encodeCall(IExtendedResolver.resolve, (info.name, calls[i]));
            }
        }
        ccipRead(
            address(this),
            abi.encodeCall(this.ccipBatch, (createBatch(info.resolver, calls, gateways))),
            this.resolveBatchCallback.selector,
            IDENTITY_FUNCTION,
            abi.encode(info.extended, multi, callbackFunction, extraData)
        );
    }

    /// @dev Propagate the revert from the resolver.
    /// @param v The error data.
    function _propagateResolverError(bytes memory v) internal pure {
        if (bytes4(v) == UnsupportedResolverProfile.selector) {
            assembly {
                revert(add(v, 32), mload(v))
            }
        } else {
            revert ResolverError(v);
        }
    }
}
