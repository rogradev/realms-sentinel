import type { PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Risk flags — each represents an independently detectable attack surface.
//
// SOLO_VOTE: communityVoteThreshold is yesVotePercentage AND community
//   proposals are enabled (minWeight ≠ u64::MAX).  A single wallet that
//   accumulates ≥ minWeight tokens can create a proposal and cast the only
//   vote.  Because yesVotePercentage is measured against cast votes (not
//   total supply), 1 YES vote from a sole voter = 100% → passes any
//   threshold.  This is the primary BonkDAO attack vector.
//
// LOW_THRESHOLD: yesVotePercentage < 50%.  Even when other voters
//   participate, the attacker needs to control only a small fraction of
//   whoever shows up.  Amplifies SOLO_VOTE but is also independently risky
//   if the DAO has low participation.
//
// NO_COUNCIL: realm.config.councilMint is null → no guardian token exists
//   that could veto a malicious proposal before execution.
// ---------------------------------------------------------------------------
export type RiskFlag = 'SOLO_VOTE' | 'LOW_THRESHOLD' | 'NO_COUNCIL';

export interface GovernanceRisk {
  governancePubkey: string;
  threshold: string;
  minWeight: string;
  votingPeriod: string;
  hasCouncil: boolean;
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

// u64::MAX sentinel — community cannot create proposals when this is set.
const U64_MAX = '18446744073709551615';

type VoteThreshold =
  | { yesVotePercentage: number | Record<string, number> }
  | { quorum: number | Record<string, number> }
  | { disabled: Record<string, never> };

function extractU8(v: number | Record<string, number>): number {
  if (typeof v === 'number') return v;
  return Object.values(v)[0] ?? 0;
}

export function formatThreshold(t: unknown): string {
  const vt = t as VoteThreshold;
  if ('yesVotePercentage' in vt) return `${extractU8(vt.yesVotePercentage)}% yes`;
  if ('quorum' in vt)            return `${extractU8(vt.quorum)}% quorum`;
  if ('disabled' in vt)          return 'disabled';
  return JSON.stringify(t);
}

export function formatMinWeight(raw: unknown): string {
  const s = String(raw);
  return s === U64_MAX ? 'u64::MAX' : s;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return `${seconds}s`;
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

export function assessGovernance(params: {
  governancePubkey: string;
  communityVoteThreshold: unknown;
  minCommunityWeightToCreateProposal: unknown;
  votingBaseTime: number;
  councilMint: PublicKey | null | undefined;
}): GovernanceRisk {
  const flags: RiskFlag[] = [];

  const vt = params.communityVoteThreshold as VoteThreshold;
  const minWeightStr = String(params.minCommunityWeightToCreateProposal);
  const proposalsEnabled = minWeightStr !== U64_MAX;
  const isYesPct = 'yesVotePercentage' in vt;
  const pct = isYesPct ? extractU8((vt as { yesVotePercentage: number | Record<string, number> }).yesVotePercentage) : null;

  if (proposalsEnabled && isYesPct) {
    flags.push('SOLO_VOTE');
  }

  if (isYesPct && pct !== null && pct < 50) {
    flags.push('LOW_THRESHOLD');
  }

  const hasCouncil = !!(params.councilMint);
  if (!hasCouncil) {
    flags.push('NO_COUNCIL');
  }

  return {
    governancePubkey: params.governancePubkey,
    threshold: formatThreshold(vt),
    minWeight: formatMinWeight(params.minCommunityWeightToCreateProposal),
    votingPeriod: formatDuration(params.votingBaseTime),
    hasCouncil,
    flags,
    score: Math.min(flags.length, 3) as 0 | 1 | 2 | 3,
  };
}

const SCORE_LABEL = ['✅ SAFE', '🟡 LOW', '🟠 MEDIUM', '🔴 HIGH'] as const;

export function scoreLabel(score: 0 | 1 | 2 | 3): string {
  return SCORE_LABEL[score];
}

// ---------------------------------------------------------------------------
// Markdown table output
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function renderMarkdownTable(daos: DaoRisk[]): string {
  const rows: string[][] = [];

  for (const dao of daos) {
    for (const gov of dao.governances) {
      const flagStr = gov.flags.length ? gov.flags.join(' ') : '—';
      rows.push([
        `${dao.symbol} (${dao.name})`,
        gov.governancePubkey.slice(0, 8) + '…',
        gov.threshold,
        gov.minWeight === 'u64::MAX' ? 'disabled' : gov.minWeight,
        gov.votingPeriod,
        gov.hasCouncil ? '✓' : '✗',
        flagStr,
        scoreLabel(gov.score),
      ]);
    }
  }

  const headers = ['DAO', 'Governance', 'Approval', 'Min Weight', 'Period', 'Council', 'Flags', 'Risk'];
  const cols = headers.length;

  // Column widths
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0)));

  const line = (cells: string[]): string =>
    '| ' + cells.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';

  const sep = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';

  return [line(headers), sep, ...rows.map(line)].join('\n');
}
