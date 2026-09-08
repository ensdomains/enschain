// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ENS} from "@ens/contracts/registry/ENS.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IRegistry} from "../registry/interfaces/IRegistry.sol";

/// @notice The NameWrapper reads `CustomResolver` needs to resolve a wrapped
///         name's real owner.
/// @dev Interface selector: `0x8ad7c8db`
interface IFixtureNameWrapper {
    /// @notice The holder of a wrapped name's token.
    /// @param id The token id, which is the namehash of the name.
    /// @return The token holder.
    function ownerOf(uint256 id) external view returns (address);

    /// @notice Whether an operator may act for an owner's wrapped names.
    /// @param owner The token holder.
    /// @param operator The operator to test.
    /// @return True when the operator is approved.
    function isApprovedForAll(address owner, address operator) external view returns (bool);
}


/// @title CustomResolver
/// @notice Test-only v1-style resolver holding the record subset the weighted
///         migration corpus writes, referenced by scenarios as
///         `fixture.CustomResolver`.
/// @dev Writes are authorised against the live ENS registry owner, so the
///      resolver follows ownership as scenarios transfer names around. It holds
///      no ENSv2 state.
contract CustomResolver is IERC165 {
    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @dev Interface id of the single-address resolver profile.
    bytes4 private constant _ADDR_INTERFACE_ID = 0x3b3b57de;
    /// @dev Interface id of the multicoin address resolver profile.
    bytes4 private constant _ADDR_COIN_INTERFACE_ID = 0xf1cb7e06;
    /// @dev Interface id of the text record resolver profile.
    bytes4 private constant _TEXT_INTERFACE_ID = 0x59d1d43c;
    /// @dev Interface id of the contenthash resolver profile.
    bytes4 private constant _CONTENTHASH_INTERFACE_ID = 0xbc1c58d1;

    /// @notice The v1 ENS registry consulted for write authorisation.
    ENS public immutable ENS_REGISTRY;

    /// @notice The v1 NameWrapper, used to resolve the owner of a wrapped name.
    IFixtureNameWrapper public immutable NAME_WRAPPER;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Recorded addresses, keyed by name and SLIP-44 coin type.
    mapping(bytes32 node => mapping(uint256 coinType => bytes addr)) private _addresses;
    /// @dev Recorded text records, keyed by name and record key.
    mapping(bytes32 node => mapping(string key => string value)) private _texts;
    /// @dev Recorded contenthashes, keyed by name.
    mapping(bytes32 node => bytes contenthash) private _contenthashes;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Emitted when the coin type 60 address changes.
    /// @param node The namehash of the name.
    /// @param a The new address.
    event AddrChanged(bytes32 indexed node, address a);

    /// @notice Emitted when an address of any coin type changes.
    /// @param node The namehash of the name.
    /// @param coinType The SLIP-44 coin type.
    /// @param newAddress The new address bytes.
    event AddressChanged(bytes32 indexed node, uint256 coinType, bytes newAddress);

    /// @notice Emitted when a text record changes.
    /// @param node The namehash of the name.
    /// @param indexedKey The record key, indexed.
    /// @param key The record key.
    /// @param value The new value.
    event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value);

    /// @notice Emitted when the contenthash changes.
    /// @param node The namehash of the name.
    /// @param hash The new contenthash.
    event ContenthashChanged(bytes32 indexed node, bytes hash);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice The caller does not control the node.
    /// @param node The namehash of the name.
    /// @param caller The unauthorised caller.
    /// @dev Error selector: `0x14c417b5`
    error NotAuthorised(bytes32 node, address caller);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param ensRegistry The v1 ENS registry to consult for authorisation.
    /// @param nameWrapper The v1 NameWrapper holding wrapped names.
    constructor(ENS ensRegistry, IFixtureNameWrapper nameWrapper) {
        ENS_REGISTRY = ensRegistry;
        NAME_WRAPPER = nameWrapper;
    }

    /// @notice Report the resolver profiles this contract implements.
    /// @param interfaceId The interface id to probe.
    /// @return True when the profile is supported.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == _ADDR_INTERFACE_ID ||
            interfaceId == _ADDR_COIN_INTERFACE_ID ||
            interfaceId == _TEXT_INTERFACE_ID ||
            interfaceId == _CONTENTHASH_INTERFACE_ID;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set the coin type 60 address.
    /// @param node The namehash of the name.
    /// @param a The address to record.
    function setAddr(bytes32 node, address a) external {
        _requireAuthorised(node);
        _addresses[node][60] = abi.encodePacked(a);
        emit AddrChanged(node, a);
    }

    /// @notice Set the address for an arbitrary coin type.
    /// @param node The namehash of the name.
    /// @param coinType The SLIP-44 coin type.
    /// @param a The address bytes; empty clears the record.
    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external {
        _requireAuthorised(node);
        _addresses[node][coinType] = a;
        emit AddressChanged(node, coinType, a);
    }

    /// @notice Set a text record.
    /// @param node The namehash of the name.
    /// @param key The record key.
    /// @param value The value; empty clears the record.
    function setText(bytes32 node, string calldata key, string calldata value) external {
        _requireAuthorised(node);
        _texts[node][key] = value;
        emit TextChanged(node, key, key, value);
    }

    /// @notice Set the contenthash.
    /// @param node The namehash of the name.
    /// @param hash The contenthash; empty clears the record.
    function setContenthash(bytes32 node, bytes calldata hash) external {
        _requireAuthorised(node);
        _contenthashes[node] = hash;
        emit ContenthashChanged(node, hash);
    }

    /// @notice Read the coin type 60 address.
    /// @param node The namehash of the name.
    /// @return The recorded address, or the zero address.
    function addr(bytes32 node) external view returns (address) {
        bytes memory raw = _addresses[node][60];
        if (raw.length != 20)
            return address(0);
        return address(bytes20(raw));
    }

    /// @notice Read the address for a coin type.
    /// @param node The namehash of the name.
    /// @param coinType The SLIP-44 coin type.
    /// @return The recorded address bytes.
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return _addresses[node][coinType];
    }

    /// @notice Read a text record.
    /// @param node The namehash of the name.
    /// @param key The record key.
    /// @return The recorded value.
    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _texts[node][key];
    }

    /// @notice Read the contenthash.
    /// @param node The namehash of the name.
    /// @return The recorded contenthash.
    function contenthash(bytes32 node) external view returns (bytes memory) {
        return _contenthashes[node];
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Reverts unless the caller owns the node or is an approved operator.
    ///      A name held by the NameWrapper is owned by whoever holds its token,
    ///      so ownership resolves through the wrapper before the check.
    function _requireAuthorised(bytes32 node) internal view {
        address owner = ENS_REGISTRY.owner(node);
        if (owner == address(NAME_WRAPPER)) {
            address tokenOwner = NAME_WRAPPER.ownerOf(uint256(node));
            if (tokenOwner == msg.sender || NAME_WRAPPER.isApprovedForAll(tokenOwner, msg.sender)) {
                return;
            }
            revert NotAuthorised(node, msg.sender);
        }
        if (owner != msg.sender && !ENS_REGISTRY.isApprovedForAll(owner, msg.sender)) {
            revert NotAuthorised(node, msg.sender);
        }
    }
}


