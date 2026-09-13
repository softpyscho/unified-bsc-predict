// Generated from bsc-predict-bot/contracts/*.json (the prediction ABI is byte-identical in all three
// source repositories). Only functions used by this application are kept.

export const predictionV2Abi = [
  {
    "name": "betBear",
    "type": "function",
    "stateMutability": "payable",
    "inputs": [
      {
        "name": "epoch",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": []
  },
  {
    "name": "betBull",
    "type": "function",
    "stateMutability": "payable",
    "inputs": [
      {
        "name": "epoch",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": []
  },
  {
    "name": "bufferSeconds",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "claim",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "epochs",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "outputs": []
  },
  {
    "name": "claimable",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "epoch",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ]
  },
  {
    "name": "currentEpoch",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "getUserRounds",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "cursor",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "size",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct PancakePredictionV2.BetInfo[]",
        "components": [
          {
            "name": "position",
            "type": "uint8",
            "internalType": "enum PancakePredictionV2.Position"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "claimed",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "getUserRoundsLength",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "intervalSeconds",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "ledger",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "position",
        "type": "uint8",
        "internalType": "enum PancakePredictionV2.Position"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "claimed",
        "type": "bool",
        "internalType": "bool"
      }
    ]
  },
  {
    "name": "minBetAmount",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "oracle",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract AggregatorV3Interface"
      }
    ]
  },
  {
    "name": "paused",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ]
  },
  {
    "name": "refundable",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "epoch",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ]
  },
  {
    "name": "rounds",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "epoch",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "startTimestamp",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "lockTimestamp",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "closeTimestamp",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "lockPrice",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "closePrice",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "lockOracleId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "closeOracleId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "totalAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bullAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "bearAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "rewardBaseCalAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "rewardAmount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "oracleCalled",
        "type": "bool",
        "internalType": "bool"
      }
    ]
  },
  {
    "name": "treasuryFee",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;

export const chainlinkOracleAbi = [
  {
    "name": "decimals",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ]
  },
  {
    "name": "description",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "name": "latestRoundData",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "roundId",
        "type": "uint80",
        "internalType": "uint80"
      },
      {
        "name": "answer",
        "type": "int256",
        "internalType": "int256"
      },
      {
        "name": "startedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "updatedAt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "answeredInRound",
        "type": "uint80",
        "internalType": "uint80"
      }
    ]
  }
] as const;
