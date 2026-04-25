# Vision: Autonomous Trading Agent System

## Project Overview

An autonomous multi-agent system that discovers, evaluates, optimizes, and trades financial strategies with minimal human intervention. The system uses a team of specialized AI agents that collaborate through a structured pipeline — from internet-based strategy research through rigorous backtesting with **fwbg**, paper trading validation, to live execution with real capital.

The core philosophy: **no strategy reaches real money without statistical proof**. Every stage acts as a gate, and every modification restarts the validation cycle from backtesting.

### Why This Matters

Manual strategy research is slow, biased by recency and survivorship, and rarely subjected to rigorous overfitting analysis. This system automates the tedious parts (searching, implementing, parameter tuning) while enforcing statistical discipline that most human traders skip (walk-forward validation, Deflated Sharpe Ratio, Probability of Backtest Overfitting tests).

---

## Goals & Objectives

| Goal | Measurable Outcome |
|------|--------------------|
| Autonomous strategy discovery | System finds and formalizes 10+ strategy candidates per research cycle without human input |
| Rigorous backtesting | Every strategy is validated with walk-forward CV, DSR, PBO, and Monte Carlo permutation tests via fwbg |
| Parameter optimization | Grid search over TP/SL/CT/indicator params with overfitting protection |
| Paper trading validation | Strategies run 3+ months on paper accounts before live consideration |
| Statistical significance gate | Only strategies with p-value < 0.05 on multiple overfitting tests advance |
| Live trading with monitoring | Profitable strategies deploy to real accounts with continuous performance tracking |
| Self-improving cycle | Underperforming strategies get re-optimized or discarded automatically |

---

## Target Users

- **Primary**: The system operator (you) — monitors agent activities, approves live-trading transitions, reviews strategy performance dashboards
- **Secondary**: The agents themselves — consume each other's outputs as structured data

The system is **not** a consumer product. It is an internal tool for a single operator who understands trading and fwbg.

---

## Core Features

### 1. Research Agent

**Purpose**: Discover and formalize trading strategies from the internet.

**Capabilities**:
- Search financial forums, academic papers, trading blogs, YouTube transcripts, and social media for strategy ideas
- Extract the core logic: entry conditions, exit conditions, indicators used, timeframes, asset classes
- Assess initial plausibility (e.g., discard strategies that require unavailable data or impossible execution)
- Produce a **Strategy Research Document** — a structured output containing:
  - Strategy name and source
  - Trading logic in plain language
  - Required indicators (mapped to fwbg plugin names where possible)
  - Suggested entry/exit rules
  - Suggested asset classes and timeframes
  - Risk/reward characteristics described by the source
  - Confidence assessment (how well-documented, how many independent sources)

**Output Format**: Structured JSON/YAML that the Training Agent can consume directly.

**Key Constraint**: The Research Agent does NOT need to produce valid fwbg configurations. It produces human-readable strategy descriptions with enough detail for the Training Agent to translate them into fwbg pipelines.

### 2. Training Agent (Backtesting & Optimization)

**Purpose**: Translate strategy ideas into fwbg pipelines, run backtests, evaluate results, and optimize parameters.

**Capabilities**:
- Deep understanding of fwbg's architecture:
  - Plugin system (indicators, exit strategies, feature selection, risk management)
  - Pipeline phases: `DATA_LOADING → PREPROCESSING → INDICATORS → FEATURE_SELECTION → EXIT_STRATEGIES → RISK_MANAGEMENT → MODEL → VALIDATION`
  - JSON strategy configuration format (`StrategyConfig`)
  - Available indicators (30+ core: momentum, volatility, trend, price action, structural)
  - Exit strategies (`fixed`, `atr_based`, `atr_trailing`, `structural_rr`)
  - Feature selection plugins (`stability`, `correlation_filter`, `boruta`)
  - Model configurations (XGBoost, LightGBM, unified/separate architectures)
  - Validation settings (walk-forward folds, embargo, inner CV)
- Translate Research Agent output into valid fwbg `StrategyConfig` JSON
- Map described indicators to available fwbg plugins; flag when custom plugins are needed
- Run backtests via fwbg CLI (`fwbg --strategy-file ... --assets ...`) or REST API
- Interpret results:
  - `significant` → Strategy has statistical edge, advance to optimization or paper trading
  - `not_significant` → Adjust parameters or discard
  - `no_candidates` → Fundamentally flawed configuration, rethink approach
