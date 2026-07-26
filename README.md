# Realms Sentinel

Governance health and anomaly monitoring for Solana Realms DAOs.

## Why this exists

On July 7, 2026, BonkDAO lost ~$20M in treasury funds through a malicious
governance proposal. Three configuration failures made the attack possible:

1. **Low approval threshold** — only a small fraction of cast votes needed to be YES
2. **Voting power concentration** — one wallet controlled 99.9% of the effective vote
3. **No execution delay** — the transaction executed immediately after passing

All three are static, on-chain properties. They can be read before an
attack happens. This project reads them.

## What Phase 0 builds

`packages/config-audit` scans active Realms DAOs, reads their
`GovernanceConfig` accounts, and flags dangerous configurations using three
independently detectable risk signals.

### How resolution works

Realms DAOs exist under at least 34 distinct governance program deployments
on mainnet-beta (source: [governance-ui registry][registry], 338 DAOs total).
Major protocols forked SPL Governance to deploy under their own program ID.
Two realm address patterns exist:

- **PDA-based** (seeds: `["governance", realmName]`): address is derivable
  from the DAO name. Confirmed: Squads, Jito, and most DAOs under the
  canonical program.
- **Keypair-based**: address was generated at deploy time, not derivable
  from the name. Confirmed: Mango, Marinade, Orca, Drift, Pyth. These
  require a registry lookup (Phase 1).

Phase 0 resolves both via `getRealmByPubkey()` using a curated
[`dao-list.json`](packages/config-audit/src/dao-list.json) with pre-verified
realm addresses and program IDs sourced from the governance-ui registry.

### What gets decoded

For each vanilla token-weighted DAO (no voter-weight plugin), the pipeline
reads every `GovernanceAccount` under the realm and extracts:

| Field | Source | What it means |
|---|---|---|
| `communityVoteThreshold` | `GovernanceConfig` | % of cast votes required for YES |
| `minCommunityWeightToCreateProposal` | `GovernanceConfig` | Token balance needed to submit a proposal |
| `votingBaseTime` | `GovernanceConfig` | Length of the voting window |
| `minTransactionHoldUpTime` | `GovernanceConfig` | Governance-level execution delay after a proposal passes |
| `votingCoolOffTime` | `GovernanceConfig` | Post-voting buffer during which council can veto |
| `councilVetoVoteThreshold` | `GovernanceConfig` | Council threshold to veto a passed community proposal |
| `councilMint` | inline `RealmConfig` in `RealmV2` | Whether a council token mint exists |

Note: per-proposal `holdUpTime` lives in `ProposalTransaction` accounts and
requires reading historical proposals — that is Phase 1 scope.

### What gets skipped and why

| Category | Count (of 15 scanned) | Reason |
|---|---|---|
| Voter-weight plugin (VSR) | 7 | `voterWeightAddin` or `maxVoterWeightAddin` set — vote power is not 1 token = 1 vote, risk model doesn't apply |
| RealmV1 layout | 4 | Older Borsh layout predates governance v2 IDL; requires separate decoder |
| Network / fetch error | 0 | — |

## Risk flags

Three binary flags, each targeting one of the three BonkDAO attack vectors:

### `SOLO_VOTE`
Community proposals are enabled (`minCommunityWeightToCreateProposal` ≠
`u64::MAX`) and the approval threshold is `yesVotePercentage`. Because
`yesVotePercentage` is measured against votes cast — not total supply — a
single wallet that meets the minimum weight can submit a proposal, vote
alone, achieve 100% of cast votes, and pass regardless of the threshold
value. This is the primary attack pattern from BonkDAO.

### `LOW_THRESHOLD`
`yesVotePercentage` is below 50%. Even with other voters participating, the
attacker controls only a small minority of whoever shows up. This amplifies
`SOLO_VOTE` but is independently risky in low-participation DAOs.

### `NO_COUNCIL`
Community proposals are enabled AND `councilVetoVoteThreshold` is either
`disabled` or `0%`. A council token mint existing is not sufficient — the
veto threshold must be non-zero for the council to function as a safety net.
This flag is silent when community proposals are disabled (`u64::MAX`), since
there are no community proposals to veto.

**Score**: count of fired flags (0 = ✅ SAFE, 1 = 🟡 LOW, 2 = 🟠 MEDIUM,
3 = 🔴 HIGH).

## Phase 0 scan results — 15 DAOs, mainnet-beta

*Scanned 2026-07-26. On-chain values; decimals and supply verified live.*

### Configuration details

| DAO / Governance | Approval | Min Weight | % Supply | HoldUp | CoolOff | Council veto | Period |
|---|---|---|---|---|---|---|---|
| JTO / 8cEhMTsw… | 1% yes | 250K JTO | 0.025% | 0s | 2d | 51% yes | 5d |
| JTO / EA4eoKGv… | disabled | disabled | disabled | 0s | 2d | 51% yes | 3d |
| ORCA / 64FH4dmm… | 2% yes | 500K ORCA | 0.667% | 0s | 4d | 70% yes | 10d |
| ORCA / 6d76JcdN… | 1% yes | 250K ORCA | 0.333% | 0s | 2d | disabled ⚠ | 5d |
| ORCA / 7VZTFBDy… | 3% yes | 500K ORCA | 0.667% | 0s | 2d | 51% yes | 5d |
| SQDS / 3dfQyNJc… | 76% yes | disabled | disabled | 0s | 0s | 0% yes ⚠ | 3d |
| SQDS / 8X34PHBc… | 76% yes | disabled | disabled | 0s | 0s | 0% yes ⚠ | 3d |
| MEAN / 4Dh7dqgp… | 30% yes | 100K MEAN | 2.141% | 0s | 0s | 0% yes ⚠ | 3d |
| MEAN / AgRKrvNd… | 10% yes | 28K MEAN | 0.6% | 0s | 0s | 0% yes ⚠ | 5d |

