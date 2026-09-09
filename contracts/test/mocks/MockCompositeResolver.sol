// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ICompositeResolver} from "@ens/contracts/resolvers/profiles/ICompositeResolver.sol";

contract MockCompositeResolver is ERC165, ICompositeResolver {
    address internal immutable RESOLVER;
    bool internal immutable OFFCHAIN;
    constructor(address resolver, bool offchain) {
        RESOLVER = resolver;
        OFFCHAIN = offchain;
    }
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return
            interfaceId == type(ICompositeResolver).interfaceId ||
            super.supportsInterface(interfaceId);
    }
    function getResolver(bytes calldata) external view returns (address, bool) {
        return (RESOLVER, OFFCHAIN);
    }
    function resolve(bytes calldata, bytes calldata) external pure returns (bytes memory) {
        return "";
    }
}
