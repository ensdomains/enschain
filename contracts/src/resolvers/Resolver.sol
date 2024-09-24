//SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./profiles/IABIResolver.sol";
import "./profiles/IAddressResolver.sol";
import "./profiles/IAddrResolver.sol";
import "./profiles/IContentHashResolver.sol";
import "./profiles/IDNSRecordResolver.sol";
import "./profiles/IDNSZoneResolver.sol";
import "./profiles/IInterfaceResolver.sol";
import "./profiles/INameResolver.sol";
import "./profiles/IPubkeyResolver.sol";
import "./profiles/ITextResolver.sol";
import "./profiles/IExtendedResolver.sol";

/**
 * A generic resolver interface which includes all the functions including the ones deprecated
 */
interface Resolver is
    IERC165,
    IABIResolver,
    IAddressResolver,
    IAddrResolver,
    IContentHashResolver,
    IDNSRecordResolver,
    IDNSZoneResolver,
    IInterfaceResolver,
    INameResolver,
    IPubkeyResolver,
    ITextResolver,
    IExtendedResolver
{
    /* Deprecated events */
    event ContentChanged(bytes32 indexed node, bytes32 hash);

    function setApprovalForAll(address, bool) external;

    function approve(bytes calldata dnsEncodedName, address delegate, bool approved) external;

    function isApprovedForAll(address account, address operator) external;

    function isApprovedFor(
        address owner,
        bytes calldata dnsEncodedName,
        address delegate
    ) external;

    function setABI(
        bytes calldata dnsEncodedName,
        uint256 contentType,
        bytes calldata data
    ) external;

    function setAddr(bytes calldata dnsEncodedName, address addr) external;

    function setAddr(bytes calldata dnsEncodedName, uint256 coinType, bytes calldata a) external;

    function setContenthash(bytes calldata dnsEncodedName, bytes calldata hash) external;

    function setDnsrr(bytes calldata dnsEncodedName, bytes calldata data) external;

    function setName(bytes calldata dnsEncodedName, string calldata _name) external;

    function setPubkey(bytes calldata dnsEncodedName bytes32 x, bytes32 y) external;

    function setText(
        bytes calldata dnsEncodedName,
        string calldata key,
        string calldata value
    ) external;

    function setInterface(
        bytes calldata dnsEncodedName,
        bytes4 interfaceID,
        address implementer
    ) external;

    function multicall(
        bytes[] calldata data
    ) external returns (bytes[] memory results);

    function multicallWithNodeCheck(
       bytes calldata dnsEncodedName,
        bytes[] calldata data
    ) external returns (bytes[] memory results);

    /* Deprecated functions */
    function content(bytes32 node) external view returns (bytes32);

    function multihash(bytes32 node) external view returns (bytes memory);

    function setContent(bytes32 node, bytes32 hash) external;

    function setMultihash(bytes32 node, bytes calldata hash) external;
}
