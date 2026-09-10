import {
  type Hex,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
} from "viem";
import { expect } from "vitest";

import { COIN_TYPE_ETH, dnsEncodeName, namehash, shortCoin } from "./utils.js";
import {
  MULTICALL_ABI,
  ADDR_ABI,
  PROFILE_ABI,
  V1_SETTER_ABI,
  V2_SETTER_ABI,
} from "./resolver-abis.js";

type StringRecord = { value: string };
type BytesRecord = { value: Hex };
export type HasAddressRecord = { coinType: bigint; exists: boolean };
export type PubkeyRecord = { x: Hex; y: Hex };
export type ErrorRecord = { call: Hex; answer: Hex };
export type TextRecord = StringRecord & { key: string };
export type DataRecord = BytesRecord & { key: string };
export type AddressRecord = BytesRecord & { coinType: bigint };
export type ABIRecord = BytesRecord & { contentType: bigint };
export type InterfaceRecord = BytesRecord & { selector: Hex };

export type KnownProfile = {
  title?: string;
  name: string;
  extended?: boolean;
  addresses?: AddressRecord[];
  hasAddresses?: HasAddressRecord[];
  texts?: TextRecord[];
  datas?: DataRecord[];
  contenthash?: BytesRecord;
  primary?: StringRecord;
  pubkey?: PubkeyRecord;
  interfaces?: InterfaceRecord[];
  abis?: ABIRecord[];
  errors?: ErrorRecord[];
};

export type KnownReverse = {
  title: string;
  expectError?: boolean;
  encodedAddress: Hex;
  coinType: bigint;
  expectPrimary?: boolean;
};

type Expected = {
  call: Hex;
  answer: Hex;
  expect(data: Hex): void;
  writeV1: Hex;
  writeV2: Hex;
};

export type KnownResolution = Expected & {
  desc: string;
};

export type KnownBundle = Expected & {
  resolutions: KnownResolution[];
  unbundleAnswers: (data: Hex) => readonly Hex[];
};

export function bundleCalls(resolutions: KnownResolution[]): KnownBundle {
  if (resolutions.length === 1) {
    return {
      ...resolutions[0],
      resolutions,
      unbundleAnswers: (x) => [x],
    };
  }
  const abi = MULTICALL_ABI;
  return {
    call: encodeFunctionData({
      abi,
      args: [resolutions.map((x) => x.call)],
    }),
    answer: encodeFunctionResult({
      abi,
      result: resolutions.map((x) => x.answer),
    }),
    resolutions,
    unbundleAnswers: (data) => decodeFunctionResult({ abi, data }),
    expect(answer) {
      const answers = this.unbundleAnswers(answer);
      expect(answers).toHaveLength(resolutions.length);
      resolutions.forEach((x, i) => {
        x.expect(answers[i]);
      });
    },
    writeV1: encodeFunctionData({
      abi,
      args: [resolutions.map((x) => x.writeV1).filter((x) => x.length > 2)],
    }),
    writeV2: encodeFunctionData({
      abi,
      args: [resolutions.map((x) => x.writeV2).filter((x) => x.length > 2)],
    }),
  };
}

