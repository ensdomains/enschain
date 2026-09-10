// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Test} from "forge-std/Test.sol";

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {GatewayProvider} from "@ens/contracts/ccipRead/GatewayProvider.sol";
import {CloneProxyBytecode} from "@ensdomains/verifiable-factory/CloneProxyBytecode.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RegistryRolesLib} from "~src/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "~src/registry/PermissionedRegistry.sol";
import {ContractNamer} from "~src/utils/ContractNamer.sol";
import {LabelStore} from "~src/utils/LabelStore.sol";
import {UniversalResolverV2} from "~src/universalResolver/UniversalResolverV2.sol";
import {UniversalHelper} from "~src/universalResolver/UniversalHelper.sol";

/// @dev Reusable testing fixture for ENSv2 with a basic ".eth" deployment.
abstract contract V2Fixture is Test, ERC1155Holder {
    ContractNamer contractNamer;
    VerifiableFactory verifiableFactory;
    LabelStore labelStore;
    PermissionedRegistry rootRegistry;
    PermissionedRegistry ethRegistry;
    GatewayProvider batchGatewayProvider;
    UniversalResolverV2 universalResolver;
    UniversalHelper universalHelper;

    /// @dev Role bitmaps matching README Static Deployment Permissions.
    function _rootRegistryRootRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_REGISTRAR |
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_REGISTER_RESERVED |
            RegistryRolesLib.ROLE_REGISTER_RESERVED_ADMIN |
            RegistryRolesLib.ROLE_SET_PARENT |
            RegistryRolesLib.ROLE_SET_PARENT_ADMIN |
            RegistryRolesLib.ROLE_RENEW |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN;
    }

    function _ethRegistryRootRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_REGISTER_RESERVED_ADMIN |
            RegistryRolesLib.ROLE_SET_PARENT |
            RegistryRolesLib.ROLE_SET_PARENT_ADMIN |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_CAN_NAME |
            RegistryRolesLib.ROLE_CAN_NAME_ADMIN;
    }

    function _ethTokenRoles() internal pure returns (uint256) {
        return
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN;
    }

    function deployV2Fixture() public {
        contractNamer = ContractNamer(
            address(
                new ERC1967Proxy(
                    address(new ContractNamer()),
                    abi.encodeCall(ContractNamer.initialize, (address(this)))
                )
            )
        );
        verifiableFactory = new VerifiableFactory();
        labelStore = new LabelStore(contractNamer);
        rootRegistry = new PermissionedRegistry(labelStore, address(this), _rootRegistryRootRoles());
        ethRegistry = new PermissionedRegistry(labelStore, address(this), _ethRegistryRootRoles());
        rootRegistry.register(
            "eth",
            address(this),
            ethRegistry,
            address(0),
            _ethTokenRoles(),
            type(uint64).max
        );
        ethRegistry.setParent(rootRegistry, "eth");
        ethRegistry.grantRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(this));
        batchGatewayProvider = new GatewayProvider(address(this), new string[](0));
        universalResolver = new UniversalResolverV2(
            rootRegistry,
            batchGatewayProvider,
            contractNamer
        );
        universalHelper = new UniversalHelper(rootRegistry, contractNamer);
    }

    function findResolverV2(bytes memory name) public view returns (address resolver) {
        (resolver, , ) = universalResolver.findResolver(name);
    }

    function _computeVerifiableFactoryAddress(address deployer, uint256 salt)
        internal
        view
        returns (address)
    {
        bytes32 outerSalt = keccak256(abi.encode(deployer, salt));
        bytes memory bytecode =
            CloneProxyBytecode.creationCode(verifiableFactory.proxyLogic(), outerSalt);
        return vm.computeCreate2Address(outerSalt, keccak256(bytecode), address(verifiableFactory));
    }
}
