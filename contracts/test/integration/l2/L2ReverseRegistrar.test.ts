import { shouldSupportInterfaces } from "@ensdomains/hardhat-chai-matchers-viem/behaviour";
import hre from "hardhat";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  serializeErc6492Signature,
  type Address,
} from "viem";
import { optimism } from "viem/chains";
import { describe, expect, it } from "vitest";
import { dnsEncodeName, namehash } from "../../utils/utils.js";
import { deployUniversalSigValidator } from "../fixtures/deployUniversalSigValidator.js";

const connection = await hre.network.connect();

// Chain ID for Optimism - used to construct coin type
const OPTIMISM_CHAIN_ID = BigInt(optimism.id);
// Coin type format: 0x80000000 | chainId (see ENSIP-11)
const COIN_TYPE = 0x80000000n | OPTIMISM_CHAIN_ID;
// Label is the hex representation of the coin type
const COIN_TYPE_LABEL = COIN_TYPE.toString(16);
// `8000000a.reverse`
const PARENT_NAMESPACE = `${COIN_TYPE_LABEL}.reverse`;

/**
 * Converts a Unix timestamp to ISO 8601 format (matching LibISO8601.sol)
 * Format: YYYY-MM-DDTHH:MM:SSZ
 */
function timestampToISO8601(timestamp: bigint): string {
  const date = new Date(Number(timestamp) * 1000);
  return date.toISOString().replace(".000Z", "Z");
}

/**
 * Creates the plaintext message for setNameForAddrWithSignature
 * This must match the format in L2ReverseRegistrar._createClaimMessageHash (owner == address(0))
 */
function createNameForAddrMessage({
  name,
  address,
  chainIds,
  signedAt,
}: {
  name: string;
  address: Address;
  chainIds: bigint[];
  signedAt: bigint;
}): string {
  const chainIdsString = chainIds.map((id) => id.toString()).join(", ");
  const signedAtString = timestampToISO8601(signedAt);

  return `You are setting your ENS primary name to:
${name}

Address: ${getAddress(address)}
Chains: ${chainIdsString}
Signed At: ${signedAtString}`;
}

/**
 * Creates the plaintext message for setNameForContractWithSignature
 * This must match the format in L2ReverseRegistrar._createClaimMessageHash (owner != address(0))
 */
function createNameForOwnableMessage({
  name,
  contractAddress,
  owner,
  chainIds,
  signedAt,
}: {
  name: string;
  contractAddress: Address;
  owner: Address;
  chainIds: bigint[];
  signedAt: bigint;
}): string {
  const chainIdsString = chainIds.map((id) => id.toString()).join(", ");
  const signedAtString = timestampToISO8601(signedAt);

  return `You are setting the ENS primary name for a contract you own to:
${name}

Contract Address: ${getAddress(contractAddress)}
Owner: ${getAddress(owner)}
Chains: ${chainIdsString}
Signed At: ${signedAtString}`;
}

async function fixture() {
  const accounts = await connection.viem
    .getWalletClients()
    .then((clients) => clients.map((c) => c.account));

  await deployUniversalSigValidator(connection);

  const l2ReverseRegistrar = await connection.viem.deployContract(
    // Use fully qualified name to ensure the correct contract is deployed
    "src/reverse-registrar/L2ReverseRegistrar.sol:L2ReverseRegistrar",
    [OPTIMISM_CHAIN_ID, COIN_TYPE_LABEL],
  );
  const mockSmartContractAccount = await connection.viem.deployContract(
    "MockSmartContractWallet",
    [accounts[0].address],
  );
  const mockOwnableSca = await connection.viem.deployContract("MockOwnable", [
    mockSmartContractAccount.address,
  ]);
  const mockErc6492WalletFactory = await connection.viem.deployContract(
    "MockERC6492WalletFactory",
  );
  const mockOwnableEoa = await connection.viem.deployContract("MockOwnable", [
    accounts[0].address,
  ]);

  /**
   * Helper function to get the name for an address
   * Since v2 uses name(bytes32 node) instead of nameForAddr(address)
   */
  async function getNameForAddr(addr: Address): Promise<string> {
    const node = namehash(`${addr.slice(2).toLowerCase()}.${PARENT_NAMESPACE}`);
    return l2ReverseRegistrar.read.name([node]);
  }

  return {
    l2ReverseRegistrar,
    mockSmartContractAccount,
    mockErc6492WalletFactory,
    mockOwnableSca,
    mockOwnableEoa,
    accounts,
    getNameForAddr,
  };
}