export function makeResolutions(p: KnownProfile): KnownResolution[] {
  const resolutions: KnownResolution[] = [];
  const dnsName = dnsEncodeName(p.name);
  const node = namehash(p.name);
  if (p.addresses) {
    const functionName = "addr";
    for (const { coinType, value } of p.addresses) {
      if (coinType === COIN_TYPE_ETH) {
        const abi = ADDR_ABI;
        resolutions.push({
          desc: `${functionName}()`,
          call: encodeFunctionData({ abi, functionName, args: [node] }),
          answer: encodeFunctionResult({ abi, functionName, result: value }),
          expect(data) {
            const actual = decodeFunctionResult({ abi, functionName, data });
            expect(actual, this.desc).toStrictEqual(getAddress(value));
          },
          writeV1: encodeFunctionData({
            abi,
            functionName: "setAddr",
            args: [node, value],
          }),
          writeV2: encodeFunctionData({
            abi: V2_SETTER_ABI,
            functionName: "setAddress",
            args: [dnsName, coinType, value],
          }),
        });
      } else {
        const abi = PROFILE_ABI;
        resolutions.push({
          desc: `${functionName}(${shortCoin(coinType)})`,
          call: encodeFunctionData({
            abi,
            functionName,
            args: [node, coinType],
          }),
          answer: encodeFunctionResult({
            abi,
            functionName,
            result: value,
          }),
          expect(data) {
            const actual = decodeFunctionResult({
              abi,
              functionName,
              data,
            });
            expect(actual, this.desc).toStrictEqual(value.toLowerCase());
          },
          writeV1: encodeFunctionData({
            abi: V1_SETTER_ABI,
            functionName: "setAddr",
            args: [node, coinType, value],
          }),
          writeV2: encodeFunctionData({
            abi: V2_SETTER_ABI,
            functionName: "setAddress",
            args: [dnsName, coinType, value],
          }),
        });
      }
    }
  }
  if (p.hasAddresses) {
    const abi = PROFILE_ABI;
    const functionName = "hasAddr";
    for (const { coinType, exists } of p.hasAddresses) {
      resolutions.push({
        desc: `${functionName}(${shortCoin(coinType)})`,
        call: encodeFunctionData({
          abi,
          functionName,
          args: [node, coinType],
        }),
        answer: encodeFunctionResult({
          abi,
          functionName,
          result: exists,
        }),
        expect(data) {
          const actual = decodeFunctionResult({
            abi,
            functionName,
            data,
          });
          expect(actual, this.desc).toStrictEqual(exists);
        },
        writeV1: "0x",
        writeV2: "0x",
      });
    }
  }
  if (p.texts) {
    const abi = PROFILE_ABI;
    const functionName = "text";
    for (const { key, value } of p.texts) {
      resolutions.push({
        desc: `${functionName}(${key})`,
        call: encodeFunctionData({
          abi,
          functionName,
          args: [node, key],
        }),
        answer: encodeFunctionResult({
          abi,
          functionName,
          result: value,
        }),
        expect(data) {
          const actual = decodeFunctionResult({
            abi,
            functionName,
            data,
          });
          expect(actual, this.desc).toStrictEqual(value);
        },
        writeV1: encodeFunctionData({
          abi: V1_SETTER_ABI,
          functionName: "setText",
          args: [node, key, value],
        }),
        writeV2: encodeFunctionData({
          abi: V2_SETTER_ABI,
          functionName: "setText",
          args: [dnsName, key, value],
        }),
      });
    }
  }
  if (p.datas) {
    const functionName = "data";
    for (const { key, value } of p.datas) {
      resolutions.push({
        desc: `${functionName}(${key})`,
        call: encodeFunctionData({
          abi: PROFILE_ABI,
          functionName,
          args: [node, key],
        }),
        answer: encodeFunctionResult({
          abi: PROFILE_ABI,
          functionName,
          result: value,
        }),
        expect(data) {
          const actual = decodeFunctionResult({
            abi: PROFILE_ABI,
            functionName,
            data,
          });
          expect(actual, this.desc).toStrictEqual(value);
        },
        writeV1: encodeFunctionData({
          abi: V1_SETTER_ABI,
          functionName: "setData",
          args: [node, key, value],
        }),
        writeV2: encodeFunctionData({
          abi: V2_SETTER_ABI,
          functionName: "setData",
          args: [dnsName, key, value],
        }),
      });
    }
  }
  if (p.contenthash) {
    const functionName = "contenthash";
    const { value } = p.contenthash;
    resolutions.push({
      desc: `${functionName}()`,
      call: encodeFunctionData({
        abi: PROFILE_ABI,
        functionName,
        args: [node],
      }),
      answer: encodeFunctionResult({
        abi: PROFILE_ABI,
        functionName,
        result: value,
      }),
      expect(data) {
        const actual = decodeFunctionResult({
          abi: PROFILE_ABI,
          functionName,
          data,
        });
        expect(actual, this.desc).toStrictEqual(value);
      },
      writeV1: encodeFunctionData({
        abi: V1_SETTER_ABI,
        functionName: "setContenthash",
        args: [node, value],
      }),
      writeV2: encodeFunctionData({
        abi: V2_SETTER_ABI,
        functionName: "setContenthash",
        args: [dnsName, value],
      }),
    });
  }
  if (p.pubkey) {
    const functionName = "pubkey";
    const { x, y } = p.pubkey;
    resolutions.push({
      desc: `${functionName}()`,
      call: encodeFunctionData({
        abi: PROFILE_ABI,
        functionName,
        args: [node],
      }),
      answer: encodeFunctionResult({
        abi: PROFILE_ABI,
        functionName,
        result: [x, y],
      }),
      expect(data) {
        const actual = decodeFunctionResult({
          abi: PROFILE_ABI,
          functionName,
          data,
        });
        expect(actual, this.desc).toStrictEqual([x, y]);
      },
      writeV1: encodeFunctionData({
        abi: V1_SETTER_ABI,
        functionName: "setPubkey",
        args: [node, x, y],
      }),
      writeV2: "0x",
    });
  }
  if (p.primary) {
    const functionName = "name";
    const { value } = p.primary;
    resolutions.push({
      desc: `${functionName}()`,
      call: encodeFunctionData({
        abi: PROFILE_ABI,
        functionName,
        args: [node],
      }),
      answer: encodeFunctionResult({
        abi: PROFILE_ABI,
        functionName,
        result: value,
      }),
      expect(data) {
        const actual = decodeFunctionResult({
          abi: PROFILE_ABI,
          functionName,
          data,
        });
        expect(actual, this.desc).toStrictEqual(value);
      },
      writeV1: encodeFunctionData({
        abi: V1_SETTER_ABI,
        functionName: "setName",
        args: [node, value],
      }),
      writeV2: encodeFunctionData({
        abi: V2_SETTER_ABI,
        functionName: "setName",
        args: [dnsName, value],
      }),
    });
  }
  if (p.abis) {
    const functionName = "ABI";
    for (const { contentType, value } of p.abis) {
      resolutions.push({
        desc: `${functionName}(${contentType})`,
        call: encodeFunctionData({
          abi: PROFILE_ABI,
          functionName,
          args: [node, contentType],
        }),
        answer: encodeFunctionResult({
          abi: PROFILE_ABI,
          functionName,
          result: [contentType, value],
        }),
        expect(data) {
          const actual = decodeFunctionResult({
            abi: PROFILE_ABI,
            functionName,
            data,
          });
          expect(actual, this.desc).toStrictEqual([contentType, value]);
        },
        writeV1: encodeFunctionData({
          abi: V1_SETTER_ABI,
          functionName: "setABI",
          args: [node, contentType, value],
        }),
        writeV2: encodeFunctionData({
          abi: V2_SETTER_ABI,
          functionName: "setABI",
          args: [dnsName, contentType, value],
        }),
      });
    }
  }
  if (p.interfaces) {
    const functionName = "interfaceImplementer";
    for (const { selector, value } of p.interfaces) {
      resolutions.push({
        desc: `${functionName}(${selector})`,
        call: encodeFunctionData({
          abi: PROFILE_ABI,
          functionName,
          args: [node, selector],
        }),
        answer: encodeFunctionResult({
          abi: PROFILE_ABI,
          functionName,
          result: value,
        }),
        expect(data) {
          const actual = decodeFunctionResult({
            abi: PROFILE_ABI,
            functionName,
            data,
          });
          expect(actual, this.desc).toStrictEqual(value);
        },
        writeV1: encodeFunctionData({
          abi: V1_SETTER_ABI,
          functionName: "setInterface",
          args: [node, selector, value],
        }),
        writeV2: encodeFunctionData({
          abi: V2_SETTER_ABI,
          functionName: "setInterface",
          args: [dnsName, selector, value],
        }),
      });
    }
  }
  if (p.errors) {
    for (const { call, answer } of p.errors) {
      resolutions.push({
        desc: `error(${call.slice(0, 10)})`,
        call,
        answer,
        expect(data) {
          expect(data, this.desc).toStrictEqual(this.answer);
        },
        writeV1: "0x",
        writeV2: "0x",
      });
    }
  }
  return resolutions;
}
