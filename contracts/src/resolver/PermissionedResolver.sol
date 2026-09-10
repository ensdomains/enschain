// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IProxyAuthorization} from "@ensdomains/verifiable-factory/IProxyAuthorization.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {EnhancedAccessControl} from "../access-control/EnhancedAccessControl.sol";
import {IEnhancedAccessControl} from "../access-control/interfaces/IEnhancedAccessControl.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";

import {AbstractRecordResolver} from "./AbstractRecordResolver.sol";
import {IPermissionedResolver} from "./interfaces/IPermissionedResolver.sol";
import {
    IPermissionedResolverInitializable,
    Grant
} from "./interfaces/IPermissionedResolverInitializable.sol";
import {IABISetter} from "./interfaces/setters/IABISetter.sol";
import {IAddressSetter} from "./interfaces/setters/IAddressSetter.sol";
import {IContenthashSetter} from "./interfaces/setters/IContenthashSetter.sol";
import {IDataSetter} from "./interfaces/setters/IDataSetter.sol";
import {IInterfaceSetter} from "./interfaces/setters/IInterfaceSetter.sol";
import {INameSetter} from "./interfaces/setters/INameSetter.sol";
import {ITextSetter} from "./interfaces/setters/ITextSetter.sol";
import {PermissionedResolverLib} from "./libraries/PermissionedResolverLib.sol";

