# AGENTS.md — Unified BSC Predict Agent Guidelines

## 1. Project Overview & Architecture

`unified-bsc-predict` is a production-oriented TypeScript modular monolith for PancakeSwap's BNB/USD Prediction market on BNB Smart Chain (BSC). It unifies prediction tracking, betting automation, historical data archival, risk management, and portfolio analytics into a single process with one canonical PostgreSQL database (embedded PGlite by default, or any `postgres://` server such as Supabase).

### Monorepo Structure

```
unified-bsc-predict/
├── packages/core/         # Pure domain logic (ZERO I/O, no DB, no network, shared by server & web)
│   └── src/               # units, round, trade state machine, risk engine, portfolio, backtest, strategy pipeline
├── apps/server/           # Node.js service (HTTP API, SSE, worker daemon, CLI, PostgreSQL, viem chain client)
│   └── src/               # api, chain, db (async Db, migrations, SQLite importer), repositories, services, cli.ts, app.ts
├── apps/web/              # Vite + React operator dashboard (built to apps/web/dist, served by apps/server)
├── docs/                  # In-depth architectural & operational documentation
└── scripts/               # Utility scripts (check-secrets.mjs, dev-dashboard.mjs)
```

### Core Architecture Principles

- **Modular Monolith**: Ingestion, strategy evaluation, execution, and settlement run in one Node.js process to share atomic state and avoid distributed consensus issues.
- **Canonical Store**: PostgreSQL (PGlite or `pg`) behind the async `Db` in `apps/server/src/db/database.ts`: ACID transactions (savepoints when nested), PL/pgSQL triggers, `NUMERIC(78,0)` wei. Every repository call is async; never leave a query promise un-awaited inside `db.tx` (ESLint `no-floating-promises` enforces this).
- **Event-Driven**: In-process event bus distributes round and trade lifecycle events to the SSE stream (`/api/stream`).
- **Paper Trading by Default**: Live execution with real funds is strictly disabled unless explicitly armed and gated.

---

## 2. Critical Invariants & Safety Rules (Zero-Tolerance)

### 2.1 Financial Math & Precision

- **Wei Precision**: All BNB and token monetary amounts MUST be represented as `bigint` wei in memory and stored as `NUMERIC(78,0)` in PostgreSQL (read back as a decimal string, converted to `bigint`).
- **NO Floating-Point for Money**: NEVER use JavaScript `number` (floats) for balance checks, stake amounts, payouts, or P&L. Floating-point math causes binary rounding drift.
- **Oracle Prices**: Chainlink oracle prices are integer-scaled by 8 decimals (`1e8`, `PRICE_SCALE = 100_000_000`).
- **Exact Contract Formulas**: Payouts must mirror `PancakePredictionV2.claim()` byte-for-byte:
  $$\text{payout} = \lfloor (\text{amount} \times \text{rewardAmount}) / \text{rewardBaseCalAmount} \rfloor$$
- **Own-Stake Dilution**: In paper and backtest modes, simulated stakes MUST be added into the round pool to model market impact and payout dilution.

### 2.2 Security & Secret Handling

- **Automated Secret Scan**: `scripts/check-secrets.mjs` runs on `npm run validate`. Never commit `.env` or files matching private key / mnemonic / API token patterns.
- **Private Key Isolation**: `PRIVATE_KEY` is loaded into memory only for Viem's local account. It MUST NEVER be written to the database, logged, returned via API, or exposed to the client.
- **Example Files**: `.env.example` must only contain placeholder tokens (`REPLACE-...`) and empty `PRIVATE_KEY=`.

### 2.3 Idempotency & Database Integrity

- **Guarded Transitions**: Every trade state transition must use guarded updates (`UPDATE trades SET status = :to WHERE uid = :uid AND status = :from`).
- **Append-Only History**: `trade_events` and `audit_events` are strictly append-only, enforced by PL/pgSQL triggers.
- **Round Immutability**: Ended rounds are immutable. Chain data may replace imported CSV rounds via `round_corrections`, but chain-derived rounds are never mutated.
- **Single Active Bet**: Unique partial index enforces at most one non-failed bet per round and wallet.

### 2.4 Live Execution Safety & Circuit Breakers

- **Multi-Condition Live Gate**: Live orders require:
  `LIVE_TRADING_ENABLED=true` ∧ Operator armed in dashboard (with exact typed confirmation phrase) ∧ Valid signer ∧ Strategy enabled ∧ Strategy live flag enabled ∧ Risk limits OK ∧ Round open with adequate time buffer ∧ Wallet balance sufficient ∧ Bot `RUNNING` and `READY` ∧ Circuit breaker clear.
- **Two-Phase Commit**: Live transaction hashes are signed and recorded in the database in state `SUBMITTING` _before_ broadcast to the RPC mempool.
- **No Blind Resubmission**: If broadcast outcome is unknown, the trade remains `SUBMITTING` and is reconciled against transaction receipts or on-chain `ledger(epoch, wallet)`. Never re-broadcast duplicate bets.
- **Circuit Breaker**: `MAX_EXECUTION_FAILURES` consecutive failures immediately pauses the bot and disarms live trading (`CRITICAL` audit event).

### 2.5 Strategy Isolation & Look-Ahead Protection

- **Pure Evaluation**: `StrategyPlugin.evaluate(ctx, params)` MUST be synchronous, pure, and free of I/O or side-effects. Strategies return signals; the engine handles sizing, risk, and execution.
- **No Exceptions**: Strategies must return `SKIP` with a rationale rather than throwing errors.
- **Strict Context Boundary**: `StrategyContext` only exposes historical data finalized before or at decision time (`now`). In backtests, `betting.pool` and live price are `null` to avoid look-ahead leakage.

