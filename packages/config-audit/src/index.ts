import { Connection, PublicKey } from '@solana/web3.js';
import { SplGovernance, type GovernanceConfig, type RealmV2, type RealmConfig, type GovernanceAccount } from 'governance-idl-sdk';

// ---------------------------------------------------------------------------
// VoteThreshold — Anchor encodes enum variants as single-key objects.
// The inner u8 comes off the wire as a Buffer-like object { "0": <value> },
// not a plain number. We normalise it with extractU8().
// ---------------------------------------------------------------------------
type VoteThreshold =
  | { yesVotePercentage: number | Record<string, number> }
  | { quorum: number | Record<string, number> }
  | { disabled: Record<string, never> };

// ---------------------------------------------------------------------------
// Candidates to scan in order.  We stop at the first vanilla (no plugin) DAO.
// Names must match what is stored on-chain in the Realm account's `name` field
// (the SDK derives the Realm PDA deterministically from this string).
// ---------------------------------------------------------------------------
// These names are confirmed to exist on mainnet under the default SPL Governance
// program (GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw). Many well-known DAOs
// (Marinade, Drift, Orca, Mango) use a different programId or realm name —
// they won't be found here. We skip BONK (active exploit investigation).
const CANDIDATES = [
  'Squads',  // Squads protocol governance
  'Grape',   // Grape Network community DAO
  'Realms',  // Realms protocol's own governance
];

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('Realms Sentinel — config-audit  (Phase 0)');
  console.log(`RPC: ${RPC_URL}\n`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const gov = new SplGovernance(connection);

  for (const name of CANDIDATES) {
    console.log(`── Trying "${name}" …`);

    const realm = await resolveRealm(gov, name);
    if (!realm) continue;

    console.log(`   realm pubkey    : ${realm.publicKey.toBase58()}`);
    console.log(`   community mint  : ${realm.communityMint.toBase58()}`);

    const isVanilla = await checkVanilla(gov, realm);
    if (!isVanilla) continue;

    await printGovernanceConfigs(gov, realm);
    return; // stop after the first vanilla DAO
  }

  console.error('\nNo vanilla DAO found among candidates.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRealm(
  gov: SplGovernance,
  name: string,
): Promise<RealmV2 | null> {
  try {
    return await gov.getRealmByName(name);
  } catch {
    console.log(`   ✗ Not found on-chain.\n`);
    return null;
  }
}

async function checkVanilla(
  gov: SplGovernance,
  realm: RealmV2,
): Promise<boolean> {
  let cfg: RealmConfig | null = null;

  try {
    cfg = await gov.getRealmConfigByRealm(realm.publicKey);
  } catch {
    // No RealmConfigAccount → old-style realm with no plugin support.
    console.log(`   ✓ No RealmConfigAccount → vanilla (no plugin possible)\n`);
    return true;
  }

  // communityTokenConfig.voterWeightAddin is Option<PublicKey>:
  // Anchor decodes None as null, Some(pk) as a PublicKey instance.
  const addin = cfg.communityTokenConfig.voterWeightAddin as PublicKey | null;

  if (addin) {
    console.log(`   ⚠  Uses voter-weight plugin (VSR or similar): ${addin.toBase58()}`);
    console.log(`   Skipping — Phase 0 only supports vanilla token-weighted DAOs.\n`);
    return false;
  }

  console.log(`   ✓ No voter-weight plugin — vanilla token-weighted.`);
  return true;
}

async function printGovernanceConfigs(
  gov: SplGovernance,
  realm: RealmV2,
): Promise<void> {
  let accounts: GovernanceAccount[];
  try {
    accounts = await gov.getGovernanceAccountsByRealm(realm.publicKey);
  } catch (err) {
    console.error(`\nFailed to fetch governance accounts: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`DAO: ${realm.name}`);
  console.log(`Realm: ${realm.publicKey.toBase58()}`);
  console.log(`Governance accounts: ${accounts.length}`);
  console.log('═'.repeat(62));

  if (accounts.length === 0) {
    console.log('(no governance accounts found)');
    return;
  }

  for (const ga of accounts) {
    // GovernanceAccount.config is typed GovernanceConfig from the SDK.
    const cfg = ga.config as GovernanceConfig;

    console.log(`\n  Governance : ${ga.publicKey.toBase58()}`);
    console.log(`  ├ approval threshold   : ${formatVoteThreshold(cfg.communityVoteThreshold as VoteThreshold)}`);
    console.log(`  ├ min weight (proposal): ${formatMinWeight(cfg.minCommunityWeightToCreateProposal)}`);
    console.log(`  └ voting period        : ${formatDuration(Number(cfg.votingBaseTime))}`);
  }

  console.log('');
}

// Anchor serialises u8 enum fields as a Buffer-like { "0": value } object.
function extractU8(v: number | Record<string, number>): number {
  if (typeof v === 'number') return v;
  return Object.values(v)[0] ?? 0;
}

function formatVoteThreshold(t: VoteThreshold): string {
  if ('yesVotePercentage' in t) return `${extractU8(t.yesVotePercentage)}% of cast votes must be YES`;
  if ('quorum' in t)            return `${extractU8(t.quorum)}% of total supply must vote`;
  if ('disabled' in t)          return 'disabled';
  return JSON.stringify(t);
}

// u64::MAX is the sentinel used by SPL Governance to signal "disabled"
// (effectively: no community member can create a proposal directly).
const U64_MAX = '18446744073709551615';

function formatMinWeight(raw: unknown): string {
  const s = String(raw);
  return s === U64_MAX ? 'u64::MAX — community cannot create proposals' : `${s} base units`;
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
  return `${parts.join(' ')}  (${seconds}s)`;
}

main().catch((err: unknown) => {
  console.error('Fatal:', (err as Error).message ?? err);
  process.exit(1);
});