/// @notice An upgradeable resolver that supports many profiles, multiple names, linked records, and fine-grained permissions.
///
/// Supported profiles and standards:
///
/// | ENSIP | EIP  | Signature                           |
/// | ----- | ---- | ----------------------------------- |
/// | 1     | 137  | `addr()`                            |
/// | 3     | 181  | `name()`                            |
/// | 4     | 205  | `ABI(contentTypes)`                 |
/// | 5     | 634  | `text(key)`                         |
/// | 7     | 1577 | `contenthash()`                     |
/// | 8     |      | `interfaceImplementer(interfaceId)` |
/// | 9     | 2304 | `addr(coinType)`                    |
/// | 19    |      | `addr(default)`                     |
/// | 24    |      | `data(key)`                         |
/// | TBD   |      | `hasAddr(coinType)`                 |
///
/// Records are created automatically by setters and assigned record ID numbers (starting at 1).
///
/// `getRecordId(node)` reveals the internal record ID.
///
/// `linkToNode(name, node)` makes `name` use the record currently used by `node`.
/// `linkToRecord(name, recordId)` makes `name` use a specific record ID.
/// `linkToRecord(name, 0)` unlinks `name` from the record.
///
/// To link, `ROLE_LINK` is required on root.
///
/// Names without a record use the default record, which can be managed using the root name (`0x00`).
///
/// Every record setter has a corresponding role:
///
/// | Function           | Role                   | Argument              |
/// | ------------------ | ---------------------- | --------------------- |
/// | `setABI()`         | `ROLE_SET_ABI`         | `uint256 contentType` |
/// | `setAddress()`     | `ROLE_SET_ADDRESS`     | `uint256 coinType`    |
/// | `setContenthash()` | `ROLE_SET_CONTENTHASH` |                       |
/// | `setData()`        | `ROLE_SET_DATA`        | `string key`          |
/// | `setInterface()`   | `ROLE_SET_INTERFACE`   | `bytes4 interfaceId`  |
/// | `setName()`        | `ROLE_SET_NAME`        |                       |
/// | `setText()`        | `ROLE_SET_TEXT`        | `string key`          |
///
/// Every record setter has the form: `f(name, ...)`
/// Some record setters have the form: `f(name, <argument>, ...)`
///
/// `grantSetterRoles(setter, account)` gives argument-specific permission.
///
/// Every setter with an argument can be decoded with `decodeSetter(setter)`.
/// Every argument can be translated to a resource with `PermissionedResolverLib.resource(<argument>)`.
///
/// eg. `setText(<name>, "key", <value>)` will check the following resources for `ROLE_SET_TEXT` permission:
/// 1. `PermissionedResolverLib.resource("key")` => only "key"
/// 2. `ROOT_RESOURCE` => any key
///
contract PermissionedResolver is
    IPermissionedResolver,
    IPermissionedResolverInitializable,
    AbstractRecordResolver,
    EnhancedAccessControl,
    IContractNamer,
    UUPSUpgradeable,
    IProxyAuthorization
{
    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Number of records created.
    uint256 internal _recordCount;

    /// @dev Mapping from `node` to `recordId`.
    mapping(bytes32 node => uint256 recordId) internal _recordIds;

    /// @dev Mapping from `recordId` to `Record`.
    mapping(uint256 recordId => Record record) internal _records;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param namer The implementation namer.
    constructor(address namer) {
        emit ResolverCreated();
        _grantRoles(
            ROOT_RESOURCE,
            PermissionedResolverLib.ROLE_CAN_NAME | PermissionedResolverLib.ROLE_CAN_NAME_ADMIN,
            namer,
            false
        );
        _disableInitializers();
    }

    /// @inheritdoc IPermissionedResolverInitializable
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external initializer {
        __UUPSUpgradeable_init();
        emit ResolverCreated();
        for (uint256 i; i < grants.length; ++i) {
            _grantRoles(ROOT_RESOURCE, grants[i].roleBitmap, grants[i].account, false);
        }
        multicall(calls);
    }

    /// @inheritdoc AbstractRecordResolver
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(AbstractRecordResolver, EnhancedAccessControl)
        returns (bool)
    {
        return
            type(IPermissionedResolver).interfaceId == interfaceId ||
            type(UUPSUpgradeable).interfaceId == interfaceId ||
            type(IProxyAuthorization).interfaceId == interfaceId ||
            type(IContractNamer).interfaceId == interfaceId ||
            type(IPermissionedResolverInitializable).interfaceId == interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IABISetter
    function setABI(bytes calldata name, uint256 contentType, bytes calldata data)
        external
        onlyRoles(
            PermissionedResolverLib.resource(contentType),
            PermissionedResolverLib.ROLE_SET_ABI
        )
    {
        _checkContentType(contentType);
        uint256 recordId = _ensureRecord(name);
        _records[recordId].abis[contentType] = data;
        emit ABIUpdated(recordId, contentType);
    }

    /// @inheritdoc IAddressSetter
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes)
        external
        onlyRoles(
            PermissionedResolverLib.resource(coinType),
            PermissionedResolverLib.ROLE_SET_ADDRESS
        )
    {
        _checkAddress(coinType, addressBytes);
        uint256 recordId = _ensureRecord(name);
        _records[recordId].addresses[coinType] = addressBytes;
        emit AddressUpdated(recordId, coinType, addressBytes);
    }

    /// @inheritdoc IContenthashSetter
    function setContenthash(bytes calldata name, bytes calldata hash)
        external
        onlyRootRoles(PermissionedResolverLib.ROLE_SET_CONTENTHASH)
    {
        uint256 recordId = _ensureRecord(name);
        _records[recordId].contenthash = hash;
        emit ContenthashUpdated(recordId, hash);
    }

    /// @inheritdoc IDataSetter
    function setData(bytes calldata name, string calldata key, bytes calldata value)
        external
        onlyRoles(PermissionedResolverLib.resource(key), PermissionedResolverLib.ROLE_SET_DATA)
    {
        uint256 recordId = _ensureRecord(name);
        _records[recordId].datas[key] = value;
        emit DataUpdated(recordId, key, key, value);
    }

    /// @inheritdoc IInterfaceSetter
    function setInterface(bytes calldata name, bytes4 interfaceId, address implementer)
        external
        onlyRoles(
            PermissionedResolverLib.resource(interfaceId),
            PermissionedResolverLib.ROLE_SET_INTERFACE
        )
    {
        uint256 recordId = _ensureRecord(name);
        _records[recordId].interfaces[interfaceId] = implementer;
        emit InterfaceUpdated(recordId, interfaceId, implementer);
    }

    /// @inheritdoc INameSetter
    function setName(bytes calldata name, string calldata primaryName)
        external
        onlyRootRoles(PermissionedResolverLib.ROLE_SET_NAME)
    {
        uint256 recordId = _ensureRecord(name);
        _records[recordId].name = primaryName;
        emit NameUpdated(recordId, primaryName);
    }

    /// @inheritdoc ITextSetter
    function setText(bytes calldata name, string calldata key, string calldata value)
        external
        onlyRoles(PermissionedResolverLib.resource(key), PermissionedResolverLib.ROLE_SET_TEXT)
    {
        uint256 recordId = _ensureRecord(name);
        _records[recordId].texts[key] = value;
        emit TextUpdated(recordId, key, key, value);
    }

    /// @inheritdoc IPermissionedResolver
    function linkToNode(bytes calldata sourceName, bytes32 targetNode)
        external
        onlyRootRoles(PermissionedResolverLib.ROLE_LINK)
    {
        uint256 recordId = _recordIds[targetNode];
        if (recordId == 0) {
            revert InvalidRecord(); // prevent linking unknown targets
        }
        _link(sourceName, recordId);
    }

    /// @inheritdoc IPermissionedResolver
    function linkToRecord(bytes calldata sourceName, uint256 recordId)
        external
        onlyRootRoles(PermissionedResolverLib.ROLE_LINK)
    {
        if (recordId > _recordCount) {
            revert InvalidRecord(); // prevent linking future records
        }
        _link(sourceName, recordId);
    }

    /// @inheritdoc IPermissionedResolver
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool) {
        (bytes memory arg, uint256 resource, uint256 roleBitmap) = decodeSetter(setter);
        _checkCanGrantRoles(resource, roleBitmap, msg.sender);
        if (roleCount(resource) == 0) {
            emit ResourceArgument(resource, arg);
        }
        return _grantRoles(resource, roleBitmap, account, true);
    }

    /// @inheritdoc IPermissionedResolver
    function getRecordCount() external view returns (uint256) {
        return _recordCount;
    }

    /// @inheritdoc IPermissionedResolver
    function getRecordId(bytes32 node) external view returns (uint256) {
        return _recordIds[node];
    }

    /// @notice Declares this implementation as an eligible verifiable proxy upgrade target.
    /// @dev Upgrade authorization is still enforced by the current implementation during the UUPS
    ///      upgrade call.
    /// @param {previousImplementation} Ignored.
    /// @return allowed Always `true` for implementations in this resolver family.
    function canUpgradeFrom(
        address /*previousImplementation*/
    )
        external
        pure
        virtual
        override
        returns (bool allowed)
    {
        return true;
    }

    /// @inheritdoc IContractNamer
    function isContractNamer(address namer) public view virtual returns (bool) {
        return hasRootRoles(PermissionedResolverLib.ROLE_CAN_NAME, namer);
    }

    /// @inheritdoc EnhancedAccessControl
    /// @notice Function is disabled.  Use `grantSetterRoles()` instead.
    function grantRoles(uint256 resource, uint256 roleBitmap, address account)
        public
        pure
        override(EnhancedAccessControl, IEnhancedAccessControl)
        returns (bool)
    {
        revert EACCannotGrantRoles(resource, roleBitmap, account);
    }

    /// @inheritdoc IPermissionedResolver
    function decodeSetter(bytes calldata setter)
        public
        pure
        returns (bytes memory arg, uint256 resource, uint256 roleBitmap)
    {
        bytes4 selector = bytes4(setter);
        if (selector == this.setAddress.selector) {
            (, uint256 coinType) = abi.decode(setter[4:], (bytes, uint256));
            arg = abi.encodePacked(coinType);
            roleBitmap = PermissionedResolverLib.ROLE_SET_ADDRESS;
        } else if (selector == this.setText.selector) {
            (, string memory key) = abi.decode(setter[4:], (bytes, string));
            arg = bytes(key);
            roleBitmap = PermissionedResolverLib.ROLE_SET_TEXT;
        } else if (selector == this.setData.selector) {
            (, string memory key) = abi.decode(setter[4:], (bytes, string));
            arg = bytes(key);
            roleBitmap = PermissionedResolverLib.ROLE_SET_DATA;
        } else if (selector == this.setABI.selector) {
            (, uint256 contentType) = abi.decode(setter[4:], (bytes, uint256));
            arg = abi.encodePacked(contentType);
            roleBitmap = PermissionedResolverLib.ROLE_SET_ABI;
        } else if (selector == this.setInterface.selector) {
            (, bytes4 interfaceId) = abi.decode(setter[4:], (bytes, bytes4));
            arg = abi.encodePacked(interfaceId);
            roleBitmap = PermissionedResolverLib.ROLE_SET_INTERFACE;
        } else {
            revert UnsupportedResolverProfile(selector);
        }
        resource = uint256(keccak256(arg)); // same as PermissionedResolverLib.resource()
        assert(resource != ROOT_RESOURCE);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Allow `ROLE_UPGRADE` to upgrade.
    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRootRoles(PermissionedResolverLib.ROLE_UPGRADE)
    {}

    /// @dev Ensure record exists for `name`.
    function _ensureRecord(bytes memory name) internal returns (uint256 recordId) {
        bytes32 node = NameCoder.namehash(name, 0);
        recordId = _recordIds[node];
        if (recordId == 0) {
            recordId = ++_recordCount;
            _recordIds[node] = recordId;
            emit Linked(recordId, node, name);
        }
    }

    /// @dev Set `sourceName` to `recordId`.
    function _link(bytes calldata sourceName, uint256 recordId) internal {
        bytes32 sourceNode = NameCoder.namehash(sourceName, 0);
        _recordIds[sourceNode] = recordId;
        emit Linked(recordId, sourceNode, sourceName);
    }

    /// @dev Avoid permission checks during initialization.
    function _checkRoles(uint256 resource, uint256 roleBitmap, address account)
        internal
        view
        override
    {
        if (!_isInitializing()) {
            super._checkRoles(resource, roleBitmap, account);
        }
    }

    /// @dev Determine the active storage record for `node`.
    function _record(bytes32 node) internal view override returns (Record storage) {
        uint256 recordId = _recordIds[node];
        if (recordId == 0) {
            recordId = _recordIds[bytes32(0)]; // use default
        }
        return _records[recordId];
    }
}
