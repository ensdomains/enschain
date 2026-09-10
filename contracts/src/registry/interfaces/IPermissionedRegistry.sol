// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IEnhancedAccessControl} from "../../access-control/interfaces/IEnhancedAccessControl.sol";
import {IContractNamer} from "../../reverse-registrar/interfaces/IContractNamer.sol";
import {IUnsafeTransferable} from "../../utils/interfaces/IUnsafeTransferable.sol";

import {IRegistryURIRenderer} from "./IRegistryURIRenderer.sol";
import {IStandardRegistry} from "./IStandardRegistry.sol";

/// @dev Interface selector: `0xc18bd555`
interface IPermissionedRegistry is
    IStandardRegistry,
    IEnhancedAccessControl,
    IUnsafeTransferable,
    IContractNamer
{
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice The registration status of a label.
    enum Status {
        AVAILABLE,
        RESERVED,
        REGISTERED
    }

    /// @notice The registration state of a label.
    struct State {
        Status status; // getStatus()
        uint64 expiry; // getExpiry()
        address latestOwner; // latestOwnerOf()
        uint256 tokenId; // getTokenId()
        uint256 resource; // getResource()
    }

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Associate a token with an EAC resource.
    /// @param tokenId The token ID.
    /// @param resource The EAC resource.
    event TokenResource(uint256 indexed tokenId, uint256 indexed resource);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Label cannot be reserved again.
    /// @dev Error selector: `0xf60759e0`
    error LabelAlreadyReserved(string label);

    /// @notice Transfer is not allowed due to missing `CAN_TRANSFER_ADMIN` role.
    /// @dev Error selector: `0xe58f6d5a`
    error TransferDisallowed(uint256 tokenId, address from);

    /// @notice Safe transfer is not allowed because the registry is not emancipated.
    /// @dev Error selector: `0x54838f98`
    error TransferUnsafeUntilRegistryIsEmancipated();

    /// @notice Safe transfer is not allowed because the token has non-owner roles.
    /// @dev Error selector: `0x677f1c18`
    error TransferUnsafeWithMultipleAssignees(uint256 tokenId, address from);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Change metadata parameters.
    /// @dev Should emit `URIUpdated`.
    /// @param uri The new URI.
    /// @param renderer The new renderer address.
    function setURI(string calldata uri, IRegistryURIRenderer renderer) external;

    /// @notice Get metadata parameters.
    /// @return uri The metadata URI.
    /// @return renderer The metadata renderer address.
    function getURI() external view returns (string memory uri, IRegistryURIRenderer renderer);

    /// @notice Get the latest owner of a token.
    ///         If the token was burned, returns null.
    /// @param tokenId The token ID to query.
    /// @return owner The latest owner address.
    function latestOwnerOf(uint256 tokenId) external view returns (address owner);

    /// @notice Get the state of a label.
    /// @param anyId The labelhash, token ID, or resource.
    /// @return state The state of the label.
    function getState(uint256 anyId) external view returns (State memory state);

    /// @notice Get `Status` from `anyId`.
    /// @param anyId The labelhash, token ID, or resource.
    /// @return status The status of the label.
    function getStatus(uint256 anyId) external view returns (Status status);

    /// @notice Get `resource` from `anyId`.
    /// @param anyId The labelhash, token ID, or resource.
    /// @return resource The resource.
    function getResource(uint256 anyId) external view returns (uint256 resource);

    /// @notice Get `tokenId` from `anyId`.
    /// @param anyId The labelhash, token ID, or resource.
    /// @return tokenId The token ID.
    function getTokenId(uint256 anyId) external view returns (uint256 tokenId);

    /// @notice Get token owner from `anyId`.
    /// @param anyId The labelhash, token ID, or resource.
    /// @return owner The token owner.
    function getOwner(uint256 anyId) external view returns (address owner);

    /// @notice Return `true` if the tokens cannot be controlled by root.
    function isEmancipated() external view returns (bool);
}
