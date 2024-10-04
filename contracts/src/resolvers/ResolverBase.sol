// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "./profiles/IVersionableResolver.sol";
import {BytesUtils} from "../utils/BytesUtils.sol";
abstract contract ResolverBase is ERC165, IVersionableResolver {
    using BytesUtils for bytes;
    mapping(bytes32 => uint64) public recordVersions;

    function isAuthorised(
        bytes calldata dnsEncodedName
    ) internal view virtual returns (bool);

    modifier authorised(bytes calldata dnsEncodedName) {
        require(isAuthorised(dnsEncodedName));
        _;
    }

    /**
     * Increments the record version associated with an ENS node.
     * May only be called by the owner of that node in the ENS registry.
     * @param dnsEncodedName The name to update.
     */
    function clearRecords(
        bytes calldata dnsEncodedName
    ) public virtual authorised(dnsEncodedName) {
        bytes32 node = dnsEncodedName.namehash(0);
        recordVersions[node]++;
        emit VersionChanged(node, recordVersions[node]);
    }

    function supportsInterface(
        bytes4 interfaceID
    ) public view virtual override returns (bool) {
        return
            interfaceID == type(IVersionableResolver).interfaceId ||
            super.supportsInterface(interfaceID);
    }
}
