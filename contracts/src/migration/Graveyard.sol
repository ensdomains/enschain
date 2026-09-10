// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {
    BaseRegistrarImplementation
} from "@ens/contracts/ethregistrar/BaseRegistrarImplementation.sol";
import {IBaseRegistrar} from "@ens/contracts/ethregistrar/IBaseRegistrar.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {INameWrapper} from "@ens/contracts/wrapper/INameWrapper.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

import {LibMigration} from "./libraries/LibMigration.sol";

/// @notice The ENSv1 ETHRegistrarController for ENSv2 launch which becomes the burn address for migrated tokens.
///
/// 1. Claim any expired ENSv1 name and assign ownership to this contract.
/// 2. Clear the registry for any owned token.
///
contract Graveyard is ERC721Holder, ERC1155Holder, DelegatedContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @dev The internal states of registry ownership.
    enum State {
        ROOT,
        ETH,
        OWNED,
        LOCKED
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv1 `NameWrapper` contract.
    INameWrapper public immutable NAME_WRAPPER;

    /// @dev The ENSv1 `ENSRegistry` contract.
    ENS internal immutable _REGISTRY_V1;

    /// @dev The ENSv1 `BaseRegistrar` contract.
    IBaseRegistrar internal immutable _BASE_REGISTRAR;

    /// @dev Same as `BaseRegistrarImplementation.GRACE_PERIOD()`.
    uint256 internal immutable _GRACE_PERIOD;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Name cannot be cleared.
    /// @dev Error selector: `0xacae6b3b`
    error NameNotClearable();

    /// @notice Wrapped names require preimage. 
    /// @dev Error selector: `0xa3f28cee`
    error NameRequiresPreimage();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Create a graveyard.
    /// @param nameWrapper The ENSv1 `NameWrapper` contract.
    /// @param contractNamer Delegated contract namer.
    constructor(INameWrapper nameWrapper, IContractNamer contractNamer)
        DelegatedContractNamer(contractNamer)
    {
        NAME_WRAPPER = nameWrapper;
        _REGISTRY_V1 = nameWrapper.ens();
        _BASE_REGISTRAR = nameWrapper.registrar();
        _GRACE_PERIOD = BaseRegistrarImplementation(address(_BASE_REGISTRAR)).GRACE_PERIOD();
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155Holder, DelegatedContractNamer)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Clear registry for migrated names.
    /// @param names The array of names to clear.
    function clear(bytes[] calldata names) external {
        for (uint256 i; i < names.length; ++i) {
            _clear(names[i], 0);
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Recursively clear ancestor namespace.
    ///
    /// Wrapped labels are 1-255 bytes and always have a preimage.
    /// see: V1Fixture.t.sol: `test_nameWrapper_labelTooShort` and `test_nameWrapper_labelTooLong`
    /// see: https://github.com/ensdomains/ens-contracts/blob/staging/contracts/wrapper/NameWrapper.sol#L865-L876
    ///
    /// This function supports a modified DNS-encoding where zero-length labels
    /// in the middle of name must be followed with exactly 32 bytes of labelhash.
    ///
    /// This is safe because zero-length non-terminating labels normally revert.
    ///
    function _clear(bytes calldata name, uint256 offset) internal returns (bytes32 node, State) {
        bytes32 labelHash;
        uint256 nextOffset;
        // modified DNS-encoding: interpret zero-length labels differently
        if (offset + 1 < name.length && uint8(name[offset]) == 0) {
            nextOffset = offset + 33; // skip length and ensure next 32 bytes exist
            if (nextOffset >= name.length) {
                revert NameCoder.DNSDecodingFailed(name);
            }
            labelHash = bytes32(name[offset + 1:nextOffset]); // cast as literal bytes32
        } else {
            (labelHash, nextOffset) = NameCoder.readLabel(name, offset); // use standard logic
            if (labelHash == bytes32(0)) {
                return (bytes32(0), State.ROOT);
            }
        }
        (bytes32 parentNode, State parentState) = _clear(name, nextOffset);
        node = NameCoder.namehash(parentNode, labelHash);
        if (parentState == State.ROOT) {
            if (node != NameCoder.ETH_NODE) {
                revert NameNotClearable();
            }
            return (node, State.ETH);
        } else if (parentState == State.ETH) {
            address owner = _REGISTRY_V1.owner(node);
            if (owner == address(this)) {
                // resolver is cleared by migration
                return (node, State.OWNED);
            }
            uint32 fuses;
            (owner, fuses, ) = NAME_WRAPPER.getData(uint256(node));
            if (LibMigration.isLocked(fuses)) {
                if (owner != address(this)) {
                    revert NameNotClearable();
                }
                // resolver is cleared by migration
                return (node, State.LOCKED);
            }
            if (_BASE_REGISTRAR.nameExpires(uint256(labelHash)) == 0) {
                revert NameNotClearable();
            }
            _BASE_REGISTRAR.register(
                uint256(labelHash),
                address(this),
                type(uint64).max - block.timestamp - _GRACE_PERIOD // max duration?
            );
            // lock expired? so clear it
            if (_REGISTRY_V1.resolver(node) != address(0)) {
                _REGISTRY_V1.setResolver(node, address(0));
            }
            return (node, State.OWNED);
        } else if (parentState == State.OWNED) {
            _REGISTRY_V1.setSubnodeRecord(parentNode, labelHash, address(this), address(0), 0);
            return (node, State.OWNED);
        } else {
            (address owner, uint32 fuses, ) = NAME_WRAPPER.getData(uint256(node));
            if (LibMigration.isLocked(fuses)) {
                if (owner != address(this)) {
                    revert NameNotClearable();
                }
                // resolver is cleared by migration
                return (node, State.LOCKED);
            } else if (LibMigration.isEmancipatedChild(fuses)) {
                if (owner != address(0) || _REGISTRY_V1.owner(node) != address(this)) {
                    revert NameNotClearable();
                }
                // resolver is cleared by migration
            } else {
                if (uint8(name[offset]) == 0) {
                    revert NameRequiresPreimage();
                }
                NAME_WRAPPER.setSubnodeRecord(
                    parentNode,
                    string(name[offset + 1:nextOffset]),
                    address(this), // owner
                    address(0), // resolver is cleared
                    0, // ttl
                    0, // fuses
                    0 // expiry (uses min)
                ); // reverts if not migrated
                NAME_WRAPPER.unwrap(parentNode, labelHash, address(this));
            }
            return (node, State.OWNED);
        }
    }
}
