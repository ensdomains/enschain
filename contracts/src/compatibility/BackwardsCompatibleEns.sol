//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {EnsRootRegistry} from "../EnsRootRegistry.sol";
import {NameHashLib} from "./NameHashLib.sol";

error OffchainLookup(
    address sender,
    string[] urls,
    bytes callData,
    bytes4 callbackFunction,
    bytes extraData
);

contract BackwardsCompatibleEns {
    using NameHashLib for bytes;

    EnsRootRegistry immutable _ensRootRegistry;

    string[] _urls;

    constructor(EnsRootRegistry ensRootRegistry_, string[] memory urls_) {
        _ensRootRegistry = ensRootRegistry_;
        _urls = urls_;
    }

    function resolver(bytes32 node) external view returns (address) {
        revert OffchainLookup(
            address(this),
            _urls,
            abi.encode(node),
            this.resolverCallback.selector,
            abi.encode(node)
        );
    }

    function resolverCallback(
        bytes calldata response,
        bytes calldata extraData
    ) external view returns (address) {
        bytes32 node = abi.decode(extraData, (bytes32));
        bytes32 receivedNode = response.namehash(0);

        require(node == receivedNode, "Invalid response");

        return _ensRootRegistry.resolver(response);
    }
}
