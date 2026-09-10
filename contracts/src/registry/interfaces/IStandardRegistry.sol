// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IRegistry} from "./IRegistry.sol";
import {ITemporalRegistry} from "./ITemporalRegistry.sol";
import {ITokenizedRegistry} from "./ITokenizedRegistry.sol";

/// @title IStandardRegistry
/// @notice A tokenized registry with registrations that expire.
/// @dev Interface selector: `0xb844ab6c`
interface IStandardRegistry is ITemporalRegistry, ITokenizedRegistry {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Label is already registered.
    /// @dev Error selector: `0xdef545a4`
    error LabelAlreadyRegistered(string label);

    /// @notice Label is expired/unregistered.
    /// @dev Error selector: `0xc44e2374`
    error LabelExpired(uint256 tokenId);

    /// @notice Label expiry cannot be reduced.
    /// @dev Error selector: `0x68c1425a`
    error CannotReduceExpiry(uint64 oldExpiry, uint64 newExpiry);

    /// @notice Label expiry cannot be before now.
    /// @dev Error selector: `0xf1d446c3`
    error CannotSetPastExpiry(uint64 expiry);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Registers a new label.
    /// @param label The label to register.
    /// @param owner The address of the owner of the label.
    /// @param registry The registry to set as the label.
    /// @param resolver The resolver to set for the label.
    /// @param roleBitmap The role bitmap to set for the label.
    /// @param expiry The expiry of the label, in seconds.
    /// @return tokenId The token ID.
    function register(
        string calldata label,
        address owner,
        IRegistry registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    )
        external
        returns (uint256 tokenId);

    /// @notice Renew a label.
    /// @param anyId The labelhash, token ID, or resource.
    /// @param newExpiry The new expiry, in seconds.
    function renew(uint256 anyId, uint64 newExpiry) external;

    /// @notice Delete a label.
    /// @param anyId The labelhash, token ID, or resource.
    function unregister(uint256 anyId) external;

    /// @notice Change registry of label.
    /// @dev Should emit `SubregistryUpdated`.
    /// @param anyId The labelhash, token ID, or resource.
    /// @param registry The new registry.
    function setSubregistry(uint256 anyId, IRegistry registry) external;

    /// @notice Change resolver of label.
    /// @dev Should emit `ResolverUpdated`.
    /// @param anyId The labelhash, token ID, or resource.
    /// @param resolver The new resolver.
    function setResolver(uint256 anyId, address resolver) external;

    /// @notice Change canonical "location".
    /// @dev Should emit `ParentUpdated`.
    /// @param parent The canonical parent of this registry.
    /// @param label The canonical subdomain of this registry.
    function setParent(IRegistry parent, string calldata label) external;

    /// @notice Get expiry of label.
    /// @param anyId The labelhash, token ID, or resource.
    /// @return expiry The expiry of the label, in seconds.
    function getExpiry(uint256 anyId) external view returns (uint64 expiry);
}
