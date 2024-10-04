// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "../ResolverBase.sol";
import "./ITextResolver.sol";
import {BytesUtils} from "../../utils/BytesUtils.sol";

abstract contract TextResolver is ITextResolver, ResolverBase {
    using BytesUtils for bytes;
    mapping(uint64 => mapping(bytes32 => mapping(string => string))) versionable_texts;

    /**
     * Sets the text data associated with an ENS node and key.
     * May only be called by the owner of that node in the ENS registry.
     * @param dnsEncodedName The name to update.
     * @param key The key to set.
     * @param value The text data value to set.
     */
    function setText(
        bytes calldata dnsEncodedName,
        string calldata key,
        string calldata value
    ) external virtual authorised(dnsEncodedName) {
        bytes32 node = dnsEncodedName.namehash(0);
        versionable_texts[recordVersions[node]][node][key] = value;
        emit TextChanged(node, key, key, value);
    }

    /**
     * Returns the text data associated with an ENS node and key.
     * @param node The ENS node to query.
     * @param key The text data key to query.
     * @return The associated text data.
     */
    function text(
        bytes32 node,
        string calldata key
    ) external view virtual override returns (string memory) {
        return versionable_texts[recordVersions[node]][node][key];
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view virtual override returns (bool) {
        return
            interfaceID == type(ITextResolver).interfaceId ||
            super.supportsInterface(interfaceID);
    }
}