/// @title UnsupportedResolver
/// @notice Test-only resolver that stores records but denies every interface
///         probe, referenced by scenarios as `fixture.UnsupportedResolver`.
/// @dev Exercises how migration treats a resolver it cannot recognise. Reads
///      succeed; only interface detection fails.
contract UnsupportedResolver {
    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Recorded addresses, keyed by name.
    mapping(bytes32 node => address addr) private _addresses;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Emitted when the recorded address changes.
    /// @param node The namehash of the name.
    /// @param a The new address.
    event AddrChanged(bytes32 indexed node, address a);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Always reports no support, including for ERC-165 itself.
    /// @param interfaceId The interface id to probe; ignored.
    /// @return False, for every interface id.
    /// @dev Deliberate: this is the property the fixture exists to provide.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return false;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set the recorded address.
    /// @param node The namehash of the name.
    /// @param a The address to record.
    function setAddr(bytes32 node, address a) external {
        _addresses[node] = a;
        emit AddrChanged(node, a);
    }

    /// @notice Read the recorded address.
    /// @param node The namehash of the name.
    /// @return The recorded address.
    function addr(bytes32 node) external view returns (address) {
        return _addresses[node];
    }
}


/// @title ERC1155ReceiverOwner
/// @notice Test-only contract owner that accepts both ENS token standards,
///         referenced by scenarios as `fixture.ERC1155ReceiverOwner`.
contract ERC1155ReceiverOwner is IERC721Receiver, IERC1155Receiver {
    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Report the receiver interfaces this contract implements.
    /// @param interfaceId The interface id to probe.
    /// @return True when the interface is supported.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Accept an ERC-721 token.
    /// @param operator The address that initiated the transfer; ignored.
    /// @param from The previous token holder; ignored.
    /// @param tokenId The token being transferred; ignored.
    /// @param data Extra data supplied by the sender; ignored.
    /// @return The ERC-721 receiver magic value.
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Accept a single ERC-1155 token.
    /// @param operator The address that initiated the transfer; ignored.
    /// @param from The previous token holder; ignored.
    /// @param id The token being transferred; ignored.
    /// @param value The amount transferred; ignored.
    /// @param data Extra data supplied by the sender; ignored.
    /// @return The ERC-1155 receiver magic value.
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    )
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    /// @notice Accept a batch of ERC-1155 tokens.
    /// @param operator The address that initiated the transfer; ignored.
    /// @param from The previous token holder; ignored.
    /// @param ids The tokens being transferred; ignored.
    /// @param values The amounts transferred; ignored.
    /// @param data Extra data supplied by the sender; ignored.
    /// @return The ERC-1155 batch receiver magic value.
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    )
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }
}


