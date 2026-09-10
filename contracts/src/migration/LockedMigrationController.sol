// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {INameWrapper} from "@ens/contracts/wrapper/INameWrapper.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";
import {IAddressSet} from "../utils/interfaces/IAddressSet.sol";

import {AbstractWrapperReceiver} from "./AbstractWrapperReceiver.sol";
import {LockedWrapperReceiver} from "./LockedWrapperReceiver.sol";

/// @notice Migration controller for handling locked .eth names.
///
/// Assumes premigration has `RESERVED` existing ENSv1 names.
/// Requires `ROLE_REGISTER_RESERVED` on .eth registry to perform migration.
///
contract LockedMigrationController is LockedWrapperReceiver, DelegatedContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 .eth `PermissionedRegistry` where migrated names are registered.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param nameWrapper The ENSv1 `NameWrapper` contract.
    /// @param graveyard The ENSv1 `BaseRegistrar` token graveyard.
    /// @param ethRegistry The ENSv2 .eth `PermissionedRegistry` where migrated names are registered.
    /// @param verifiableFactory The shared factory for verifiable deployments.
    /// @param wrapperRegistryImpl The `WrapperRegistry` implementation contract.
    /// @param publicResolverSet The list of `PublicResolver` contracts that require replacement.
    /// @param publicResolver The replacement `PublicResolver`.
    /// @param contractNamer Delegated contract namer.
    constructor(
        INameWrapper nameWrapper,
        address graveyard,
        IPermissionedRegistry ethRegistry,
        VerifiableFactory verifiableFactory,
        address wrapperRegistryImpl,
        IAddressSet publicResolverSet,
        address publicResolver,
        IContractNamer contractNamer
    )
        LockedWrapperReceiver(
            nameWrapper,
            graveyard,
            verifiableFactory,
            wrapperRegistryImpl,
            publicResolverSet,
            publicResolver
        )
        DelegatedContractNamer(contractNamer)
    {
        ETH_REGISTRY = ethRegistry;
    }

    /// @inheritdoc DelegatedContractNamer
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbstractWrapperReceiver, DelegatedContractNamer)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Returns the DNS-encoded name for "eth".
    function getWrappedNode() public pure override returns (bytes32) {
        return NameCoder.ETH_NODE;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Register `RESERVED` .eth token.
    function _inject(
        string memory label,
        address owner,
        IRegistry subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 /*expiry*/
    )
        internal
        override
        returns (uint256 tokenId)
    {
        return
            ETH_REGISTRY.register(
                label,
                owner,
                subregistry,
                resolver,
                roleBitmap,
                0 // use reserved expiry
            ); // reverts if not RESERVED
    }

    /// @inheritdoc LockedWrapperReceiver
    function _getRegistry() internal view override returns (IRegistry) {
        return ETH_REGISTRY;
    }
}
