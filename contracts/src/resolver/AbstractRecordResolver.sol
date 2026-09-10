// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IMulticallable} from "@ens/contracts/resolvers/Multicallable.sol";
import {IABIResolver} from "@ens/contracts/resolvers/profiles/IABIResolver.sol";
import {IAddressResolver} from "@ens/contracts/resolvers/profiles/IAddressResolver.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {IContentHashResolver} from "@ens/contracts/resolvers/profiles/IContentHashResolver.sol";
import {IDataResolver} from "@ens/contracts/resolvers/profiles/IDataResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {IHasAddressResolver} from "@ens/contracts/resolvers/profiles/IHasAddressResolver.sol";
import {IInterfaceResolver} from "@ens/contracts/resolvers/profiles/IInterfaceResolver.sol";
import {INameResolver} from "@ens/contracts/resolvers/profiles/INameResolver.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {ENSIP19, COIN_TYPE_ETH, COIN_TYPE_DEFAULT} from "@ens/contracts/utils/ENSIP19.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

import {IRecordResolver} from "./interfaces/IRecordResolver.sol";
import {IABISetter} from "./interfaces/setters/IABISetter.sol";
import {IAddressSetter} from "./interfaces/setters/IAddressSetter.sol";
import {IContenthashSetter} from "./interfaces/setters/IContenthashSetter.sol";
import {IDataSetter} from "./interfaces/setters/IDataSetter.sol";
import {IInterfaceSetter} from "./interfaces/setters/IInterfaceSetter.sol";
import {INameSetter} from "./interfaces/setters/INameSetter.sol";
import {ITextSetter} from "./interfaces/setters/ITextSetter.sol";

