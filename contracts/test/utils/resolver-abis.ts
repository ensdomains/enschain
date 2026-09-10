import { parseAbi } from "viem";

export const MULTICALL_ABI = parseAbi([
  "function multicall(bytes[] calls) external view returns (bytes[])",
]);

export const ADDR_ABI = parseAbi([
  "function addr(bytes32) external view returns (address)",
  "function setAddr(bytes32, address) external",
]);

export const PROFILE_ABI = parseAbi([
  "function ABI(bytes32, uint256 contentTypes) external view returns (uint256, bytes memory)",
  "function addr(bytes32, uint256 coinType) external view returns (bytes)",
  "function contenthash(bytes32) external view returns (bytes)",
  "function data(bytes32, string key) external view returns (bytes)",
  "function hasAddr(bytes32, uint256 coinType) external view returns (bool)",
  "function interfaceImplementer(bytes32, bytes4 interfaceID) external view returns (address)",
  "function name(bytes32) external view returns (string)",
  "function pubkey(bytes32) external view returns (bytes32, bytes32)",
  "function text(bytes32, string key) external view returns (string)",
]);

export const V1_SETTER_ABI = parseAbi([
  "function setABI(bytes32, uint256 contentType, bytes data) external",
  "function setAddr(bytes32, uint256 coinType, bytes value) external",
  "function setContenthash(bytes32, bytes value) external",
  "function setData(bytes32, string key, bytes value) external",
  "function setInterface(bytes32, bytes4 interfaceID, address implementer) external",
  "function setName(bytes32, string name) external",
  "function setPubkey(bytes32, bytes32 x, bytes32 y) external",
  "function setText(bytes32, string key, string value) external",
]);

export const V2_SETTER_ABI = parseAbi([
  "function setABI(bytes, uint256 contentType, bytes data) external",
  "function setAddress(bytes, uint256 coinType, bytes value) external",
  "function setContenthash(bytes, bytes value) external",
  "function setData(bytes, string key, bytes value) external",
  "function setInterface(bytes, bytes4 interfaceID, address implementer) external",
  "function setName(bytes, string name) external",
  "function setText(bytes, string key, string value) external",
]);
