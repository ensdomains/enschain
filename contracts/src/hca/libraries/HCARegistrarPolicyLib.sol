// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Execution} from "nexus/types/DataTypes.sol";

import {IETHRegistrar} from "../../registrar/interfaces/IETHRegistrar.sol";
import {IRentPriceOracle} from "../../registrar/interfaces/IRentPriceOracle.sol";
import {IRentPriceOracleProvider} from "../../registrar/interfaces/IRentPriceOracleProvider.sol";
import {IPermissionedRegistry} from "../../registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "../../registry/libraries/RegistryRolesLib.sol";

import {HCAExecutionLib} from "./HCAExecutionLib.sol";

/// @title HCA Registrar Policy Library
/// @notice Identifies authorized registrars and the payment tokens their rent oracles accept.
/// @dev Fails closed when registrar authorization or oracle discovery is unavailable.
library HCARegistrarPolicyLib {
    /// @notice Returns whether a registry currently authorizes an account to register names.
    /// @dev Checks the registrar role at the registry root.
    /// @param registry The permissioned ENS registry.
    /// @param account The prospective registrar.
    /// @return authorized Whether the account holds the root registrar role.
    function isAuthorized(address registry, address account)
        internal
        view
        returns (bool authorized)
    {
        return
            IPermissionedRegistry(registry).hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, account);
    }

    /// @notice Returns whether a registrar's current rent oracle accepts a payment token.
    /// @dev Fails closed when the registrar or its oracle does not answer as expected.
    /// @param registrar The registrar whose oracle decides payment-token support.
    /// @param token The candidate payment token.
    /// @return supported Whether the registrar's oracle accepts the token.
    function isPaymentToken(address registrar, address token)
        internal
        view
        returns (bool supported)
    {
        if (registrar.code.length == 0) {
            return false;
        }
        try IRentPriceOracleProvider(registrar).rentPriceOracle() returns (IRentPriceOracle oracle) {
            if (address(oracle).code.length == 0) {
                return false;
            }
            try oracle.isPaymentToken(IERC20(token)) returns (bool isSupported) {
                return isSupported;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    /// @notice Returns whether a registration batch uses one registrar that accepts a payment token.
    /// @dev Reuses the execution array decoded by the calling validator and queries the selected
    ///      registrar's oracle once. Batches without a registration return true.
    /// @param executions The decoded operation batch.
    /// @param token The token delivered to the account by the signed intent.
    /// @return supported Whether the batch uses at most one registrar and it accepts the token.
    function isBatchPaymentToken(Execution[] memory executions, address token)
        internal
        view
        returns (bool supported)
    {
        address registrar;
        bool seenRegistration;
        for (uint256 i; i < executions.length; ++i) {
            if (HCAExecutionLib.selector(executions[i].callData) != IETHRegistrar.register.selector) {
                continue;
            }
            if (!seenRegistration) {
                registrar = executions[i].target;
                seenRegistration = true;
            } else if (executions[i].target != registrar) {
                return false;
            }
        }
        return !seenRegistration || isPaymentToken(registrar, token);
    }

    /// @notice Reads the registrant and resolver from an encoded registration call.
    /// @dev Reads fixed ABI head words without decoding the dynamic label argument.
    /// @param callData ABI-encoded registrar call data.
    /// @return registrant The owner argument of the registration.
    /// @return resolver The resolver argument of the registration.
    function registrationFields(bytes memory callData)
        internal
        pure
        returns (address registrant, address resolver)
    {
        registrant = HCAExecutionLib.readAddress(callData, 4 + 32);
        resolver = HCAExecutionLib.readAddress(callData, 4 + 128);
    }
}