const loadFixture = async () => connection.networkHelpers.loadFixture(fixture);

describe("L2ReverseRegistrar", () => {
  shouldSupportInterfaces({
    contract: () =>
      loadFixture().then(({ l2ReverseRegistrar }) => l2ReverseRegistrar),
    interfaces: [
      "src/reverse-registrar/interfaces/IL2ReverseRegistrar.sol:IL2ReverseRegistrar",
      "IExtendedResolver",
      "INameResolver",
      "IERC165",
    ],
  });

  it("should deploy the contract", async () => {
    const { l2ReverseRegistrar } = await loadFixture();

    expect(l2ReverseRegistrar.address).not.toBeUndefined();
  });

  it("should have correct CHAIN_ID set", async () => {
    const { l2ReverseRegistrar } = await loadFixture();

    const chainId = await l2ReverseRegistrar.read.CHAIN_ID();
    expect(chainId).toStrictEqual(OPTIMISM_CHAIN_ID);
  });

  describe("setName", () => {
    async function setNameFixture() {
      const initial = await loadFixture();

      const name = "myname.eth";

      return {
        ...initial,
        name,
      };
    }

    it("should set the name record for the calling account", async () => {
      const { l2ReverseRegistrar, name, accounts, getNameForAddr } =
        await connection.networkHelpers.loadFixture(setNameFixture);

      await l2ReverseRegistrar.write.setName([name]);

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        name,
      );
    });

    it("event NameChanged is emitted", async () => {
      const { l2ReverseRegistrar, name } =
        await connection.networkHelpers.loadFixture(setNameFixture);

      await expect(l2ReverseRegistrar.write.setName([name])).toEmitEvent(
        "NameChanged",
      );
    });

    it("can update the name record", async () => {
      const { l2ReverseRegistrar, name, accounts, getNameForAddr } =
        await connection.networkHelpers.loadFixture(setNameFixture);

      await l2ReverseRegistrar.write.setName([name]);
      const newName = "newname.eth";
      await l2ReverseRegistrar.write.setName([newName]);

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        newName,
      );
    });

    it("can set the name to an empty string", async () => {
      const { l2ReverseRegistrar, name, accounts, getNameForAddr } =
        await connection.networkHelpers.loadFixture(setNameFixture);

      await l2ReverseRegistrar.write.setName([name]);
      await l2ReverseRegistrar.write.setName([""]);

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        "",
      );
    });
  });

  describe("setNameForAddr", () => {
    async function setNameForAddrFixture() {
      const initial = await loadFixture();

      const name = "myname.eth";

      return {
        ...initial,
        name,
      };
    }

    it("should set the name record for a contract the caller owns", async () => {
      const { l2ReverseRegistrar, name, mockOwnableEoa, getNameForAddr } =
        await connection.networkHelpers.loadFixture(setNameForAddrFixture);

      await l2ReverseRegistrar.write.setNameForAddr([
        mockOwnableEoa.address,
        name,
      ]);

      await expect(
        getNameForAddr(mockOwnableEoa.address),
      ).resolves.toStrictEqual(name);
    });

    it("event NameChanged is emitted", async () => {
      const { l2ReverseRegistrar, name, mockOwnableEoa } =
        await connection.networkHelpers.loadFixture(setNameForAddrFixture);

      await expect(
        l2ReverseRegistrar.write.setNameForAddr([mockOwnableEoa.address, name]),
      ).toEmitEvent("NameChanged");
    });

    it("caller can set their own name", async () => {
      const { l2ReverseRegistrar, name, accounts, getNameForAddr } =
        await connection.networkHelpers.loadFixture(setNameForAddrFixture);

      await l2ReverseRegistrar.write.setNameForAddr([
        accounts[0].address,
        name,
      ]);

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        name,
      );
    });

    it("reverts if the caller is not the owner of the target address", async () => {
      const { l2ReverseRegistrar, name, accounts, mockOwnableEoa } =
        await connection.networkHelpers.loadFixture(setNameForAddrFixture);

      await expect(
        l2ReverseRegistrar.write.setNameForAddr(
          [mockOwnableEoa.address, name],
          { account: accounts[1] },
        ),
      )
        .toBeRevertedWithCustomError("UnauthorizedNamer")
        .withArgs([getAddress(accounts[1].address)]);
    });

    it("reverts if caller tries to set name for another EOA", async () => {
      const { l2ReverseRegistrar, name, accounts } =
        await connection.networkHelpers.loadFixture(setNameForAddrFixture);

      await expect(
        l2ReverseRegistrar.write.setNameForAddr([accounts[1].address, name]),
      )
        .toBeRevertedWithCustomError("UnauthorizedNamer")
        .withArgs([getAddress(accounts[0].address)]);
    });

    it("reverts if caller is not owner of the target contract (via Ownable)", async () => {
      const { l2ReverseRegistrar, name, accounts, mockOwnableSca } =
        await connection.networkHelpers.loadFixture(setNameForAddrFixture);

      // mockOwnableSca is owned by mockSmartContractAccount, not accounts[0]
      await expect(
        l2ReverseRegistrar.write.setNameForAddr([mockOwnableSca.address, name]),
      )
        .toBeRevertedWithCustomError("UnauthorizedNamer")
        .withArgs([getAddress(accounts[0].address)]);
    });
  });

  describe("setNameForAddrWithSignature", () => {
    async function setNameForAddrWithSignatureFixture() {
      const initial = await loadFixture();
      const { l2ReverseRegistrar, accounts } = initial;

      const name = "myname.eth";

      const publicClient = await connection.viem.getPublicClient();
      const blockTimestamp = await publicClient
        .getBlock()
        .then((b) => b.timestamp);
      const signedAt = blockTimestamp;

      const [walletClient] = await connection.viem.getWalletClients();

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      return {
        ...initial,
        message,
        name,
        signedAt,
        signature,
        walletClient,
      };
    }

    it("allows an account to sign a message to allow a relayer to claim the address", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        signature,
        accounts,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForAddrWithSignatureFixture,
      );

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).not.toBeReverted();

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        name,
      );
    });

    it("event NameChanged is emitted", async () => {
      const { l2ReverseRegistrar, name, signedAt, signature, accounts } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toEmitEvent("NameChanged");
    });

    it("allows SCA signatures (ERC1271)", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockSmartContractAccount,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForAddrWithSignatureFixture,
      );

      const message = createNameForAddrMessage({
        name,
        address: mockSmartContractAccount.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockSmartContractAccount.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toEmitEvent("NameChanged");

      await expect(
        getNameForAddr(mockSmartContractAccount.address),
      ).resolves.toStrictEqual(name);
    });

    it("allows undeployed SCA signatures (ERC6492)", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockErc6492WalletFactory,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForAddrWithSignatureFixture,
      );

      const predictedAddress =
        await mockErc6492WalletFactory.read.predictAddress([
          accounts[0].address,
        ]);

      const message = createNameForAddrMessage({
        name,
        address: predictedAddress,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const wrappedSignature = serializeErc6492Signature({
        address: mockErc6492WalletFactory.address,
        data: encodeFunctionData({
          abi: mockErc6492WalletFactory.abi,
          functionName: "createWallet",
          args: [accounts[0].address],
        }),
        signature,
      });

      const claim = {
        name,
        addr: predictedAddress,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, wrappedSignature],
          { account: accounts[1] },
        ),
      ).toEmitEvent("NameChanged");

      await expect(getNameForAddr(predictedAddress)).resolves.toStrictEqual(
        name,
      );
    });

    it("reverts if signature parameters do not match", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      // Sign with different name
      const message = createNameForAddrMessage({
        name: "different.eth",
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name, // Original name
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toBeRevertedWithCustomError("InvalidSignature");
    });

    it("reverts if signedAt is in the future", async () => {
      const { l2ReverseRegistrar, name, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const publicClient = await connection.viem.getPublicClient();
      const blockTimestamp = await publicClient
        .getBlock()
        .then((b) => b.timestamp);
      const futureTime = blockTimestamp + 3600n; // 1 hour in the future

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: futureTime,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: futureTime,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toBeRevertedWithCustomError("SignatureNotValidYet");
    });

    it("reverts if signedAt is not after inception", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        walletClient,
        signature,
      } = await connection.networkHelpers.loadFixture(
        setNameForAddrWithSignatureFixture,
      );

      // First, use the signature to establish an inception
      const claim1 = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await l2ReverseRegistrar.write.setNameForAddrWithSignature(
        [claim1, signature],
        { account: accounts[1] },
      );

      // Try to use a signature with the same signedAt (should fail)
      const newName = "newname.eth";
      const message2 = createNameForAddrMessage({
        name: newName,
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature2 = await walletClient.signMessage({
        message: message2,
      });

      const claim2 = {
        name: newName,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim2, signature2],
          { account: accounts[1] },
        ),
      ).toBeRevertedWithCustomError("StaleSignature");
    });

    it("allows multiple chain IDs in array (must be ascending)", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForAddrWithSignatureFixture,
      );

      const chainIds = [1n, OPTIMISM_CHAIN_ID, 8453n, 42161n]; // ETH (1), Optimism (10), Base (8453), Arbitrum (42161) - ascending order

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds,
        signedAt,
      };

      await l2ReverseRegistrar.write.setNameForAddrWithSignature(
        [claim, signature],
        { account: accounts[1] },
      );

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        name,
      );
    });

    it("allows large chain ID array with approx. linear gas scaling", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const getClaimAndSig = async (length: number) => {
        const chainIds = Array.from({ length }, (_, i) => BigInt(i) + 1n);
        if (length === 1) chainIds[0] = OPTIMISM_CHAIN_ID;

        const message = createNameForAddrMessage({
          name,
          address: accounts[0].address,
          chainIds,
          signedAt,
        });

        const signature = await walletClient.signMessage({
          message,
        });

        const claim = {
          name,
          addr: accounts[0].address,
          chainIds,
          signedAt,
        };

        return [claim, signature] as const;
      };

      const amounts = [1, 25, 50, 100, 200, 400, 800, 1600];
      const gasUseds = await Promise.all(
        amounts.map(async (length) => {
          const [claim, signature] = await getClaimAndSig(length);
          const gas =
            await l2ReverseRegistrar.estimateGas.setNameForAddrWithSignature(
              [claim, signature],
              { account: accounts[1] },
            );
          return { gas, gasPerEach: Number((gas - 99_650n) / BigInt(length)) };
        }),
      );

      for (let i = 1; i < gasUseds.length; i++) {
        expect(gasUseds[i].gasPerEach).toBeLessThan(
          gasUseds[i - 1].gasPerEach * 1.15,
        );
      }
    });

    it("reverts if chain IDs are not in ascending order", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const chainIds = [1n, 42161n, OPTIMISM_CHAIN_ID, 8453n]; // Not ascending: 1, 42161, 10, 8453

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toBeRevertedWithCustomError("ChainIdsNotAscending");
    });

    it("reverts if chain IDs contain duplicates", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const chainIds = [1n, OPTIMISM_CHAIN_ID, OPTIMISM_CHAIN_ID, 42161n]; // Duplicate: 10 appears twice

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toBeRevertedWithCustomError("ChainIdsNotAscending");
    });

    it("reverts if current chain ID is not in array", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const chainIds = [1n, 8453n, 42161n]; // ETH, Base, Arbitrum - ascending order, NO Optimism

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      )
        .toBeRevertedWithCustomError("CurrentChainNotFound")
        .withArgs([OPTIMISM_CHAIN_ID]);
    });

    it("reverts if chain ID array is empty", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const chainIds: bigint[] = [];

      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      )
        .toBeRevertedWithCustomError("CurrentChainNotFound")
        .withArgs([OPTIMISM_CHAIN_ID]);
    });

    it("reverts if the same signature is used twice (replay protection)", async () => {
      const { l2ReverseRegistrar, name, signedAt, signature, accounts } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      // First call should succeed
      await l2ReverseRegistrar.write.setNameForAddrWithSignature(
        [claim, signature],
        { account: accounts[1] },
      );

      // Second call with same signature should fail (signedAt not after inception)
      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[1] },
        ),
      ).toBeRevertedWithCustomError("StaleSignature");
    });

    it("allows newer signatures with later signedAt for same address", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForAddrWithSignatureFixture,
      );

      // First signature
      const message1 = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature1 = await walletClient.signMessage({
        message: message1,
      });

      const claim1 = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim1, signature1],
          { account: accounts[1] },
        ),
      ).not.toBeReverted();

      // Mine a block to advance time
      await connection.networkHelpers.mine(1);
      const publicClient = await connection.viem.getPublicClient();
      const newBlockTimestamp = await publicClient
        .getBlock()
        .then((b) => b.timestamp);

      // Second signature with newer signedAt should work
      const newName = "updated.eth";
      const message2 = createNameForAddrMessage({
        name: newName,
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: newBlockTimestamp,
      });

      const signature2 = await walletClient.signMessage({
        message: message2,
      });

      const claim2 = {
        name: newName,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: newBlockTimestamp,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim2, signature2],
          { account: accounts[1] },
        ),
      ).not.toBeReverted();

      await expect(getNameForAddr(accounts[0].address)).resolves.toStrictEqual(
        newName,
      );
    });

    it("reverts if signed by wrong account", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      const [, secondWalletClient] = await connection.viem.getWalletClients();

      // Sign with account[1] but claim is for account[0]
      const message = createNameForAddrMessage({
        name,
        address: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await secondWalletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForAddrWithSignature(
          [claim, signature],
          { account: accounts[2] },
        ),
      ).toBeRevertedWithCustomError("InvalidSignature");
    });

    it("updates and returns inception correctly", async () => {
      const { l2ReverseRegistrar, name, signedAt, signature, accounts } =
        await connection.networkHelpers.loadFixture(
          setNameForAddrWithSignatureFixture,
        );

      // Check initial inception is 0
      const initialInception = await l2ReverseRegistrar.read.inceptionOf([
        accounts[0].address,
      ]);
      expect(initialInception).toStrictEqual(0n);

      const claim = {
        name,
        addr: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await l2ReverseRegistrar.write.setNameForAddrWithSignature(
        [claim, signature],
        { account: accounts[1] },
      );

      // Check inception is updated
      const updatedInception = await l2ReverseRegistrar.read.inceptionOf([
        accounts[0].address,
      ]);
      expect(updatedInception).toStrictEqual(signedAt);
    });
  });

  describe("setNameForContractWithSignature", () => {
    async function setNameForContractWithSignatureFixture() {
      const initial = await loadFixture();
      const { l2ReverseRegistrar } = initial;

      const name = "ownable.eth";

      const publicClient = await connection.viem.getPublicClient();
      const blockTimestamp = await publicClient
        .getBlock()
        .then((b) => b.timestamp);
      const signedAt = blockTimestamp;

      const [walletClient] = await connection.viem.getWalletClients();

      return {
        ...initial,
        name,
        signedAt,
        walletClient,
      };
    }

    it("allows an EOA to sign a message to claim the address of a contract it owns via Ownable", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).toEmitEvent("NameChanged");

      await expect(
        getNameForAddr(mockOwnableEoa.address),
      ).resolves.toStrictEqual(name);
    });

    it("allows an SCA to sign a message to claim the address of a contract it owns via Ownable", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableSca,
        mockSmartContractAccount,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableSca.address,
        owner: mockSmartContractAccount.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableSca.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, mockSmartContractAccount.address, signature],
          { account: accounts[9] },
        ),
      ).toEmitEvent("NameChanged");

      await expect(
        getNameForAddr(mockOwnableSca.address),
      ).resolves.toStrictEqual(name);
    });

    it("reverts if the owner address is not the owner of the contract", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, mockOwnableEoa } =
        await connection.networkHelpers.loadFixture(
          setNameForContractWithSignatureFixture,
        );

      const [, secondWalletClient] = await connection.viem.getWalletClients();

      // Sign with accounts[1] and claim they own mockOwnableEoa
      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[1].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await secondWalletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[1].address, signature],
          { account: accounts[9] },
        ),
      )
        .toBeRevertedWithCustomError("UnauthorizedNamer")
        .withArgs([getAddress(accounts[1].address)]);
    });

    it("reverts if the target address is not a contract (is an EOA)", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForContractWithSignatureFixture,
        );

      // Try to claim for EOA account[2] saying account[0] owns it
      const message = createNameForOwnableMessage({
        name,
        contractAddress: accounts[2].address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: accounts[2].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      )
        .toBeRevertedWithCustomError("UnauthorizedNamer")
        .withArgs([getAddress(accounts[0].address)]);
    });

    it("reverts if the target address does not implement Ownable", async () => {
      const { l2ReverseRegistrar, name, signedAt, accounts, walletClient } =
        await connection.networkHelpers.loadFixture(
          setNameForContractWithSignatureFixture,
        );

      // L2ReverseRegistrar itself does not implement Ownable
      const message = createNameForOwnableMessage({
        name,
        contractAddress: l2ReverseRegistrar.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: l2ReverseRegistrar.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      )
        .toBeRevertedWithCustomError("UnauthorizedNamer")
        .withArgs([getAddress(accounts[0].address)]);
    });

    it("reverts if the signature is invalid", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      // Sign with different signedAt
      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: signedAt - 100n,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt, // Original signedAt
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).toBeRevertedWithCustomError("InvalidSignature");
    });

    it("reverts if signedAt is in the future", async () => {
      const {
        l2ReverseRegistrar,
        name,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const publicClient = await connection.viem.getPublicClient();
      const blockTimestamp = await publicClient
        .getBlock()
        .then((b) => b.timestamp);
      const futureTime = blockTimestamp + 3600n; // 1 hour in the future

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: futureTime,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt: futureTime,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).toBeRevertedWithCustomError("SignatureNotValidYet");
    });

    it("reverts if signedAt is not after inception", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      // First call should succeed
      await l2ReverseRegistrar.write.setNameForContractWithSignature(
        [claim, accounts[0].address, signature],
        { account: accounts[9] },
      );

      // Try to use a signature with the same signedAt (should fail)
      const newName = "newname.eth";
      const message2 = createNameForOwnableMessage({
        name: newName,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature2 = await walletClient.signMessage({
        message: message2,
      });

      const claim2 = {
        name: newName,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim2, accounts[0].address, signature2],
          { account: accounts[9] },
        ),
      ).toBeRevertedWithCustomError("StaleSignature");
    });

    it("allows multiple chain IDs in array (must be ascending)", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
        getNameForAddr,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const chainIds = [1n, OPTIMISM_CHAIN_ID, 8453n, 42161n]; // Ascending order

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).toEmitEvent("NameChanged");

      await expect(
        getNameForAddr(mockOwnableEoa.address),
      ).resolves.toStrictEqual(name);
    });

    it("allows large chain ID array with approx. linear gas scaling", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const getClaimAndSig = async (length: number) => {
        const chainIds = Array.from({ length }, (_, i) => BigInt(i) + 1n);
        if (length === 1) chainIds[0] = OPTIMISM_CHAIN_ID;

        const message = createNameForOwnableMessage({
          name,
          contractAddress: mockOwnableEoa.address,
          owner: accounts[0].address,
          chainIds,
          signedAt,
        });

        const signature = await walletClient.signMessage({
          message,
        });

        const claim = {
          name,
          addr: mockOwnableEoa.address,
          chainIds,
          signedAt,
        };

        return [claim, signature] as const;
      };

      const amounts = [1, 25, 50, 100, 200, 400, 800, 1600];
      const gasUseds = await Promise.all(
        amounts.map(async (length) => {
          const [claim, signature] = await getClaimAndSig(length);
          const gas =
            await l2ReverseRegistrar.estimateGas.setNameForContractWithSignature(
              [claim, accounts[0].address, signature],
              { account: accounts[9] },
            );
          return { gas, gasPerEach: Number((gas - 114_300n) / BigInt(length)) };
        }),
      );

      for (let i = 1; i < gasUseds.length; i++) {
        expect(gasUseds[i].gasPerEach).toBeLessThan(
          gasUseds[i - 1].gasPerEach * 1.15,
        );
      }
    });

    it("reverts if chain IDs are not in ascending order", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const chainIds = [1n, 42161n, OPTIMISM_CHAIN_ID, 8453n]; // Not ascending

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).toBeRevertedWithCustomError("ChainIdsNotAscending");
    });

    it("reverts if current chain ID is not in array", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const chainIds = [1n, 8453n, 42161n]; // Ascending order, No Optimism

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      )
        .toBeRevertedWithCustomError("CurrentChainNotFound")
        .withArgs([OPTIMISM_CHAIN_ID]);
    });

    it("reverts if chain ID array is empty", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const chainIds: bigint[] = [];

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds,
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds,
        signedAt,
      };

      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      )
        .toBeRevertedWithCustomError("CurrentChainNotFound")
        .withArgs([OPTIMISM_CHAIN_ID]);
    });

    it("reverts if the same signature is used twice (replay protection)", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      // First call should succeed
      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).not.toBeReverted();

      // Second call with same signature should fail (signedAt not after inception)
      await expect(
        l2ReverseRegistrar.write.setNameForContractWithSignature(
          [claim, accounts[0].address, signature],
          { account: accounts[9] },
        ),
      ).toBeRevertedWithCustomError("StaleSignature");
    });

    it("updates and returns inception correctly", async () => {
      const {
        l2ReverseRegistrar,
        name,
        signedAt,
        accounts,
        mockOwnableEoa,
        walletClient,
      } = await connection.networkHelpers.loadFixture(
        setNameForContractWithSignatureFixture,
      );

      // Check initial inception is 0
      const initialInception = await l2ReverseRegistrar.read.inceptionOf([
        mockOwnableEoa.address,
      ]);
      expect(initialInception).toStrictEqual(0n);

      const message = createNameForOwnableMessage({
        name,
        contractAddress: mockOwnableEoa.address,
        owner: accounts[0].address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      });

      const signature = await walletClient.signMessage({
        message,
      });

      const claim = {
        name,
        addr: mockOwnableEoa.address,
        chainIds: [OPTIMISM_CHAIN_ID],
        signedAt,
      };

      await l2ReverseRegistrar.write.setNameForContractWithSignature(
        [claim, accounts[0].address, signature],
        { account: accounts[9] },
      );

      // Check inception is updated
      const updatedInception = await l2ReverseRegistrar.read.inceptionOf([
        mockOwnableEoa.address,
      ]);
      expect(updatedInception).toStrictEqual(signedAt);
    });
  });

  describe("name (reading reverse records)", () => {
    it("returns empty string for unset address", async () => {
      const { accounts, getNameForAddr } = await loadFixture();

      await expect(getNameForAddr(accounts[5].address)).resolves.toStrictEqual(
        "",
      );
    });
  });

  describe("resolve", () => {
    async function resolveFixture() {
      const initial = await loadFixture();
      const { l2ReverseRegistrar, accounts } = initial;

      const name = "test.eth";
      await l2ReverseRegistrar.write.setName([name], {
        account: accounts[0],
      });

      return {
        ...initial,
        name,
      };
    }

    it("can resolve name for an address via resolve()", async () => {
      const { l2ReverseRegistrar, name, accounts } =
        await connection.networkHelpers.loadFixture(resolveFixture);

      const addressString = accounts[0].address.slice(2).toLowerCase();

      const coinTypeLabel = COIN_TYPE_LABEL;
      const reverseLabel = "reverse";
      const fullName = `${addressString}.${coinTypeLabel}.${reverseLabel}`;

      const dnsEncodedName = dnsEncodeName(fullName);
      const node = namehash(fullName);
      const calldata = encodeFunctionData({
        abi: l2ReverseRegistrar.abi,
        functionName: "name",
        args: [node],
      });

      const result = await l2ReverseRegistrar.read.resolve([
        dnsEncodedName,
        calldata,
      ]);

      const resultName = decodeFunctionResult({
        abi: l2ReverseRegistrar.abi,
        functionName: "name",
        data: result,
      });

      expect(resultName).toStrictEqual(name);
    });
  });
});
