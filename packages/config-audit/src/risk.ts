import type { PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Risk flags
//
// SOLO_VOTE: community proposals are enabled (minWeight ≠ u64::MAX) AND the
//   threshold is yesVotePercentage. A single wallet that reaches minWeight can
//   create a proposal, vote alone, and achieve 100% of cast votes regardless
//   of the threshold value. This is the core BonkDAO attack vector.
//
// LOW_THRESHOLD: yesVotePercentage < 50%. Even with participation, the
//   attacker only needs a small fraction of cast votes.
//
// NO_COUNCIL: community proposals are enabled AND either no council mint
//   exists OR the council's veto threshold is disabled/0%. A functioning
//   council (veto > 0%) is the primary on-chain defence against a malicious
//   community proposal. If proposals are disabled (u64::MAX minWeight) this
//   flag is irrelevant and does not fire.
// ---------------------------------------------------------------------------
export type RiskFlag = 'SOLO_VOTE' | 'LOW_THRESHOLD' | 'NO_COUNCIL';

export interface GovernanceRisk {
  governancePubkey: string;
  // Config values
  threshold: string;
  minWeightHuman: string;   // e.g. "250K JTO" or "disabled"
  minWeightPct: string;     // e.g. "0.025%" or "disabled" or "N/A"
  holdUpTime: string;       // minTransactionHoldUpTime, formatted
  votingPeriod: string;
  coolOffTime: string;      // votingCoolOffTime, formatted
  // Council
  hasCouncilMint: boolean;
  vetoThreshold: string;    // formatted councilVetoVoteThreshold
  hasEffectiveVeto: boolean;
  // Risk
  flags: RiskFlag[];
  score: 0 | 1 | 2 | 3;
}

export interface DaoRisk {
  name: string;
  symbol: string;
  realmPubkey: string;
  governances: GovernanceRisk[];
  worstScore: 0 | 1 | 2 | 3;
  worstFlags: RiskFlag[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const U64_MAX = '18446744073709551615';

type VoteThreshold =
  | { yesVotePercentage: number | Record<string, number> }
  | { quorum: number | Record<string, number> }
  | { disabled: Record<string, never> };

function extractU8(v: number | Record<string, number>): number {
  if (typeof v === 'number') return v;
  return Object.values(v)[0] ?? 0;
}

// Returns the numeric percentage (0-100) if the threshold is yesVotePercentage,
// -1 for quorum, -2 for disabled.
function thresholdPct(t: VoteThreshold): number {
  if ('yesVotePercentage' in t) return extractU8(t.yesVotePercentage);
  if ('quorum' in t) return -1;
  return -2; // disabled
}

// Returns true when the threshold represents a functional veto (non-disabled, > 0%).
function isEffectiveThreshold(t: VoteThreshold): boolean {
  const p = thresholdPct(t);
  return p > 0; // p==-2 (disabled) and p==0 (yesVotePercentage:0) are both non-functional
}

export function formatThreshold(t: unknown): string {
  const vt = t as VoteThreshold;
  if ('yesVotePercentage' in vt) return `${extractU8(vt.yesVotePercentage)}% yes`;
  if ('quorum' in vt)            return `${extractU8(vt.quorum)}% quorum`;
  if ('disabled' in vt)          return 'disabled';
  return JSON.stringify(t);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return `${seconds}s`;
  if (seconds === 0) return '0s';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

// Uses BigInt arithmetic to avoid float64 precision loss on u64 values.
function computeMinWeightPct(minWeightBN: unknown, supplyStr: string | null): string {
  const minStr = String(minWeightBN);
  if (minStr === U64_MAX) return 'disabled';
  if (!supplyStr || supplyStr === '0') return 'N/A';

  const minBI = BigInt(minStr);
  const supBI = BigInt(supplyStr);
  if (supBI === 0n) return 'N/A';

  // (minBI / supBI) × 100, with 7 decimal places of intermediate precision.
  const scaled = minBI * 10_000_000n / supBI; // units: 100 × 10^5 = 10^7
  const pct = Number(scaled) / 100_000;       // percent to 5 decimal places

  if (pct < 0.001) return '<0.001%';
  if (pct >= 100)  return '≥100%';
  // Strip trailing zeros after decimal point.
  return pct.toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + '%';
}

function formatHumanWeight(minWeightBN: unknown, decimals: number, symbol: string): string {
  const minStr = String(minWeightBN);
  if (minStr === U64_MAX) return 'disabled';

  // Number() is safe here: minWeight for active DAOs is well below 2^53.
  const tokens = Number(BigInt(minStr)) / Math.pow(10, decimals);
  let formatted: string;
  if      (tokens >= 1_000_000) formatted = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  else if (tokens >= 1_000)     formatted = Math.round(tokens / 1_000) + 'K';
  else                          formatted = tokens.toFixed(2).replace(/\.?0+$/, '');
  return `${formatted} ${symbol}`;
}

// ---------------------------------------------------------------------------
// Core assessment function
// ---------------------------------------------------------------------------

export function assessGovernance(params: {
  governancePubkey: string;
  communityVoteThreshold: unknown;
  minCommunityWeightToCreateProposal: unknown;
  votingBaseTime: number;
  minTransactionHoldUpTime: number;
  votingCoolOffTime: number;
  councilVetoVoteThreshold: unknown;
  councilMint: PublicKey | null | undefined;
  // Mint metadata for human-readable weight display
  mintDecimals: number;
  mintSupply: string | null;
  tokenSymbol: string;
}): GovernanceRisk {
  const vt = params.communityVoteThreshold as VoteThreshold;
  const minWeightStr = String(params.minCommunityWeightToCreateProposal);
  const proposalsEnabled = minWeightStr !== U64_MAX;

  const pct = thresholdPct(vt);
  const isYesPct = pct >= 0; // >=0 means it's a yesVotePercentage (could be 0)
  const vetoVT = params.councilVetoVoteThreshold as VoteThreshold;

  const hasCouncilMint = !!(params.councilMint);
  const hasEffectiveVeto = hasCouncilMint && isEffectiveThreshold(vetoVT);

  const flags: RiskFlag[] = [];

  if (proposalsEnabled && isYesPct) {
    flags.push('SOLO_VOTE');
  }

  if (isYesPct && pct < 50) {
    flags.push('LOW_THRESHOLD');
  }

  // NO_COUNCIL only fires when community proposals are enabled — if they're
  // disabled (u64::MAX), there are no community proposals to veto.
  if (proposalsEnabled && !hasEffectiveVeto) {
    flags.push('NO_COUNCIL');
  }

  return {
    governancePubkey: params.governancePubkey,
    threshold:       formatThreshold(vt),
    minWeightHuman:  formatHumanWeight(params.minCommunityWeightToCreateProposal, params.mintDecimals, params.tokenSymbol),
    minWeightPct:    computeMinWeightPct(params.minCommunityWeightToCreateProposal, params.mintSupply),
    holdUpTime:      formatDuration(params.minTransactionHoldUpTime),
    votingPeriod:    formatDuration(params.votingBaseTime),
    coolOffTime:     formatDuration(params.votingCoolOffTime),
    hasCouncilMint,
    vetoThreshold:   formatThreshold(vetoVT),
    hasEffectiveVeto,
    flags,
    score: Math.min(flags.length, 3) as 0 | 1 | 2 | 3,
  };
}

const SCORE_LABEL = ['✅ SAFE', '🟡 LOW', '🟠 MEDIUM', '🔴 HIGH'] as const;

export function scoreLabel(score: 0 | 1 | 2 | 3): string {
  return SCORE_LABEL[score];
}

// ---------------------------------------------------------------------------
// Markdown table rendering — two tables: config details + risk flags
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function buildTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0)));
  const line = (cells: string[]): string =>
    '| ' + cells.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

function daoGovLabel(dao: DaoRisk, gov: GovernanceRisk): string {
  return `${dao.symbol} / ${gov.governancePubkey.slice(0, 8)}…`;
}

export function renderMarkdownTables(daos: DaoRisk[]): string {
  const configRows: string[][] = [];
  const riskRows: string[][] = [];

  for (const dao of daos) {
    for (const gov of dao.governances) {
      const label = daoGovLabel(dao, gov);
      const council = gov.hasCouncilMint
        ? `${gov.vetoThreshold}${gov.hasEffectiveVeto ? '' : ' ⚠'}`
        : '✗ none';

      configRows.push([
        label,
        gov.threshold,
        gov.minWeightHuman,
        gov.minWeightPct,
        gov.holdUpTime,
        gov.coolOffTime,
        council,
        gov.votingPeriod,
      ]);

      const flagStr = gov.flags.length ? gov.flags.join(' ') : '—';
      riskRows.push([label, flagStr, scoreLabel(gov.score)]);
    }
  }

  const configHeaders = ['DAO / Governance', 'Approval', 'Min Weight', '% Supply', 'HoldUp', 'CoolOff', 'Council veto', 'Period'];
  const riskHeaders   = ['DAO / Governance', 'Risk flags', 'Score'];

  return [
    '### Configuration details\n',
    buildTable(configHeaders, configRows),
    '\n### Risk assessment\n',
    buildTable(riskHeaders, riskRows),
  ].join('\n');
}

// Per-DAO worst-case summary table
export function renderSummaryTable(daos: DaoRisk[]): string {
  const rows = daos.map(dao => [
    `${dao.symbol} (${dao.name})`,
    String(dao.governances.length),
    dao.worstFlags.length ? dao.worstFlags.join(' ') : '—',
    scoreLabel(dao.worstScore),
  ]);
  return buildTable(['DAO', 'Govs', 'Worst flags', 'Risk'], rows);
}
