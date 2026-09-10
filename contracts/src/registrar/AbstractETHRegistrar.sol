// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {LibLabel} from "../utils/LibLabel.sol";

import {IETHRenewer, RenewData} from "./interfaces/IETHRenewer.sol";
import {IRentPriceOracle} from "./interfaces/IRentPriceOracle.sol";
import {IRentPriceOracleProvider} from "./interfaces/IRentPriceOracleProvider.sol";

/// @dev Abstract registrar implementation shared between `ETHRegistrar` and `ETHRenewerV1`.
abstract contract AbstractETHRegistrar is Ownable, ERC165, IETHRenewer, IRentPriceOracleProvider {
    ////////////////////////////////////////////////////////////////////////
    // Constants & Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice Minimum renew duration, in seconds.
    uint64 public constant MIN_RENEW_DURATION = 1;

    /// @notice ENSv2 .eth `PermissionedRegistry`.
    IPermissionedRegistry public immutable ETH_REGISTRY;

    /// @notice Address that receives payments.
    address public immutable BENEFICIARY;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @notice Oracle for registration and renewal costs.
    IRentPriceOracle public override rentPriceOracle;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice `IRentPriceOracle` was replaced.
    /// @param oracle The new `IRentPriceOracle` contract.
    event RentPriceOracleUpdated(IRentPriceOracle oracle);

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param owner_ Contract owner.
    /// @param ethRegistry ENSv2 .eth `PermissionedRegistry`.
    /// @param beneficiary Address that receives payments.
    /// @param oracle Initial oracle for registration and renewal costs.
    constructor(
        address owner_,
        IPermissionedRegistry ethRegistry,
        address beneficiary,
        IRentPriceOracle oracle
    )
        Ownable(owner_)
    {
        ETH_REGISTRY = ethRegistry;
        BENEFICIARY = beneficiary;

        rentPriceOracle = oracle;
        emit RentPriceOracleUpdated(oracle);
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IETHRenewer).interfaceId ||
            interfaceId == type(IRentPriceOracleProvider).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Change the rent price oracle.
    /// @param oracle The new `IRentPriceOracle` instance.
    function setRentPriceOracle(IRentPriceOracle oracle) external onlyOwner {
        rentPriceOracle = oracle;
        emit RentPriceOracleUpdated(oracle);
    }

    /// @inheritdoc IETHRenewer
    function isRenewable(string calldata label) external view returns (bool) {
        return _isRenewable(ETH_REGISTRY.getState(LibLabel.id(label)));
    }

    /// @inheritdoc IETHRenewer
    function renew(RenewData calldata rd, IERC20 paymentToken) public virtual {
        SafeERC20.safeTransferFrom(paymentToken, msg.sender, BENEFICIARY, _renew(rd, paymentToken)); // reverts if payment failed
    }

    /// @inheritdoc IETHRenewer
    function renewBatch(RenewData[] calldata rds, IERC20 paymentToken) public virtual {
        uint256 total;
        for (uint256 i; i < rds.length; ++i) {
            total += _renew(rds[i], paymentToken);
        }
        if (rds.length > 0) {
            SafeERC20.safeTransferFrom(paymentToken, msg.sender, BENEFICIARY, total); // reverts if payment failed
        }
    }

    /// @inheritdoc IETHRenewer
    function getRenewPrice(string calldata label, uint64 duration, IERC20 paymentToken)
        public
        view
        returns (uint256)
    {
        return
            rentPriceOracle.getRenewPrice(
                label,
                _requireRenewable(label, duration).expiry,
                duration,
                paymentToken
            );
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Renew a name and return the amount of `paymentToken`.
    function _renew(RenewData calldata rd, IERC20 paymentToken) internal returns (uint256 amount) {
        IPermissionedRegistry.State memory state = _requireRenewable(rd.label, rd.duration); // reverts if not
        uint64 newExpiry = state.expiry + rd.duration; // reverts if overflow
        amount = rentPriceOracle.getRenewPrice(rd.label, state.expiry, rd.duration, paymentToken); // reverts if invalid
        ETH_REGISTRY.renew(state.tokenId, newExpiry);
        _onRenew(rd.label, rd.duration);
        emit NameRenewed(
            state.tokenId,
            rd.label,
            rd.duration,
            newExpiry,
            paymentToken,
            rd.referrer,
            amount
        );
    }

    /// @dev Callback for when a name is renewed.
    function _onRenew(string calldata label, uint64 duration) internal virtual {}

    /// @dev Returns whether the name is renewable by this contract.
    function _isRenewable(IPermissionedRegistry.State memory state)
        internal
        view
        virtual
        returns (bool);

    /// @dev Ensure name is renewable.
    function _requireRenewable(string calldata label, uint64 duration)
        internal
        view
        returns (IPermissionedRegistry.State memory state)
    {
        state = ETH_REGISTRY.getState(LibLabel.id(label));
        if (!_isRenewable(state)) {
            revert NameNotRenewable(label);
        }
        if (duration < MIN_RENEW_DURATION) {
            revert DurationTooShort(duration, MIN_RENEW_DURATION);
        }
    }
}