- Evaluate key metrics: Sharpe ratio, win rate, max drawdown, PBO p-value, DSR p-value, total PnL, trade frequency
- Iterative optimization loop:
  1. Run initial backtest with sensible defaults
  2. Analyze results — identify weak points (high drawdown? low win rate? too few trades?)
  3. Adjust parameters (widen/tighten TP/SL, change CT thresholds, add/remove indicators, try different exit strategies)
  4. Re-run backtest
  5. Repeat until: (a) statistically significant results achieved, or (b) max iterations exhausted → discard strategy
- Track optimization history: every parameter change and its effect on results

**Output**: Optimized `StrategyConfig` JSON + backtest results summary + optimization log.

**Key Design Decision**: The Training Agent must be able to reason about *why* a strategy fails, not just try random parameter combinations. It should understand concepts like:
- Overfitting indicators (good in-sample, bad out-of-sample)
- Too many features leading to curse of dimensionality
- Trade frequency too low for statistical significance
- Regime dependency (strategy works in trends but not ranges)

### 3. Paper Trading Agent

**Purpose**: Validate backtested strategies in live market conditions over extended periods.

**Capabilities**:
- Deploy optimized strategies to paper trading accounts (broker-specific integration)
- Monitor positions, fills, slippage, and execution quality
- Track live performance metrics and compare against backtest expectations:
  - Expected vs. actual Sharpe ratio
  - Expected vs. actual win rate
  - Expected vs. actual drawdown profile
  - Trade frequency consistency
- Detect performance degradation:
  - Rolling Sharpe dropping below threshold
  - Drawdown exceeding backtest maximum
  - Win rate significantly below expectation (binomial test)
  - Regime change detection
- Decision logic after validation period (minimum 3 months):
  - **Pass**: Results match or exceed backtest expectations with statistical significance → recommend for live trading
  - **Adjust**: Results are promising but below expectations → send back to Training Agent with specific adjustment recommendations, then re-paper-trade
  - **Discard**: Results are clearly unprofitable or inconsistent → archive and discard

**Cycle Enforcement**: Any parameter change → restart from fwbg backtesting → only then re-deploy to paper account. No shortcuts.

**Statistical Significance**: The Paper Trading Agent must collect enough trades to make statistically valid conclusions. It should calculate required sample sizes based on expected win rate and Sharpe ratio.

### 4. Live Trading Agent

**Purpose**: Execute validated strategies with real capital and continuously monitor performance.

**Capabilities**:
- Deploy strategies to live trading accounts
- Real-time position management and execution
- Continuous performance monitoring with alerting:
  - Daily P&L tracking
  - Drawdown monitoring with circuit breakers
  - Performance vs. paper trading expectations
  - Slippage analysis (paper vs. live execution)
- Risk management enforcement:
  - Maximum position sizes
  - Daily loss limits
  - Correlation limits across strategies
  - Portfolio-level drawdown limits
- Automated circuit breakers:
  - Pause trading if drawdown exceeds threshold
  - Alert operator if performance deviates significantly from expectations
  - Emergency stop capability
- Performance reporting:
  - Daily/weekly/monthly summaries
  - Strategy-level attribution
  - Risk-adjusted return metrics

**Human Gate**: The transition from paper to live trading **requires explicit human approval**. This is the one step that is NOT fully autonomous.

### 5. Orchestrator / Coordinator

**Purpose**: Manage the overall workflow, route data between agents, track system state.

**Capabilities**:
- Maintain a strategy pipeline database: track every strategy from discovery through live trading
- Route outputs between agents (Research → Training → Paper → Live)
- Schedule agent activities (research cycles, backtest runs, paper trading reviews)
- Handle failures and retries
- Provide a dashboard / reporting interface for the operator
- Enforce the validation cycle: any modification → backtest → paper → live
- Track agent performance meta-metrics: How many strategies researched? How many pass backtesting? What's the conversion rate to live?

---

## Technical Architecture

### Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Agent Framework | Claude Agent SDK (Python) | Native tool use, extended thinking, structured outputs; aligns with existing Claude Code ecosystem |
| Backtesting Engine | fwbg (existing) | In-house framework with walk-forward CV, plugin system, statistical tests, Numba acceleration |
| Broker Integration | IG Markets API (existing in fwbg) | Already integrated in fwbg's live trading module |
| Data Storage | SQLite + JSON files | Simple, portable, no external DB dependency; JSON for strategy configs and results (fwbg native format) |
| Task Queue / Scheduling | Python asyncio + cron / systemd timers | Lightweight; no need for Celery/Redis for single-operator system |
| Monitoring / Dashboard | Terminal-based (Rich) + optional web UI | Start simple; fwbg already uses Rich for CLI output |
| Configuration | YAML/JSON | Consistent with fwbg's configuration approach |
| Language | Python 3.11+ | Consistent with fwbg requirement |

### System Architecture

```
                    ┌─────────────────────┐
                    │    Orchestrator      │
                    │  (Workflow Engine)   │
                    └──────────┬──────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                   │
    ┌───────▼───────┐  ┌──────▼───────┐  ┌───────▼───────┐
    │  Research      │  │  Training    │  │  Paper/Live   │
    │  Agent         │  │  Agent       │  │  Trading Agent│
    │                │  │              │  │               │
    │  Web Search    │  │  fwbg CLI/   │  │  Broker API   │
    │  Content Parse │  │  REST API    │  │  Position Mgmt│
    │  Strategy      │  │  Config Gen  │  │  Monitoring   │
    │  Extraction    │  │  Result Eval │  │  Alerting     │
    └───────┬───────┘  └──────┬───────┘  └───────┬───────┘
            │                  │                   │
            └──────────────────┼──────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Strategy Store    │
                    │  (SQLite + JSON)    │
                    │                     │
                    │  - Research docs    │
                    │  - fwbg configs     │
                    │  - Backtest results │
                    │  - Paper trade logs │
                    │  - Live trade logs  │
                    │  - Optimization     │
                    │    history          │
                    └─────────────────────┘
```

### Strategy Lifecycle States

```
DISCOVERED → RESEARCHED → BACKTESTING → OPTIMIZING → BACKTEST_PASSED
    → PAPER_TRADING → PAPER_EVALUATING → PAPER_PASSED
    → LIVE_APPROVED → LIVE_TRADING → LIVE_MONITORING

At any point: → DISCARDED (with reason logged)
Any modification: PAPER/LIVE → BACKTESTING (restart cycle)
```

### Integration with fwbg

The Training Agent interacts with fwbg through two interfaces:

1. **CLI** (`fwbg --strategy-file <path> --assets <symbols>`): For batch backtests, simple to invoke from agent
2. **REST API** (`POST /api/runs/start`): For programmatic control, progress monitoring, result retrieval

The agent generates valid `StrategyConfig` JSON files and reads results from fwbg's structured output (`test_results/<run_id>/results.json`).

Key fwbg concepts the Training Agent must master:
- Pipeline plugin configuration (indicators, exit strategies, feature selection)
- Grid search parameters (TP/SL ranges, CT thresholds)
- Validation configuration (walk-forward folds, embargo, inner CV folds)
- Filter criteria (min trades, min Sharpe, max drawdown)
- Result interpretation (significant/not_significant/no_candidates + detailed metrics)

---

## Non-Functional Requirements

### Performance
- Backtests should complete within reasonable time (fwbg handles parallelization internally)
- Agent decision-making should not be the bottleneck — LLM calls are fast relative to backtests
- Paper/Live trading agents must have sub-second response time for position management

### Reliability
- Agent failures must not cause data loss (all state persisted to disk)
- Broker connection failures must be handled gracefully (retry logic, position reconciliation)
- Circuit breakers must work even if agents crash (broker-side stop-losses as final safety net)

### Security
- API keys and broker credentials stored securely (environment variables, not in code/config)
- Live trading requires explicit human approval
- Maximum position sizes enforced at both agent and broker level
- No strategy can exceed defined risk limits regardless of agent behavior

### Observability
- All agent actions logged with timestamps
- Strategy pipeline state always queryable
- Performance metrics tracked and alertable
- Optimization history fully traceable (which parameter changes led to which results)

---

## Constraints & Assumptions

### Constraints
- **fwbg is the sole backtesting engine** — no alternative backtesting tools; all backtesting goes through fwbg's pipeline
- **IG Markets is the broker** — existing fwbg integration; paper and live accounts on IG
- **Single operator** — system designed for one person, not multi-tenant
- **Python ecosystem** — all agents in Python, consistent with fwbg
- **Budget-conscious** — minimize external service costs; Claude API calls should be efficient (batched reasoning, cached prompts where possible)

