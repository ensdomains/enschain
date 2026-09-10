// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {LibRegistry} from "../universalResolver/libraries/LibRegistry.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

import {AbstractRecordResolver} from "./AbstractRecordResolver.sol";
import {ISharedResolver} from "./interfaces/ISharedResolver.sol";
import {IABISetter} from "./interfaces/setters/IABISetter.sol";
import {IAddressSetter} from "./interfaces/setters/IAddressSetter.sol";
import {IContenthashSetter} from "./interfaces/setters/IContenthashSetter.sol";
import {IDataSetter} from "./interfaces/setters/IDataSetter.sol";
import {IInterfaceSetter} from "./interfaces/setters/IInterfaceSetter.sol";
import {INameSetter} from "./interfaces/setters/INameSetter.sol";
import {ITextSetter} from "./interfaces/setters/ITextSetter.sol";

/// @notice PublicResolver that respects the ENSv2 registry and uses name-based setters.
contract SharedResolver is ISharedResolver, AbstractRecordResolver, DelegatedContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct RecordPointer {
        uint256 version;
        mapping(uint256 version => Record record) records;
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv2 Root Registry contract.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Mapping from `node` to `RecordPointer`.
    mapping(bytes32 node => RecordPointer pointer) internal _pointers;

    /// @dev Mapping from `(owner, operator, node)` to approval state.
    mapping(address owner => mapping(address operator => mapping(bytes32 node => bool approved))) internal _approvals;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootRegistry The ENSv2 Root Registry contract.
    /// @param contractNamer Delegated contract namer.
    constructor(IPermissionedRegistry rootRegistry, IContractNamer contractNamer)
        DelegatedContractNamer(contractNamer)
    {
        ROOT_REGISTRY = rootRegistry;
    }

    /// @inheritdoc AbstractRecordResolver
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AbstractRecordResolver, DelegatedContractNamer)
        returns (bool)
    {
        return
            type(ISharedResolver).interfaceId == interfaceId || super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc ISharedResolver
    function approve(bytes calldata name, address operator, bool approved) external {
        bytes32 node = NameCoder.namehash(name, 0);
        _ensureLinked(node, name);
        _approvals[msg.sender][operator][node] = approved;
        emit ApprovalUpdated(uint256(node), msg.sender, operator, approved);
    }

    /// @inheritdoc ISharedResolver
    function clear(bytes calldata name) external {
        bytes32 node = _checkAuth(name);
        if (_pointers[node].version > 0) {
            ++_pointers[node].version;
            emit Cleared(uint256(node));
        }
    }

    /// @inheritdoc IABISetter
    function setABI(bytes calldata name, uint256 contentType, bytes calldata data) external {
        _checkContentType(contentType);
        bytes32 node = _ensureRecord(name);
        _record(node).abis[contentType] = data;
        emit ABIUpdated(uint256(node), contentType);
    }

    /// @inheritdoc IAddressSetter
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes)
        external
    {
        _checkAddress(coinType, addressBytes);
        bytes32 node = _ensureRecord(name);
        _record(node).addresses[coinType] = addressBytes;
        emit AddressUpdated(uint256(node), coinType, addressBytes);
    }

    /// @inheritdoc IContenthashSetter
    function setContenthash(bytes calldata name, bytes calldata hash) external {
        bytes32 node = _ensureRecord(name);
        _record(node).contenthash = hash;
        emit ContenthashUpdated(uint256(node), hash);
    }

    /// @inheritdoc IDataSetter
    function setData(bytes calldata name, string calldata key, bytes calldata value) external {
        bytes32 node = _ensureRecord(name);
        _record(node).datas[key] = value;
        emit DataUpdated(uint256(node), key, key, value);
    }

    /// @inheritdoc IInterfaceSetter
    function setInterface(bytes calldata name, bytes4 interfaceId, address implementer) external {
        bytes32 node = _ensureRecord(name);
        _record(node).interfaces[interfaceId] = implementer;
        emit InterfaceUpdated(uint256(node), interfaceId, implementer);
    }

    /// @inheritdoc INameSetter
    function setName(bytes calldata name, string calldata primaryName) external {
        bytes32 node = _ensureRecord(name);
        _record(node).name = primaryName;
        emit NameUpdated(uint256(node), primaryName);
    }

    /// @inheritdoc ITextSetter
    function setText(bytes calldata name, string calldata key, string calldata value) external {
        bytes32 node = _ensureRecord(name);
        _record(node).texts[key] = value;
        emit TextUpdated(uint256(node), key, key, value);
    }

    /// @inheritdoc ISharedResolver
    function canModifyName(bytes calldata name, address operator) external view returns (bool) {
        return _canModifyNode(ownerOf(name), operator, NameCoder.namehash(name, 0));
    }

    /// @inheritdoc ISharedResolver
    function isApproved(bytes calldata name, address owner, address operator)
        external
        view
        returns (bool)
    {
        return _approvals[owner][operator][NameCoder.namehash(name, 0)];
    }

    /// @inheritdoc ISharedResolver
    function ownerOf(bytes calldata name) public view returns (address owner) {
        (owner, ) = LibRegistry.findNearestOwner(ROOT_REGISTRY, name, 0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Check authorization and ensure record exists for `name`.
    function _ensureRecord(bytes calldata name) internal returns (bytes32 node) {
        node = _checkAuth(name);
        _ensureLinked(node, name);
    }

    /// @dev Ensure `Linked` is emit once.
    function _ensureLinked(bytes32 node, bytes calldata name) internal {
        RecordPointer storage p = _pointers[node];
        if (p.version == 0) {
            p.version = 1;
            emit Linked(uint256(node), node, name);
        }
    }

    /// @dev Determine if `operator` can modify `node`.
    function _canModifyNode(address owner, address operator, bytes32 node)
        internal
        view
        returns (bool can)
    {
        if (owner != address(0)) {
            can = owner == operator;
            if (!can) {
                mapping(bytes32 node => bool approved) storage map = _approvals[owner][operator];
                can = map[node] || (node != bytes32(0) && map[bytes32(0)]);
            }
        }
    }

    /// @dev Ensure `name` can be modified by caller.
    function _checkAuth(bytes calldata name) internal view returns (bytes32 node) {
        node = NameCoder.namehash(name, 0);
        if (!_canModifyNode(ownerOf(name), msg.sender, node)) {
            revert CannotModifyName(name);
        }
    }

    /// @dev Get the active storage record.
    function _record(bytes32 node) internal view override returns (Record storage) {
        RecordPointer storage p = _pointers[node];
        return p.records[p.version];
    }
}
