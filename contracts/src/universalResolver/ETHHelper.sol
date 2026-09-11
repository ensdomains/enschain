// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {
    BaseRegistrarImplementation
} from "@ens/contracts/ethregistrar/BaseRegistrarImplementation.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {INameWrapper} from "@ens/contracts/wrapper/INameWrapper.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";
import {LibLabel} from "../utils/LibLabel.sol";

/// @notice Helper contract for determining .eth state.
contract ETHHelper is DelegatedContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    enum Status {
        AVAILABLE,
        WRAPPED,
        UNWRAPPED,
        REGISTERED,
        GRACE_V1,
        GRACE_V2
    }

    struct State {
        Status status;
        uint256 tokenId;
        address owner;
        uint64 expiry;
        address resolver;
        address manager; // v1 only
        IRegistry subregistry; // v2 only
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv1 registry used to look up resolvers for names.
    ENS public immutable REGISTRY_V1;

    /// @notice The ENSv1 `NameWrapper` contract.
    INameWrapper public immutable NAME_WRAPPER;

    /// @notice ENSv1 `BaseRegistrarImplementation` contract.
    BaseRegistrarImplementation public immutable BASE_REGISTRAR;

    /// @notice Post-expiry period where still renewable in ENSv1 and not available, in seconds.
    uint64 public immutable GRACE_PERIOD_V1;

    /// @notice The ENSv2 root registry.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    /// @notice The ENSv2 "eth" registry.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    /// @notice Post-expiry period where still renewable in ENSv2 and not available, in seconds.
    uint64 public immutable GRACE_PERIOD_V2;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param nameWrapper ENSv1 `NameWrapper` contract.
    /// @param rootRegistry ENSv2 root registry.
    /// @param contractNamer Delegated contract namer.
    /// @param gracePeriodV2 ENSv2 `GRACE_PERIOD`.
    constructor(
        INameWrapper nameWrapper,
        IPermissionedRegistry rootRegistry,
        IContractNamer contractNamer,
        uint64 gracePeriodV2
    )
        DelegatedContractNamer(contractNamer)
    {
        NAME_WRAPPER = nameWrapper;
        REGISTRY_V1 = nameWrapper.ens();
        BASE_REGISTRAR = BaseRegistrarImplementation(address(nameWrapper.registrar()));
        GRACE_PERIOD_V1 = uint64(BASE_REGISTRAR.GRACE_PERIOD());

        ROOT_REGISTRY = rootRegistry;
        ETH_REGISTRY = IPermissionedRegistry(address(rootRegistry.getSubregistry("eth")));
        GRACE_PERIOD_V2 = gracePeriodV2;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Get .eth state of a label for ENSv1 or ENSv2.
    /// @param label The label to query.
    /// @return ethState The .eth state.
    /// @return blockNumber The block number.
    /// @return timestamp The current time, in seconds.
    function getState(string calldata label)
        external
        view
        returns (State memory ethState, uint256 blockNumber, uint64 timestamp)
    {
        uint256 labelId = LibLabel.id(label);
        IPermissionedRegistry.State memory state = ETH_REGISTRY.getState(labelId);
        if (state.status == IPermissionedRegistry.Status.RESERVED) {
            ethState.expiry = uint64(BASE_REGISTRAR.nameExpires(labelId));
            bytes32 node = NameCoder.namehash(NameCoder.ETH_NODE, bytes32(labelId));
            if (NAME_WRAPPER.isWrapped(NameCoder.ETH_NODE, bytes32(labelId))) {
                ethState.tokenId = uint256(node);
                ethState.owner = NAME_WRAPPER.ownerOf(uint256(node));
                ethState.status = Status.WRAPPED;
            } else {
                ethState.tokenId = labelId;
                if (ethState.expiry > block.timestamp) {
                    ethState.owner = BASE_REGISTRAR.ownerOf(labelId);
                    ethState.status = Status.UNWRAPPED;
                } else {
                    ethState.status = Status.GRACE_V1;
                    ethState.expiry = state.expiry;
                }
            }
            ethState.resolver = REGISTRY_V1.resolver(node);
            ethState.manager = REGISTRY_V1.owner(node);
        } else {
            ethState.tokenId = state.tokenId;
            ethState.expiry = state.expiry;
            if (state.status == IPermissionedRegistry.Status.REGISTERED) {
                ethState.status = Status.REGISTERED;
                ethState.owner = state.latestOwner;
                ethState.resolver = ETH_REGISTRY.getResolver(label);
                ethState.subregistry = ETH_REGISTRY.getSubregistry(label);
            } else if (state.expiry + GRACE_PERIOD_V2 > block.timestamp) {
                if (state.latestOwner == address(0)) {
                    ethState.status = Status.GRACE_V1;
                } else {
                    ethState.status = Status.GRACE_V2;
                }
            }
        }
        blockNumber = block.number;
        timestamp = uint64(block.timestamp);
    }
}
