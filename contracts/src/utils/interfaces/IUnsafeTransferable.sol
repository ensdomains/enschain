// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

/// @notice Interface for `ERC721` or `ERC1155Singleton` for an additional transfer method.
/// @dev Interface selector: `0x35aee916`
interface IUnsafeTransferable {
    /// @notice Transfer a token without safety checks.
    /// @param to Address to transfer to.
    /// @param tokenId The token ID.
    /// @param data Additional calldata passed to receiver hooks.
    function unsafeTransfer(address to, uint256 tokenId, bytes calldata data) external;

    /// @notice Batch transfer multiple tokens without safety checks.
    /// @param to Address to transfer to.
    /// @param tokenIds Array of token IDs.
    /// @param data Additional calldata passed to receiver hooks.
    function unsafeBatchTransfer(address to, uint256[] calldata tokenIds, bytes calldata data)
        external;
}
