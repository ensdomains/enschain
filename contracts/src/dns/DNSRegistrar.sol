// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IGatewayProvider} from "@ens/contracts/ccipRead/IGatewayProvider.sol";
import {PublicSuffixList} from "@ens/contracts/dnsregistrar/PublicSuffixList.sol";
import {DNSSEC} from "@ens/contracts/dnssec-oracle/DNSSEC.sol";
import {RRUtils} from "@ens/contracts/dnssec-oracle/RRUtils.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {HexUtils} from "@ens/contracts/utils/HexUtils.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {
    IEACGrantInitializable,
    Grant
} from "../access-control/interfaces/IEACGrantInitializable.sol";
import {EACBaseRolesLib} from "../access-control/libraries/EACBaseRolesLib.sol";
import {InvalidOwner} from "../CommonErrors.sol";
import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";
import {LibLabel} from "../utils/LibLabel.sol";

import {IDNSRegistrar} from "./interfaces/IDNSRegistrar.sol";
import {LibDNSSEC} from "./libraries/LibDNSSEC.sol";

contract DNSRegistrar is DelegatedContractNamer, IDNSRegistrar {
    ////////////////////////////////////////////////////////////////////////
    // Errors
    /// /////////////////////////////////////////////////////////////////////
    /// @dev Error selector: `0xb0ef9c4c`

    error UnsupportedName(bytes name);

    /// @dev Error selector: `0x2dd6a7af`
    error StaleProof();

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice ENSv1 global registry.
    ENS public immutable ENS_REGISTRY_V1;

    /// @notice ENSv2 root registry.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    /// @notice The DNSSEC oracle contract that verifies signed DNS resource-record sets.
    DNSSEC public immutable DNSSEC_ORACLE;

    /// @notice Gateway provider for the DNSSEC oracle CCIP-Read queries.
    IGatewayProvider public immutable ORACLE_GATEWAY_PROVIDER;

    /// @notice The shared factory for verifiable deployments.
    IVerifiableFactory public immutable VERIFIABLE_FACTORY;

    PublicSuffixList public immutable SUFFIXES;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    // Mapping of the most recent signatures seen for each claimed domain.
    mapping(bytes name => uint32 inception) public inceptions;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param ensRegistryV1 ENSv1 global registry.
    /// @param fallbackResolver ENSv2 fallback resolver.
    /// @param rootRegistry ENSv2 root registry.
    /// @param dnssecOracle DNSSEC oracle contract.
    /// @param oracleGatewayProvider The gateway provider for the DNSSEC oracle CCIP-Read queries.
    /// @param verifiableFactory The shared factory for verifiable deployments.
    /// @param contractNamer Delegated contract namer.
    constructor(
        ENS ensRegistryV1,
        address fallbackResolver,
        IPermissionedRegistry rootRegistry,
        DNSSEC dnssecOracle,
        IGatewayProvider oracleGatewayProvider,
        IVerifiableFactory verifiableFactory,
        IContractNamer contractNamer
    )
        DelegatedContractNamer(contractNamer)
    {
        ENS_REGISTRY_V1 = ensRegistryV1;
        ROOT_REGISTRY = rootRegistry;
        DNSSEC_ORACLE = dnssecOracle;
        ORACLE_GATEWAY_PROVIDER = oracleGatewayProvider;
        VERIFIABLE_FACTORY = verifiableFactory;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IDNSRegistrar
    function claim(
        bytes calldata name,
        IRegistry subregistry,
        address resolver,
        DNSSEC.RRSetWithSignature[] calldata rrs
    )
        external
        returns (IPermissionedRegistry parentRegistry, uint256 tokenId)
    {
        if (!isClaimable(name)) {
            revert UnsupportedName(name);
        }
        (bytes memory data, uint32 inception) = DNSSEC_ORACLE.verifyRRSet(rrs);
        address owner = _parseOwner(name, data);
        if (owner == address(0)) {
            revert InvalidOwner();
        }
        if (!RRUtils.serialNumberGte(inception, inceptions[name])) {
            revert StaleProof();
        }
        inceptions[name] = inception;

        (string memory label, uint256 offset) = NameCoder.extractLabel(name, 0);
        (parentRegistry, ) = _claim(name, offset);
        if (parentRegistry.findOwner(label) != address(0)) {
            parentRegistry.unregister(LibLabel.id(label));
        }
        tokenId = parentRegistry.register(
            label,
            owner,
            subregistry,
            resolver,
            EACBaseRolesLib.ALL_ROLES,
            type(uint64).max
        );
    }

    function isClaimable(bytes calldata name) public view returns (bool) {
        return _findSuffix(name, 0) < name.length;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    function _claim(bytes calldata name, uint256 offset)
        internal
        returns (IPermissionedRegistry parentRegistry, bytes32 node)
    {
        (string memory label, uint256 next) = NameCoder.extractLabel(name, offset);
        if (bytes(label).length == 0) {
            return (ROOT_REGISTRY, bytes32(0));
        }
        (parentRegistry, node) = _claim(name, next);
        node = NameCoder.namehash(node, keccak256(bytes(label)));
        IRegistry child = parentRegistry.getSubregistry(label);
        if (address(child) == address(0)) {
            uint256 salt = uint256(keccak256(abi.encode("TemporaryRegistry", node)));
            Grant[] memory grants = new Grant[](1);
            grants[0] = Grant(address(this), EACBaseRolesLib.ALL_ROLES);
            address proxy =
                VERIFIABLE_FACTORY.deployProxy(
                    address(0),
                    salt,
                    abi.encodeCall(IEACGrantInitializable.initialize, (grants))
                );
            IPermissionedRegistry(proxy).setParent(parentRegistry, label);
            child = IRegistry(proxy);
        } else {
            VERIFIABLE_FACTORY.verifyContract(address(child)); // do we need this?
            // do we check if its a member of a impl set?
            // require(IPermissionedRegistry(address(child)).hasRootRoles(EACBaseRolesLib.ALL_ROLES, address(this)));
        }
        parentRegistry.register(label, address(0), child, address(0), 0, type(uint64).max);
        parentRegistry = IPermissionedRegistry(address(child));
    }

    function _findSuffix(bytes calldata name, uint256 offset) internal view returns (uint256) {
        if (SUFFIXES.isPublicSuffix(name[offset:])) {
            return offset;
        }
        (uint8 size, uint256 next) = NameCoder.nextLabel(name, offset);
        return size == 0 ? name.length : _findSuffix(name, next);
    }

    function _parseOwner(bytes memory name, bytes memory data)
        internal
        pure
        returns (address owner)
    {
        bytes memory txtName = NameCoder.addLabel(name, "_ens");
        for (
            RRUtils.RRIterator memory iter = RRUtils.iterateRRs(data, 0);
            !RRUtils.done(iter);
            RRUtils.next(iter)
        ) {
            if (LibDNSSEC.isTXTForName(iter, txtName)) {
                bytes memory txt = LibDNSSEC.decodeTXT(iter.data, iter.rdataOffset, iter.nextOffset);
                if (txt.length == 44 && bytes4(txt) == "a=0x") {
                    (address addr, bool ok) = HexUtils.hexToAddress(txt, 4, 44);
                    if (ok) {
                        return addr;
                    }
                }
            }
        }
    }
}
