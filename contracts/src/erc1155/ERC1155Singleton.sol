// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {
    IERC1155MetadataURI
} from "@openzeppelin/contracts/token/ERC1155/extensions/IERC1155MetadataURI.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Utils} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Utils.sol";
import {Arrays} from "@openzeppelin/contracts/utils/Arrays.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IERC1155Singleton} from "./interfaces/IERC1155Singleton.sol";

/// @notice ERC1155 variant enforcing exactly one owner per token ID.
///
/// Instead of the standard nested balance mapping (`id → address → balance`), uses a flat
/// `id → address` ownership mapping. `balanceOf` returns 1 if the account is the owner,
/// 0 otherwise. Transferring value > 1 reverts.
///
/// Used by `PermissionedRegistry` to represent domain name ownership as non-divisible tokens.
/// The registry overrides `ownerOf` to add expiry and version validation on top of raw ownership.
///
/// @author OpenZeppelin (https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.0/contracts/token/ERC1155/ERC1155.sol)
/// @dev This contract has been modified from the implementation at the above link.
abstract contract ERC1155Singleton is
    ERC165,
    IERC1155Singleton,
    IERC1155Errors,
    IERC1155MetadataURI
{
    using Arrays for uint256[];

    using Arrays for address[];

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Maps each token ID to its single owner address.
    mapping(uint256 id => address account) private _owners;

    /// @dev Standard ERC1155 operator approval mapping.
    mapping(address account => mapping(address operator => bool)) private _operatorApprovals;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC165, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IERC1155).interfaceId ||
            interfaceId == type(IERC1155Singleton).interfaceId ||
            interfaceId == type(IERC1155MetadataURI).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Sets the approval for all operator.
    /// @param operator The operator to set the approval for.
    /// @param approved The approval status.
    function setApprovalForAll(address operator, bool approved) public virtual {
        _setApprovalForAll(msg.sender, operator, approved);
    }

    /// @notice Transfers a single token from one address to another.
    /// @param from The address to transfer the token from.
    /// @param to The address to transfer the token to.
    /// @param id The token ID.
    /// @param value The amount of tokens to transfer.
    /// @param data Additional data to pass to the receiver.
    /// @dev `to` cannot be the zero address.
    /// @dev If the caller is not `from`, it must have been approved to spend `from`'s tokens via `setApprovalForAll`.
    /// @dev `from` must have a balance of tokens of type `id` of at least `value` amount.
    /// @dev If `to` refers to a smart contract, it must implement IERC1155Receiver.onERC1155Received and return the
    ///      acceptance magic value.
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes memory data)
        public
        virtual
    {
        _checkApproval(from, msg.sender);
        _safeTransferFrom(from, to, id, value, data);
    }

    /// @notice Transfers multiple tokens from one address to another.
    /// @param from The address to transfer the tokens from.
    /// @param to The address to transfer the tokens to.
    /// @param ids The token IDs.
    /// @param values The amounts of tokens to transfer.
    /// @param data Additional data to pass to the receiver.
    /// @dev `ids` and `values` must have the same length.
    /// @dev If `to` refers to a smart contract, it must implement IERC1155Receiver.onERC1155BatchReceived and return the
    ///      acceptance magic value.
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    )
        public
        virtual
    {
        _checkApproval(from, msg.sender);
        _safeBatchTransferFrom(from, to, ids, values, data);
    }

    /// @inheritdoc IERC1155Singleton
    function ownerOf(uint256 id) public view virtual returns (address owner) {
        return _owners[id];
    }

    /// @notice Returns the URI for a token.
    /// @param id The token ID.
    /// @return uri The URI for the token.
    function uri(uint256 id) public view virtual returns (string memory uri);

    /// @notice Returns the balance of a token for an account.
    /// @param account The account to get the balance for.
    /// @param id The token ID.
    /// @return balance The balance of the token for the account. This will only ever be 1 or 0.
    function balanceOf(address account, uint256 id) public view virtual returns (uint256) {
        return account != address(0) && ownerOf(id) == account ? 1 : 0;
    }

    /// @notice Returns the balances of a batch of tokens for an account.
    /// @param accounts The accounts to get the balances for.
    /// @param ids The token IDs.
    /// @return batchBalances The balances of the tokens for the accounts. These will only ever be 1 or 0.
    /// @dev `accounts` and `ids` must have the same length.
    function balanceOfBatch(address[] memory accounts, uint256[] memory ids)
        public
        view
        virtual
        returns (uint256[] memory)
    {
        if (accounts.length != ids.length) {
            revert ERC1155InvalidArrayLength(ids.length, accounts.length);
        }

        uint256[] memory batchBalances = new uint256[](accounts.length);

        for (uint256 i = 0; i < accounts.length; ++i) {
            batchBalances[i] = balanceOf(accounts.unsafeMemoryAccess(i), ids.unsafeMemoryAccess(i));
        }

        return batchBalances;
    }

    /// @notice Returns the approval for all operator.
    /// @param account The account to get the approval for.
    /// @param operator The operator to get the approval for.
    /// @return approved The approval status.
    function isApprovedForAll(address account, address operator) public view virtual returns (bool) {
        return _operatorApprovals[account][operator];
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Apply token updates for each pair in `ids` and `values`.
    /// @param from Address tokens are moved from. Use `address(0)` for mints.
    /// @param to Address tokens are moved to. Use `address(0)` for burns.
    /// @param ids Token IDs to update.
    /// @param values Amounts for each token ID.
    /// @param {safe} Ignored. `true` if `safe{Batch}TransferFrom()`.
    /// @dev Reverts with `ERC1155InvalidArrayLength` if `ids.length != values.length`.
    /// @dev Reverts with `ERC1155InsufficientBalance` if `from` is not the current owner or `value > 1`.
    /// @dev This function does not perform ERC-1155 receiver acceptance checks.
    /// @dev Emits `TransferSingle` when one token ID is updated, otherwise emits `TransferBatch`.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bool /* safe */
    )
        internal
        virtual
    {
        if (ids.length != values.length) {
            revert ERC1155InvalidArrayLength(ids.length, values.length);
        }

        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids.unsafeMemoryAccess(i);
            uint256 value = values.unsafeMemoryAccess(i);

            if (value > 0) {
                address owner = _owners[id];
                if (owner != from) {
                    revert ERC1155InsufficientBalance(from, 0, value, id);
                } else if (value > 1) {
                    revert ERC1155InsufficientBalance(from, 1, value, id);
                }
                _owners[id] = to;
            }
        }

        if (ids.length == 1) {
            uint256 id = ids.unsafeMemoryAccess(0);
            uint256 value = values.unsafeMemoryAccess(0);
            emit TransferSingle(msg.sender, from, to, id, value);
        } else {
            emit TransferBatch(msg.sender, from, to, ids, values);
        }
    }

    /// @dev Convenience function for `_asSingletonArrays()` + `_updateWithAcceptanceCheck()`.
    function _updateOneWithAcceptanceCheck(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bool safe,
        bytes memory data
    )
        internal
    {
        (uint256[] memory ids, uint256[] memory values) = _asSingletonArrays(id, value);
        _updateWithAcceptanceCheck(from, to, ids, values, safe, data, false);
    }

    /// @notice Apply token updates and run ERC-1155 receiver acceptance checks.
    /// @param from Address tokens are moved from. Use `address(0)` for mints.
    /// @param to Address tokens are moved to. Use `address(0)` for burns.
    /// @param ids Token IDs to update.
    /// @param values Amounts for each token ID.
    /// @param safe `true` if `safe{Batch}TransferFrom()`.
    /// @param data Additional calldata passed to receiver hooks.
    /// @param batch `true` if a batch operation.
    /// @dev Calls `_update` before external receiver callbacks.
    /// @dev If `to` is a contract, this calls `onERC1155Received` or `onERC1155BatchReceived`.
    /// @dev Overriding is discouraged because post-callback state writes can introduce reentrancy bugs.
    function _updateWithAcceptanceCheck(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bool safe,
        bytes memory data,
        bool batch
    )
        internal
        virtual
    {
        _update(from, to, ids, values, safe);
        if (to != address(0)) {
            if (batch) {
                ERC1155Utils.checkOnERC1155BatchReceived(msg.sender, from, to, ids, values, data);
            } else {
                uint256 id = ids.unsafeMemoryAccess(0);
                uint256 value = values.unsafeMemoryAccess(0);
                ERC1155Utils.checkOnERC1155Received(msg.sender, from, to, id, value, data);
            }
        }
    }

    /// @notice Safely transfer `value` tokens of token ID `id` from `from` to `to`.
    /// @param from Address to transfer from.
    /// @param to Address to transfer to.
    /// @param id Token ID to transfer.
    /// @param value Amount to transfer.
    /// @param data Additional calldata passed to receiver hooks.
    /// @dev Reverts with `ERC1155InvalidSender` if `from` is the zero address.
    /// @dev Reverts with `ERC1155InvalidReceiver` if `to` is the zero address.
    /// @dev If `to` is a contract, it must return the ERC-1155 acceptance magic value.
    /// @dev Emits `TransferSingle`.
    function _safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    )
        internal
    {
        _checkReceiver(to);
        _checkSender(from);
        _updateOneWithAcceptanceCheck(from, to, id, value, true, data);
    }

    /// @notice Safely transfer multiple token IDs from `from` to `to`.
    /// @param from Address to transfer from.
    /// @param to Address to transfer to.
    /// @param ids Token IDs to transfer.
    /// @param values Amounts to transfer for each token ID.
    /// @param data Additional calldata passed to receiver hooks.
    /// @dev Reverts with `ERC1155InvalidSender` if `from` is the zero address.
    /// @dev Reverts with `ERC1155InvalidReceiver` if `to` is the zero address.
    /// @dev Reverts with `ERC1155InvalidArrayLength` if `ids.length != values.length`.
    /// @dev If `to` is a contract, it must return the ERC-1155 acceptance magic value.
    /// @dev Emits `TransferBatch`.
    function _safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    )
        internal
    {
        _checkReceiver(to);
        _checkSender(from);
        _updateWithAcceptanceCheck(from, to, ids, values, true, data, true);
    }

    /// @notice Mint `value` tokens of token ID `id` to `to`.
    /// @param to Address receiving the minted token.
    /// @param id Token ID to mint.
    /// @param value Amount to mint.
    /// @param data Additional calldata passed to receiver hooks.
    /// @dev Reverts with `ERC1155InvalidReceiver` if `to` is the zero address.
    /// @dev If `to` is a contract, it must return the ERC-1155 acceptance magic value.
    /// @dev Emits `TransferSingle`.
    function _mint(address to, uint256 id, uint256 value, bytes memory data) internal {
        _checkReceiver(to);
        _updateOneWithAcceptanceCheck(address(0), to, id, value, false, data);
    }

    /// @notice Burn `value` tokens of token ID `id` from `from`.
    /// @param from Address to burn from.
    /// @param id Token ID to burn.
    /// @param value Amount to burn.
    /// @dev Reverts with `ERC1155InvalidSender` if `from` is the zero address.
    /// @dev Reverts with `ERC1155InsufficientBalance` if `from` is not current owner or `value > 1`.
    /// @dev Emits `TransferSingle`.
    function _burn(address from, uint256 id, uint256 value) internal {
        _checkSender(from);
        _updateOneWithAcceptanceCheck(from, address(0), id, value, false, "");
    }

    /// @notice Set or clear approval for `operator` to manage all tokens owned by `owner`.
    /// @param owner Token owner granting or revoking approval.
    /// @param operator Operator receiving approval.
    /// @param approved Approval status to set.
    /// @dev Reverts with `ERC1155InvalidOperator` if `operator` is the zero address.
    /// @dev Emits `ApprovalForAll`.
    function _setApprovalForAll(address owner, address operator, bool approved) internal virtual {
        if (operator == address(0)) {
            revert ERC1155InvalidOperator(address(0));
        }
        _operatorApprovals[owner][operator] = approved;
        emit ApprovalForAll(owner, operator, approved);
    }

    /// @dev Ensure operator is approved.
    function _checkApproval(address from, address operator) internal view {
        if (from != operator && !isApprovedForAll(from, operator)) {
            revert ERC1155MissingApprovalForAll(operator, from);
        }
    }

    /// @dev Ensure receiver is valid.
    function _checkReceiver(address to) internal pure {
        if (to == address(0)) {
            revert ERC1155InvalidReceiver(address(0));
        }
    }

    /// @dev Ensure sender is valid.
    function _checkSender(address from) internal pure {
        if (from == address(0)) {
            revert ERC1155InvalidSender(address(0));
        }
    }

    /// @dev Gas-optimized assembly helper that creates two length-1 memory arrays without Solidity's
    ///      default zero-initialization overhead. Used to adapt single-token operations (`_mint`,
    ///      `_burn`, `_safeTransferFrom`) to the array-based `_update` function.
    function _asSingletonArrays(uint256 element1, uint256 element2)
        internal
        pure
        returns (uint256[] memory array1, uint256[] memory array2)
    {
        /// @solidity memory-safe-assembly
        assembly {
            // Load the free memory pointer
            array1 := mload(0x40)
            // Set array length to 1
            mstore(array1, 1)
            // Store the single element at the next word after the length (where content starts)
            mstore(add(array1, 0x20), element1)

            // Repeat for next array locating it right after the first array
            array2 := add(array1, 0x40)
            mstore(array2, 1)
            mstore(add(array2, 0x20), element2)

            // Update the free memory pointer by pointing after the second array
            mstore(0x40, add(array2, 0x40))
        }
    }
}
