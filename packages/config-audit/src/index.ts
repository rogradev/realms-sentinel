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
// Known SPL Governance program deployments on mainnet-beta.
//
// Source: Mythic-Project/governance-ui public/realms/mainnet-beta.json (338 DAOs).
// Each major protocol that launched a DAO fork deployed its own program ID so
// they could upgrade governance logic independently.
//
// Architecture note — PDA-based vs keypair-based realms:
//   Most established DAOs (Mango, Marinade, Orca, Drift, Pyth) created their
//   realm account as a keypair account, not a PDA.  The PDA derivation in
//   SplGovernance.getRealmByName() uses seeds ["governance", realmName] which
//   only works when the original deploy chose that path.  Verified on mainnet:
//     Jito    → PDA match under jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx ✓
//     Mango   → keypair account (0xDPiH3H3c…), PDA derivation fails
//     Marinade→ keypair account (0x899YG3yk…), PDA derivation fails
//     Orca    → keypair account (0x66Du7mXg…), PDA derivation fails
//     Drift   → keypair account (0xFVVXu18a…), PDA derivation fails
//     Pyth    → keypair account (0x4ct8XU5t…), PDA derivation fails
//   Phase 0 covers PDA-based realms only. Registry-based lookup planned for Phase 1.
// ---------------------------------------------------------------------------
const GOVERNANCE_PROGRAMS: Array<{ programId: string; protocol: string }> = [
  // Canonical SPL Governance — hosts the majority of Solana DAOs (290 of 338 in registry)
  { programId: 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', protocol: 'SPL Governance (canonical)' },
  // Jito — liquid staking + MEV infrastructure DAO fork (PDA-based realm confirmed)
  { programId: 'jtogvBNH3WBSWDYD5FJfQP2ZxNTuf82zL8GkEhPeaJx', protocol: 'Jito' },
  // Mango Markets — perps & lending DAO fork (keypair realm — PDA won't match, listed for completeness)
  { programId: 'GqTPL6qRf5aUuqscLh8Rg2HTxPUXfhhAXDptTLhp1t2J', protocol: 'Mango' },
  // Marinade Finance — liquid staking DAO fork (keypair realm)
  { programId: 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs', protocol: 'Marinade' },
  // Orca — AMM DAO fork (keypair realm)
  { programId: 'J9uWvULFL47gtCPvgR3oN7W357iehn5WF2Vn9MJvcSxz', protocol: 'Orca' },
  // Drift Protocol — perps DEX DAO fork (keypair realm)
  { programId: 'dgov7NC8iaumWw3k8TkmLDybvZBCmd1qwxgLAGAsWxf', protocol: 'Drift' },
  // Pyth Network — oracle DAO fork (keypair realm)
  { programId: 'pytGY6tWRgGinSCvRLnSv4fHfBTMoiDGiCsesmHWM6U', protocol: 'Pyth' },
  // Helium — IoT/Mobile DAO fork
  { programId: 'hgovkRU6Ghe1Qoyb54HdSLdqN7VtxaifBzRmh9jtd3S', protocol: 'Helium' },
];

// ---------------------------------------------------------------------------
// Candidates to scan in order.  We stop at the first vanilla (no plugin) DAO.
// Names must match what is stored on-chain in the Realm account's `name` field.
// The resolver tries PDA derivation under every known program ID before giving up.
// We skip BONK (active exploit investigation — excluded from Phase 0).
// ---------------------------------------------------------------------------
const CANDIDATES = [
  'Squads',  // Squads protocol — PDA under canonical program
  'Grape',   // Grape Network community DAO — PDA under canonical program
  'Jito',    // Jito DAO — PDA confirmed under Jito fork program
  'Realms',  // Realms protocol governance — PDA under canonical program
];

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('Realms Sentinel — config-audit  (Phase 0)');
  console.log(`RPC: ${RPC_URL}\n`);
  console.log(`Known governance programs: ${GOVERNANCE_PROGRAMS.length}`);
  console.log(`Candidates to scan: ${CANDIDATES.join(', ')}\n`);

  const connection = new Connection(RPC_URL, 'confirmed');

  for (const name of CANDIDATES) {
    console.log(`── Trying "${name}" …`);

    const result = await resolveRealm(connection, name);
    if (!result) continue;

    const { gov, realm } = result;
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

// Try PDA derivation under every known governance program ID.
// Returns the first match together with the SplGovernance client that found it.
// Logs each attempt so the output serves as evidence for which programs are live.
async function resolveRealm(
  connection: Connection,
  name: string,
): Promise<{ gov: SplGovernance; realm: RealmV2 } | null> {
  for (const { programId, protocol } of GOVERNANCE_PROGRAMS) {
    const gov = new SplGovernance(connection, new PublicKey(programId));
    try {
      const realm = await gov.getRealmByName(name);
      console.log(`   ✓ Found under ${protocol} (${programId})`);
      return { gov, realm };
    } catch {
      // PDA miss or network error — try next program
    }
  }
  console.log(`   ✗ Not found under any known program ID.\n`);
  return null;
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
