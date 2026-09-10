// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {StringUtils} from "@ens/contracts/utils/StringUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {EnhancedAccessControl} from "../access-control/EnhancedAccessControl.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";

import {IRentPriceOracle} from "./interfaces/IRentPriceOracle.sol";
import {LibHalving} from "./libraries/LibHalving.sol";

/// @dev Nybble 0: authorizes updating tokens. Root only.
uint256 constant ROLE_UPDATE_TOKEN = 1 << 0;

/// @dev Nybble 32: authorizes setting `ROLE_UPDATE_TOKEN`.
uint256 constant ROLE_UPDATE_TOKEN_ADMIN = ROLE_UPDATE_TOKEN << 128;

/// @dev Nybble 1: authorizes disabling tokens. Root only.
uint256 constant ROLE_DISABLE_TOKEN = 1 << 4;

/// @dev Nybble 33: authorizes setting `ROLE_DISABLE_TOKEN`.
uint256 constant ROLE_DISABLE_TOKEN_ADMIN = ROLE_DISABLE_TOKEN << 128;

/// @dev Nybble 2: authorizes contract naming. Root only.
uint256 constant ROLE_CAN_NAME = 1 << 8;

/// @dev Nybble 34: authorizes setting `ROLE_CAN_NAME`.
uint256 constant ROLE_CAN_NAME_ADMIN = ROLE_CAN_NAME << 128;

/// @dev Default root roles assigned at construction.
uint256 constant DEFAULT_ROLE_BITMAP =
    ROLE_UPDATE_TOKEN |
    ROLE_UPDATE_TOKEN_ADMIN |
    ROLE_DISABLE_TOKEN |
    ROLE_DISABLE_TOKEN_ADMIN |
    ROLE_CAN_NAME |
    ROLE_CAN_NAME_ADMIN;

/// @dev Initialization-time structure for a discount point.
/// @param duration Duration threshold, in seconds.
/// @param numer Discount numerator, relative to `DISCOUNT_DENOMINATOR`.
struct DiscountPoint {
    uint64 duration;
    uint128 numer;
}

/// @dev Initialization-time structure for a payment token and exchange rate.
/// @param paymenToken The payment token.
/// @param numer Exchange rate numerator, relative to base units.
/// @param denom Exchange rate denominator, relative to base units.
struct PaymentRatio {
    IERC20 paymentToken;
    uint128 numer;
    uint128 denom;
}

