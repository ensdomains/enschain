// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface IERC1155Singleton is IERC1155 {
    function ownerOf(uint256 id) external view returns (address owner);
}
