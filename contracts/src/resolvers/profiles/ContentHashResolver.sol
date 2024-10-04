// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "../ResolverBase.sol";
import "./IContentHashResolver.sol";
import {BytesUtils} from "../../utils/BytesUtils.sol";
abstract contract ContentHashResolver is IContentHashResolver, ResolverBase {
    using BytesUtils for bytes;
    mapping(uint64 => mapping(bytes32 => bytes)) versionable_hashes;

    /**
     * Sets the contenthash associated with an ENS node.
     * May only be called by the owner of that node in the ENS registry.
     * @param dnsEncodedName The name to update.
     * @param hash The contenthash to set
     */
    function setContenthash(
        bytes calldata dnsEncodedName,
        bytes calldata hash
    ) external virtual authorised(dnsEncodedName) {
        bytes32 node = dnsEncodedName.namehash(0);
        versionable_hashes[recordVersions[node]][node] = hash;
        emit ContenthashChanged(node, hash);
    }

    /**
     * Returns the contenthash associated with an ENS node.
     * @param node The ENS node to query.
     * @return The associated contenthash.
     */
    function contenthash(
        bytes32 node
    ) external view virtual override returns (bytes memory) {
        return versionable_hashes[recordVersions[node]][node];
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view virtual override returns (bool) {
        return
            interfaceID == type(IContentHashResolver).interfaceId ||
            super.supportsInterface(interfaceID);
    }
}