/// @notice Rent pricing oracle with (4) components:
///
/// 1. Base rates: per-second cost indexed by label codepoint count. Shorter names cost more.
///    Rates are stored in an array where index `i` corresponds to `i+1` codepoints; labels
///    longer than the array use the last entry.
/// 2. Duration discounts: increasing expiry reduce costs. Each dicount point specifies a
///    duration and a numerator. `1 - numerator / DISCOUNT_DENOMINATOR` determines the
///    discount percentage. Rewards longer registrations.
/// 3. Expiry premium: exponential decay from an initial premium with a configurable halving
///    period, reaching zero at the end of the premium period. Only charged to new owners of
///    recently expired names; renewals are exempt.
/// 4. Configurable payment tokens: payment tokens and their exchange rates can be managed
///    with `ROLE_UPDATE_TOKEN`. The exchange rate converts the token to standard units.
///    Since no external oracle is consulted, only stablecoins.
///    Accounts with `ROLE_DISABLE_TOKEN` can only disable payment tokens.
///
contract StandardRentPriceOracle is EnhancedAccessControl, IRentPriceOracle, IContractNamer {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    /// @dev Internal numerator/denominator pair representing a payment token's exchange rate relative to base pricing units.
    struct Ratio {
        uint128 numer;
        uint128 denom;
    }

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice Denominator for discounts.
    uint128 public immutable DISCOUNT_DENOMINATOR;

    /// @notice Starting value of the exponential decay premium for recently expired names, in base pricing units.
    uint256 public immutable PREMIUM_PRICE_INITIAL;

    /// @notice Number of seconds for the premium to halve in value.
    uint64 public immutable PREMIUM_HALVING_PERIOD;

    /// @notice Total duration of the premium window; the premium reaches zero at this offset from expiry.
    uint64 public immutable PREMIUM_PERIOD;

    /// @notice Precomputed premium halving at end of period.
    uint256 public immutable PREMIUM_PRICE_OFFSET;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev Per-second base rates indexed by codepoint count; `_baseRatePerCp[i]` prices labels with `i+1` codepoints.
    uint256[] internal _baseRatePerCp;

    /// @dev Ordered discount points, relative to `DISCOUNT_DENOMINATOR`.
    DiscountPoint[] internal _discountPoints;

    /// @dev Exchange rates for each accepted payment token, mapping token address to its numerator/denominator ratio.
    mapping(IERC20 paymentToken => Ratio ratio) internal _paymentRatios;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice `paymentToken` has changed.
    /// @param paymentToken The payment token.
    /// @param numer Exchange rate numerator, relative to base units.
    /// @param denom Exchange rate denominator, relative to base units, or 0 if disabled.
    event PaymentTokenUpdated(IERC20 indexed paymentToken, uint128 numer, uint128 denom);

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice Invalid base rates.
    /// @dev Error selector: `0xde276447`
    error InvalidBaseRates();

    /// @notice Invalid payment token exchange rate.
    /// @dev Error selector: `0x648564d3`
    error InvalidRatio();

    /// @notice Invalid discount configuration.
    /// @dev Error selector: `0x997ea360`
    error InvalidDiscount();

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param rootAccount Account granted root roles.
    /// @param baseRatePerCp Base rates, in standard units per second.
    /// @param discountPoints List of discount points.
    /// @param discountDenominator Denominator for discounts.
    /// @param premiumPriceInitial Premium initial price, in standard units.
    /// @param premiumHalvingPeriod Premium halving period, in seconds.
    /// @param premiumPeriod Premium period, in seconds.
    /// @param paymentRatios List of payment tokens with exchange rates.
    constructor(
        address rootAccount,
        uint256[] memory baseRatePerCp,
        DiscountPoint[] memory discountPoints,
        uint128 discountDenominator,
        uint256 premiumPriceInitial,
        uint64 premiumHalvingPeriod,
        uint64 premiumPeriod,
        PaymentRatio[] memory paymentRatios
    )
    {
        _grantRoles(ROOT_RESOURCE, DEFAULT_ROLE_BITMAP, rootAccount, false);

        if (baseRatePerCp.length == 0) {
            revert InvalidBaseRates();
        }
        _baseRatePerCp = baseRatePerCp;

        uint256 n = discountPoints.length;
        if (n > 0) {
            uint64 duration; // must increase
            uint128 numer = discountDenominator; // must decrease
            for (uint256 i; i < n; ++i) {
                DiscountPoint memory p = discountPoints[i];
                if (p.duration <= duration || p.numer >= numer) {
                    revert InvalidDiscount(); // not strictly monotonic
                }
                duration = p.duration;
                numer = p.numer;
                _discountPoints.push(p);
            }
            if (numer == 0) {
                revert InvalidDiscount(); // free
            }
            DISCOUNT_DENOMINATOR = discountDenominator;
        }

        PREMIUM_PRICE_INITIAL = premiumPriceInitial;
        PREMIUM_HALVING_PERIOD = premiumHalvingPeriod;
        PREMIUM_PERIOD = premiumPeriod;
        PREMIUM_PRICE_OFFSET = LibHalving.halving(
            premiumPriceInitial,
            premiumHalvingPeriod,
            premiumPeriod
        );

        for (uint256 i; i < paymentRatios.length; ++i) {
            PaymentRatio memory pr = paymentRatios[i];
            if (pr.numer == 0 || pr.denom == 0) {
                revert InvalidRatio();
            }
            _paymentRatios[pr.paymentToken] = Ratio(pr.numer, pr.denom);
            emit PaymentTokenUpdated(pr.paymentToken, pr.numer, pr.denom);
        }
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return
            interfaceId == type(IRentPriceOracle).interfaceId ||
            interfaceId == type(IContractNamer).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Update `paymentToken` support and/or exchange rate.
    /// @param paymentToken The payment token.
    /// @param numer The numerator of the exchange rate.
    /// @param denom The denominator of the exchange rate, or 0 to disable.
    function updatePaymentToken(IERC20 paymentToken, uint128 numer, uint128 denom)
        external
        onlyRootRoles(ROLE_UPDATE_TOKEN)
    {
        Ratio memory ratio = _paymentRatios[paymentToken];
        if (denom > 0) {
            if (numer == 0) {
                revert InvalidRatio();
            }
            if (ratio.numer != numer || ratio.denom != denom) {
                _paymentRatios[paymentToken] = Ratio(numer, denom);
                emit PaymentTokenUpdated(paymentToken, numer, denom);
            }
        } else if (ratio.denom > 0) {
            delete _paymentRatios[paymentToken];
            emit PaymentTokenUpdated(paymentToken, 0, 0);
        }
    }

    /// @notice Disable `paymentToken` support.
    /// @param paymentToken The payment token.
    function disablePaymentToken(IERC20 paymentToken) external onlyRootRoles(ROLE_DISABLE_TOKEN) {
        if (_paymentRatios[paymentToken].denom > 0) {
            delete _paymentRatios[paymentToken];
            emit PaymentTokenUpdated(paymentToken, 0, 0);
        }
    }

    /// @inheritdoc IContractNamer
    function isContractNamer(address namer) external view returns (bool) {
        return hasRootRoles(ROLE_CAN_NAME, namer);
    }

    /// @notice Get all base rates, in standard units per second.
    function getBaseRates() external view returns (uint256[] memory) {
        return _baseRatePerCp;
    }

    /// @notice Get all discount durations, in seconds.
    function getDiscountPoints() external view returns (DiscountPoint[] memory v) {
        return _discountPoints;
    }

    /// @notice Check if a `label` is valid. Does not check if normalized.
    /// @param label The name to check.
    /// @return `true` if the `label` is valid.
    function isValid(string calldata label) external view returns (bool) {
        return getBasePrice(label, 1) > 0;
    }

    /// @notice Get numerator/denominator for `paymentToken`.
    /// @param paymentToken The payment token.
    /// @return numer The numerator of the exchange rate.
    /// @return denom The denominator of the exchange rate.
    function getPaymentTokenRatio(IERC20 paymentToken)
        external
        view
        returns (uint128 numer, uint128 denom)
    {
        Ratio storage ratio = _paymentRatios[paymentToken];
        return (ratio.numer, ratio.denom);
    }

    /// @inheritdoc IRentPriceOracle
    function isPaymentToken(IERC20 paymentToken) external view returns (bool) {
        return _paymentRatios[paymentToken].denom > 0;
    }

    /// @inheritdoc IRentPriceOracle
    function getRegisterPrice(
        string calldata label,
        uint64 available,
        uint64 duration,
        IERC20 paymentToken
    )
        external
        view
        returns (uint256 base, uint256 premium)
    {
        base = _requireBasePrice(label, duration);
        Ratio memory ratio = _requirePaymentToken(paymentToken);
        premium = getPremiumPriceAfter(available);
        if (premium > 0) {
            base += premium; // total
            premium = _toAmount(premium, ratio);
        }
        base = _toAmount(base, ratio) - premium; // ensure: f(a+b) - f(a) == f(b)
    }

    /// @inheritdoc IRentPriceOracle
    function getRenewPrice(
        string calldata label,
        uint64 /*expiry*/,
        uint64 duration,
        IERC20 paymentToken
    )
        external
        view
        returns (uint256)
    {
        return _toAmount(_requireBasePrice(label, duration), _requirePaymentToken(paymentToken));
    }

    /// @notice Convert arbitrary standard units to payment token amount.
    /// @param value An arbitrary value, in standard units.
    /// @param paymentToken The payment token.
    /// @return The amount of payment token.
    function convertUnits(uint256 value, IERC20 paymentToken) external view returns (uint256) {
        return _toAmount(value, _requirePaymentToken(paymentToken));
    }

    /// @notice Apply discount function to an arbitrary value.
    /// @param value An arbitrary value.
    /// @param duration The duration, in seconds.
    /// @return `value` reduced by discount.
    function applyDiscount(uint256 value, uint64 duration) public view returns (uint256) {
        uint256 n = _discountPoints.length;
        uint128 numer;
        for (uint256 i; i < n; ++i) {
            DiscountPoint storage p = _discountPoints[i];
            if (duration < p.duration)
                break;
            numer = p.numer;
        }
        return
            numer == 0
                ? value
                : Math.mulDiv(value, numer, DISCOUNT_DENOMINATOR);
    }

    /// @notice Get base price to register or renew `label` for `duration` seconds.
    /// @param label The name to price.
    /// @param duration The duration, in seconds.
    /// @return The base price, in standard units, or 0 if not valid.
    function getBasePrice(string calldata label, uint64 duration) public view returns (uint256) {
        uint256 n = bytes(label).length;
        if (n == 0 || n > 255)
            return 0; // too long or too short
        uint256 i = getLength(label);
        if (i > _baseRatePerCp.length) {
            i = _baseRatePerCp.length;
        }
        return applyDiscount(_baseRatePerCp[i - 1] * duration, duration);
    }

    /// @notice Get premium price for a duration after expiry.
    /// @dev Defined over `[0, premiumPeriod)`.
    /// @param duration The time after expiration, in seconds.
    /// @return The premium price, in standard units.
    function getPremiumPriceAfter(uint64 duration) public view returns (uint256) {
        return
            duration < PREMIUM_PERIOD
                ? LibHalving.halving(PREMIUM_PRICE_INITIAL, PREMIUM_HALVING_PERIOD, duration) -
                PREMIUM_PRICE_OFFSET
                : 0;
    }

    /// @notice Check length of a name.
    /// @param label The name to check.
    /// @return The number of Unicode codepoints.
    function getLength(string calldata label) public pure returns (uint256) {
        return StringUtils.strlen(label);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    /// @dev Compute `rate * duration` and apply discount.
    function _requireBasePrice(string calldata label, uint64 duration)
        internal
        view
        returns (uint256 rate)
    {
        rate = getBasePrice(label, duration);
        if (rate == 0) {
            revert NotValid(label);
        }
    }

    /// @dev Ensure `paymentToken` is supported.
    function _requirePaymentToken(IERC20 paymentToken) internal view returns (Ratio memory ratio) {
        ratio = _paymentRatios[paymentToken];
        if (ratio.denom == 0) {
            revert PaymentTokenNotSupported(paymentToken);
        }
    }

    /// @dev Convert standard units to token amount.
    function _toAmount(uint256 value, Ratio memory ratio) internal pure returns (uint256) {
        return
            ratio.numer == ratio.denom
                ? value
                : Math.mulDiv(value, ratio.numer, ratio.denom, Math.Rounding.Ceil);
    }
}