---

## 3. Technology Stack & Development Environment

| Layer                 | Technologies / Versions                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| **Runtime**           | Node.js ≥ 22.13 (Node 24 recommended)                                      |
| **Package Manager**   | `npm` (workspaces: `packages/*`, `apps/*`)                                 |
| **Language**          | TypeScript (target `ES2023`, module `ESNext`, `moduleResolution: Bundler`) |
| **Database**          | PostgreSQL: `@electric-sql/pglite` (embedded, default) or `pg` (Supabase)  |
| **Web3 / Blockchain** | `viem` (Multicall3, BSC Mainnet 56 / Testnet 97)                           |
| **Server Framework**  | Native Node HTTP / lightweight router, SSE for real-time                   |
| **Frontend UI**       | Vite, React, Vanilla CSS tokens (no Tailwind)                              |
| **Testing**           | Vitest (node environment, 30s timeout)                                     |
| **Code Quality**      | ESLint (`eslint.config.js`), Prettier, TypeScript strict                   |

---

## 4. Key Workflows & CLI Commands

Always run commands from the workspace root.

### Universal Quality Gate

Before completing any task or pushing changes, run the validation suite:

```bash
npm run validate
```

This runs in sequence: `check:secrets` → `format:check` → `lint` → `typecheck` → `test` → `build`.

### Targeted Development Checks (Token-Efficient)

- **Targeted Unit Test**: `npx vitest run <path/to/test.ts>` (avoid running the full test suite during intermediate iterations)
- **Full Test Suite**: `npm test`
- **Type Checking**: `npm run typecheck`
- **Linting**: `npm run lint`
- **Formatting**: `npm run format` (writes fixes) or `npm run format:check`
- **Secret Scan**: `npm run check:secrets`
- **Build**: `npm run build`

### Local Development

- **Dev Server**: `npm run dev:server`
- **Dev UI**: `npm run dev:web`
- **Dev Dashboard with Auth Proxy**: `node scripts/dev-dashboard.mjs`

### Application CLI

```bash
npm run app -- migrate                       # Apply database schema & seed initial data
npm run app -- import-history [--format v2]  # Import historical round archives
npm run app -- sync-history [--from epoch]   # Synchronize rounds from BSC Multicall
npm run app -- reconcile                     # Reconcile pending txs and verify round data
npm run app -- bot status|start|stop|pause   # Bot operations
npm run app -- strategy list|enable <slug>   # Manage strategies
npm run app -- health                        # Verify RPC, contracts, and wallet connectivity
npm run app -- verify-chain                  # Dry-run read-only contract verification
```

---

## 5. Coding & Implementation Standards

### 5.1 TypeScript Conventions

- **Strict Mode**: `noUncheckedIndexedAccess: true` is active. Array indexing (`arr[i]`) and string-indexed objects produce `T | undefined`. Always guard with optional chaining (`?.`), nullish coalescing (`??`), or explicit `undefined` checks.
- **ESM Extensions**: Use `.js` extension on all relative imports (e.g., `import { bnbToWei } from './units.js';`).
- **No Floating Arithmetic for Wei**: Use `packages/core/src/units.ts` (`bnbToWei`, `weiToBnbString`, `mulWeiByFraction`, `ratio`). Never write raw float math for token balances.

### 5.2 Package Boundaries

- **`packages/core`**: Must remain strictly free of environment variables, filesystem operations, database connections, and network calls. Keep it 100% portable and deterministically testable.
- **`apps/server`**: Houses database repositories, viem blockchain adapters, worker loops, and HTTP routes. Keep route handlers thin; delegate business logic to domain services.
- **`apps/web`**: Uses pure React and Vanilla CSS. Consumes SSE from `/api/stream`. Never call RPC nodes or private contract methods directly from the frontend.

### 5.3 Database Operations

- **Parameterization**: Never concatenate user inputs into SQL strings. Always use parameterized queries (`db.prepare('...').run({ param })`).
- **Migrations**: Add new schema modifications to `apps/server/src/db/migrations.ts` in sequence with idempotent execution guards.

---

## 6. Agent Instructions & Context Guardrails

When working in this repository, follow these constraints:

### 6.1 Token & Context Preservation (STRICT)

- **Targeted Reading**: Never read entire files exceeding 120 lines if only a specific function, type, or state transition is relevant. Use line-range reads or grep/search first.
- **Selective Test Execution**: During iterations, run ONLY the test file related to the code being changed (`npx vitest run <path-to-test>`). Do NOT run the full test suite until final validation.
- **Fail-Fast Circuit Breaker**: If a compilation, typecheck, or test error persists identically after 2 attempts, HALT immediately. Present the error and ask for clarification rather than trying random edits in a loop.
- **No Speculative Exploration**: Limit searches strictly to the packages or apps impacted by the user prompt. Do not read historical archives, docs, or scripts unless specifically instructed.
- **Concise Execution**: Avoid chatty preambles or repeating instructions. Provide diffs and direct technical summaries.

### 6.2 Operational Integrity

- **Preserve Documentation & Comments**: Keep architectural docstrings, safety notices, and formula explanations intact.
- **Never Weaken Risk Limits**: Do not bypass risk gates, circuit breakers, or confirmation mechanisms in tests or application code.
- **Final Validation**: Before marking a task complete, ensure `npm run validate` passes (exit code 0, 0 lint errors, 0 type errors, all tests green).
