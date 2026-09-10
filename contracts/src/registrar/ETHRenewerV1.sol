// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {
    BaseRegistrarImplementation
} from "@ens/contracts/ethregistrar/BaseRegistrarImplementation.sol";
import {INameWrapper} from "@ens/contracts/wrapper/INameWrapper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {LibLabel} from "../utils/LibLabel.sol";

import {AbstractETHRegistrar} from "./AbstractETHRegistrar.sol";
import {IETHRenewer, RenewData} from "./interfaces/IETHRenewer.sol";
import {IRentPriceOracle} from "./interfaces/IRentPriceOracle.sol";

// https://github.com/ensdomains/ens-contracts/blob/staging/deployments/mainnet/WrappedETHRegistrarController.json
/// @notice `ETHRegistrarController.renew()` stub interface.
/// @dev Interface selector: `0xacf1a841`
interface IWrappedETHRegistrarController {
    /// @notice Renew an ENSv1 name.
    /// @param label The name to renew.
    /// @param duration The expiry extension, in seconds.
    function renew(string calldata label, uint256 duration) external payable;
}


/// @notice .eth registrar that only renews premigrated ENSv2 reservations
/// and syncs with ENSv1.
///
/// Pricing and payment are delegated to a swappable `IRentPriceOracle`.
///
/// Provides a mechanism for syncing `NameWrapper` expiry.
///
contract ETHRenewerV1 is AbstractETHRegistrar {
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @inheritdoc IETHRenewer
    uint64 public immutable GRACE_PERIOD;

    /// @dev ENSv2 `GRACE_PERIOD`.
    uint64 internal immutable _GRACE_PERIOD_V2;

    /// @notice The ENSv1 `NameWrapper` contract.
    INameWrapper public immutable NAME_WRAPPER;

    /// @notice ENSv1 `BaseRegistrarImplementation` contract.
    BaseRegistrarImplementation public immutable BASE_REGISTRAR;

    /// @notice ENSv1 `ETHRegistrarController` that is an active `NameWrapper` controller.
    IWrappedETHRegistrarController public immutable WRAPPED_CONTROLLER;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param owner_ Contract owner.
    /// @param ethRegistry ENSv2 .eth `PermissionedRegistry`.
    /// @param beneficiary Address that receives payments.
    /// @param oracle Initial oracle for registration and renewal costs.
    /// @param gracePeriod Post-expiry period where renewable and not available, in seconds.
    /// @param bonusPeriod Duration added by premigration, in seconds.
    /// @param nameWrapper ENSv1 `NameWrapper` contract.
    /// @param wrappedController ENSv1 `ETHRegistrarController` that is a `NameWrapper` controller.
    constructor(
        address owner_,
        IPermissionedRegistry ethRegistry,
        address beneficiary,
        IRentPriceOracle oracle,
        uint64 gracePeriod,
        uint64 bonusPeriod,
        INameWrapper nameWrapper,
        address wrappedController
    )
        AbstractETHRegistrar(owner_, ethRegistry, beneficiary, oracle)
    {
        GRACE_PERIOD = bonusPeriod + gracePeriod;
        _GRACE_PERIOD_V2 = gracePeriod;
        NAME_WRAPPER = nameWrapper;
        BASE_REGISTRAR = BaseRegistrarImplementation(address(nameWrapper.registrar()));
        WRAPPED_CONTROLLER = IWrappedETHRegistrarController(wrappedController);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Transfers ownership of the registrar.
    /// @dev Same as `RegistrarSecurityController`.
    /// @param newOwner The new owner for the registrar.
    function transferRegistrarOwnership(address newOwner) external onlyOwner {
        BASE_REGISTRAR.transferOwnership(newOwner);
    }

    /// @notice Sets the registrar's resolver for the base node.
    /// @dev Same as `RegistrarSecurityController`.
    /// @param resolver The resolver address to set.
    function setRegistrarResolver(address resolver) external onlyOwner {
        BASE_REGISTRAR.setResolver(resolver);
    }

    /// @inheritdoc IETHRenewer
    function getRemainingGracePeriod(string calldata label) external view returns (uint64) {
        IPermissionedRegistry.State memory state = ETH_REGISTRY.getState(LibLabel.id(label));
        uint64 bonusPeriod = GRACE_PERIOD - _GRACE_PERIOD_V2;
        if (state.latestOwner == address(0) && state.expiry > bonusPeriod) {
            uint64 expiryV1 = state.expiry - bonusPeriod;
            uint64 t = uint64(block.timestamp);
            if (t >= expiryV1 && t < expiryV1 + GRACE_PERIOD) {
                return GRACE_PERIOD - (t - expiryV1);
            }
        }
        return 0;
    }

    /// @inheritdoc IETHRenewer
    function renew(RenewData calldata rd, IERC20 paymentToken) public override {
        super.renew(rd, paymentToken);
        string[] memory labels = new string[](1);
        labels[0] = rd.label;
        syncWrapper(labels);
    }

    /// @inheritdoc IETHRenewer
    function renewBatch(RenewData[] calldata rds, IERC20 paymentToken) public override {
        super.renewBatch(rds, paymentToken);
        if (rds.length > 0) {
            string[] memory labels = new string[](rds.length);
            for (uint256 i; i < rds.length; ++i) {
                labels[i] = rds[i].label;
            }
            syncWrapper(labels);
        }
    }

    /// @notice Sync `NameWrapper` expiry with `BaseRegistrarImplementation` expiry.
    /// @param labels The labels to sync.
    function syncWrapper(string[] memory labels) public {
        BASE_REGISTRAR.addController(address(NAME_WRAPPER));
        for (uint256 i; i < labels.length; ++i) {
            WRAPPED_CONTROLLER.renew(labels[i], 0);
        }
        BASE_REGISTRAR.removeController(address(NAME_WRAPPER));
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Update ENSv1 during renew.
    function _onRenew(string calldata label, uint64 duration) internal override {
        BASE_REGISTRAR.renew(LibLabel.id(label), duration);
    }

    /// @dev Determine if `RESERVED` or in grace was `RESERVED`.
    function _isRenewable(IPermissionedRegistry.State memory state)
        internal
        view
        override
        returns (bool)
    {
        return
            state.status == IPermissionedRegistry.Status.RESERVED ||
            (state.status == IPermissionedRegistry.Status.AVAILABLE &&
                state.latestOwner == address(0) &&
                (block.timestamp - state.expiry) < _GRACE_PERIOD_V2);
    }
}
