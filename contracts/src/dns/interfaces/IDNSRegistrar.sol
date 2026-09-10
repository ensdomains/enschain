// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {DNSSEC} from "@ens/contracts/dnssec-oracle/DNSSEC.sol";

import {IPermissionedRegistry} from "../../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../../registry/interfaces/IRegistry.sol";

/// @dev Interface selector: `0xd3baf1a4`
interface IDNSRegistrar {
    function claim(
        bytes calldata name,
        IRegistry subregistry,
        address resolver,
        DNSSEC.RRSetWithSignature[] calldata rrs
    )
        external
        returns (IPermissionedRegistry parentRegistry, uint256 tokenId);
}
