// SPDX-License-Identifier: MIT
// Portions from OpenZeppelin Contracts (last updated v5.0.0) (token/ERC1155/ERC1155.sol)
pragma solidity >=0.8.13;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ETHRegistry} from "../registry/ETHRegistry.sol";
import {IRegistry} from "../registry/IRegistry.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {StringUtils} from "../utils/StringUtils.sol";

error UnexpiredCommitmentExists(bytes32 commitment);
error ResolverRequiredWhenDataSupplied();
error InsufficientValue();
error DurationTooShort(uint64 duration);
error CommitmentTooNew(bytes32 commitment);
error CommitmentTooOld(bytes32 commitment);
error NameNotAvailable(string label);
error NameExpired(bytes32 labelHash);

contract ETHRegistrar is Ownable {
    using StringUtils for string;

    uint256 public immutable MIN_COMMIT_AGE;
    uint256 public immutable MAX_COMMIT_AGE;
    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;
    mapping(bytes32 => uint256) public commitments;
    bytes32 public constant ETH_LABELHASH = keccak256(abi.encodePacked("eth"));
    ETHRegistry public registry;
    IPriceOracle public prices;

    event NameRegistered(
        string label,
        bytes32 labelHash,
        address owner,
        uint256 base,
        uint256 premium,
        uint256 expires
    );

    event NameRenewed(
        string label,
        bytes32 indexed labelHash,
        uint256 cost,
        uint256 expires
    );

    event CommitmentMade(bytes32 commitment, uint256 timestamp);

    constructor(
        ETHRegistry _registry,
        IPriceOracle _prices,
        uint256 _minCommitAge,
        uint256 _maxCommitAge
    ) Ownable(msg.sender) {
        // constructor
        prices = _prices;
        registry = _registry;
        MIN_COMMIT_AGE = _minCommitAge;
        MAX_COMMIT_AGE = _maxCommitAge;
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
        emit CommitmentMade(commitment, block.timestamp);
    }

    function available(string memory label) public view returns (bool) {
        (uint64 expiry, ) = registry.nameData(uint256(keccak256(bytes(label))));
        return expiry < block.timestamp;
    }

    function rentPrice(
        string memory name,
        uint256 duration
    ) public view returns (IPriceOracle.Price memory price) {
        bytes32 label = keccak256(bytes(name));
        (uint64 expiry, ) = registry.nameData(uint256(label));
        price = prices.price(name, expiry, duration);
    }

    function register(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes[] calldata data,
        bytes32 secret
    ) public payable {
        _consumeCommitment(
            label,
            duration,
            makeCommitment(label, owner, duration, resolver, data, secret)
        );

        // check if msg.value given is enough
        IPriceOracle.Price memory price = rentPrice(label, duration);
        if (msg.value < price.base + price.premium) {
            revert InsufficientValue();
        }

        // Todo add setRecords
        // Todo set ENS chain reverse

        uint64 expires = uint64(block.timestamp) + duration;

        registry.register(label, msg.sender, registry, 0, expires);

        emit NameRegistered(
            label,
            keccak256(bytes(label)),
            owner,
            price.base,
            price.premium,
            expires
        );

        // send back excess
        if (msg.value > (price.base + price.premium)) {
            payable(msg.sender).transfer(
                msg.value - (price.base + price.premium)
            );
        }
    }

    function renew(string calldata label, uint64 duration) public payable {
        bytes32 labelHash = keccak256(bytes(label));
        // Get current expiry of name
        (uint64 currentExpiry, ) = registry.nameData(uint256(labelHash));
        if (currentExpiry < block.timestamp) {
            revert NameExpired(labelHash);
        }

        // Calculate new expiry
        uint64 expires = currentExpiry + duration;

        // Check if the provided value is sufficient
        IPriceOracle.Price memory price = rentPrice(label, duration);
        if (msg.value < price.base + price.premium) {
            revert InsufficientValue();
        }
        registry.renew(uint256(labelHash), expires);
        emit NameRenewed(label, labelHash, duration, expires);
    }

    function withdraw() public {
        payable(owner()).transfer(address(this).balance);
    }

    function valid(string memory label) public pure returns (bool) {
        return label.strlen() >= 3;
    }

    /* Internal functions */

    function _consumeCommitment(
        string memory label,
        uint64 duration,
        bytes32 commitment
    ) internal {
        // Require an old enough commitment.
        if (commitments[commitment] + MIN_COMMIT_AGE > block.timestamp) {
            revert CommitmentTooNew(commitment);
        }

        // If the commitment is too old, or the name is registered, stop
        if (commitments[commitment] + MAX_COMMIT_AGE <= block.timestamp) {
            revert CommitmentTooOld(commitment);
        }
        if (!available(label)) {
            revert NameNotAvailable(label);
        }

        delete (commitments[commitment]);

        if (duration < MIN_REGISTRATION_DURATION) {
            revert DurationTooShort(duration);
        }
    }
}
