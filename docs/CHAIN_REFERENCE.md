# Blockchain reference — PancakeSwap Prediction V2 (BNB/USD)

Generated 2026-09-14T19:53:04.837Z by `npx tsx scripts/verify/chain.ts`. Everything below was read or simulated on BNB Smart Chain at block 121896970 (read-only: `eth_call`, `eth_estimateGas`, `eth_getLogs`; no transaction was sent).

Contract source: PancakeSwap's [PancakePredictionV2.sol](https://github.com/pancakeswap/pancake-smart-contracts/blob/master/projects/predictions/v2/contracts/PancakePredictionV2.sol); line numbers below refer to it. Behaviour was verified by simulation against the deployed contract; the deployed bytecode was not byte-compared with a compilation of that source.

## 1. Expected vs verified

| Item              | Brief expects     | Chain                                                  | Match |
| ----------------- | ----------------- | ------------------------------------------------------ | ----- |
| Chain id          | 56                | 56                                                     | yes   |
| Contract has code | yes               | yes (21561 bytes)                                      | yes   |
| Round interval    | 300 s             | 300 s                                                  | yes   |
| Treasury fee      | 300 bps           | 300 bps (cap 1000 bps)                                 | yes   |
| Oracle            | Chainlink BNB/USD | BNB / USD (0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE) | yes   |

## 2. Parameters and roles (live)

