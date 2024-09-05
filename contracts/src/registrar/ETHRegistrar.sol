// SPDX-License-Identifier: MIT
// Portions from OpenZeppelin Contracts (last updated v5.0.0) (token/ERC1155/ERC1155.sol)
pragma solidity >=0.8.13;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import "forge-std/console.sol";

error UnexpiredCommitmentExists(bytes32 commitment);

contract ETHRegistrar is Ownable {
    uint256 public immutable MAX_COMMIT_AGE;
    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;
    mapping(bytes32 => uint256) public commitments;

    constructor(uint256 maxCommitAge) Ownable(msg.sender) {
        // constructor
        MAX_COMMIT_AGE = maxCommitAge;
    }

    function commit(bytes32 commitment) public {
        console.log(block.timestamp);
        if (commitments[commitment] + MAX_COMMIT_AGE >= block.timestamp) {
            revert UnexpiredCommitmentExists(commitment);
        }
        commitments[commitment] = block.timestamp;
    }

    function register(string calldata label) public {
        // get labelhash
        bytes32 labelhash = keccak256(abi.encodePacked(label));
        // check if the name has been registered

        // check if a commit exists
        // check price
        // check if value > price
        // return excess value
    }

    function renew(bytes32 node) public {}

    function withdraw() public {
        payable(owner()).transfer(address(this).balance);
    }
}
