// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IUniversalResolver} from "@ens/contracts/universalResolver/IUniversalResolver.sol";

/// @dev Interface selector: `0x9e2af83e`
interface IUniversalResolverExtended is IUniversalResolver {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice A valid resolver and its relevant properties.
    struct ResolverInfo {
        bytes name; // dns-encoded name (safe to decode)
        uint256 offset; // byte offset into name used for resolver
        bytes32 node; // namehash(name)
        address resolver;
        bool extended; // IExtendedResolver
    }

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Returns a valid resolver for `name` or reverts.
    /// @param name The DNS-encoded name to search.
    /// @return info The valid resolver information.
    function requireResolver(bytes calldata name) external view returns (ResolverInfo memory info);

    /// @notice Invoke a specific resolver. 
    /// @param resolver The resolver address.
    /// @param name The DNS-encoded name to resolve.
    /// @param data The ABI-encoded resolver calldata.
    /// @param gateways The list of batch gateway URLs to use.
    /// @return The ABI-encoded response for the calldata.
    function resolveWithResolver(
        address resolver,
        bytes calldata name,
        bytes calldata data,
        string[] calldata gateways
    )
        external
        view
        returns (bytes memory);

    /// @notice Performs ENS forward resolution for the supplied name and data.
    ///         Caller should enable EIP-3668.
    /// @param name The DNS-encoded name to resolve.
    /// @param data The ABI-encoded resolver calldata.
    /// @param gateways The list of batch gateway URLs to use.
    /// @return result The ABI-encoded response for the calldata.
    /// @return resolver The resolver that was used to resolve the name.
    function resolveWithGateways(
        bytes calldata name,
        bytes calldata data,
        string[] calldata gateways
    )
        external
        view
        returns (bytes memory result, address resolver);

    /// @notice Performs ENS primary resolution for the supplied address and coin type.
    ///         Caller should enable EIP-3668.
    /// @param lookupAddress The input address.
    /// @param coinType The coin type.
    /// @param gateways The list of batch gateway URLs to use.
    /// @return primary The resolved primary name.
    /// @return resolver The resolver address for primary name.
    /// @return reverseResolver The resolver address for the reverse name.
    function reverseWithGateways(
        bytes calldata lookupAddress,
        uint256 coinType,
        string[] calldata gateways
    )
        external
        view
        returns (string memory primary, address resolver, address reverseResolver);
}
