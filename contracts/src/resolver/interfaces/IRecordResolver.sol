// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IMulticallable} from "@ens/contracts/resolvers/Multicallable.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";

import {IABISetter} from "./setters/IABISetter.sol";
import {IAddressSetter} from "./setters/IAddressSetter.sol";
import {IContenthashSetter} from "./setters/IContenthashSetter.sol";
import {IDataSetter} from "./setters/IDataSetter.sol";
import {IInterfaceSetter} from "./setters/IInterfaceSetter.sol";
import {INameSetter} from "./setters/INameSetter.sol";
import {ITextSetter} from "./setters/ITextSetter.sol";

interface IRecordResolver is
    IExtendedResolver,
    IMulticallable,
    IABISetter,
    IAddressSetter,
    IContenthashSetter,
    IDataSetter,
    IInterfaceSetter,
    INameSetter,
    ITextSetter
{
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice A record resolver was created/initialized.
    event ResolverCreated();

    /// @notice `name` was associated with a record.
    ///         If `recordId = 0`, the `name` was unassociated.
    /// @param recordId The record ID.
    /// @param node The namehash of name.
    /// @param name The DNS-encoded name.
    event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name);

    /// @notice All values assocated with `recordId` were cleared.
    /// @param recordId The record ID.
    event Cleared(uint256 indexed recordId);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Record does not exist.
    /// @dev Error selector: `0xf2a3e8db`
    error InvalidRecord();

    /// @notice The resolver profile cannot be answered.
    /// @dev Error selector: `0x7b1c461b`
    error UnsupportedResolverProfile(bytes4 selector);
}
