// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IContractNamer} from "../interfaces/IContractNamer.sol";

/// @dev Determine if an address is nameable.
library AccountNamerLib {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @dev Error selector: `0x0d1b7e4e`
    error UnauthorizedNamer(address namer);

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @dev Check if an address can be named.
    /// @param account The address to name.
    /// @param namer The address of the namer.
    /// @return canName `true` if `namer` can name `addr`.
    function isNamer(address account, address namer) internal view returns (bool canName) {
        canName = account == namer;
        if (!canName && account.code.length > 0) {
            try Ownable(account).owner() returns (address owner) {
                canName = owner == namer;
            } catch {}
            if (!canName) {
                try IContractNamer(account).isContractNamer(namer) returns (bool can) {
                    canName = can;
                } catch {}
            }
        }
    }

    /// @dev Ensure `namer` can name `account`.
    /// @param account The address to name.
    /// @param namer The address of the namer.
    function requireNamer(address account, address namer) internal view {
        if (!isNamer(account, namer)) {
            revert UnauthorizedNamer(namer);
        }
    }
}
