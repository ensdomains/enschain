// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {InvalidOwner} from "../CommonErrors.sol";
import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "../registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "../registry/libraries/RegistryRolesLib.sol";
import {LibLabel} from "../utils/LibLabel.sol";

import {AbstractETHRegistrar} from "./AbstractETHRegistrar.sol";
import {IETHRegistrar} from "./interfaces/IETHRegistrar.sol";
import {IETHRenewer} from "./interfaces/IETHRenewer.sol";
import {IRentPriceOracle} from "./interfaces/IRentPriceOracle.sol";

/// @dev Roles assigned to owners at registration. Includes set-subregistry, set-resolver, and can-transfer (with admin variants).
uint256 constant REGISTRATION_ROLE_BITMAP =
    RegistryRolesLib.ROLE_SET_SUBREGISTRY |
    RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
    RegistryRolesLib.ROLE_SET_RESOLVER |
    RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
    RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;

/// @notice Commit-reveal registrar for .eth names. Registration requires two transactions: first
/// `commit(hash)` to record a commitment, then `register(...)` after the minimum commitment
/// age but before the maximum commitment age has elapsed. The commitment hash binds all
/// registration parameters (label, owner, secret, subregistry, resolver, duration, referrer)
/// to prevent front-running.
///
/// Delegates actual name storage to an `IPermissionedRegistry`, granting the owner a fixed
/// set of roles (set subregistry, set resolver, and transfer — each with their admin
/// counterpart).
///
/// Pricing and payment are delegated to a swappable `IRentPriceOracle`.
///
contract ETHRegistrar is AbstractETHRegistrar, IETHRegistrar {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IETHRenewer
    uint64 public immutable GRACE_PERIOD;

    /// @notice Minimum seconds a commitment must age before registration can proceed.
    /// @dev If zero, front-running protection is disabled.
    uint64 public immutable MIN_COMMITMENT_AGE;

    /// @notice Maximum seconds a commitment remains valid; expired commitments are rejected.
    uint64 public immutable MAX_COMMITMENT_AGE;

    /// @notice Minimum register duration, in seconds.
    uint64 public immutable MIN_REGISTER_DURATION;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IETHRegistrar
    mapping(bytes32 commitment => uint64 commitTime) public commitmentAt;

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice `maxCommitmentAge` was not greater than `minCommitmentAge`.
    /// @dev Error selector: `0x3e5aa838`
    error MaxCommitmentAgeTooLow();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param owner_ Contract owner.
    /// @param ethRegistry ENSv2 .eth `PermissionedRegistry`.
    /// @param beneficiary Address that receives payments.
    /// @param oracle Initial oracle for registration and renewal costs.
    /// @param gracePeriod Post-expiry period where still renewable and not available, in seconds.
    /// @param minCommitmentAge Minimum seconds a commitment must age before registration can proceed.
    /// @param maxCommitmentAge Maximum seconds a commitment remains valid; expired commitments are rejected.
    /// @param minRegisterDuration Minimum register duration, in seconds.
    constructor(
        address owner_,
        IPermissionedRegistry ethRegistry,
        address beneficiary,
        IRentPriceOracle oracle,
        uint64 gracePeriod,
        uint64 minCommitmentAge,
        uint64 maxCommitmentAge,
        uint64 minRegisterDuration
    )
        AbstractETHRegistrar(owner_, ethRegistry, beneficiary, oracle)
    {
        if (maxCommitmentAge <= minCommitmentAge) {
            revert MaxCommitmentAgeTooLow();
        }
        GRACE_PERIOD = gracePeriod;
        MIN_COMMITMENT_AGE = minCommitmentAge;
        MAX_COMMITMENT_AGE = maxCommitmentAge;
        MIN_REGISTER_DURATION = minRegisterDuration;
    }

    /// @inheritdoc AbstractETHRegistrar
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return
            interfaceId == type(IETHRegistrar).interfaceId || super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IETHRegistrar
    function commit(bytes32 commitment) external {
        if (commitmentAt[commitment] + MAX_COMMITMENT_AGE > block.timestamp) {
            revert UnexpiredCommitmentExists(commitment);
        }
        commitmentAt[commitment] = uint64(block.timestamp);
        emit CommitmentMade(commitment);
    }

    /// @inheritdoc IETHRegistrar
    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        IRegistry subregistry,
        address resolver,
        uint64 duration,
        IERC20 paymentToken,
        bytes32 referrer
    )
        external
        returns (uint256 tokenId)
    {
        if (owner == address(0)) {
            revert InvalidOwner();
        }
        _consumeCommitment(
            makeCommitment(label, owner, secret, subregistry, resolver, duration, referrer)
        ); // reverts if no commitment
        IPermissionedRegistry.State memory state = _requireAvailable(label, duration); // reverts if not
        (uint256 base, uint256 premium) =
            rentPriceOracle.getRegisterPrice(
                label,
                _availablePeriod(state.expiry),
                duration,
                paymentToken
            ); // reverts if invalid
        SafeERC20.safeTransferFrom(paymentToken, msg.sender, BENEFICIARY, base + premium); // reverts if payment failed
        tokenId = ETH_REGISTRY.register(
            label,
            owner,
            subregistry,
            resolver,
            REGISTRATION_ROLE_BITMAP,
            uint64(block.timestamp) + duration // new expiry
        ); // should not revert
        emit NameRegistered(
            tokenId,
            label,
            owner,
            subregistry,
            resolver,
            duration,
            paymentToken,
            referrer,
            base,
            premium
        );
    }

    /// @inheritdoc IETHRegistrar
    function isAvailable(string calldata label) external view returns (bool) {
        return _isAvailable(ETH_REGISTRY.getState(LibLabel.id(label)));
    }

    /// @inheritdoc IETHRegistrar
    function getRegisterPrice(string calldata label, uint64 duration, IERC20 paymentToken)
        external
        view
        returns (uint256 base, uint256 premium)
    {
        return
            rentPriceOracle.getRegisterPrice(
                label,
                _availablePeriod(_requireAvailable(label, duration).expiry),
                duration,
                paymentToken
            );
    }

    /// @inheritdoc IETHRenewer
    function getRemainingGracePeriod(string calldata label) external view returns (uint64) {
        IPermissionedRegistry.State memory state = ETH_REGISTRY.getState(LibLabel.id(label));
        return
            uint64(
                _isRenewableGrace(state)
                    ? GRACE_PERIOD - (block.timestamp - state.expiry)
                    : 0
            );
    }

    /// @inheritdoc IETHRegistrar
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        IRegistry subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    )
        public
        pure
        override
        returns (bytes32)
    {
        return
            keccak256(abi.encode(label, owner, secret, subregistry, resolver, duration, referrer));
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Validates that the given `commitment` was recorded within the allowed time window
    ///      (between minimum and maximum commitment age), then deletes it so it cannot be reused.
    /// @param commitment The commitment hash to validate and consume.
    function _consumeCommitment(bytes32 commitment) internal {
        uint64 t = uint64(block.timestamp);
        uint64 t0 = commitmentAt[commitment];
        uint64 tMin = t0 + MIN_COMMITMENT_AGE;
        if (t < tMin) {
            revert CommitmentTooNew(commitment, tMin, t);
        }
        uint64 tMax = t0 + MAX_COMMITMENT_AGE;
        if (t >= tMax) {
            revert CommitmentTooOld(commitment, tMax, t);
        }
        delete commitmentAt[commitment];
    }

    /// @dev Ensure name is registerable.
    function _requireAvailable(string calldata label, uint64 duration)
        internal
        view
        returns (IPermissionedRegistry.State memory state)
    {
        state = ETH_REGISTRY.getState(LibLabel.id(label));
        if (!_isAvailable(state)) {
            revert NameNotAvailable(label);
        }
        if (duration < MIN_REGISTER_DURATION) {
            revert DurationTooShort(duration, MIN_REGISTER_DURATION);
        }
    }

    /// @dev Determine if `AVAILABLE` and not in grace.
    function _isAvailable(IPermissionedRegistry.State memory state) internal view returns (bool) {
        return _checkGrace(state, false);
    }

    /// @dev Determine if `REGISTERED` or in grace was `REGISTERED`.
    function _isRenewable(IPermissionedRegistry.State memory state)
        internal
        view
        override
        returns (bool)
    {
        return state.status == IPermissionedRegistry.Status.REGISTERED || _isRenewableGrace(state);
    }

    /// @dev Determine if was `REGISTERED` and in grace.
    function _isRenewableGrace(IPermissionedRegistry.State memory state)
        internal
        view
        returns (bool)
    {
        return state.latestOwner != address(0) && _checkGrace(state, true);
    }

    /// @dev Check if `AVAILABLE` and conditionally in grace.
    function _checkGrace(IPermissionedRegistry.State memory state, bool grace)
        internal
        view
        returns (bool)
    {
        return
            state.status == IPermissionedRegistry.Status.AVAILABLE &&
            (grace == (block.timestamp - state.expiry) < GRACE_PERIOD);
    }

    /// @dev Determine duration name has been available.
    function _availablePeriod(uint64 expiry) internal view returns (uint64) {
        uint64 t = uint64(block.timestamp);
        if (expiry == 0) {
            return t; // never registered
        }
        expiry += GRACE_PERIOD;
        return t > expiry ? t - expiry : 0;
    }
}
