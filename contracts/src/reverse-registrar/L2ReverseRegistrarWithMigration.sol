// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {L2ReverseRegistrar} from "./L2ReverseRegistrar.sol";

/// @dev Interface selector: `0x4ec3bd23`
interface IL2ReverseRegistrarV1 {
    /// @notice Returns the name for an address.
    /// @param addr The address to get the name for.
    /// @return The name for the address.
    function nameForAddr(address addr) external view returns (string memory);
}


/// @notice An L2 Reverse Registrar that allows migrating from a prior registrar.
contract L2ReverseRegistrarWithMigration is L2ReverseRegistrar, Ownable {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The v1 reverse registrar to migrate from
    IL2ReverseRegistrarV1 public immutable OLD_L2_REVERSE_REGISTRAR;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Initialises the contract with the chain ID and label for this L2 chain.
    /// @param chainId The chain ID of the chain this contract is deployed to.
    /// @param label The hex string label for the coin type (used in reverse node computation).
    /// @param owner The owner of the contract.
    /// @param oldL2ReverseRegistrar The v1 reverse registrar to migrate from.
    constructor(
        uint256 chainId,
        string memory label,
        address owner,
        IL2ReverseRegistrarV1 oldL2ReverseRegistrar
    )
        L2ReverseRegistrar(chainId, label)
        Ownable(owner)
    {
        OLD_L2_REVERSE_REGISTRAR = oldL2ReverseRegistrar;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Sets a batch of names for the specified addresses, with values taken
    ///         from the old reverse registrar. Only callable by the owner.
    /// @param addresses The addresses to migrate.
    function batchSetName(address[] calldata addresses) external onlyOwner {
        for (uint256 i = 0; i < addresses.length; ++i) {
            string memory name = OLD_L2_REVERSE_REGISTRAR.nameForAddr(addresses[i]);

            _setName(addresses[i], name);
        }
    }
}
