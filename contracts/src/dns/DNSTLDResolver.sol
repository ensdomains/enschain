// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {CCIPReader, OffchainLookup} from "@ens/contracts/ccipRead/CCIPBatcher.sol";
import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {DNSSEC} from "@ens/contracts/dnssec-oracle/DNSSEC.sol";
import {IDNSGateway} from "@ens/contracts/dnssec-oracle/IDNSGateway.sol";
import {RRUtils} from "@ens/contracts/dnssec-oracle/RRUtils.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {IAddrResolver} from "@ens/contracts/resolvers/profiles/IAddrResolver.sol";
import {ICompositeResolver} from "@ens/contracts/resolvers/profiles/ICompositeResolver.sol";
import {IExtendedResolver} from "@ens/contracts/resolvers/profiles/IExtendedResolver.sol";
import {IVerifiableResolver} from "@ens/contracts/resolvers/profiles/IVerifiableResolver.sol";
import {ResolverFeatures} from "@ens/contracts/resolvers/ResolverFeatures.sol";
import {RegistryUtils as RegistryUtilsV1} from "@ens/contracts/universalResolver/RegistryUtils.sol";
import {ResolverCaller} from "@ens/contracts/universalResolver/ResolverCaller.sol";
import {BytesUtils} from "@ens/contracts/utils/BytesUtils.sol";
import {HexUtils} from "@ens/contracts/utils/HexUtils.sol";
import {IERC7996} from "@ens/contracts/utils/IERC7996.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {LibRegistry} from "../universalResolver/libraries/LibRegistry.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

/// @dev DNS resource-record class for the Internet (`IN`), as defined in RFC 1035 section 3.2.4.
uint16 constant CLASS_INET = 1;

/// @dev DNS resource-record type for TXT records, as defined in RFC 1035 section 3.3.14.
uint16 constant QTYPE_TXT = 16;

/// @dev The prefix string that identifies an ENS-aware DNS TXT record (`"ENS1 "`).
///      Only TXT records beginning with this prefix are considered during resolution.
bytes constant TXT_PREFIX = "ENS1 ";

