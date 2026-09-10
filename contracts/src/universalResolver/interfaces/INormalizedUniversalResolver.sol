// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IENSIP15} from "./IENSIP15.sol";

/// @notice Interface for ENSv2-specific `UniversalResolver`.
/// @dev Interface selector: `0xfe0badd6`
interface INormalizedUniversalResolver {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Primary name was not normalized.
    /// @dev Error selector: `0x28c6aa0c`
    error PrimaryNameNotNormalized(string primary);

    /// @notice Input name was not normalized; resolved normalized name instead.
    /// @dev Error selector: `0x2dba1353`
    error NormalizationChangedName(bytes normalizedName, bytes result, address resolver);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Performs ENS forward resolution for the supplied name and data.
    ///         Caller should enable EIP-3668.
    ///         Reverts `NormalizationChangedName`.
    /// @param name DNS-encoded name to resolve.
    /// @param data The ABI-encoded resolver calldata.
    /// @param ensip15 ENSIP-15 Normalization implementation.
    /// @return result The ABI-encoded response for the calldata.
    /// @return resolver The resolver that was used to resolve the name.
    function resolveWithNormalization(bytes calldata name, bytes calldata data, IENSIP15 ensip15)
        external
        view
        returns (bytes memory result, address resolver);

    /// @notice Performs ENS primary resolution for the supplied address and coin type.
    ///         Caller should enable EIP-3668.
    ///         Reverts `PrimaryNameNotNormalized`.
    /// @param lookupAddress The input address.
    /// @param coinType The coin type.
    /// @param ensip15 ENSIP-15 Normalization implementation.
    /// @return primary The resolved normalized primary name.
    /// @return resolver The resolver address for primary name.
    /// @return reverseResolver The resolver address for the reverse name.
    function reverseWithNormalization(
        bytes calldata lookupAddress,
        uint256 coinType,
        IENSIP15 ensip15
    )
        external
        view
        returns (string memory primary, address resolver, address reverseResolver);

    /// @notice Normalize a name according to ENSIP-15.
    /// @param name DNS-encoded name to normalize.
    /// @param ensip15 ENSIP-15 Normalization implementation.
    /// @return wasNormalized `true` if `name` was already normalized.
    /// @return normalizedName Normalized DNS-encoded name.
    function normalize(bytes calldata name, IENSIP15 ensip15)
        external
        view
        returns (bool wasNormalized, bytes memory normalizedName);

    /// @notice Return `true` if ENSv2 otherwise ENSv1.
    function isENSv2() external view returns (bool);
}
