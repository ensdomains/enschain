// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {IOwnedRegistry} from "../registry/interfaces/IOwnedRegistry.sol";
import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";
import {IAddressSet} from "../utils/interfaces/IAddressSet.sol";

import {LibResolution} from "./libraries/LibResolution.sol";

/// @notice Collection of non-essential ENSv2 functions.
contract UniversalHelper is DelegatedContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice ENSv2 root registry.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    /// @notice The shared factory for verifiable deployments.
    IVerifiableFactory public immutable VERIFIABLE_FACTORY;

    /// @notice Set of trusted registry contracts and implementations.
    IAddressSet public immutable TRUSTED_REGISTRY_SET;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootRegistry The root registry.
    /// @param verifiableFactory The VerifiableFactory.
    /// @param trustedRegistrySet Set of trusted registry contracts and implementations.
    /// @param contractNamer Delegated contract namer.
    constructor(
        IPermissionedRegistry rootRegistry,
        IVerifiableFactory verifiableFactory,
        IAddressSet trustedRegistrySet,
        IContractNamer contractNamer
    )
        DelegatedContractNamer(contractNamer)
    {
        ROOT_REGISTRY = rootRegistry;
        VERIFIABLE_FACTORY = verifiableFactory;
        TRUSTED_REGISTRY_SET = trustedRegistrySet;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Find the exact owner for `name`.
    /// @param name The DNS-encoded name.
    /// @return The owner address or null if unowned or not found.
    function findExactOwner(bytes calldata name) external view returns (address) {
        return LibResolution.findExactOwner(ROOT_REGISTRY, name, 0);
    }

    /// @notice Find the nearest owner for `name`.
    /// @param name The DNS-encoded name.
    /// @return owner The owner address or null if unowned or not found.
    /// @return offset The offset into `name` such that `findExactOwner(name[offset:]) == owner`.
    function findNearestOwner(bytes calldata name)
        external
        view
        returns (address owner, uint256 offset)
    {
        return LibResolution.findNearestOwner(ROOT_REGISTRY, name, 0);
    }

    /// @notice Construct the canonical name for `registry`.
    /// @param registry The registry to name.
    /// @return The DNS-encoded name or empty if not canonical.
    function findCanonicalName(IRegistry registry) external view returns (bytes memory) {
        return LibResolution.findCanonicalName(ROOT_REGISTRY, registry);
    }

    /// @notice Find the canonical registry for `name`.
    /// @param name The DNS-encoded name.
    /// @return The canonical registry or null if not canonical.
    function findCanonicalRegistry(bytes calldata name) external view returns (IRegistry) {
        return LibResolution.findCanonicalRegistry(ROOT_REGISTRY, name);
    }

    /// @notice Find the exact registry for `name`.
    /// @param name The DNS-encoded name.
    /// @return The registry or null if not found.
    function findExactRegistry(bytes calldata name) external view returns (IRegistry) {
        return LibResolution.findExactRegistry(ROOT_REGISTRY, name, 0);
    }

    /// @notice Find the nearest registry for `name`.
    /// @param name The DNS-encoded name.
    /// @return registry The nearest registry or null if not found.
    /// @return offset The offset into `name` such that `findExactRegistry(name[offset:]) == registry`.
    function findNearestRegistry(bytes calldata name)
        external
        view
        returns (IRegistry registry, uint256 offset)
    {
        return LibResolution.findNearestRegistry(ROOT_REGISTRY, name, 0);
    }

    /// @notice Find the parent registry for `name`.
    /// @param name The DNS-encoded name.
    /// @return The parent registry or null if not found.
    function findParentRegistry(bytes calldata name) external view returns (IRegistry) {
        return LibResolution.findParentRegistry(ROOT_REGISTRY, name, 0);
    }

    /// @notice Find all registries in the ancestry of `name`.
    /// * `findRegistries("") = [<root>]`
    /// * `findRegistries("eth") = [<eth>, <root>]`
    /// * `findRegistries("nick.eth") = [<nick>, <eth>, <root>]`
    /// * `findRegistries("sub.nick.eth") = [null, <nick>, <eth>, <root>]`
    ///
    /// @param name The DNS-encoded name.
    /// @return Array of registries in label-order.
    function findRegistries(bytes calldata name) external view returns (IRegistry[] memory) {
        return LibResolution.findRegistries(ROOT_REGISTRY, name, 0);
    }

    /// @notice Determine if registry is trusted.  Does not check ancestory.
    /// @param registry The registry to check.
    /// @return `true` if registry is trusted.
    function isTrustedRegistry(IRegistry registry) external view returns (bool) {
        return LibResolution.isTrustedRegistry(VERIFIABLE_FACTORY, TRUSTED_REGISTRY_SET, registry);
    }

    /// @notice Find the parent registry if and only if every ancestor is trusted.
    /// @param name The DNS-encoded name.
    /// @return parent The parent registry or null if any ancestor was not trusted.
    function findTrustedParentRegistry(bytes calldata name)
        external
        view
        returns (IRegistry parent)
    {
        (bytes32 labelHash, uint256 next) = NameCoder.readLabel(name, 0);
        if (labelHash != bytes32(0)) {
            parent = LibResolution.findTrustedRegistry(
                VERIFIABLE_FACTORY,
                TRUSTED_REGISTRY_SET,
                ROOT_REGISTRY,
                name,
                next
            );
        }
    }

    /// @notice Find the parent registry if and only if every ancestor is emancipated.
    /// @param name The DNS-encoded name.
    /// @return parent The parent registry or null if any ancestor was not emancipated.
    function findEmancipatedParentRegistry(bytes calldata name)
        external
        view
        returns (IOwnedRegistry parent)
    {
        (bytes32 labelHash, uint256 next) = NameCoder.readLabel(name, 0);
        if (labelHash != bytes32(0)) {
            parent = LibResolution.findEmancipatedRegistry(
                VERIFIABLE_FACTORY,
                TRUSTED_REGISTRY_SET,
                ROOT_REGISTRY,
                name,
                next
            );
        }
    }
}
