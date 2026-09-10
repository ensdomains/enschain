// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IRentPriceOracle} from "./IRentPriceOracle.sol";

/// @title Rent Price Oracle Provider Interface
/// @notice Exposes the rent price oracle used by a registrar.
/// @dev Interface selector: `0x7b39ba16`
interface IRentPriceOracleProvider {
    /// @notice Returns the oracle used to price registrations and renewals.
    function rentPriceOracle() external view returns (IRentPriceOracle);
}