| Name                  | Value                                        |
| --------------------- | -------------------------------------------- |
| treasuryFee           | `300`                                        |
| MAX_TREASURY_FEE      | `1000`                                       |
| minBetAmount          | `1000000000000000`                           |
| intervalSeconds       | `300`                                        |
| bufferSeconds         | `30`                                         |
| oracle                | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` |
| oracleUpdateAllowance | `300`                                        |
| oracleLatestRoundId   | `55340232221132086429`                       |
| paused                | `false`                                      |
| genesisStartOnce      | `true`                                       |
| genesisLockOnce       | `true`                                       |
| currentEpoch          | `515774`                                     |
| owner                 | `0x21835332cBDf1b3530fAE9f6Cd66FEB9477dFC02` |
| adminAddress          | `0xB509DBeE68B273767Cd8D45c1Ce95453391741f6` |
| operatorAddress       | `0xF5B4C4E9e8fB4b0cc961197b6C512C66dCf55E01` |
| treasuryAmount        | `6102774732071042475`                        |

Measured block time: **0.450 s** (average over the last 100,000 blocks). Current gas price: 0.05 gwei.

## 3. Round struct (`rounds(currentEpoch − 2)`)

| #   | Field               | Value                  |
| --- | ------------------- | ---------------------- |
| 0   | epoch               | `515772`               |
| 1   | startTimestamp      | `1789414808`           |
| 2   | lockTimestamp       | `1789415108`           |
| 3   | closeTimestamp      | `1789415414`           |
| 4   | lockPrice           | `72615668430`          |
| 5   | closePrice          | `72597751000`          |
| 6   | lockOracleId        | `55340232221132086419` |
| 7   | closeOracleId       | `55340232221132086429` |
| 8   | totalAmount         | `1722339117266574416`  |
| 9   | bullAmount          | `1105868999999399921`  |
| 10  | bearAmount          | `616470117267174495`   |
| 11  | rewardBaseCalAmount | `616470117267174495`   |
| 12  | rewardAmount        | `1670668943748577184`  |
| 13  | oracleCalled        | `true`                 |

## 4. Round lifecycle and timing

- `lockTimestamp − startTimestamp` over the last 25,001 rounds: min 300, max 300 s; `closeTimestamp − lockTimestamp`: min 300, max 330 s.
- The operator's `executeRound` locks round n, closes round n−1 and starts round n+1 in one transaction. Round n+1's `startTimestamp` is therefore the actual lock time, and locking resets round n's `closeTimestamp` to actual lock + interval (line 584). Lock latency (actual − scheduled lock): median 6.0 s, p95 12.0 s, max 1826.0 s over 25,000 consecutive pairs; 8 exceeded `bufferSeconds` (30 s).
- Because each round starts when the previous one actually locks, the schedule drifts by that latency every round; strategies must use the round's own timestamps, never `epoch × 300`.
- Bets are accepted only for `currentEpoch` while `startTimestamp < block.timestamp < lockTimestamp` (lines 158–159, 637–643; verified below: the previous and next epochs both revert).
- Ties: 884 rounds in the database; 884 of them have `rewardBaseCalAmount = rewardAmount = 0` — `claimable` is false for everyone and the whole pot goes to the treasury (lines 477–479, 526–531).
- Cancellations: 261 rounds were never oracle-called; after `closeTimestamp + bufferSeconds` every stake is refundable through `claim` (lines 222–225, 493–501).

## 5. Oracle

- Proxy `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` → "BNB / USD", 8 decimals, version 6, phase 3, current aggregator `0xa6E8fEe84f9Bd528aD71917c9DdbB1fd3214f280`.
- Latest answer 725.7090 USD, updated 32 s before block 121896970.
- Update cadence over the last 20,000 blocks: 272 updates; gap between updates median 33.0 s, p95 34.0 s, max 37.0 s; median move per update 0.016%.
- `executeRound` reads one oracle answer and uses it both to lock round n and to close round n−1 (lines 249–256), so consecutive rounds share a price print: round n's lock price is round n−1's close price.
- The answer must carry a round id greater than `oracleLatestRoundId` (lines 653–656). If the feed has not published since the previous `executeRound`, the call reverts; if that lasts past `bufferSeconds`, the round can no longer be locked or closed and is cancelled.
- `oracleUpdateAllowance` (300 s) only rejects answers timestamped more than that far _in the future_ (lines 650–652). It does **not** bound staleness: an old answer with a new round id is accepted.

## 6. Functions

| Function                                                                        | Mutability | Who calls it                  |
| ------------------------------------------------------------------------------- | ---------- | ----------------------------- |
| `MAX_TREASURY_FEE()`                                                            | view       | anyone (config view)          |
| `adminAddress()`                                                                | view       | anyone (config view)          |
| `betBear(uint256 epoch)`                                                        | payable    | bettors / readers             |
| `betBull(uint256 epoch)`                                                        | payable    | bettors / readers             |
| `bufferSeconds()`                                                               | view       | anyone (config view)          |
| `claim(uint256[] epochs)`                                                       | nonpayable | bettors / readers             |
| `claimTreasury()`                                                               | nonpayable | owner / admin / operator only |
| `claimable(uint256 epoch, address user)`                                        | view       | bettors / readers             |
| `currentEpoch()`                                                                | view       | bettors / readers             |
| `executeRound()`                                                                | nonpayable | owner / admin / operator only |
| `genesisLockOnce()`                                                             | view       | anyone (config view)          |
| `genesisLockRound()`                                                            | nonpayable | owner / admin / operator only |
| `genesisStartOnce()`                                                            | view       | anyone (config view)          |
| `genesisStartRound()`                                                           | nonpayable | owner / admin / operator only |
| `getUserRounds(address user, uint256 cursor, uint256 size)`                     | view       | bettors / readers             |
| `getUserRoundsLength(address user)`                                             | view       | bettors / readers             |
| `intervalSeconds()`                                                             | view       | anyone (config view)          |
| `ledger(uint256, address)`                                                      | view       | bettors / readers             |
| `minBetAmount()`                                                                | view       | anyone (config view)          |
| `operatorAddress()`                                                             | view       | anyone (config view)          |
| `oracle()`                                                                      | view       | anyone (config view)          |
| `oracleLatestRoundId()`                                                         | view       | anyone (config view)          |
| `oracleUpdateAllowance()`                                                       | view       | anyone (config view)          |
| `owner()`                                                                       | view       | anyone (config view)          |
| `pause()`                                                                       | nonpayable | owner / admin / operator only |
| `paused()`                                                                      | view       | anyone (config view)          |
| `recoverToken(address _token, uint256 _amount)`                                 | nonpayable | owner / admin / operator only |
| `refundable(uint256 epoch, address user)`                                       | view       | bettors / readers             |
| `renounceOwnership()`                                                           | nonpayable | owner / admin / operator only |
| `rounds(uint256)`                                                               | view       | bettors / readers             |
| `setAdmin(address _adminAddress)`                                               | nonpayable | owner / admin / operator only |
| `setBufferAndIntervalSeconds(uint256 _bufferSeconds, uint256 _intervalSeconds)` | nonpayable | owner / admin / operator only |
| `setMinBetAmount(uint256 _minBetAmount)`                                        | nonpayable | owner / admin / operator only |
| `setOperator(address _operatorAddress)`                                         | nonpayable | owner / admin / operator only |
| `setOracle(address _oracle)`                                                    | nonpayable | owner / admin / operator only |
| `setOracleUpdateAllowance(uint256 _oracleUpdateAllowance)`                      | nonpayable | owner / admin / operator only |
| `setTreasuryFee(uint256 _treasuryFee)`                                          | nonpayable | owner / admin / operator only |
| `transferOwnership(address newOwner)`                                           | nonpayable | owner / admin / operator only |
| `treasuryAmount()`                                                              | view       | anyone (config view)          |
| `treasuryFee()`                                                                 | view       | anyone (config view)          |
| `unpause()`                                                                     | nonpayable | owner / admin / operator only |
| `userRounds(address, uint256)`                                                  | view       | bettors / readers             |

## 7. Events

| Event                                                                                                                 | topic0                                                               |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `BetBear(address indexed sender, uint256 indexed epoch, uint256 amount)`                                              | `0x0d8c1fe3e67ab767116a81f122b83c2557a8c2564019cb7c4f83de1aeb1f1f0d` |
| `BetBull(address indexed sender, uint256 indexed epoch, uint256 amount)`                                              | `0x438122d8cff518d18388099a5181f0d17a12b4f1b55faedf6e4a6acee0060c12` |
| `Claim(address indexed sender, uint256 indexed epoch, uint256 amount)`                                                | `0x34fcbac0073d7c3d388e51312faf357774904998eeb8fca628b9e6f65ee1cbf7` |
| `EndRound(uint256 indexed epoch, uint256 indexed roundId, int256 price)`                                              | `0xb6ff1fe915db84788cbbbc017f0d2bef9485fad9fd0bd8ce9340fde0d8410dd8` |
| `LockRound(uint256 indexed epoch, uint256 indexed roundId, int256 price)`                                             | `0x482e76a65b448a42deef26e99e58fb20c85e26f075defff8df6aa80459b39006` |
| `NewAdminAddress(address admin)`                                                                                      | `0x137b621413925496477d46e5055ac0d56178bdd724ba8bf843afceef18268ba3` |
| `NewBufferAndIntervalSeconds(uint256 bufferSeconds, uint256 intervalSeconds)`                                         | `0xe60149e0431fec12df63dfab5fce2a9cefe9a4d3df5f41cb626f579ae1f2b91a` |
| `NewMinBetAmount(uint256 indexed epoch, uint256 minBetAmount)`                                                        | `0x90eb87c560a0213754ceb3a7fa3012f01acab0a35602c1e1995adf69dabc9d50` |
| `NewOperatorAddress(address operator)`                                                                                | `0xc47d127c07bdd56c5ccba00463ce3bd3c1bca71b4670eea6e5d0c02e4aa156e2` |
| `NewOracle(address oracle)`                                                                                           | `0xb3eacd0e351fafdfefdec84e1cd19679b38dbcd63ea7c2c24da17fd2bc3b3c0e` |
| `NewOracleUpdateAllowance(uint256 oracleUpdateAllowance)`                                                             | `0x93ccaceac092ffb842c46b8718667a13a80e9058dcd0bd403d0b47215b30da07` |
| `NewTreasuryFee(uint256 indexed epoch, uint256 treasuryFee)`                                                          | `0xb1c4ee38d35556741133da7ff9b6f7ab0fa88d0406133126ff128f635490a857` |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`                                       | `0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0` |
| `Pause(uint256 indexed epoch)`                                                                                        | `0x68b095021b1f40fe513109f513c66692f0b3219aee674a69f4efc57badb8201d` |
| `Paused(address account)`                                                                                             | `0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258` |
| `RewardsCalculated(uint256 indexed epoch, uint256 rewardBaseCalAmount, uint256 rewardAmount, uint256 treasuryAmount)` | `0x6dfdfcb09c8804d0058826cd2539f1acfbe3cb887c9be03d928035bce0f1a58d` |
| `StartRound(uint256 indexed epoch)`                                                                                   | `0x939f42374aa9bf1d8d8cd56d8a9110cb040cd8dfeae44080c6fcf2645e51b452` |
| `TokenRecovery(address indexed token, uint256 amount)`                                                                | `0x14f11966a996e0629572e51064726d2057a80fbd34efc066682c06a71dbb6e98` |
| `TreasuryClaim(uint256 amount)`                                                                                       | `0xb9197c6b8e21274bd1e2d9c956a88af5cfee510f630fab3f046300f88b422361` |
| `Unpause(uint256 indexed epoch)`                                                                                      | `0xaaa520fdd7d2c83061d632fa017b0432407e798818af63ea908589fceda39ab7` |
| `Unpaused(address account)`                                                                                           | `0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa` |

