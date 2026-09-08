// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IETHRegistrarController} from "@ens/contracts/ethregistrar/IETHRegistrarController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

/// @title MigrationFixtureBatcher
/// @notice Test-only v1 fixture helper. It deliberately holds no ENSv2
///         reference, so it can never reserve into a v2 registry.
/// @dev Registrations are routed through the ordinary v1 ETHRegistrarController,
///      preserving its canonical registration events. Names are initially owned
///      by this contract, shaped through `executeBatch`, and handed to the
///      fixture actors.
contract MigrationFixtureBatcher is Ownable, ERC721Holder, ERC1155Holder {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @notice One arbitrary call executed while this contract holds a name.
    struct Call {
        address target;
        uint256 value;
        bytes data;
        bool allowFailure;
    }

    /// @notice The outcome of one executed call.
    struct Result {
        bool success;
        bytes returnData;
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The v1 registrar controller every registration is routed through.
    IETHRegistrarController public immutable CONTROLLER;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Emitted for each call executed by `executeBatch`.
    /// @param index The position of the call within the batch.
    /// @param target The called contract.
    /// @param success Whether the call succeeded.
    /// @param returnData The raw return or revert data.
    event FixtureCall(
        uint256 indexed index,
        address indexed target,
        bool success,
        bytes returnData
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The registration and value arrays are different lengths.
    /// @dev Error selector: `0xaaad13f7`
    error InputLengthMismatch();

    /// @notice The attached value does not cover the quoted registrations.
    /// @param supplied The value sent.
    /// @param required The value needed.
    /// @dev Error selector: `0x7040b58c`
    error InsufficientValue(uint256 supplied, uint256 required);

    /// @notice A batched call reverted and was not marked `allowFailure`.
    /// @param index The position of the failing call.
    /// @param target The called contract.
    /// @param reason The raw revert data.
    /// @dev Error selector: `0x405c0fff`
    error CallFailed(uint256 index, address target, bytes reason);

    /// @notice Returning the leftover balance to the caller failed.
    /// @dev Error selector: `0xf0c49d44`
    error RefundFailed();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param controller The v1 registrar controller to register through.
    /// @param owner_ The fixture operator permitted to drive this contract.
    constructor(IETHRegistrarController controller, address owner_) Ownable(owner_) {
        CONTROLLER = controller;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Accepts the value forwarded for registrations and refunds.
    receive() external payable {}

    /// @notice Submit many registration commitments in one transaction.
    /// @param commitments The commitments to submit.
    function commitBatch(bytes32[] calldata commitments) external onlyOwner {
        for (uint256 i; i < commitments.length; ++i) {
            CONTROLLER.commit(commitments[i]);
        }
    }

    /// @notice Register many committed names in one transaction.
    /// @param registrations The registration tuples, in commitment order.
    /// @param values The value to attach to each registration.
    function registerBatch(
        IETHRegistrarController.Registration[] calldata registrations,
        uint256[] calldata values
    )
        external
        payable
        onlyOwner
    {
        if (registrations.length != values.length) {
            revert InputLengthMismatch();
        }
        uint256 required;
        for (uint256 i; i < values.length; ++i) {
            required += values[i];
        }
        if (msg.value < required) {
            revert InsufficientValue(msg.value, required);
        }
        for (uint256 i; i < registrations.length; ++i) {
            CONTROLLER.register{value: values[i]}(registrations[i]);
        }
        _refund(payable(msg.sender));
    }

    /// @notice Execute v1-only fixture calls while this contract owns the names.
    /// @param calls The calls to execute, in order.
    /// @return results The outcome of each call.
    /// @dev `allowFailure` is used only for scenarios whose setup history
    ///      includes an expected rejected write. Successful calls remain atomic
    ///      per batch.
    function executeBatch(Call[] calldata calls)
        external
        payable
        onlyOwner
        returns (Result[] memory results)
    {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            (bool success, bytes memory returnData) = c.target.call{value: c.value}(c.data);
            if (!success && !c.allowFailure) {
                revert CallFailed(i, c.target, returnData);
            }
            results[i] = Result(success, returnData);
            emit FixtureCall(i, c.target, success, returnData);
        }
        _refund(payable(msg.sender));
    }

    /// @notice Send any remaining balance to a recipient.
    /// @param recipient The address to pay out to.
    function withdraw(address payable recipient) external onlyOwner {
        _refund(recipient);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Returns the whole remaining balance; the recipient is always the
    ///      fixture operator, which is the contract owner.
    function _refund(address payable recipient) internal {
        uint256 balance = address(this).balance;
        if (balance == 0)
            return;
        (bool ok, ) = recipient.call{value: balance}("");
        if (!ok)
            revert RefundFailed();
    }
}