### Risk assessment

| DAO / Governance | Risk flags | Score |
|---|---|---|
| JTO / 8cEhMTsw… | SOLO_VOTE LOW_THRESHOLD | 🟠 MEDIUM |
| JTO / EA4eoKGv… | — | ✅ SAFE |
| ORCA / 64FH4dmm… | SOLO_VOTE LOW_THRESHOLD | 🟠 MEDIUM |
| ORCA / 6d76JcdN… | SOLO_VOTE LOW_THRESHOLD NO_COUNCIL | 🔴 HIGH |
| ORCA / 7VZTFBDy… | SOLO_VOTE LOW_THRESHOLD | 🟠 MEDIUM |
| SQDS / 3dfQyNJc… | — | ✅ SAFE |
| SQDS / 8X34PHBc… | — | ✅ SAFE |
| MEAN / 4Dh7dqgp… | SOLO_VOTE LOW_THRESHOLD NO_COUNCIL | 🔴 HIGH |
| MEAN / AgRKrvNd… | SOLO_VOTE LOW_THRESHOLD NO_COUNCIL | 🔴 HIGH |

### Per-DAO worst-case

| DAO | Govs decoded | Worst flags | Risk |
|---|---|---|---|
| Jito (JTO) | 2 | SOLO_VOTE LOW_THRESHOLD | 🟠 MEDIUM |
| Orca DAO (ORCA) | 3 | SOLO_VOTE LOW_THRESHOLD NO_COUNCIL | 🔴 HIGH |
| Squads (SQDS) | 2 | — | ✅ SAFE |
| Mean Finance (MEAN) | 2 | SOLO_VOTE LOW_THRESHOLD NO_COUNCIL | 🔴 HIGH |

### Notable data points

**Jito**: the governance account that controls the main protocol has a 1%
approval threshold. The minimum weight to create a community proposal is
250,000 JTO — verified on-chain as 250,000,000,000,000 base units at 9
decimals. At the live price of $0.59 (CoinGecko, 2026-07-26), that is
approximately **$147,500**. A 2-day `votingCoolOffTime` and a 51% council
veto threshold provide meaningful mitigation; the council has a structural
window to block malicious proposals.

**Orca governance `6d76JcdN`**: 1% threshold, 250K ORCA minimum weight, and
`councilVetoVoteThreshold: disabled`. No council veto mechanism is configured
for this governance account. This is the only governance in the scan with all
three risk flags active.

**All four vanilla DAOs**: `minTransactionHoldUpTime` is 0 seconds. Proposals
execute immediately after passing with no governance-level delay. The BonkDAO
attack required this condition alongside low quorum — it is present in every
decoded DAO.

**Squads**: community proposals are disabled (`u64::MAX` minimum weight).
Only council members can create proposals. The `councilVetoVoteThreshold` of
0% is structurally inert here since there are no community proposals to veto.

## Coverage notes for grant reviewers

**What "vanilla" means precisely**: no `voterWeightAddin` and no
`maxVoterWeightAddin` on the realm's `communityTokenConfig`. Both fields are
checked. A DAO with only a `maxVoterWeightAddin` would not be classified as
vanilla.

**What "has council" means precisely**: `councilMint ≠ null` AND
`councilVetoVoteThreshold` is non-disabled and non-zero. A council token mint
without a functional veto threshold is reported as ⚠ and triggers
`NO_COUNCIL`.

**What is not yet covered**:
- Per-proposal `holdUpTime` from `ProposalTransaction` accounts (Phase 1)
- RealmV1 accounts (Mango, MonkeDAO, Metaplex Foundation, Grape) — these
  use a pre-v2 Borsh layout and require a separate decoder
- DAOs with voter-weight plugins (Marinade, Drift, Pyth, Helium, Parcl, Jet)
  — the risk model assumes 1 token = 1 vote; VSR-based voting power is
  non-linear and requires reading the VSR program state
- Registry-based lookup for keypair realm accounts at scale (Phase 1)

**Data sources**: realm addresses and program IDs from
[Mythic-Project/governance-ui][registry] `public/realms/mainnet-beta.json`
(338 DAOs, 34 distinct governance programs as of 2026-07). Decoded directly
from mainnet-beta RPC. Token decimals verified via `getParsedAccountInfo` on
each community mint; token price via CoinGecko public API.

## Monorepo structure

```
packages/
  config-audit/          # Phase 0: reads GovernanceConfig, flags risk (this README)
    src/
      index.ts           # pipeline: resolve → vanilla check → decode → assess
      risk.ts            # assessGovernance(), flag logic, markdown renderers
      dao-list.json      # 15 curated DAOs with on-chain addresses and program IDs
  heuristics-engine/     # Phase 1: anomaly detection on live proposals (planned)
  dashboard/             # Phase 2: UI (planned)
```

## Running

```bash
npm install
cd packages/config-audit
npm start                           # uses public mainnet-beta RPC
SOLANA_RPC_URL=https://your-rpc npm start   # use a private RPC endpoint
```

The public RPC endpoint rate-limits at ~100 requests per 10 seconds. For
reliable repeated scans, a private RPC (Helius, QuickNode, Triton) is
recommended.

## License

MIT

[registry]: https://github.com/Mythic-Project/governance-ui/blob/main/public/realms/mainnet-beta.json