/// @dev Abstract resolver implementation that supports multicall and the standardized resolver profiles.
abstract contract AbstractRecordResolver is ERC165, IRecordResolver, IERC7996 {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct Record {
        bytes contenthash;
        string name;
        mapping(uint256 coinType => bytes addressBytes) addresses;
        mapping(string key => string value) texts;
        mapping(string key => bytes value) datas;
        mapping(uint256 contentType => bytes value) abis;
        mapping(bytes4 interfaceId => address implementer) interfaces;
    }

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IExtendedResolver).interfaceId ||
            interfaceId == type(IERC7996).interfaceId ||
            interfaceId == type(IMulticallable).interfaceId ||
            interfaceId == type(IABISetter).interfaceId ||
            interfaceId == type(IAddressSetter).interfaceId ||
            interfaceId == type(IContenthashSetter).interfaceId ||
            interfaceId == type(IDataSetter).interfaceId ||
            interfaceId == type(IInterfaceSetter).interfaceId ||
            interfaceId == type(INameSetter).interfaceId ||
            interfaceId == type(ITextSetter).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IERC7996
    function supportsFeature(bytes4 feature) external pure returns (bool) {
        return ResolverFeatures.RESOLVE_MULTICALL == feature;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Same as `multicall()`.
    /// @param {node} Ignored, for interface compatibility.
    /// @param calls The calls to make.
    /// @return results The results of the calls.
    function multicallWithNodeCheck(
        bytes32 /*node*/,
        bytes[] calldata calls
    )
        external
        returns (bytes[] memory)
    {
        return multicall(calls);
    }

    /// @inheritdoc IMulticallable
    /// @notice Perform multiple write operations.
    /// @dev Reverts with first error.
    /// @param calls The calls to make.
    /// @return results The results of the calls.
    function multicall(bytes[] calldata calls) public returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory v) = address(this).delegatecall(calls[i]);
            if (!ok) {
                assembly {
                    revert(add(v, 32), mload(v)) // propagate the first error
                }
            }
            results[i] = v;
        }
    }

    /// @inheritdoc IExtendedResolver
    /// @dev The first argument of data (`bytes32 node`) is ignored.
    function resolve(bytes calldata name, bytes calldata data) public view returns (bytes memory) {
        bytes4 selector = bytes4(data);
        if (selector == IMulticallable.multicall.selector) {
            bytes[] memory m = abi.decode(data[4:], (bytes[]));
            for (uint256 i; i < m.length; ++i) {
                try this.resolve(name, m[i]) returns (bytes memory v) {
                    m[i] = v;
                } catch (bytes memory v) {
                    m[i] = v;
                }
            }
            return abi.encode(m); // bytes[]
        }
        Record storage r = _record(NameCoder.namehash(name, 0));
        if (selector == IAddrResolver.addr.selector) {
            return abi.encode(_getAddr(r)); // address
        } else if (selector == IAddressResolver.addr.selector) {
            (, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            return abi.encode(_getAddress(r, coinType)); // bytes
        } else if (selector == ITextResolver.text.selector) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            return abi.encode(r.texts[key]); // string
        } else if (selector == IDataResolver.data.selector) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            return abi.encode(r.datas[key]); // bytes
        } else if (selector == INameResolver.name.selector) {
            return abi.encode(r.name); // string
        } else if (selector == IContentHashResolver.contenthash.selector) {
            return abi.encode(r.contenthash); // bytes
        } else if (selector == IHasAddressResolver.hasAddr.selector) {
            (, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            return abi.encode(r.addresses[coinType].length > 0); // boolean
        } else if (selector == IABIResolver.ABI.selector) {
            (, uint256 contentTypes) = abi.decode(data[4:], (bytes32, uint256));
            (uint256 contentType, bytes memory value) = _getABI(r, contentTypes);
            return abi.encode(contentType, value); // (uint256, bytes)
        } else if (selector == IInterfaceResolver.interfaceImplementer.selector) {
            (, bytes4 interfaceId) = abi.decode(data[4:], (bytes32, bytes4));
            address implementer = r.interfaces[interfaceId];
            if (implementer == address(0)) {
                address pointer = _getAddr(r);
                if (ERC165Checker.supportsInterface(pointer, interfaceId)) {
                    implementer = pointer;
                }
            }
            return abi.encode(implementer); // address
        } else {
            revert UnsupportedResolverProfile(selector);
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Get the active storage record.
    function _record(bytes32 node) internal view virtual returns (Record storage);

    /// @dev Determine address according to ENSIP-19.
    function _getAddress(Record storage r, uint256 coinType)
        internal
        view
        returns (bytes storage addressBytes)
    {
        addressBytes = r.addresses[coinType];
        if (addressBytes.length == 0 && ENSIP19.chainFromCoinType(coinType) > 0) {
            addressBytes = r.addresses[COIN_TYPE_DEFAULT];
        }
    }

    /// @dev Convenience for mainnet address.
    function _getAddr(Record storage r) internal view returns (address) {
        return address(bytes20(_getAddress(r, COIN_TYPE_ETH)));
    }

    /// @dev Find ABI matching contentTypes filter.
    function _getABI(Record storage r, uint256 contentTypes)
        internal
        view
        returns (uint256 contentType, bytes memory value)
    {
        for (contentType = 1; contentType > 0 && contentType <= contentTypes; contentType <<= 1) {
            if ((contentType & contentTypes) != 0) {
                value = r.abis[contentType];
                if (value.length > 0) {
                    return (contentType, value);
                }
            }
        }
        return (0, "");
    }

    /// @dev If `coinType` is EVM, ensure it is the proper size.
    function _checkAddress(uint256 coinType, bytes calldata addressBytes) internal pure {
        if (
            addressBytes.length != 0 && addressBytes.length != 20 && ENSIP19.isEVMCoinType(coinType)
        ) {
            revert InvalidEVMAddress(addressBytes);
        }
    }

    /// @dev Ensure `contentType` is a single bit.
    function _checkContentType(uint256 contentType) internal pure {
        if (contentType == 0 || (contentType - 1) & contentType != 0) {
            revert InvalidContentType(contentType);
        }
    }
}
