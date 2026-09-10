// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct RenewData {
    /// @param label The name to renew.
    string label;
    /// @param duration The duration extension, in seconds.
    uint64 duration;
    /// @param referrer The referrer hash.
    bytes32 referrer;
}

/// @notice Interface for renewing ".eth" names.
/// @dev Interface selector: `0x37e6a567`
interface IETHRenewer {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice A name was extended by `duration`.
    /// @param tokenId The registry token id.
    /// @param label The name of the renewal.
    /// @param duration The duration extension, in seconds.
    /// @param newExpiry The new expiry, in seconds.
    /// @param paymentToken The payment token.
    /// @param referrer The referrer hash.
    /// @param amount The amount of `paymentToken`.
    event NameRenewed(
        uint256 indexed tokenId,
        string label,
        uint64 duration,
        uint64 newExpiry,
        IERC20 paymentToken,
        bytes32 indexed referrer,
        uint256 amount
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice `duration` less than `minDuration`.
    /// @dev Error selector: `0xa096b844`
    error DurationTooShort(uint64 duration, uint64 minDuration);

    /// @notice `label` cannot be renewed.
    /// @dev Error selector: `0x1caefaa0`
    error NameNotRenewable(string label);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Renew a name.
    /// @param rd The renew data.
    /// @param paymentToken The payment token.
    function renew(RenewData calldata rd, IERC20 paymentToken) external;

    /// @notice Renew multiple names.
    /// @param rds The renew data.
    /// @param paymentToken The payment token.
    function renewBatch(RenewData[] calldata rds, IERC20 paymentToken) external;

    /// @notice Determine renew price for a name.
    /// @param label The name to renew.
    /// @param duration The duration extension, in seconds.
    /// @param paymentToken The payment token.
    /// @return The amount of `paymentToken`.
    function getRenewPrice(string calldata label, uint64 duration, IERC20 paymentToken)
        external
        view
        returns (uint256);

    /// @notice Check if name is renewable.
    /// @param label The name to check.
    /// @return `true` if renewable.
    function isRenewable(string calldata label) external view returns (bool);

    /// @notice Determine remaining grace period.
    /// @dev Defined over `[expiry, expiry + GRACE_PERIOD)`.
    /// @param label The name to check.
    /// @return The remaining grace period, in seconds.
    function getRemainingGracePeriod(string calldata label) external view returns (uint64);

    /// @notice Post-expiry period where still renewable and not available, in seconds.
    function GRACE_PERIOD() external view returns (uint64);
}
