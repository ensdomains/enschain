// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

/// @dev Interface selector: `0x9f10f4b5`
interface IENSIP15 {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Label cannot be normalized.
    /// @dev Error selector: `0xb9954af7`
    error CannotNormalize(string label);

    ////////////////////////////////////////////////////////////////////////
    // Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Normalize a label according to ENSIP-15.
    /// @param label The label to normalize.
    /// @return The normalized label.
    function normalize(string calldata label) external view returns (string memory);
}
