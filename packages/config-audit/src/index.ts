import { Connection, PublicKey } from '@solana/web3.js';
import { SplGovernance, type GovernanceConfig, type RealmV1, type RealmV2, type RealmConfig, type GovernanceAccount } from 'governance-idl-sdk';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { daos } = require('./dao-list.json') as {
  daos: Array<{
    name: string;
    symbol: string;
    realmId: string;
    programId: string;
    realmType: 'pda' | 'keypair';
    notes: string;
  }>;
};

// ---------------------------------------------------------------------------
// VoteThreshold — Anchor encodes enum variants as single-key objects.
// The inner u8 comes off the wire as a Buffer-like object { "0": <value> },
// not a plain number. We normalise it with extractU8().
// ---------------------------------------------------------------------------
type VoteThreshold =
  | { yesVotePercentage: number | Record<string, number> }
  | { quorum: number | Record<string, number> }
  | { disabled: Record<string, never> };

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('Realms Sentinel — config-audit  (Phase 0)');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Scanning ${daos.length} DAOs from dao-list.json\n`);

  const connection = new Connection(RPC_URL, 'confirmed');

  let countVanilla = 0;
  let countPlugin  = 0;
  let countFailed  = 0;

  for (const dao of daos) {
    console.log(`── ${dao.symbol}  ${dao.name}`);
    console.log(`   realm   : ${dao.realmId}`);
    console.log(`   program : ${dao.programId}`);

    const gov = new SplGovernance(connection, new PublicKey(dao.programId));

    // Try V2 layout first; fall back to V1 for older governance forks.
    let realm: RealmV2;
    try {
      realm = await gov.getRealmByPubkey(new PublicKey(dao.realmId));
    } catch {
      try {
        const v1 = await gov.getRealmV1ByPubkey(new PublicKey(dao.realmId)) as unknown as RealmV1;
        console.log(`   ⓘ  RealmV1 account (older IDL layout) — name: ${v1.name}`);
        console.log(`   Skipping config decode — V1 layout not covered in Phase 0.\n`);
        countFailed++;
        continue;
      } catch (err2) {
        console.log(`   ✗ Failed to fetch realm (V1 + V2 both failed): ${(err2 as Error).message}\n`);
        countFailed++;
        continue;
      }
    }

    console.log(`   name on-chain: ${realm.name}`);

    const pluginResult = await checkVanilla(gov, realm);
    if (pluginResult === 'vanilla') {
      countVanilla++;
      await printGovernanceConfigs(gov, realm);
    } else if (pluginResult === 'plugin') {
      countPlugin++;
    } else {
      countFailed++;
    }
  }

  console.log('═'.repeat(62));
  console.log(`SUMMARY  (${daos.length} DAOs scanned)`);
  console.log(`  vanilla token-weighted : ${countVanilla}`);
  console.log(`  uses voter-weight plugin: ${countPlugin}`);
  console.log(`  fetch / decode errors  : ${countFailed}`);
  console.log('═'.repeat(62));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkVanilla(
  gov: SplGovernance,
  realm: RealmV2,
): Promise<'vanilla' | 'plugin' | 'error'> {
  let cfg: RealmConfig | null = null;

  try {
    cfg = await gov.getRealmConfigByRealm(realm.publicKey);
  } catch {
    console.log(`   ✓ No RealmConfigAccount → vanilla (no plugin possible)\n`);
    return 'vanilla';
  }

  const addin = cfg.communityTokenConfig.voterWeightAddin as PublicKey | null;

  if (addin) {
    console.log(`   ⚠  voter-weight plugin: ${addin.toBase58()}`);
    console.log(`   Skipping config decode — Phase 0 covers vanilla DAOs only.\n`);
    return 'plugin';
  }

  console.log(`   ✓ No voter-weight plugin — vanilla token-weighted.`);
  return 'vanilla';
}

async function printGovernanceConfigs(
  gov: SplGovernance,
  realm: RealmV2,
): Promise<void> {
  let accounts: GovernanceAccount[];
  try {
    accounts = await gov.getGovernanceAccountsByRealm(realm.publicKey);
  } catch (err) {
    console.log(`   ✗ Failed to fetch governance accounts: ${(err as Error).message}\n`);
    return;
  }

  if (accounts.length === 0) {
    console.log(`   (no governance accounts found)\n`);
    return;
  }

  for (const ga of accounts) {
    const cfg = ga.config as GovernanceConfig;
    console.log(`   gov ${ga.publicKey.toBase58().slice(0, 8)}…`);
    console.log(`     approval threshold : ${formatVoteThreshold(cfg.communityVoteThreshold as VoteThreshold)}`);
    console.log(`     min weight         : ${formatMinWeight(cfg.minCommunityWeightToCreateProposal)}`);
    console.log(`     voting period      : ${formatDuration(Number(cfg.votingBaseTime))}`);
  }
  console.log('');
}

// Anchor serialises u8 enum fields as a Buffer-like { "0": value } object.
function extractU8(v: number | Record<string, number>): number {
  if (typeof v === 'number') return v;
  return Object.values(v)[0] ?? 0;
}

function formatVoteThreshold(t: VoteThreshold): string {
  if ('yesVotePercentage' in t) return `${extractU8(t.yesVotePercentage)}% yes`;
  if ('quorum' in t)            return `${extractU8(t.quorum)}% quorum`;
  if ('disabled' in t)          return 'disabled';
  return JSON.stringify(t);
}

// u64::MAX is the sentinel used by SPL Governance to signal "disabled"
// (effectively: no community member can create a proposal directly).
const U64_MAX = '18446744073709551615';

function formatMinWeight(raw: unknown): string {
  const s = String(raw);
  return s === U64_MAX ? 'u64::MAX (proposals disabled)' : `${s} base units`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return `${seconds}s`;
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return `${parts.join(' ')} (${seconds}s)`;
}

main().catch((err: unknown) => {
  console.error('Fatal:', (err as Error).message ?? err);
  process.exit(1);
});