## 8. Guard verification (simulated with `eth_call`)

Balance override for the probe address is supported by the RPC.

| Guard                            | Call                                                         | Expected                         | Observed                                                | Source lines     | Pass |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------- | ---------------- | ---- |
| Valid bet                        | betBull(currentEpoch) with minBetAmount                      | succeeds while the round is open | succeeds                                                | 158–161, 637–643 | yes  |
| Minimum bet                      | betBull(currentEpoch) with minBetAmount − 1 wei              | reverts                          | reverts: "Bet amount must be greater than minBetAmount" | 160              | yes  |
| Previous epoch                   | betBull(currentEpoch − 1)                                    | reverts (locked)                 | reverts: "Bet is too early/late"                        | 158              | yes  |
| Future epoch                     | betBull(currentEpoch + 1)                                    | reverts (not started)            | reverts: "Bet is too early/late"                        | 158              | yes  |
| Contracts blocked                | betBull from Multicall3 (a contract)                         | reverts                          | reverts: "Contract not allowed"                         | 115–116          | yes  |
| One bet per epoch                | betBear(515774) from 0x400d3b37…, who already bet that epoch | reverts                          | reverts: "Can only bet once per round"                  | 161              | yes  |
| Claim before close               | claim([currentEpoch])                                        | reverts                          | reverts: "Round has not ended"                          | 211–212          | yes  |
| Claim without a bet              | claim([515770]) from a non-participant                       | reverts                          | reverts: "Not eligible for claim"                       | 218, 474–486     | yes  |
| Winner can claim                 | claimable(515770, winner)                                    | true                             | true                                                    | 474–486          | yes  |
| Loser cannot claim               | claimable(515770, loser)                                     | false                            | false                                                   | 474–486          | yes  |
| Resolved round is not refundable | refundable(515770, loser)                                    | false                            | false                                                   | 493–501          | yes  |

