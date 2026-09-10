// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";

/// @notice Shared `IContractNamer` instance.
contract ContractNamer is ERC165, OwnableUpgradeable, UUPSUpgradeable, IContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract.
    /// @param owner_ The contract owner.
    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IContractNamer).interfaceId || super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IContractNamer
    function isContractNamer(address namer) external view returns (bool) {
        return owner() == namer;
    }

    /// @dev Allow owner to upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