/// @title NonReceiverOwner
/// @notice Test-only contract owner that implements no token receiver hook,
///         referenced by scenarios as `fixture.NonReceiverOwner`.
/// @dev Migrating a name to this address must revert; scenarios assert the
///      transfer is rejected rather than stranding a token.
contract NonReceiverOwner {
    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Exists only so the address has code.
    function ping() external pure returns (bool) {
        return true;
    }
}


/// @title CustomSubregistry
/// @notice Test-only subregistry pointer for migration payloads that name a
///         custom one, referenced by scenarios as `fixture.CustomSubregistry`.
/// @dev Holds no names. It exists so a scenario can pass a non-zero, non-default
///      subregistry and assert how each route treats it — the locked 2LD path
///      ignores it in favour of the deterministic WrapperRegistry.
contract CustomSubregistry is IRegistry {
    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The registry reported as this one's parent.
    IRegistry public parentRegistry;

    /// @notice The label reported as this registry's location under its parent.
    string public parentLabel;

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Set the parent this registry reports.
    /// @param parent_ The parent registry.
    /// @param label_ The label under that parent.
    function setParent(IRegistry parent_, string calldata label_) external {
        parentRegistry = parent_;
        parentLabel = label_;
    }

    /// @notice Report the configured parent location.
    /// @return parent The parent registry.
    /// @return label The label under that parent.
    function getParent() external view returns (IRegistry parent, string memory label) {
        return (parentRegistry, parentLabel);
    }

    /// @notice Always reports no subregistry.
    /// @param label The label to look up; ignored.
    /// @return The zero registry.
    function getSubregistry(string calldata label) external pure returns (IRegistry) {
        return IRegistry(address(0));
    }

    /// @notice Always reports no resolver.
    /// @param label The label to look up; ignored.
    /// @return The zero address.
    function getResolver(string calldata label) external pure returns (address) {
        return address(0);
    }
}