### Assumptions
- fwbg is stable and its API/CLI interface won't change drastically during development
- IG Markets paper accounts behave identically to live accounts (fills, spreads, execution)
- Internet-sourced strategies provide enough detail to reconstruct the core logic
- 3 months of paper trading provides sufficient statistical sample for most strategies
- The operator will review and approve live trading transitions

### Technical Assumptions
- fwbg REST API is available for programmatic access (or can be started by the agent)
- Historical market data is available through existing fwbg data sources
- The system runs on a machine with sufficient resources for fwbg backtests (CPU, RAM for Numba-accelerated simulation)

---

## Out of Scope

| Exclusion | Reason |
|-----------|--------|
| Custom indicator development | Agents use existing fwbg plugins; new indicators are a separate development effort |
| Multi-broker support | IG Markets only for now; adding brokers is a future enhancement |
| High-frequency trading (HFT) | fwbg is designed for swing/position trading timeframes, not sub-second execution |
| Portfolio optimization across strategies | v1 treats each strategy independently; cross-strategy portfolio management is future work |
| Web-based dashboard | Start with terminal/CLI; web UI is a future enhancement |
| Cryptocurrency markets | Focus on forex/indices/commodities through IG Markets |
| Social/copy trading | No sharing of strategies or signals with external parties |
| Custom ML model development | Use fwbg's built-in model support (XGBoost, LightGBM); custom models are a future enhancement |

---

## Success Criteria

### Short-term (3 months after deployment)
- Research Agent successfully discovers and formalizes 50+ strategy candidates
- Training Agent successfully translates 80%+ of research outputs into valid fwbg configurations
- At least 5 strategies pass backtesting with statistical significance (p < 0.05)
- Paper trading pipeline operational with at least 2 strategies running simultaneously

### Medium-term (6-12 months after deployment)
- At least 1 strategy completes the full pipeline: research → backtest → paper → live
- Paper trading results correlate with backtesting expectations (within 1 standard deviation)
- System operates with minimal human intervention (< 1 hour/week monitoring)
- Strategy discovery → backtest cycle time < 24 hours

### Long-term (12+ months after deployment)
- Portfolio of 3+ live strategies generating consistent returns
- System has iterated through 100+ strategy candidates
- Clear feedback loop: live performance data improves research and backtesting quality
- Positive risk-adjusted returns on live capital (Sharpe > 1.0)

---

## Agent Communication Protocol

Agents communicate through **structured documents** stored in the Strategy Store:

| From → To | Document | Format |
|-----------|----------|--------|
| Research → Training | Strategy Research Document | JSON with strategy description, indicators, rules |
| Training → Paper | Optimized Strategy Package | fwbg StrategyConfig JSON + backtest results JSON |
| Paper → Training | Adjustment Request | JSON with specific parameter change recommendations |
| Paper → Live | Validation Report | JSON with paper trading metrics + statistical tests |
| Live → Orchestrator | Performance Report | JSON with daily/weekly metrics |
| Any → Orchestrator | Status Update | JSON with agent state, progress, errors |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Overfitting despite statistical tests | Multiple independent tests (DSR + PBO + Monte Carlo); paper trading as final gate |
| Broker API failures during live trading | Broker-side stop-losses; position reconciliation on reconnect; circuit breakers |
| Agent hallucination / bad strategy configs | Validate all generated configs against fwbg schema before execution; sandbox backtests |
| Excessive API costs (Claude) | Batch agent reasoning; cache repeated lookups; use cheaper models for routine tasks |
| Strategy regime change | Continuous monitoring with rolling metrics; automatic pause on performance degradation |
| Data quality issues | Use fwbg's built-in data validation; cross-reference multiple data sources |
| Single point of failure | Persist all state; agents are stateless and restartable; idempotent operations |

---

## Development Approach

Build incrementally, agent by agent, with each agent usable independently before integration:

1. **Training Agent first** — most critical, integrates with fwbg; can be tested with manually-provided strategies
2. **Research Agent second** — can be developed and tested independently
3. **Orchestrator** — connect Research → Training flow
4. **Paper Trading Agent** — requires broker integration work
5. **Live Trading Agent** — last, builds on Paper Trading Agent with additional safety layers
6. **End-to-end integration** — full autonomous pipeline

This order ensures the highest-value component (backtesting automation) is available earliest.
