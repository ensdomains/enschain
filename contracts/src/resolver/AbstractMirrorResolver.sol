// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {CCIPReader} from "@ens/contracts/ccipRead/CCIPReader.sol";
import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {ICompositeResolver} from "@ens/contracts/resolvers/profiles/ICompositeResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {ResolverCaller} from "@ens/contracts/universalResolver/ResolverCaller.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

/// @dev Resolver that mirrors resolution of the same name to a different registry.
abstract contract AbstractMirrorResolver is
    ICompositeResolver,
    IERC7996,
    ResolverCaller,
    DelegatedContractNamer
{
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice Shared batch gateway provider.
    IGatewayProvider public immutable BATCH_GATEWAY_PROVIDER;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param batchGatewayProvider The batch gateway provider.
    /// @param contractNamer Delegated contract namer.
    constructor(IGatewayProvider batchGatewayProvider, IContractNamer contractNamer)
        CCIPReader(DEFAULT_UNSAFE_CALL_GAS)
        DelegatedContractNamer(contractNamer)
    {
        BATCH_GATEWAY_PROVIDER = batchGatewayProvider;
    }

    /// @inheritdoc DelegatedContractNamer
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(DelegatedContractNamer)
        returns (bool)
    {
        return
            type(IExtendedResolver).interfaceId == interfaceId ||
            type(ICompositeResolver).interfaceId == interfaceId ||
            type(IERC7996).interfaceId == interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IERC7996
    function supportsFeature(bytes4 feature) external pure returns (bool) {
        return ResolverFeatures.RESOLVE_MULTICALL == feature;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IExtendedResolver
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        callResolver(
            _requireResolver(name),
            name,
            data,
            false,
            "",
            BATCH_GATEWAY_PROVIDER.gateways()
        );
    }

    /// @inheritdoc ICompositeResolver
    function getResolver(bytes calldata name) external view returns (address, bool) {
        return (_requireResolver(name), false);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Find the resolver for `name`.
    function _findResolver(bytes calldata name)
        internal
        view
        virtual
        returns (address resolver, uint256 offset);

    /// @dev Determine the valid resolver for `name`.
    function _requireResolver(bytes calldata name) internal view returns (address) {
        (address resolver, uint256 offset) = _findResolver(name);
        if (
            resolver.code.length == 0 ||
            (offset > 0 &&
                !ERC165Checker.supportsERC165InterfaceUnchecked(
                    resolver,
                    type(IExtendedResolver).interfaceId
                ))
        ) {
            revert UnreachableName(name);
        }
        return resolver;
    }
}
