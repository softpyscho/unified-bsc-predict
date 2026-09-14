# Phase 0 — Viability report

Generated 2026-09-14T19:17:11.257Z by `npx tsx scripts/viability/phase0.ts` (read-only; re-run to reproduce).

## Verdict

**No edge found.** 12 of 97 tested hypotheses are statistically significant after Benjamini–Hochberg correction, but none of the 58 tradable rules produces an out-of-sample net return whose 95% confidence interval is above zero after the treasury fee and measured gas. A direction-agnostic 0.01 BNB bettor needs a **51.53%** hit rate to break even; the control strategies lose -3.17% (random) to -2.95% (best single side) per bet. The research platform remains useful, but the live-execution phases are expected to be unprofitable.

## 1. Contract parameters (read live from chain)

| Parameter       | Value                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Contract        | `0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA` (PancakeSwap Prediction V2, BNB/USD, chain 56) |
| treasuryFee     | 300 bps                                                                                     |
| minBetAmount    | 0.001 BNB                                                                                   |
| intervalSeconds | 300                                                                                         |
| bufferSeconds   | 30                                                                                          |
| currentEpoch    | 515767                                                                                      |
| paused          | false                                                                                       |
| oracle          | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE`                                                |
| Read at         | 2026-09-14T19:16:34.741Z                                                                    |

## 2. Data and verification

515,765 final rounds (epochs 1–515765); the most recent 25,000 were synced directly from chain, older rounds came from the bsc-predict-updater archive. A deterministic sample was re-read from the contract and every settlement field compared: recent 200/200 identical, archive 200/200 identical.

## 3. Outcome distribution

**Full history** (515,765 rounds)

| Outcome   | Rounds  | Share   | 95% CI             |
| --------- | ------- | ------- | ------------------ |
| BULL      | 261,083 | 50.621% | 50.484% to 50.757% |
| BEAR      | 253,537 | 49.157% | 49.021% to 49.294% |
| TIE       | 884     | 0.171%  | 0.160% to 0.183%   |
| CANCELLED | 261     | 0.051%  | 0.045% to 0.057%   |

P(BULL | decided) = 50.733% (95% CI 50.597% to 50.870%; z-test vs 50%: p = 7.1e-26).

**Most recent 25,000** (25,000 rounds)

| Outcome   | Rounds | Share   | 95% CI             |
| --------- | ------ | ------- | ------------------ |
| BULL      | 12,428 | 49.712% | 49.092% to 50.332% |
| BEAR      | 12,557 | 50.228% | 49.608% to 50.848% |
| TIE       | 0      | 0.000%  | 0.000% to 0.015%   |
| CANCELLED | 15     | 0.060%  | 0.036% to 0.099%   |

P(BULL | decided) = 49.742% (95% CI 49.122% to 50.362%; z-test vs 50%: p = 0.4144).

## 4. Payout multipliers and house take

| Multiplier (final pools) | Rounds  | Mean  | p5    | p25   | Median | p75   | p95   |
| ------------------------ | ------- | ----- | ----- | ----- | ------ | ----- | ----- |
| Bull side                | 515,423 | 1.977 | 1.494 | 1.727 | 1.906  | 2.134 | 2.649 |
| Bear side                | 515,423 | 2.044 | 1.531 | 1.778 | 1.976  | 2.212 | 2.766 |
| Winning side (actual)    | 514,551 | 1.949 | 1.470 | 1.715 | 1.897  | 2.118 | 2.568 |
| Winning side, recent     | 24,985  | 1.948 | 1.522 | 1.720 | 1.899  | 2.124 | 2.525 |

House take actually realised: **3.215% of all BNB staked** (171064.6 of 5321103.6 BNB), versus the 3% fee. It exceeds the fee because ties pay nobody (895 rounds lost the whole pot, including 69 where nobody had backed the winning side) — recent: 2.999%. 102 rounds had an empty side; 250 rounds (cancellations) took nothing.

## 5. Gas and break-even accuracy

Measured from 300 recent bet receipts and 150 claim receipts: median gas price 0.052 gwei, bet 0.0000060 BNB, claim transaction 0.0000047 BNB (0.0000047 BNB per epoch when batched). On a 0.01 BNB stake, bet + claim gas is 0.107%.

| Stake     | Break-even hit rate at ×1.94 (balanced pools) | At the measured mean win multiplier ×1.942 |
| --------- | --------------------------------------------- | ------------------------------------------ |
| 0.001 BNB | 51.98%                                        | 51.92%                                     |
| 0.005 BNB | 51.63%                                        | 51.57%                                     |
| 0.01 BNB  | 51.59%                                        | 51.53%                                     |
| 0.1 BNB   | 51.55%                                        | 51.49%                                     |

**Headline: a direction-agnostic 0.01 BNB bettor needs a 51.53% hit rate to break even** (ties count as losses). Every strategy below is judged against its own break-even rate, computed from the multipliers it actually receives.

## 6. Controls — validates the cost model

Bets of 0.01 BNB every round, own stake added to the final pool, all gas charged. A random strategy must come out negative by roughly the house take; if it did not, the backtester would be broken.

| Rule                 | Bets    | Hit rate | Mean win × | Break-even hit rate | Net ROI | ROI 95% CI       | Edge? |
| -------------------- | ------- | -------- | ---------- | ------------------- | ------- | ---------------- | ----- |
| Always BULL (full)   | 515,765 | 50.65%   | 1.917      | 52.20%              | -2.97%  | -3.55% to -2.40% | no    |
| Always BEAR (full)   | 515,765 | 49.18%   | 1.975      | 50.68%              | -2.95%  | -3.23% to -2.67% | no    |
| Random (full)        | 515,765 | 49.90%   | 1.942      | 51.53%              | -3.17%  | -3.44% to -2.89% | no    |
| Always BULL (recent) | 25,000  | 49.74%   | 1.931      | 51.83%              | -4.03%  | -5.26% to -2.80% | no    |
| Always BEAR (recent) | 25,000  | 50.26%   | 1.927      | 51.94%              | -3.24%  | -4.46% to -2.01% | no    |
| Random (recent)      | 25,000  | 50.03%   | 1.929      | 51.87%              | -3.55%  | -4.77% to -2.32% | no    |

## 7. Sequence structure — transition matrices, orders 1–4

Train = first 70% of history (361,035 rounds), test = the rest. Baseline P(BULL) in train = 50.790%. **Lag 1** is the classic transition matrix (conditions on round n−1), but round n−1 is still running when round n takes bets, so it cannot be traded. **Lag 2** conditions only on rounds ≤ n−2 — what a bettor actually knows — and is traded out-of-sample: bet the side the training data favours.

| Lag | Context (oldest→newest) | Train n | P(BULL) train | p raw  | p BH   | P(BULL) test | OOS hit rate  | OOS break-even | OOS net ROI               | Edge?        |
| --- | ----------------------- | ------- | ------------- | ------ | ------ | ------------ | ------------- | -------------- | ------------------------- | ------------ |
| 1   | D                       | 177,139 | 50.28%        | 1.7e-5 | 0.0004 | 50.56%       | —             | —              | —                         | not tradable |
| 1   | U                       | 182,830 | 51.29%        | 2.3e-5 | 0.0004 | 50.64%       | —             | —              | —                         | not tradable |
| 1   | DD                      | 88,074  | 50.54%        | 0.1327 | 0.3430 | 50.50%       | —             | —              | —                         | not tradable |
| 1   | DU                      | 89,065  | 51.40%        | 0.0003 | 0.0038 | 50.80%       | —             | —              | —                         | not tradable |
| 1   | UD                      | 89,064  | 50.02%        | 4.9e-6 | 0.0002 | 50.62%       | —             | —              | —                         | not tradable |
| 1   | UU                      | 93,765  | 51.18%        | 0.0179 | 0.0993 | 50.48%       | —             | —              | —                         | not tradable |
| 1   | DDD                     | 43,564  | 50.53%        | 0.2861 | 0.4754 | 50.68%       | —             | —              | —                         | not tradable |
| 1   | DDU                     | 44,510  | 51.88%        | 3.8e-6 | 0.0002 | 51.70%       | —             | —              | —                         | not tradable |
| 1   | DUD                     | 43,286  | 49.77%        | 2.1e-5 | 0.0004 | 50.57%       | —             | —              | —                         | not tradable |
| 1   | DUU                     | 45,779  | 51.39%        | 0.0100 | 0.0690 | 50.94%       | —             | —              | —                         | not tradable |
| 1   | UDD                     | 44,510  | 50.54%        | 0.2892 | 0.4754 | 50.32%       | —             | —              | —                         | not tradable |
| 1   | UDU                     | 44,554  | 50.91%        | 0.6031 | 0.7405 | 49.92%       | —             | —              | —                         | not tradable |
| 1   | UUD                     | 45,778  | 50.27%        | 0.0250 | 0.1275 | 50.67%       | —             | —              | —                         | not tradable |
| 1   | UUU                     | 47,986  | 50.97%        | 0.4283 | 0.5691 | 50.03%       | —             | —              | —                         | not tradable |
| 1   | DDDD                    | 21,549  | 50.81%        | 0.9545 | 0.9697 | 51.41%       | —             | —              | —                         | not tradable |
| 1   | DDDU                    | 22,015  | 51.95%        | 0.0006 | 0.0067 | 51.48%       | —             | —              | —                         | not tradable |
| 1   | DDUD                    | 21,416  | 49.62%        | 0.0006 | 0.0067 | 51.48%       | —             | —              | —                         | not tradable |
| 1   | DDUU                    | 23,094  | 51.89%        | 0.0008 | 0.0082 | 50.99%       | —             | —              | —                         | not tradable |
| 1   | DUDD                    | 21,743  | 50.74%        | 0.8884 | 0.9266 | 50.26%       | —             | —              | —                         | not tradable |
| 1   | DUDU                    | 21,543  | 51.37%        | 0.0879 | 0.3278 | 50.81%       | —             | —              | —                         | not tradable |
| 1   | DUUD                    | 22,252  | 50.24%        | 0.1022 | 0.3305 | 51.06%       | —             | —              | —                         | not tradable |
| 1   | DUUU                    | 23,527  | 51.01%        | 0.5014 | 0.6316 | 50.87%       | —             | —              | —                         | not tradable |
| 1   | UDDD                    | 22,015  | 50.27%        | 0.1195 | 0.3430 | 49.98%       | —             | —              | —                         | not tradable |
| 1   | UDDU                    | 22,495  | 51.82%        | 0.0020 | 0.0176 | 51.92%       | —             | —              | —                         | not tradable |
| 1   | UDUD                    | 21,870  | 49.91%        | 0.0095 | 0.0690 | 49.72%       | —             | —              | —                         | not tradable |
| 1   | UDUU                    | 22,684  | 50.89%        | 0.7629 | 0.8409 | 50.89%       | —             | —              | —                         | not tradable |
| 1   | UUDD                    | 22,767  | 50.34%        | 0.1787 | 0.3940 | 50.39%       | —             | —              | —                         | not tradable |
| 1   | UUDU                    | 23,011  | 50.48%        | 0.3535 | 0.5195 | 49.05%       | —             | —              | —                         | not tradable |
| 1   | UUUD                    | 23,526  | 50.29%        | 0.1240 | 0.3430 | 50.29%       | —             | —              | —                         | not tradable |
| 1   | UUUU                    | 24,459  | 50.93%        | 0.6527 | 0.7720 | 49.19%       | —             | —              | —                         | not tradable |
| 2   | D                       | 177,187 | 50.97%        | 0.1318 | 0.3430 | 50.65%       | 50.65% (BULL) | 52.47%         | -3.48% (-4.17% to -2.79%) | no           |
| 2   | U                       | 182,781 | 50.62%        | 0.1379 | 0.3430 | 50.55%       | 50.55% (BULL) | 52.14%         | -3.05% (-3.74% to -2.36%) | no           |
| 2   | DD                      | 88,075  | 51.21%        | 0.0118 | 0.0766 | 51.20%       | 51.20% (BULL) | 52.99%         | -3.38% (-4.36% to -2.41%) | no           |
| 2   | DU                      | 89,022  | 50.61%        | 0.2787 | 0.4743 | 50.77%       | 50.77% (BULL) | 52.69%         | -3.65% (-4.61% to -2.68%) | no           |
| 2   | UD                      | 89,111  | 50.73%        | 0.7036 | 0.8125 | 50.11%       | 50.11% (BULL) | 51.97%         | -3.58% (-4.56% to -2.59%) | no           |
| 2   | UU                      | 93,759  | 50.62%        | 0.3097 | 0.4754 | 50.34%       | 50.34% (BULL) | 51.62%         | -2.47% (-3.44% to -1.49%) | no           |
| 2   | DDD                     | 43,563  | 51.38%        | 0.0141 | 0.0853 | 51.44%       | 51.44% (BULL) | 53.25%         | -3.40% (-4.78% to -2.02%) | no           |
| 2   | DDU                     | 44,487  | 50.81%        | 0.9403 | 0.9697 | 51.23%       | 51.23% (BULL) | 52.66%         | -2.70% (-4.08% to -1.32%) | no           |
| 2   | DUD                     | 43,306  | 51.04%        | 0.2960 | 0.4754 | 50.52%       | 50.52% (BULL) | 52.00%         | -2.86% (-4.26% to -1.46%) | no           |
| 2   | DUU                     | 45,768  | 50.64%        | 0.5205 | 0.6473 | 50.96%       | 50.96% (BULL) | 51.92%         | -1.86% (-3.24% to -0.47%) | no           |
| 2   | UDD                     | 44,512  | 51.05%        | 0.2665 | 0.4700 | 50.96%       | 50.96% (BULL) | 52.73%         | -3.36% (-4.74% to -1.98%) | no           |
| 2   | UDU                     | 44,534  | 50.41%        | 0.1092 | 0.3312 | 50.32%       | 50.32% (BULL) | 52.72%         | -4.57% (-5.93% to -3.21%) | no           |
| 2   | UUD                     | 45,805  | 50.43%        | 0.1219 | 0.3430 | 49.71%       | 49.71% (BULL) | 51.93%         | -4.28% (-5.66% to -2.89%) | no           |
| 2   | UUU                     | 47,991  | 50.61%        | 0.4281 | 0.5691 | 49.74%       | 49.74% (BULL) | 51.31%         | -3.06% (-4.45% to -1.68%) | no           |
| 2   | DDDD                    | 21,547  | 51.51%        | 0.0356 | 0.1625 | 51.90%       | 51.89% (BULL) | 53.48%         | -2.97% (-4.92% to -1.02%) | no           |
| 2   | DDDU                    | 22,012  | 51.25%        | 0.1690 | 0.3815 | 51.59%       | 51.59% (BULL) | 52.75%         | -2.19% (-4.14% to -0.24%) | no           |
| 2   | DDUD                    | 21,421  | 51.36%        | 0.0949 | 0.3304 | 51.38%       | 51.38% (BULL) | 52.27%         | -1.70% (-3.70% to 0.30%)  | no           |
| 2   | DDUU                    | 23,095  | 51.08%        | 0.3781 | 0.5473 | 51.12%       | 51.12% (BULL) | 52.00%         | -1.69% (-3.63% to 0.26%)  | no           |
| 2   | DUDD                    | 21,742  | 51.21%        | 0.2162 | 0.4187 | 51.75%       | 51.74% (BULL) | 52.81%         | -2.03% (-3.99% to -0.07%) | no           |
| 2   | DUDU                    | 21,537  | 50.74%        | 0.8839 | 0.9266 | 50.53%       | 50.53% (BULL) | 52.79%         | -4.29% (-6.23% to -2.35%) | no           |
| 2   | DUUD                    | 22,270  | 50.30%        | 0.1403 | 0.3430 | 49.80%       | 49.80% (BULL) | 52.02%         | -4.27% (-6.24% to -2.30%) | no           |
| 2   | DUUU                    | 23,522  | 50.91%        | 0.7238 | 0.8218 | 49.96%       | 49.96% (BULL) | 51.47%         | -2.93% (-4.88% to -0.98%) | no           |
| 2   | UDDD                    | 22,016  | 51.25%        | 0.1691 | 0.3815 | 51.00%       | 51.00% (BULL) | 53.03%         | -3.82% (-5.77% to -1.87%) | no           |
| 2   | UDDU                    | 22,475  | 50.37%        | 0.2091 | 0.4140 | 50.88%       | 50.88% (BULL) | 52.56%         | -3.21% (-5.16% to -1.25%) | no           |
| 2   | UDUD                    | 21,885  | 50.73%        | 0.8555 | 0.9208 | 49.71%       | 49.71% (BULL) | 51.75%         | -3.95% (-5.91% to -1.98%) | no           |
| 2   | UDUU                    | 22,672  | 50.19%        | 0.0704 | 0.2733 | 50.79%       | 50.79% (BULL) | 51.84%         | -2.03% (-3.99% to -0.06%) | no           |
| 2   | UUDD                    | 22,770  | 50.90%        | 0.7300 | 0.8218 | 50.20%       | 50.20% (BULL) | 52.65%         | -4.66% (-6.59% to -2.72%) | no           |
| 2   | UUDU                    | 22,997  | 50.10%        | 0.0369 | 0.1625 | 50.12%       | 50.12% (BULL) | 52.66%         | -4.83% (-6.75% to -2.92%) | no           |
| 2   | UUUD                    | 23,535  | 50.55%        | 0.4692 | 0.6151 | 49.62%       | 49.62% (BULL) | 51.84%         | -4.28% (-6.22% to -2.35%) | no           |
| 2   | UUUU                    | 24,469  | 50.32%        | 0.1453 | 0.3438 | 49.52%       | 49.52% (BULL) | 51.16%         | -3.20% (-5.17% to -1.24%) | no           |

## 8. Time of day (UTC hour of lock)

| Hour | Train n | P(BULL) train | p BH   | OOS side | OOS hit rate | OOS net ROI               | Edge? |
| ---- | ------- | ------------- | ------ | -------- | ------------ | ------------------------- | ----- |
| 0    | 14,907  | 50.98%        | 0.7720 | BULL     | 50.99%       | -2.33% (-4.73% to 0.08%)  | no    |
| 1    | 14,894  | 50.19%        | 0.3430 | BULL     | 49.16%       | -5.65% (-8.06% to -3.24%) | no    |
| 2    | 14,917  | 51.28%        | 0.4187 | BULL     | 50.95%       | -2.85% (-5.23% to -0.46%) | no    |
| 3    | 14,919  | 51.08%        | 0.6197 | BULL     | 51.13%       | -2.82% (-5.21% to -0.44%) | no    |
| 4    | 14,975  | 50.30%        | 0.4198 | BULL     | 49.25%       | -6.25% (-8.63% to -3.87%) | no    |
| 5    | 15,044  | 50.81%        | 0.9697 | BULL     | 51.33%       | -1.83% (-4.22% to 0.57%)  | no    |
| 6    | 15,017  | 51.08%        | 0.6197 | BULL     | 50.45%       | -3.72% (-6.10% to -1.34%) | no    |
| 7    | 15,024  | 50.46%        | 0.5691 | BULL     | 49.84%       | -4.68% (-7.07% to -2.28%) | no    |
| 8    | 15,041  | 51.32%        | 0.4005 | BULL     | 50.78%       | -3.14% (-5.54% to -0.75%) | no    |
| 9    | 15,076  | 51.20%        | 0.4754 | BULL     | 49.17%       | -5.92% (-8.31% to -3.53%) | no    |
| 10   | 15,045  | 50.05%        | 0.2733 | BULL     | 49.85%       | -4.81% (-7.19% to -2.42%) | no    |
| 11   | 15,099  | 50.87%        | 0.9188 | BULL     | 51.05%       | -1.91% (-4.32% to 0.49%)  | no    |
| 12   | 15,064  | 49.89%        | 0.1345 | BEAR     | 49.49%       | -3.27% (-5.72% to -0.82%) | no    |
| 13   | 15,055  | 50.12%        | 0.3305 | BULL     | 50.12%       | -4.12% (-6.51% to -1.74%) | no    |
| 14   | 15,013  | 50.11%        | 0.3304 | BULL     | 50.77%       | -2.77% (-5.16% to -0.38%) | no    |
| 15   | 15,023  | 50.46%        | 0.5691 | BULL     | 51.30%       | -1.36% (-3.76% to 1.04%)  | no    |
| 16   | 15,040  | 50.35%        | 0.4743 | BULL     | 50.29%       | -3.39% (-5.79% to -0.99%) | no    |
| 17   | 14,985  | 50.46%        | 0.5691 | BULL     | 51.31%       | -1.74% (-4.13% to 0.65%)  | no    |
| 18   | 15,021  | 50.79%        | 0.9972 | BULL     | 50.19%       | -3.99% (-6.38% to -1.61%) | no    |
| 19   | 14,988  | 51.31%        | 0.4140 | BULL     | 50.42%       | -3.49% (-5.89% to -1.10%) | no    |
| 20   | 14,973  | 51.21%        | 0.4754 | BULL     | 51.81%       | -1.35% (-3.73% to 1.03%)  | no    |
| 21   | 14,971  | 51.75%        | 0.0993 | BULL     | 52.50%       | -0.32% (-2.70% to 2.06%)  | no    |
| 22   | 14,950  | 51.98%        | 0.0293 | BULL     | 50.52%       | -3.39% (-5.78% to -0.99%) | no    |
| 23   | 14,929  | 50.93%        | 0.8218 | BULL     | 50.66%       | -3.33% (-5.72% to -0.94%) | no    |

## 9. Decision-time pools (reconstructed from BetBull/BetBear logs)

1,526 rounds (epochs 514238–515763) whose bet events sum exactly, to the wei, to the final Bull and Bear pools (1,527 rounds had events in the fetched window; the rest were incomplete at the window edges). Pools are rebuilt from events with block timestamp ≤ lockTimestamp − offset. Baseline P(BULL) in the sample: 48.36%.

### Decision at T−30s

- Late flow: on average **68.82%** of the final pool arrives after T−30s (median 70.84%).
- Imbalance vs outcome: corr(bull share at T−30s, BULL) = 0.0413 (n = 1526, p raw 0.1072, p BH 0.3312). For reference, the _final_ share (not available when betting) gives 0.1021.
- Slippage (realised − decision-time multiplier; medians, because a few near-empty sides make the means extreme): all sides 0.077, long-odds side -1.496, favourite side 0.576 (means -2.79 / -6.48 / 0.58). Late money flows into the side that looks cheap, pulling the pools back toward balance, so the long odds seen at decision time mostly evaporate by lock.

| Bull-share quintile | Rounds | P(BULL) | 95% CI           | p BH   |
| ------------------- | ------ | ------- | ---------------- | ------ |
| 1                   | 306    | 45.42%  | 39.94% to 51.03% | 0.4754 |
| 2                   | 305    | 49.51%  | 43.94% to 55.09% | 0.8048 |
| 3                   | 305    | 45.90%  | 40.39% to 51.51% | 0.5562 |
| 4                   | 305    | 48.85%  | 43.29% to 54.44% | 0.9208 |
| 5                   | 305    | 52.13%  | 46.53% to 57.68% | 0.3959 |

| Rule                                    | Bets  | Hit rate | Mean win × | Break-even hit rate | Net ROI | ROI 95% CI       | Edge? |
| --------------------------------------- | ----- | -------- | ---------- | ------------------- | ------- | ---------------- | ----- |
| Long-odds side at T−30s (whole sample)  | 1,526 | 48.36%   | 2.013      | 49.71%              | -2.71%  | -7.93% to 2.51%  | no    |
| Favourite side at T−30s (whole sample)  | 1,526 | 51.64%   | 1.868      | 53.57%              | -3.61%  | -8.41% to 1.20%  | no    |
| Long-odds side at T−30s (last 30%, OOS) | 458   | 48.25%   | 2.020      | 49.54%              | -2.60%  | -12.08% to 6.89% | no    |
| Favourite side at T−30s (last 30%, OOS) | 458   | 51.75%   | 1.880      | 53.23%              | -2.79%  | -11.61% to 6.02% | no    |

### Decision at T−10s

- Late flow: on average **43.81%** of the final pool arrives after T−10s (median 43.29%).
- Imbalance vs outcome: corr(bull share at T−10s, BULL) = 0.0313 (n = 1526, p raw 0.2211, p BH 0.4187). For reference, the _final_ share (not available when betting) gives 0.1021.
- Slippage (realised − decision-time multiplier; medians, because a few near-empty sides make the means extreme): all sides 0.000, long-odds side -0.859, favourite side 0.411 (means -1.13 / -2.70 / 0.43). Late money flows into the side that looks cheap, pulling the pools back toward balance, so the long odds seen at decision time mostly evaporate by lock.

| Bull-share quintile | Rounds | P(BULL) | 95% CI           | p BH   |
| ------------------- | ------ | ------- | ---------------- | ------ |
| 1                   | 306    | 47.06%  | 41.54% to 52.65% | 0.7720 |
| 2                   | 305    | 44.92%  | 39.43% to 50.53% | 0.4187 |
| 3                   | 305    | 51.15%  | 45.56% to 56.71% | 0.4929 |
| 4                   | 305    | 44.59%  | 39.11% to 50.20% | 0.3959 |
| 5                   | 305    | 54.10%  | 48.49% to 59.61% | 0.1897 |

| Rule                                    | Bets  | Hit rate | Mean win × | Break-even hit rate | Net ROI | ROI 95% CI        | Edge? |
| --------------------------------------- | ----- | -------- | ---------- | ------------------- | ------- | ----------------- | ----- |
| Long-odds side at T−10s (whole sample)  | 1,526 | 49.41%   | 2.035      | 49.19%              | 0.45%   | -4.82% to 5.72%   | no    |
| Favourite side at T−10s (whole sample)  | 1,526 | 50.59%   | 1.845      | 54.26%              | -6.76%  | -11.51% to -2.02% | no    |
| Long-odds side at T−10s (last 30%, OOS) | 458   | 48.47%   | 2.044      | 48.96%              | -1.00%  | -10.57% to 8.58%  | no    |
| Favourite side at T−10s (last 30%, OOS) | 458   | 51.53%   | 1.857      | 53.90%              | -4.39%  | -13.10% to 4.32%  | no    |

| Rule                      | Bets  | Hit rate | Mean win × | Break-even hit rate | Net ROI | ROI 95% CI        | Edge? |
| ------------------------- | ----- | -------- | ---------- | ------------------- | ------- | ----------------- | ----- |
| Always BULL (same sample) | 1,526 | 48.36%   | 1.945      | 51.46%              | -6.02%  | -11.07% to -0.98% | no    |
| Random (same sample)      | 1,526 | 47.05%   | 1.929      | 51.88%              | -9.32%  | -14.27% to -4.36% | no    |

## 10. Cancelled and unresolved rounds

261 of 515,765 rounds were cancelled (oracle not called in time; stakes refundable) — 0.051% (0.045% to 0.057%); recent: 15 (0.060%).

## 11. Hypothesis log and multiple-testing correction

97 hypotheses were tested; Benjamini–Hochberg is applied across all of them together. 12 survive at 5% FDR. Statistical significance is not profitability: a real but tiny bias still has to clear the break-even hit rate. The complete log (including every failure) is in `data/phase0/results.json`. Smallest raw p-values:

| Hypothesis | Family                        | n                             | Estimate | Baseline | p raw  | p BH    | Survives |
| ---------- | ----------------------------- | ----------------------------- | -------- | -------- | ------ | ------- | -------- |
| P(BULL     | decided) ≠ 0.5 (full history) | baseline                      | 514,620  | 0.5073   | 0.5000 | 7.1e-26 | 6.9e-24  | yes |
| P(BULL     | last 3 = DDU)                 | sequence (lag 1, statistical) | 44,510   | 0.5188   | 0.5079 | 3.8e-6  | 0.0002   | yes |
| P(BULL     | last 2 = UD)                  | sequence (lag 1, statistical) | 89,064   | 0.5002   | 0.5079 | 4.9e-6  | 0.0002   | yes |
| P(BULL     | last 1 = D)                   | sequence (lag 1, statistical) | 177,139  | 0.5028   | 0.5079 | 1.7e-5  | 0.0004   | yes |
| P(BULL     | last 3 = DUD)                 | sequence (lag 1, statistical) | 43,286   | 0.4977   | 0.5079 | 2.1e-5  | 0.0004   | yes |
| P(BULL     | last 1 = U)                   | sequence (lag 1, statistical) | 182,830  | 0.5129   | 0.5079 | 2.3e-5  | 0.0004   | yes |
| P(BULL     | last 2 = DU)                  | sequence (lag 1, statistical) | 89,065   | 0.5140   | 0.5079 | 0.0003  | 0.0038   | yes |
| P(BULL     | last 4 = DDDU)                | sequence (lag 1, statistical) | 22,015   | 0.5195   | 0.5079 | 0.0006  | 0.0067   | yes |
| P(BULL     | last 4 = DDUD)                | sequence (lag 1, statistical) | 21,416   | 0.4962   | 0.5079 | 0.0006  | 0.0067   | yes |
| P(BULL     | last 4 = DDUU)                | sequence (lag 1, statistical) | 23,094   | 0.5189   | 0.5079 | 0.0008  | 0.0082   | yes |
| P(BULL     | last 4 = UDDU)                | sequence (lag 1, statistical) | 22,495   | 0.5182   | 0.5079 | 0.0020  | 0.0176   | yes |
| P(BULL     | hour 22)                      | time of day (UTC)             | 14,950   | 0.5198   | 0.5079 | 0.0036  | 0.0293   | yes |
| P(BULL     | last 4 = UDUD)                | sequence (lag 1, statistical) | 21,870   | 0.4991   | 0.5079 | 0.0095  | 0.0690   | no  |
| P(BULL     | last 3 = DUU)                 | sequence (lag 1, statistical) | 45,779   | 0.5139   | 0.5079 | 0.0100  | 0.0690   | no  |
| P(BULL     | last 2 = DD)                  | sequence (lag 2, tradable)    | 88,075   | 0.5121   | 0.5079 | 0.0118  | 0.0766   | no  |
| P(BULL     | last 3 = DDD)                 | sequence (lag 2, tradable)    | 43,563   | 0.5138   | 0.5079 | 0.0141  | 0.0853   | no  |
| P(BULL     | last 2 = UU)                  | sequence (lag 1, statistical) | 93,765   | 0.5118   | 0.5079 | 0.0179  | 0.0993   | no  |
| P(BULL     | hour 21)                      | time of day (UTC)             | 14,971   | 0.5175   | 0.5079 | 0.0184  | 0.0993   | no  |
| P(BULL     | last 3 = UUD)                 | sequence (lag 1, statistical) | 45,778   | 0.5027   | 0.5079 | 0.0250  | 0.1275   | no  |
| P(BULL     | hour 12)                      | time of day (UTC)             | 15,064   | 0.4989   | 0.5079 | 0.0277  | 0.1345   | no  |

## 12. Limitations

- Open lead, not testable with this data: round n−1 is still running when round n takes bets, but its live price move is visible. The lag-1 matrix shows mild persistence — P(BULL | previous BULL) 51.29% vs P(BULL | previous BEAR) 50.28% in train (50.64% vs 50.56% in test) — so "bet the live round's current direction" is the most plausible remaining sequence signal. Testing it needs the Chainlink BNB/USD price at T−10s for every round (historical oracle updates), which Phase 0 did not collect. Even a perfect proxy for the previous outcome would land below the 51.53% break-even on these numbers.
- Decision-time pools come from 1,526 rounds: the only free RPC serving historical logs (https://rpc-bsc.48.club) prunes old blocks. The platform's worker should record every bet event live (`round_pool_events`) so this sample grows continuously; a paid archive RPC could backfill it.
- Payouts model this bettor's own dilution of the final pool, but not other bettors reacting to it.
- T−10s assumes the bet transaction is mined before lock; with ~0.45 s blocks that is realistic but not guaranteed.
- Outcome and sequence statistics use the full history; the archive portion was spot-checked against chain (section 2), not fully re-read.
- Only single-rule strategies were tested here; combinations and parameter searches belong to the Phase 14 discovery engine, which must count every configuration it tries in the multiple-testing budget.
