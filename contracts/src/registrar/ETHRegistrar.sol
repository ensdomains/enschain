// SPDX-License-Identifier: MIT
// Portions from OpenZeppelin Contracts (last updated v5.0.0) (token/ERC1155/ERC1155.sol)
pragma solidity >=0.8.13;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import "../registry/ETHRegistry.sol";
import "../registry/IRegistry.sol";
import "forge-std/console.sol";

contract ETHRegistrar is Ownable {
    uint256 public immutable MAX_COMMIT_AGE;
    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;
    mapping(bytes32 => uint256) public commitments;
    bytes32 public constant ETH_LABELHASH = keccak256(abi.encodePacked("eth"));
    ETHRegistry public registry;
    //IRegistry registry;

    error UnexpiredCommitmentExists(bytes32 commitment);
    error ResolverRequiredWhenDataSupplied();
    error CommitmentDoesNotExist();

    constructor(
        ETHRegistry _registry,
        uint256 maxCommitAge
    ) Ownable(msg.sender) {
        // constructor
        registry = _registry;
        MAX_COMMIT_AGE = maxCommitAge;
    }

    function makeCommitment(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes[] calldata data,
        bytes32 secret
    ) public pure returns (bytes32) {
        if (data.length > 0 && resolver == address(0)) {
            revert ResolverRequiredWhenDataSupplied();
        }
        return
            keccak256(
                abi.encode(label, owner, duration, resolver, data, secret)
            );
    }

    function commit(bytes32 commitment) public {
        if (commitments[commitment] + MAX_COMMIT_AGE >= block.timestamp) {
            revert UnexpiredCommitmentExists(commitment);
        }
        commitments[commitment] = block.timestamp;
    }

    function register(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes[] calldata data,
        bytes32 secret
    ) public {
        // get labelhash
        bytes32 labelhash = keccak256(abi.encodePacked(label));
        // check if msg.value given is enough

        // check if commitment exists
        uint256 commitmentTime = commitments[
            makeCommitment(label, owner, duration, resolver, data, secret)
        ];

        if (commitmentTime + MAX_COMMIT_AGE < block.timestamp) {
            revert CommitmentDoesNotExist();
        }

        (uint64 expiry, uint96 flags) = registry.nameData(uint256(labelhash));
        registry.register(
            label,
            msg.sender,
            registry,
            0,
            uint64(block.timestamp) + duration
        );

        // send back excess
    }

    function renew(bytes32 node) public {}

    function withdraw() public {
        payable(owner()).transfer(address(this).balance);
    }
}
