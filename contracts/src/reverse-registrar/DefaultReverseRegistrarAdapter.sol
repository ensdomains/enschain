// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {
    IDefaultReverseRegistrar
} from "@ens/contracts/reverseRegistrar/IDefaultReverseRegistrar.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {HCAAuthorizer} from "../hca/HCAAuthorizer.sol";
import {IStandaloneHCAFactory} from "../hca/interfaces/IStandaloneHCAFactory.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

import {IContractNamer} from "./interfaces/IContractNamer.sol";
import {IDefaultReverseRegistrarAdapter} from "./interfaces/IDefaultReverseRegistrarAdapter.sol";
import {AccountNamerLib} from "./libraries/AccountNamerLib.sol";

/// @title Default Reverse Registrar Adapter
/// @notice Forwarder for v1 `default.reverse` registrar updates.
/// @dev The adapter must be configured as a controller on the default reverse registrar.
contract DefaultReverseRegistrarAdapter is
    DelegatedContractNamer,
    HCAAuthorizer,
    IDefaultReverseRegistrarAdapter
{
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The v1 default reverse registrar for `default.reverse`.
    IDefaultReverseRegistrar public immutable DEFAULT_REVERSE_REGISTRAR;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param defaultReverseRegistrar The v1 default reverse registrar for `default.reverse`.
    /// @param standaloneHCAFactory Factory certifying immutable HCA owner bindings.
    /// @param contractNamer Delegated contract namer.
    constructor(
        IDefaultReverseRegistrar defaultReverseRegistrar,
        IStandaloneHCAFactory standaloneHCAFactory,
        IContractNamer contractNamer
    )
        HCAAuthorizer(standaloneHCAFactory)
        DelegatedContractNamer(contractNamer)
    {
        DEFAULT_REVERSE_REGISTRAR = defaultReverseRegistrar;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IDefaultReverseRegistrarAdapter).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set account's `default.reverse` primary name.
    /// @param account The contract address.
    /// @param name The primary name to store.
    function setName(address account, string calldata name) external {
        AccountNamerLib.requireNamer(account, msg.sender);
        DEFAULT_REVERSE_REGISTRAR.setNameForAddr(account, name);
    }

    /// @notice Sets account's `default.reverse` primary name through an HCA caller.
    /// @param account The account to name.
    /// @param name The primary name to store.
    function setNameWithHCA(address account, string calldata name) external {
        _requireHCAForAccount(account);
        DEFAULT_REVERSE_REGISTRAR.setNameForAddr(account, name);
    }
}
