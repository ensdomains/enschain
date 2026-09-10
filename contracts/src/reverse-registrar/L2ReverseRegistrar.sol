// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IUniversalSignatureValidator} from "../utils/interfaces/IUniversalSignatureValidator.sol";
import {LibISO8601} from "../utils/LibISO8601.sol";
import {LibString} from "../utils/LibString.sol";

import {IContractName} from "./interfaces/IContractName.sol";
import {IL2ReverseRegistrar} from "./interfaces/IL2ReverseRegistrar.sol";
import {AccountNamerLib} from "./libraries/AccountNamerLib.sol";
import {ChainIdsBuilderLib} from "./libraries/ChainIdsBuilderLib.sol";
import {StandaloneReverseRegistrar} from "./StandaloneReverseRegistrar.sol";

/// @title L2 Reverse Registrar
/// @notice A reverse registrar for L2 chains that allows users to set their ENS primary name.
/// @dev Deployed to each L2 chain. Supports signature-based claims for both EOAs and contracts.
contract L2ReverseRegistrar is IL2ReverseRegistrar, ERC165, StandaloneReverseRegistrar {
    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @dev The ERC6492 detection suffix.
    bytes32 private constant _ERC6492_DETECTION_SUFFIX =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    /// @dev The universal signature validator for ERC6492 signatures.
    IUniversalSignatureValidator private constant _UNIVERSAL_SIG_VALIDATOR =
        IUniversalSignatureValidator(0x164af34fAF9879394370C7f09064127C043A35E9);

    /// @notice The chain ID of the chain this contract is deployed to.
    /// @dev Derived from the coin type during construction.
    uint256 public immutable CHAIN_ID;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @notice Mapping of addresses to their inception timestamp for replay protection.
    /// @dev Only signatures with a signedAt timestamp greater than the stored inception can be used.
    mapping(address addr => uint256 inception) public inceptionOf;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Thrown when the signature's signedAt is not after the current inception.
    /// @dev Error selector: `0xbdc2d236`
    error StaleSignature(uint256 signedAt, uint256 inception);

    /// @notice Thrown when the signature's signedAt timestamp is in the future.
    /// @dev Error selector: `0x2c4fde1c`
    error SignatureNotValidYet(uint256 signedAt, uint256 currentTime);

    /// @notice Thrown when the signature is invalid.
    /// @dev Error selector: `0x8baa579f`
    error InvalidSignature();

    /// @notice Thrown when the chain ID array is not in strictly ascending order.
    /// @dev Error selector: `0xea0b14e2`
    /// @dev Re-declared here (despite living in`ChainIdsBuilderLib`) because the library
    /// reverts via assembly literal and Solidity has no source-level reference to propagate
    /// the type into this contract's ABI. `CurrentChainNotFound` doesn't need this anchor —
    /// the library reverts it via `revert CurrentChainNotFound(...)` so its type propagates
    /// automatically.
    error ChainIdsNotAscending();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Initialises the contract with the chain ID and label for this L2 chain.
    /// @param chainId The chain ID of the chain this contract is deployed to.
    /// @param label The hex string label for the coin type (used in reverse node computation).
    constructor(uint256 chainId, string memory label) StandaloneReverseRegistrar(label) {
        CHAIN_ID = chainId;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceID)
        public
        view
        override(ERC165, StandaloneReverseRegistrar)
        returns (bool)
    {
        return
            interfaceID == type(IL2ReverseRegistrar).interfaceId ||
            super.supportsInterface(interfaceID);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IL2ReverseRegistrar
    function setName(string calldata name) external {
        _setName(msg.sender, name);
        _advanceInception(msg.sender);
    }

    /// @inheritdoc IL2ReverseRegistrar
    function setNameForAddr(address addr, string calldata name) external {
        AccountNamerLib.requireNamer(addr, msg.sender);
        _setName(addr, name);
        _advanceInception(addr);
    }

    /// @inheritdoc IL2ReverseRegistrar
    function setNameForAddrWithSignature(NameClaim calldata claim, bytes calldata signature)
        external
    {
        string memory chainIdsString = ChainIdsBuilderLib.validateAndBuild(claim.chainIds, CHAIN_ID);

        bytes32 message = _createClaimMessageHash(claim, chainIdsString, address(0));
        _validateSignature(signature, claim.addr, message);
        _validateAndUpdateInception(claim.addr, claim.signedAt);

        _setName(claim.addr, claim.name);
    }

    /// @inheritdoc IL2ReverseRegistrar
    function setNameForContractWithSignature(
        NameClaim calldata claim,
        address owner,
        bytes calldata signature
    )
        external
    {
        string memory chainIdsString = ChainIdsBuilderLib.validateAndBuild(claim.chainIds, CHAIN_ID);

        AccountNamerLib.requireNamer(claim.addr, owner);

        bytes32 message = _createClaimMessageHash(claim, chainIdsString, owner);
        _validateSignature(signature, owner, message);
        _validateAndUpdateInception(claim.addr, claim.signedAt);

        _setName(claim.addr, claim.name);
    }

    /// @inheritdoc IL2ReverseRegistrar
    function syncName(address addr) external {
        _setName(addr, IContractName(addr).contractName()); // reverts if not implemented
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @notice Validates a signature for the given address and message.
    /// @dev Supports EOA signatures, ERC1271 (smart contract wallets), and ERC6492 (undeployed wallets).
    /// @param signature The signature to validate.
    /// @param addr The address that should have signed the message.
    /// @param message The message hash that was signed.
    function _validateSignature(bytes calldata signature, address addr, bytes32 message) internal {
        // ERC6492 check is done internally because UniversalSigValidator is not gas efficient.
        // We only want to use UniversalSigValidator for ERC6492 signatures.
        if (bytes32(signature[signature.length - 32:signature.length]) == _ERC6492_DETECTION_SUFFIX) {
            if (!_UNIVERSAL_SIG_VALIDATOR.isValidSig(addr, message, signature))
                revert InvalidSignature();
        } else {
            if (!SignatureChecker.isValidSignatureNow(addr, message, signature))
                revert InvalidSignature();
        }
    }

    /// @notice Validates and updates the inception timestamp for replay protection.
    /// @dev Reverts if signedAt is not after the current inception or is in the future.
    /// @param addr The address to validate and update inception for.
    /// @param signedAt The signedAt timestamp from the signature.
    function _validateAndUpdateInception(address addr, uint256 signedAt) internal {
        uint256 currentInception = inceptionOf[addr];

        // signedAt must be strictly greater than the current inception
        if (signedAt <= currentInception)
            revert StaleSignature(signedAt, currentInception);

        // signedAt cannot be in the future
        if (signedAt > block.timestamp)
            revert SignatureNotValidYet(signedAt, block.timestamp);

        // Update the inception to the new signedAt
        inceptionOf[addr] = signedAt;
    }

    /// @notice Advances the inception timestamp after an authorized direct name update.
    /// @dev The replay fence never moves backward.
    /// @param addr The address whose inception should be advanced.
    function _advanceInception(address addr) internal {
        if (block.timestamp > inceptionOf[addr]) {
            inceptionOf[addr] = block.timestamp;
        }
    }

    /// @dev Creates the EIP-191 message hash for signature-based name claims.
    ///
    /// For address claims (owner == address(0)):
    /// ```
    /// You are setting your ENS primary name to:
    /// {name}
    ///
    /// Address: {address}
    /// Chains: {chainList}
    /// Signed At: {signedAt}
    /// ```
    ///
    /// For ownable contract claims (owner != address(0)):
    /// ```
    /// You are setting the ENS primary name for a contract you own to:
    /// {name}
    ///
    /// Contract Address: {address}
    /// Owner: {owner}
    /// Chains: {chainList}
    /// Signed At: {signedAt}
    /// ```
    ///
    /// @param claim The name claim data.
    /// @param chainIdsString The pre-validated chain IDs as a display string.
    /// @param owner The owner address for ownable claims, or address(0) for address claims.
    /// @return digest The EIP-191 signed message hash.
    function _createClaimMessageHash(
        NameClaim calldata claim,
        string memory chainIdsString,
        address owner
    )
        internal
        pure
        returns (bytes32 digest)
    {
        string memory name = claim.name;
        string memory addrString = LibString.toChecksumHexString(claim.addr);
        string memory signedAtString = LibISO8601.toISO8601(claim.signedAt);

        bool isOwnable = owner != address(0);
        string memory ownerString;
        if (isOwnable) {
            ownerString = LibString.toChecksumHexString(owner);
        }

        // Build message in memory as bytes
        bytes memory message;
        assembly {
            // Paris-compatible memory copy helper (replaces mcopy from Cancun)
            // Copies in 32-byte chunks; safe here since subsequent writes overwrite any overshoot
            function _memcpy(dest, src, len) {
                for {
                    let i := 0
                } lt(i, len) {
                    i := add(i, 32)
                } {
                    mstore(add(dest, i), mload(add(src, i)))
                }
            }

            // Get free memory pointer - reserve space for length, then build message
            message := mload(0x40)
            let ptr := add(message, 32) // Start writing after length slot

            // Header differs based on claim type
            switch isOwnable
            case 0 {
                // "You are setting your ENS primary" (32 bytes)
                mstore(ptr, 0x596f75206172652073657474696e6720796f757220454e53207072696d617279)
                // " name to:\n" (10 bytes)
                mstore(
                    add(ptr, 32),
                    0x206e616d6520746f3a0a00000000000000000000000000000000000000000000
                )
                ptr := add(ptr, 42)
            }
            default {
                // "You are setting the ENS primary " (32 bytes)
                mstore(ptr, 0x596f75206172652073657474696e672074686520454e53207072696d61727920)
                // "name for a contract you own to:\n" (32 bytes)
                mstore(
                    add(ptr, 32),
                    0x6e616d6520666f72206120636f6e747261637420796f75206f776e20746f3a0a
                )
                ptr := add(ptr, 64)
            }
            // Copy name (variable length)
            let nameLen := mload(name)
            _memcpy(ptr, add(name, 32), nameLen)
            ptr := add(ptr, nameLen)

            // Address label differs based on claim type
            switch isOwnable
            case 0 {
                // "\n\nAddress: " (11 bytes)
                mstore(ptr, 0x0a0a416464726573733a20000000000000000000000000000000000000000000)
                ptr := add(ptr, 11)
            }
            default {
                // "\n\nContract Address: " (20 bytes)
                mstore(ptr, 0x0a0a436f6e747261637420416464726573733a20000000000000000000000000)
                ptr := add(ptr, 20)
            }
            // Copy addrString (42 bytes)
            _memcpy(ptr, add(addrString, 32), 42)
            ptr := add(ptr, 42)

            // Owner section (only for ownable claims)
            if isOwnable {
                // "\nOwner: " (8 bytes)
                mstore(ptr, 0x0a4f776e65723a20000000000000000000000000000000000000000000000000)
                ptr := add(ptr, 8)

                // Copy ownerString (42 bytes)
                _memcpy(ptr, add(ownerString, 32), 42)
                ptr := add(ptr, 42)
            }

            // "\nChains: " (9 bytes)
            mstore(ptr, 0x0a436861696e733a200000000000000000000000000000000000000000000000)
            ptr := add(ptr, 9)

            // Copy chainIdsString (variable length)
            let chainLen := mload(chainIdsString)
            _memcpy(ptr, add(chainIdsString, 32), chainLen)
            ptr := add(ptr, chainLen)

            // "\nSigned At: " (12 bytes)
            mstore(ptr, 0x0a5369676e65642041743a200000000000000000000000000000000000000000)
            ptr := add(ptr, 12)

            // Copy signedAtString (20 bytes fixed - ISO8601 format)
            _memcpy(ptr, add(signedAtString, 32), 20)
            ptr := add(ptr, 20)

            // Store final message length and update free memory pointer
            mstore(message, sub(ptr, add(message, 32)))
            mstore(0x40, ptr)
        }

        // Compute EIP-191 signed message hash: keccak256("\x19Ethereum Signed Message:\n" || len || message)
        string memory lenString = LibString.toString(message.length);
        assembly {
            function _memcpy(dest, src, len) {
                for {
                    let i := 0
                } lt(i, len) {
                    i := add(i, 32)
                } {
                    mstore(add(dest, i), mload(add(src, i)))
                }
            }

            let messageLen := mload(message)
            let lenStringLen := mload(lenString)

            // Build prefixed message at free memory pointer (not updated since only used for hashing)
            let ptr := mload(0x40)

            // "\x19Ethereum Signed Message:\n" (26 bytes)
            mstore(ptr, 0x19457468657265756d205369676e6564204d6573736167653a0a000000000000)

            // Copy length string (decimal digits of message length) after prefix
            _memcpy(add(ptr, 26), add(lenString, 32), lenStringLen)

            // Copy message content after prefix + length string
            let messageStart := add(add(ptr, 26), lenStringLen)
            _memcpy(messageStart, add(message, 32), messageLen)

            // Compute the final EIP-191 hash
            digest := keccak256(ptr, add(add(26, lenStringLen), messageLen))
        }
    }
}
