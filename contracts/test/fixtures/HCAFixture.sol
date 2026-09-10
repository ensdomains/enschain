// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {Test} from "forge-std/Test.sol";

import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {IStandaloneHCAFactory} from "~src/hca/interfaces/IStandaloneHCAFactory.sol";
import {IStandaloneHCAOwner} from "~src/hca/interfaces/IStandaloneHCAOwner.sol";

/// @title HCA Test Fixture
/// @notice Provides factory-certified and uncertified HCAs for adapter tests.
/// @dev Certified HCAs are deployed through the real `StandaloneHCAFactory` so consumer tests
///      exercise the production certification path; the fixture acts as factory governance.
///      The factory is deployed from its compiled artifact so consumer tests never import its
///      source into their own compiler profile.
abstract contract HCAFixture is Test {
    string internal constant STANDALONE_HCA_FACTORY_ARTIFACT =
        "src/hca/StandaloneHCAFactory.sol:StandaloneHCAFactory";

    MockHCA trustedHCAImpl;
    MockHCA untrustedHCAImpl;
    VerifiableFactory verifiableFactory;
    IStandaloneHCAFactory standaloneHCAFactory;

    uint256 private nextSalt = 1;

    function deployHCAFixture() public {
        verifiableFactory = new VerifiableFactory();
        trustedHCAImpl = new MockHCA();
        untrustedHCAImpl = new MockHCA();
        standaloneHCAFactory = IStandaloneHCAFactory(
            deployCode(STANDALONE_HCA_FACTORY_ARTIFACT, abi.encode(verifiableFactory, address(this)))
        );
        standaloneHCAFactory.setImplementationApproval(address(trustedHCAImpl), true);
    }

    /// @dev Deploys a factory-certified HCA owned by `hcaOwner`.
    function _deployHCA(address hcaOwner, address hcaImpl) internal returns (address) {
        return standaloneHCAFactory.deploy(hcaOwner, hcaImpl, nextSalt++);
    }
}


/// @title Mock HCA
/// @notice Stores an initialized owner and exposes the standalone HCA ownership interface.
contract MockHCA is IStandaloneHCAOwner {
    address internal _owner;

    /// @notice Initializes the fixture owner directly.
    /// @param owner_ The owner to store.
    function initialize(address owner_) external {
        _owner = owner_;
    }

    /// @notice Initializes the fixture owner through the standalone account interface.
    /// @param initData ABI-encoded owner address, as passed by `StandaloneHCAFactory.deploy`.
    function initializeAccount(bytes calldata initData) external {
        _owner = abi.decode(initData, (address));
    }

    /// @inheritdoc IStandaloneHCAOwner
    function owner() external view virtual returns (address) {
        return _owner;
    }

    /// @inheritdoc IStandaloneHCAOwner
    function ownerAndSessionNonce() external view returns (address, uint96) {
        return (_owner, 0);
    }
}