/// @notice Multi-step resolver for DNS TLD names. Resolution follows this priority:
///
/// 1. Check for an existing resolver in the ENSv1 registry. If found (and it's not the v1
///    DNS TLD resolver or this contract), delegate to it directly.
/// 2. Otherwise, query the DNSSEC oracle via CCIP-Read (EIP-3668) for TXT records.
/// 3. Verify the DNSSEC proof, find the first `ENS1`-prefixed TXT record, parse it into a
///    resolver address and context.
/// 4. Call the parsed resolver with the context.
///
/// Implements `IVerifiableResolver` to expose the DNSSEC oracle address and gateways for
/// verification.
///
contract DNSTLDResolver is
    DelegatedContractNamer,
    ResolverCaller,
    IERC7996,
    ICompositeResolver,
    IVerifiableResolver
{
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv1 registry, used to check for existing resolvers on mainnet before falling
    ///         back to DNSSEC resolution.
    ENS public immutable ENS_REGISTRY_V1;

    /// @notice The v1 DNS TLD resolver address. If the v1 registry points to this resolver (or to
    ///         this contract), the name is considered unresolved in v1 and DNSSEC fallback is used.
    address public immutable DNS_TLD_RESOLVER_V1;

    /// @notice The ENSv2 root registry, used to resolve names parsed from `ENS1` TXT records.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    /// @notice The DNSSEC oracle contract that verifies signed DNS resource-record sets.
    DNSSEC public immutable DNSSEC_ORACLE;

    /// @notice Gateway provider for the DNSSEC oracle CCIP-Read queries.
    IGatewayProvider public immutable ORACLE_GATEWAY_PROVIDER;

    /// @notice Gateway provider for batch CCIP-Read calls when forwarding resolution to downstream
    ///         resolvers.
    IGatewayProvider public immutable BATCH_GATEWAY_PROVIDER;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Some raw TXT data was incorrectly encoded.
    /// @dev Error selector: `0xf4ba19b7`
    error InvalidTXT();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param ensRegistryV1 The ENSv1 registry.
    /// @param dnsTLDResolverV1 The v1 DNS TLD resolver address.
    /// @param rootRegistry The ENSv2 root registry.
    /// @param dnssecOracle The DNSSEC oracle contract.
    /// @param oracleGatewayProvider The gateway provider for the DNSSEC oracle CCIP-Read queries.
    /// @param batchGatewayProvider The gateway provider for batch CCIP-Read calls when forwarding resolution to downstream resolvers.
    /// @param contractNamer Delegated contract namer.
    constructor(
        ENS ensRegistryV1,
        address dnsTLDResolverV1,
        IPermissionedRegistry rootRegistry,
        DNSSEC dnssecOracle,
        IGatewayProvider oracleGatewayProvider,
        IGatewayProvider batchGatewayProvider,
        IContractNamer contractNamer
    )
        CCIPReader(DEFAULT_UNSAFE_CALL_GAS)
        DelegatedContractNamer(contractNamer)
    {
        ENS_REGISTRY_V1 = ensRegistryV1;
        DNS_TLD_RESOLVER_V1 = dnsTLDResolverV1;
        ROOT_REGISTRY = rootRegistry;
        DNSSEC_ORACLE = dnssecOracle;
        ORACLE_GATEWAY_PROVIDER = oracleGatewayProvider;
        BATCH_GATEWAY_PROVIDER = batchGatewayProvider;
    }

    /// @inheritdoc DelegatedContractNamer
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            type(IExtendedResolver).interfaceId == interfaceId ||
            type(ICompositeResolver).interfaceId == interfaceId ||
            type(IVerifiableResolver).interfaceId == interfaceId ||
            type(IERC7996).interfaceId == interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @inheritdoc IERC7996
    function supportsFeature(bytes4 feature) public pure returns (bool) {
        return ResolverFeatures.RESOLVE_MULTICALL == feature;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Fetch the DNSSEC TXT record.
    ///         Callers should enable EIP-3668.
    /// @dev This function executes over multiple steps.
    /// @param name The DNS-encoded name.
    /// @return The verified DNSSEC TXT records.
    function getDNSSECRecords(bytes calldata name) external view returns (bytes[] memory) {
        address resolver = _getResolverV1(name);
        if (resolver != address(0)) {
            return new bytes[](0);
        }
        revert OffchainLookup(
            address(this),
            ORACLE_GATEWAY_PROVIDER.gateways(),
            abi.encodeCall(IDNSGateway.resolve, (name, QTYPE_TXT)),
            this.getDNSSECRecordsCallback.selector, // ==> step 2
            name
        );
    }

    /// @notice CCIP-Read callback for `getDNSSECRecords()`.
    /// @param response The response data.
    /// @param name The DNS-encoded name.
    /// @return txts The verified DNSSEC TXT records.
    function getDNSSECRecordsCallback(bytes calldata response, bytes calldata name)
        external
        view
        returns (bytes[] memory txts)
    {
        DNSSEC.RRSetWithSignature[] memory rrsets =
            abi.decode(response, (DNSSEC.RRSetWithSignature[]));
        (bytes memory data, ) = DNSSEC_ORACLE.verifyRRSet(rrsets);
        uint256 i;
        for (
            RRUtils.RRIterator memory iter = RRUtils.iterateRRs(data, 0);
            !RRUtils.done(iter);
            RRUtils.next(iter)
        ) {
            if (_isTXTForName(iter, name)) {
                ++i;
            }
        }
        txts = new bytes[](i);
        i = 0;
        for (
            RRUtils.RRIterator memory iter = RRUtils.iterateRRs(data, 0);
            !RRUtils.done(iter);
            RRUtils.next(iter)
        ) {
            if (_isTXTForName(iter, name)) {
                txts[i++] = _readTXT(iter.data, iter.rdataOffset, iter.nextOffset);
            }
        }
    }

    /// @inheritdoc IVerifiableResolver
    function verifierMetadata(bytes calldata name)
        external
        view
        returns (address verifier, string[] memory gateways)
    {
        if (_getResolverV1(name) == address(0)) {
            verifier = address(DNSSEC_ORACLE);
            gateways = ORACLE_GATEWAY_PROVIDER.gateways();
        }
    }

    /// @inheritdoc ICompositeResolver
    /// @dev This function executes over multiple steps.
    function getResolver(bytes calldata name) external view returns (address, bool) {
        address resolver = _getResolverV1(name);
        if (resolver != address(0)) {
            return (resolver, false);
        }
        revert OffchainLookup(
            address(this),
            ORACLE_GATEWAY_PROVIDER.gateways(),
            abi.encodeCall(IDNSGateway.resolve, (name, QTYPE_TXT)),
            this.getResolverCallback.selector, // ==> step 2
            name
        );
    }

    /// @notice CCIP-Read callback for `getResolver()`.
    /// @param response The response data.
    /// @param name The DNS-encoded name.
    /// @return resolver The underlying resolver address.
    /// @return offchain `true` if `resolver` is offchain.
    function getResolverCallback(bytes calldata response, bytes calldata name)
        external
        view
        returns (address, bool)
    {
        (address resolver, ) = _verifyDNSSEC(name, response);
        return (resolver, true);
    }

    /// @notice Resolve `name` using ENSv1 or DNSSEC.
    ///         Caller should enable EIP-3668.
    /// @dev This function executes over multiple steps.
    /// @param name The DNS-encoded name.
    /// @param data The data to resolve.
    /// @return The abi-encoded result from the resolver.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        address resolver = _getResolverV1(name);
        if (resolver != address(0)) {
            return callResolver(resolver, name, data, false, "", BATCH_GATEWAY_PROVIDER.gateways()); // ==> step 2
        }
        revert OffchainLookup(
            address(this),
            ORACLE_GATEWAY_PROVIDER.gateways(),
            abi.encodeCall(IDNSGateway.resolve, (name, QTYPE_TXT)),
            this.resolveOracleCallback.selector, // ==> step 2
            abi.encode(name, data)
        );
    }

    /// @notice CCIP-Read callback for `resolve()` from calling the DNSSEC oracle.
    ///         Reverts `UnreachableName` if no "ENS1" TXT record is found.
    /// @param response The response data.
    /// @param extraData The contextual data passed from `resolve()`.
    /// @return The abi-encoded result from the resolver.
    function resolveOracleCallback(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (bytes memory name, bytes memory call) = abi.decode(extraData, (bytes, bytes));
        (address resolver, bytes memory context) = _verifyDNSSEC(name, response);
        if (resolver == address(0)) {
            revert UnreachableName(name);
        }
        return callResolver(resolver, name, call, true, context, BATCH_GATEWAY_PROVIDER.gateways()); // ==> step 3
    }

    /// @notice Parse DNSSEC TXT record into parts.
    ///         Format: "ENS1 <name-or-address> <context>".
    /// @param txt The DNSSEC TXT record.
    /// @return resolver The resolver address or null if wrong format or name didn't resolve.
    /// @return context The context data.
    function parseDNSSECRecord(bytes memory txt)
        public
        view
        returns (address resolver, bytes memory context)
    {
        uint256 p = TXT_PREFIX.length;
        uint256 n = txt.length;
        if (n > p && BytesUtils.equals(txt, 0, TXT_PREFIX, 0, p)) {
            uint256 sep = BytesUtils.find(txt, p, n - p, " ");
            if (sep < n) {
                context = BytesUtils.substring(txt, sep + 1, n - sep - 1);
            } else {
                sep = n;
            }
            resolver = _parseResolver(BytesUtils.substring(txt, p, sep - p));
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Looks up the resolver for `name` in the ENSv1 registry. Returns `address(0)` if
    ///      no resolver is set, or if the resolver is the v1 DNS TLD resolver or this contract
    ///      (indicating the name has not been explicitly configured in v1).
    /// @param name The DNS-encoded name to look up.
    /// @return resolver The v1 resolver address, or `address(0)` if none is applicable.
    function _getResolverV1(bytes memory name) internal view returns (address resolver) {
        (resolver, , ) = RegistryUtilsV1.findResolver(ENS_REGISTRY_V1, name, 0);
        if (resolver == DNS_TLD_RESOLVER_V1 || resolver == address(this)) {
            resolver = address(0);
        }
    }

    /// @dev Verifies a DNSSEC proof and scans the resulting resource records for the first
    ///      valid `ENS1`-prefixed TXT record. Returns the parsed resolver and context from
    ///      that record, or `address(0)` if no matching record is found.
    /// @param name The DNS-encoded name the records should belong to.
    /// @param oracleWitness The ABI-encoded `DNSSEC.RRSetWithSignature[]` proof from the gateway.
    /// @return resolver The resolver address parsed from the first valid `ENS1` TXT record.
    /// @return context The context bytes following the resolver in the TXT record.
    function _verifyDNSSEC(bytes memory name, bytes calldata oracleWitness)
        internal
        view
        returns (address resolver, bytes memory context)
    {
        DNSSEC.RRSetWithSignature[] memory rrsets =
            abi.decode(oracleWitness, (DNSSEC.RRSetWithSignature[]));
        (bytes memory data, ) = DNSSEC_ORACLE.verifyRRSet(rrsets);
        for (
            RRUtils.RRIterator memory iter = RRUtils.iterateRRs(data, 0);
            !RRUtils.done(iter);
            RRUtils.next(iter)
        ) {
            if (_isTXTForName(iter, name)) {
                (resolver, context) = parseDNSSECRecord(
                    _readTXT(iter.data, iter.rdataOffset, iter.nextOffset)
                );
                if (resolver != address(0)) {
                    break; // https://github.com/ensdomains/ens-contracts/blob/289913d7e3923228675add09498d66920216fe9b/contracts/dnsregistrar/OffchainDNSResolver.sol#L111
                }
            }
        }
    }

    /// @dev Parse the value into a resolver address.
    ///      If the value matches `/^0x[0-9a-fA-F]{40}$/`, it's a literal address.
    ///      Otherwise, it's considered a name and resolved in the registry.
    ///      Reverts `DNSEncodingFailed` if the name cannot be encoded.
    /// @param v The address or name.
    /// @return resolver The corresponding resolver address.
    function _parseResolver(bytes memory v) internal view returns (address resolver) {
        if (v.length == 42 && bytes2(v) == "0x") {
            (address addr, bool valid) = HexUtils.hexToAddress(v, 2, 42);
            if (valid) {
                return addr;
            }
        }
        bytes memory name = NameCoder.encode(string(v));
        (, address r, , ) = LibRegistry.findResolver(ROOT_REGISTRY, name, 0);
        if (r != address(0)) {
            // in ENSv1, this was immediate only, but now supports IExtendedResolver
            // does not support offchain
            try this.callResolver(
                r,
                name,
                abi.encodeCall(IAddrResolver.addr, (NameCoder.namehash(name, 0))),
                false,
                "",
                new string[](0)
            ) returns (bytes memory a) {
                if (a.length == 32) {
                    resolver = abi.decode(a, (address));
                }
            } catch {}
        }
    }

    /// @dev Returns `true` if `iter` points to a TXT record of class `IN` whose owner name
    ///      matches `name`.
    /// @param iter The current position in the resource-record iteration.
    /// @param name The DNS-encoded name to match against the record's owner name.
    /// @return `true` if the record is a matching Internet-class TXT record.
    function _isTXTForName(RRUtils.RRIterator memory iter, bytes memory name)
        internal
        pure
        returns (bool)
    {
        return
            iter.class == CLASS_INET &&
            iter.dnstype == QTYPE_TXT &&
            BytesUtils.equals(iter.data, iter.offset, name, 0, name.length);
    }

    /// @dev Decode `v[off:end]` as raw TXT chunks.
    ///      Encoding: `(byte(n) <n-bytes>)...`
    ///      Reverts `InvalidTXT` if the data is malformed.
    /// @param v The raw TXT data.
    /// @param off The offset of the record data.
    /// @param end The upper bound of the record data.
    /// @return txt The decoded TXT value.
    function _readTXT(bytes memory v, uint256 off, uint256 end)
        internal
        pure
        returns (bytes memory txt)
    {
        if (end > v.length)
            revert InvalidTXT();
        txt = new bytes(end - off);
        assembly {
            let ptr := add(v, 32)
            off := add(ptr, off) // start of input
            end := add(ptr, end) // end of input
            ptr := add(txt, 32) // start of output
            // prettier-ignore
            for { } lt(off, end) { } { // while input
                let size := byte(0, mload(off)) // length of chunk
                off := add(off, 1) // advance input
                if size { // length > 0
                    let next := add(off, size) // compute end of chunk
                    if gt(next, end) { // beyond end
                        end := 0 // error: overflow
                        break
                    }
                    mcopy(ptr, off, size) // copy chunk
                    off := next // advance input
                    ptr := add(ptr, size) // advance output
                }
            }
            mstore(txt, sub(ptr, add(txt, 32))) // truncate
        }
        if (off != end)
            revert InvalidTXT(); // overflow or junk at end
    }
}
