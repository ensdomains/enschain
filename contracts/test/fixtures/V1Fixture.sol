// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Test} from "forge-std/Test.sol";

import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ENSRegistry, ENS} from "@ens/contracts/registry/ENSRegistry.sol";
import {
    BaseRegistrarImplementation
} from "@ens/contracts/ethregistrar/BaseRegistrarImplementation.sol";
import {NameWrapper, INameWrapper, IMetadataService} from "@ens/contracts/wrapper/NameWrapper.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {RegistryUtils} from "@ens/contracts/universalResolver/RegistryUtils.sol";

/// @dev Reusable testing fixture for ENSv1.
abstract contract V1Fixture is Test, ERC721Holder, ERC1155Holder {
    enum StatusV1 {
        REGISTERED,
        GRACE,
        AVAILABLE
    }

    ENS registryV1;
    BaseRegistrarImplementation baseRegistrar;
    NameWrapper nameWrapper;
    MockWrappedETHRegistrarController wrappedController;

    uint64 gracePeriodV1;
    address testOwner = makeAddr("ownerV1");
    uint64 testDuration = 1 days;
    address ethControllerV1 = makeAddr("ethControllerV1");

    function deployV1Fixture() public {
        registryV1 = new ENSRegistry();
        baseRegistrar = new BaseRegistrarImplementation(registryV1, NameCoder.ETH_NODE);
        baseRegistrar.addController(ethControllerV1);
        gracePeriodV1 = uint64(baseRegistrar.GRACE_PERIOD()) + 1; // see: BaseRegistrarImplementation.available()
        _claimNodes(NameCoder.encode("eth"), 0, address(baseRegistrar));
        _claimNodes(NameCoder.encode("addr.reverse"), 0, address(this)); // see: fake ReverseClaimer
        nameWrapper = new NameWrapper(registryV1, baseRegistrar, IMetadataService(address(0)));
        wrappedController = new MockWrappedETHRegistrarController(nameWrapper);
        nameWrapper.setController(ethControllerV1, true);
        nameWrapper.setController(address(wrappedController), true);
        baseRegistrar.addController(address(nameWrapper));

        uint256 t = gracePeriodV1;
        if (block.timestamp < t) {
            vm.warp(t); // avoid timestamp issues
        }
    }

    // fake ReverseClaimer
    function claim(address) external pure returns (bytes32) {}

    /// @dev Claim a name in the registry at any depth.
    ///      Preseves existing ownership until the leaf.
    function _claimNodes(bytes memory name, uint256 offset, address owner) internal {
        (bytes32 labelHash, uint256 nextOffset) = NameCoder.readLabel(name, offset);
        if (labelHash != bytes32(0)) {
            _claimNodes(name, nextOffset, owner);
            // claim if leaf or unset
            if (offset == 0 || registryV1.owner(NameCoder.namehash(name, offset)) == address(0)) {
                bytes32 parentNode = NameCoder.namehash(name, nextOffset);
                vm.prank(registryV1.owner(parentNode));
                registryV1.setSubnodeOwner(parentNode, labelHash, owner);
            }
        }
    }

    function registerUnwrapped(string memory label)
        public
        virtual
        returns (bytes memory name, uint256 tokenId)
    {
        name = NameCoder.ethName(label);
        address registrant = _determineRegistrant();
        tokenId = uint256(keccak256(bytes(label)));
        vm.prank(ethControllerV1);
        baseRegistrar.register(tokenId, registrant, testDuration);
    }

    function registerWrappedETH2LD(string memory label, uint32 ownerFuses)
        public
        returns (bytes memory name)
    {
        address wrappedOwner = _determineRegistrant();
        uint256 tokenId;
        (name, tokenId) = registerUnwrapped(label);
        address owner = baseRegistrar.ownerOf(tokenId);
        vm.prank(owner);
        baseRegistrar.safeTransferFrom(
            owner,
            address(nameWrapper),
            tokenId,
            abi.encode(
                label, // label
                wrappedOwner,
                uint16(ownerFuses), // fuses
                address(0) // resolver
            )
        );
    }

    function createWrappedChild(bytes memory parentName, string memory label, uint32 fuses)
        public
        returns (bytes memory name)
    {
        address wrappedOwner = _determineRegistrant();
        bytes32 parentNode = NameCoder.namehash(parentName, 0);
        (address owner, , uint64 expiry) = nameWrapper.getData(uint256(parentNode));
        vm.prank(owner);
        nameWrapper.setSubnodeOwner(parentNode, label, wrappedOwner, fuses, expiry);
        name = NameCoder.addLabel(parentName, label);
    }

    function createWrappedName(string memory domain, uint32 fuses)
        public
        returns (bytes memory name)
    {
        name = NameCoder.encode(domain);
        address registrant = _determineRegistrant();
        _claimNodes(name, 0, registrant);
        (bytes32 labelHash, uint256 offset) = NameCoder.readLabel(name, 0);
        bytes32 parentNode = NameCoder.namehash(name, offset);
        vm.prank(registrant);
        registryV1.setApprovalForAll(address(nameWrapper), true);
        vm.prank(registrant);
        nameWrapper.wrap(name, registrant, address(0));
        if (fuses != 0) {
            vm.prank(registrant);
            nameWrapper.setFuses(NameCoder.namehash(parentNode, labelHash), uint16(fuses));
        }
    }

    function getStatusV1(uint256 tokenId) public view returns (StatusV1) {
        try baseRegistrar.ownerOf(tokenId) {
            return StatusV1.REGISTERED;
        } catch {
            return baseRegistrar.available(tokenId) ? StatusV1.AVAILABLE : StatusV1.GRACE;
        }
    }

    function findResolverV1(bytes memory name) public view returns (address resolver) {
        (resolver, , ) = RegistryUtils.findResolver(registryV1, name, 0);
    }

    function _determineRegistrant() internal view returns (address registrant) {
        registrant = msg.sender;
        if (registrant == DEFAULT_SENDER) {
            registrant = testOwner;
        }
    }
}


// https://github.com/ensdomains/ens-contracts/blob/staging/deployments/mainnet/WrappedETHRegistrarController.json
contract MockWrappedETHRegistrarController {
    INameWrapper internal immutable NAME_WRAPPER;
    constructor(INameWrapper nameWrapper) {
        NAME_WRAPPER = nameWrapper;
    }
    function renew(string calldata label, uint256 duration) external payable {
        require(duration == 0);
        NAME_WRAPPER.renew(uint256(keccak256(bytes(label))), duration);
    }
}