## 9. Gas

- `betBull`: 121513 gas ≈ 0.00000608 BNB at 0.05 gwei.
- `claim([epoch])` for one winning epoch: 99075 gas ≈ 0.00000495 BNB. Batching several epochs in one `claim` amortises the base cost.
- Receipt-measured medians from real bets and claims are in docs/VIABILITY_REPORT.md section 5.

## 10. Discrepancies found

- **Oracle address.** bsc-predict-bot (`config.py:14`) and bsc-prediction-market (`src/contracts/oracle.ts:2`) hard-code `0xD276fCF34D54A926773c399eBAa772C12ec394aC`; the contract's `oracle()` returns `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE`. This repository reads it from the contract.
- **Gas.** The brief's example (§0.2) assumes ~0.0003 BNB of bet + claim gas; at today's 0.05 gwei it is ~0.00001103 BNB, so gas is no longer a material drag on a 0.01 BNB stake.
- **Block time.** 0.45 s per block today; T−10 s is ~22 blocks before lock.
- **Late pool flow.** The brief (§0.5) expects late money to chase the favourite; the Phase 0 sample shows the opposite — late money flows into the side that looks cheap (docs/VIABILITY_REPORT.md section 9). The conclusion that decision-time multipliers overstate realised ones holds either way.
- **Buffer semantics.** bsc-predict-bot treated `bufferSeconds` as a delay after `startTimestamp`; on chain it is the window after `lockTimestamp` / `closeTimestamp` within which the operator must lock or close the round.
