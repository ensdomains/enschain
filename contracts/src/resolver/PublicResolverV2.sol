// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Multicallable} from "@ens/contracts/resolvers/Multicallable.sol";
import {ABIResolver} from "@ens/contracts/resolvers/profiles/ABIResolver.sol";
import {AddrResolver} from "@ens/contracts/resolvers/profiles/AddrResolver.sol";
import {ContentHashResolver} from "@ens/contracts/resolvers/profiles/ContentHashResolver.sol";
import {DataResolver} from "@ens/contracts/resolvers/profiles/DataResolver.sol";
import {DNSResolver} from "@ens/contracts/resolvers/profiles/DNSResolver.sol";
import {InterfaceResolver} from "@ens/contracts/resolvers/profiles/InterfaceResolver.sol";
import {NameResolver} from "@ens/contracts/resolvers/profiles/NameResolver.sol";
import {PubkeyResolver} from "@ens/contracts/resolvers/profiles/PubkeyResolver.sol";
import {TextResolver} from "@ens/contracts/resolvers/profiles/TextResolver.sol";
import {INameWrapper} from "@ens/contracts/wrapper/INameWrapper.sol";
import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import {IPermissionedRegistry} from "../registry/interfaces/IPermissionedRegistry.sol";
import {IContractNamer} from "../reverse-registrar/interfaces/IContractNamer.sol";
import {LibResolution} from "../universalResolver/libraries/LibResolution.sol";
import {DelegatedContractNamer} from "../utils/DelegatedContractNamer.sol";

/// @notice PublicResolver that respects the ENSv2 registry.
contract PublicResolverV2 is
    ERC165,
    Multicallable,
    ABIResolver,
    AddrResolver,
    ContentHashResolver,
    DataResolver,
    DNSResolver,
    InterfaceResolver,
    NameResolver,
    PubkeyResolver,
    TextResolver,
    DelegatedContractNamer
{
    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    /// @notice The ENSv1 `NameWrapper` contract.
    INameWrapper public immutable NAME_WRAPPER;

    /// @notice The ENSv2  Root Registry contract.
    IPermissionedRegistry public immutable ROOT_REGISTRY;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    /// @dev A mapping of operators. An address that is authorised for an address
    ///      may make any changes to the name that the owner could, but may not update
    ///      the set of authorisations.
    mapping(address owner => mapping(address operator => bool approved)) internal _operatorApprovals;

    /// @dev A mapping of delegates. A delegate that is authorised by an owner
    ///      for a name may make changes to the name's resolver, but may not update
    ///      the set of token approvals.
    mapping(address owner => mapping(bytes32 node => mapping(address delegate => bool approved))) internal _tokenApprovals;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice An operator is added or removed.
    /// @param owner The node owner.
    /// @param operator The approved account.
    /// @param approved If `true`, approved, otherwise revoked.
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// @notice A delegate is approved or an approval is revoked.
    /// @param owner The node owner.
    /// @param node The namehash.
    /// @param delegate The approved account.
    /// @param approved If `true`, approved, otherwise revoked.
    event Approved(
        address owner,
        bytes32 indexed node,
        address indexed delegate,
        bool indexed approved
    );

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param nameWrapper The ENSv1 `NameWrapper` contract.
    /// @param rootRegistry The ENSv2 Root Registry contract.
    /// @param contractNamer Delegated contract namer.
    constructor(
        INameWrapper nameWrapper,
        IPermissionedRegistry rootRegistry,
        IContractNamer contractNamer
    )
        DelegatedContractNamer(contractNamer)
    {
        NAME_WRAPPER = nameWrapper;
        ROOT_REGISTRY = rootRegistry;
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(
            ERC165,
            Multicallable,
            ABIResolver,
            AddrResolver,
            ContentHashResolver,
            DataResolver,
            DNSResolver,
            InterfaceResolver,
            NameResolver,
            PubkeyResolver,
            TextResolver,
            DelegatedContractNamer
        )
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Implementation
    ////////////////////////////////////////////////////////////////////////

    /// @notice Grant or revoke `operator` approval.
    /// @param operator The account to approve.
    /// @param approved If `true`, approved, otherwise revoked.
    function setApprovalForAll(address operator, bool approved) external {
        address sender = msg.sender;
        require(sender != operator, "ERC1155: setting approval status for self");
        _operatorApprovals[sender][operator] = approved;
        emit ApprovalForAll(sender, operator, approved);
    }

    /// @notice Grant or revoke `delegate` approval on a specific node.
    /// @param node The namehash to approve.
    /// @param delegate The account to approve.
    /// @param approved If `true`, approved, otherwise revoked.
    function approve(bytes32 node, address delegate, bool approved) external {
        address sender = msg.sender;
        require(sender != delegate, "Setting delegate status for self");
        _tokenApprovals[sender][node][delegate] = approved;
        emit Approved(sender, node, delegate, approved);
    }

    /// @notice Check if `operator` is approved for all nodes owned by `account`.
    /// @param owner The owner account.
    /// @param operator The operator account.
    /// @return `true` if `operator` is approved.
    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    /// @notice Check to see if the delegate has been approved by the owner for the node.
    /// @param owner The owner account.
    /// @param node The namehash to check.
    /// @param delegate The delegated account.
    /// @return `true` if `operator` is approved.
    function isApprovedFor(address owner, bytes32 node, address delegate)
        public
        view
        returns (bool)
    {
        return _tokenApprovals[owner][node][delegate];
    }

    /// @notice Determine if `operator` is authorized for `node`.
    /// @param node The namehash to check.
    /// @param operator The account requesting authorization.
    /// @return `true` if `node` is authorized.
    function canModifyName(bytes32 node, address operator) public view returns (bool) {
        bytes memory name = NAME_WRAPPER.names(node);
        if (name.length == 0) {
            return false;
        }
        address owner = LibResolution.findExactOwner(ROOT_REGISTRY, name, 0);
        return
            owner == operator ||
            isApprovedForAll(owner, operator) ||
            isApprovedFor(owner, node, operator);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal Functions
    ////////////////////////////////////////////////////////////////////////

    // solhint-disable private-vars-leading-underscore
    /// @dev Determine if the caller is authorized for `node`.
    function isAuthorised(bytes32 node) internal view override returns (bool) {
        return canModifyName(node, msg.sender);
    }
}
