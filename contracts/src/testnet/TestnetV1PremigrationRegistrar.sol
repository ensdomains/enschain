// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {
    BaseRegistrarImplementation
} from "@ens/contracts/ethregistrar/BaseRegistrarImplementation.sol";
import {IETHRegistrarController} from "@ens/contracts/ethregistrar/IETHRegistrarController.sol";
import {ENS} from "@ens/contracts/registry/ENS.sol";
import {Resolver} from "@ens/contracts/resolvers/Resolver.sol";
import {
    IDefaultReverseRegistrar
} from "@ens/contracts/reverseRegistrar/IDefaultReverseRegistrar.sol";
import {IReverseRegistrar} from "@ens/contracts/reverseRegistrar/IReverseRegistrar.sol";
import {StringUtils} from "@ens/contracts/utils/StringUtils.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {LibLabel} from "../utils/LibLabel.sol";

/// @title TestnetV1PremigrationRegistrar
/// @notice Free testnet-only v1 registration controller that immediately reserves names in ENSv2.
contract TestnetV1PremigrationRegistrar {
    using StringUtils for *;

    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The bitmask for setting the Ethereum reverse record.
    uint8 public constant REVERSE_RECORD_ETHEREUM_BIT = 1;

    /// @notice The bitmask for setting the default reverse record.
    uint8 public constant REVERSE_RECORD_DEFAULT_BIT = 2;

    /// @notice The minimum registration duration accepted by the v1 controller.
    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;

    /// @notice Bonus added to the v2 reservation expiry so testnet reservations match
    ///         the migration's continuity-adjusted expiry (v1 grace minus v2 grace) and
    ///         pass the premigration verifier's expected-expiry check, which expects
    ///         `v1Expiry + bonusPeriodDays` (default 62 days, i.e. 90 days - 28 days).
    uint256 public constant CONTINUITY_BONUS_PERIOD = 90 days - 28 days;

    /// @notice The ENS namehash for `eth`.
    bytes32 public constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;

    /// @notice The ENSv1 base registrar used to mint the `.eth` registration.
    BaseRegistrarImplementation public immutable BASE;

    /// @notice The ENSv1 registry used when setting resolver records.
    ENS public immutable ENS_REGISTRY;

    /// @notice The ENSv1 Ethereum reverse registrar.
    IReverseRegistrar public immutable REVERSE_REGISTRAR;

    /// @notice The ENSv1 default reverse registrar.
    IDefaultReverseRegistrar public immutable DEFAULT_REVERSE_REGISTRAR;

    /// @notice The ENSv2 `.eth` registry where names are reserved for premigration.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    /// @notice The ENSv2 subregistry assigned to premigrated reservations.
    IRegistry public immutable PREMIGRATION_REGISTRY;

    /// @notice The ENSv2 resolver assigned to premigrated reservations.
    address public immutable PREMIGRATION_RESOLVER;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice Emitted when a name is registered.
    /// @param label The label of the name.
    /// @param labelhash The keccak256 hash of the label.
    /// @param owner The owner of the name.
    /// @param baseCost The base cost of the name.
    /// @param premium The premium cost of the name.
    /// @param expires The expiry time of the name.
    /// @param referrer The referrer of the registration.
    event NameRegistered(
        string label,
        bytes32 indexed labelhash,
        address indexed owner,
        uint256 baseCost,
        uint256 premium,
        uint256 expires,
        bytes32 referrer
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Name is not available for v1 registration.
    /// @dev Error selector: `0x477707e8`
    /// @param name The unavailable label.
    error NameNotAvailable(string name);

    /// @notice Registration duration is below the accepted minimum.
    /// @dev Error selector: `0x9a71997b`
    /// @param duration The supplied duration.
    error DurationTooShort(uint256 duration);

    /// @notice Resolver calldata was supplied without a resolver.
    /// @dev Error selector: `0xd3f605c4`
    error ResolverRequiredWhenDataSupplied();

    /// @notice A reverse record was requested without a resolver.
    /// @dev Error selector: `0x7d4a034a`
    error ResolverRequiredForReverseRecord();

    /// @notice The v1 expiry cannot fit in the ENSv2 registry expiry field.
    /// @dev Error selector: `0x544476c3`
    /// @param expiry The v1 expiry timestamp.
    error ExpiryTooLarge(uint256 expiry);

    /// @notice Refund of accidentally supplied ETH failed.
    /// @dev Error selector: `0xaf73b0b2`
    /// @param recipient The refund recipient.
    /// @param amount The amount that failed to refund.
    error RefundFailed(address recipient, uint256 amount);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Initializes the testnet registration controller.
    /// @param base_ The ENSv1 base registrar.
    /// @param ensRegistry_ The ENSv1 registry.
    /// @param reverseRegistrar_ The ENSv1 Ethereum reverse registrar.
    /// @param defaultReverseRegistrar_ The ENSv1 default reverse registrar.
    /// @param ethRegistry_ The ENSv2 `.eth` registry.
    /// @param premigrationRegistry_ The ENSv2 subregistry to assign to reservations.
    /// @param premigrationResolver_ The ENSv2 resolver to assign to reservations.
    constructor(
        BaseRegistrarImplementation base_,
        ENS ensRegistry_,
        IReverseRegistrar reverseRegistrar_,
        IDefaultReverseRegistrar defaultReverseRegistrar_,
        IPermissionedRegistry ethRegistry_,
        IRegistry premigrationRegistry_,
        address premigrationResolver_
    )
    {
        BASE = base_;
        ENS_REGISTRY = ensRegistry_;
        REVERSE_REGISTRAR = reverseRegistrar_;
        DEFAULT_REVERSE_REGISTRAR = defaultReverseRegistrar_;
        ETH_REGISTRY = ethRegistry_;
        PREMIGRATION_REGISTRY = premigrationRegistry_;
        PREMIGRATION_RESOLVER = premigrationResolver_;
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Registers a `.eth` label in ENSv1 for free and reserves it in ENSv2.
    /// @param registration The v1 controller registration parameters.
    function register(IETHRegistrarController.Registration calldata registration) external payable {
        bytes32 labelhash = keccak256(bytes(registration.label));

        if (registration.duration < MIN_REGISTRATION_DURATION) {
            revert DurationTooShort(registration.duration);
        }
        if (!_available(registration.label, labelhash)) {
            revert NameNotAvailable(registration.label);
        }
        if (registration.data.length > 0 && registration.resolver == address(0)) {
            revert ResolverRequiredWhenDataSupplied();
        }
        if (registration.reverseRecord != 0 && registration.resolver == address(0)) {
            revert ResolverRequiredForReverseRecord();
        }

        uint256 expires = _registerV1(registration, labelhash);
        _premigrate(registration.label, expires);

        emit NameRegistered(
            registration.label,
            labelhash,
            registration.owner,
            0,
            0,
            expires,
            registration.referrer
        );

        _refund();
    }

    /// @notice Returns true if the label is valid and available for v1 registration.
    /// @param label The label to check.
    /// @return True if the label is valid and available, false otherwise.
    function available(string calldata label) public view returns (bool) {
        return _available(label, keccak256(bytes(label)));
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Registers the name in ENSv1 and applies optional resolver and reverse records.
    function _registerV1(
        IETHRegistrarController.Registration calldata registration,
        bytes32 labelhash
    )
        internal
        returns (uint256 expires)
    {
        uint256 tokenId = uint256(labelhash);
        if (registration.resolver == address(0)) {
            return BASE.register(tokenId, registration.owner, registration.duration);
        }

        expires = BASE.register(tokenId, address(this), registration.duration);
        bytes32 namehash = keccak256(abi.encodePacked(ETH_NODE, labelhash));

        // Apply resolver records while this registrar still owns the node, then hand
        // ownership to the registrant. A resolver that authorises writes by node owner
        // would otherwise reject these calls once ownership has moved.
        ENS_REGISTRY.setResolver(namehash, registration.resolver);
        if (registration.data.length > 0) {
            Resolver(registration.resolver).multicallWithNodeCheck(namehash, registration.data);
        }
        ENS_REGISTRY.setOwner(namehash, registration.owner);

        BASE.transferFrom(address(this), registration.owner, tokenId);

        // Reverse records are set for the registrant rather than the caller.
        string memory name = string.concat(registration.label, ".eth");
        if (registration.reverseRecord & REVERSE_RECORD_ETHEREUM_BIT != 0) {
            REVERSE_REGISTRAR.setNameForAddr(
                registration.owner,
                registration.owner,
                registration.resolver,
                name
            );
        }
        if (registration.reverseRecord & REVERSE_RECORD_DEFAULT_BIT != 0) {
            DEFAULT_REVERSE_REGISTRAR.setNameForAddr(registration.owner, name);
        }
    }

    /// @dev Reserves or extends the matching ENSv2 reservation. Every reservation
    ///      carries the continuity bonus on top of the v1 expiry, matching the migration's
    ///      expected expiry for premigrated names.
    function _premigrate(string calldata label, uint256 v1Expiry) internal {
        uint256 reservationExpiry = v1Expiry + CONTINUITY_BONUS_PERIOD;
        if (reservationExpiry > type(uint64).max) {
            revert ExpiryTooLarge(reservationExpiry);
        }

        IPermissionedRegistry.State memory state = ETH_REGISTRY.getState(LibLabel.id(label));
        uint64 expiry = uint64(reservationExpiry);

        if (state.status == IPermissionedRegistry.Status.AVAILABLE) {
            ETH_REGISTRY.register(
                label,
                address(0),
                PREMIGRATION_REGISTRY,
                PREMIGRATION_RESOLVER,
                0,
                expiry
            );
        } else if (state.status == IPermissionedRegistry.Status.RESERVED && expiry > state.expiry) {
            ETH_REGISTRY.renew(state.tokenId, expiry);
        }
    }

    /// @dev Refunds ETH because this testnet controller is free.
    function _refund() internal {
        if (msg.value == 0)
            return;

        (bool ok, ) = payable(msg.sender).call{value: msg.value}("");
        if (!ok) {
            revert RefundFailed(msg.sender, msg.value);
        }
    }

    /// @dev Returns true when the label is valid and available in ENSv1.
    function _available(string calldata label, bytes32 labelhash) internal view returns (bool) {
        return label.strlen() >= 3 && BASE.available(uint256(labelhash));
    }
}
