import { Connection, PublicKey } from '@solana/web3.js';
import {
  SplGovernance,
  type GovernanceConfig,
  type RealmV1,
  type RealmV2,
  type RealmConfig,
  type GovernanceAccount,
} from 'governance-idl-sdk';
import { createRequire } from 'module';
import {
  assessGovernance,
  renderMarkdownTable,
  scoreLabel,
  type DaoRisk,
  type GovernanceRisk,
} from './risk.js';

const require = createRequire(import.meta.url);
const { daos: DAO_LIST } = require('./dao-list.json') as {
  daos: Array<{
    name: string;
    symbol: string;
    realmId: string;
    programId: string;
    realmType: 'pda' | 'keypair';
  }>;
};

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('Realms Sentinel — config-audit  (Phase 0)');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Scanning ${DAO_LIST.length} DAOs from dao-list.json\n`);

  const connection = new Connection(RPC_URL, 'confirmed');

  let countVanilla = 0;
  let countPlugin  = 0;
  let countSkipped = 0;

  const riskResults: DaoRisk[] = [];

  for (const dao of DAO_LIST) {
    console.log(`── ${dao.symbol}  ${dao.name}`);

    const gov = new SplGovernance(connection, new PublicKey(dao.programId));

    // Try V2 layout; fall back to V1 for older governance forks.
    let realm: RealmV2;
    try {
      realm = await gov.getRealmByPubkey(new PublicKey(dao.realmId));
    } catch {
      try {
        const v1 = await gov.getRealmV1ByPubkey(new PublicKey(dao.realmId)) as unknown as RealmV1;
        console.log(`   ⓘ  RealmV1 (${v1.name}) — older IDL layout, skipping Phase 0.\n`);
        countSkipped++;
        continue;
      } catch (err2) {
        console.log(`   ✗ Fetch failed: ${(err2 as Error).message}\n`);
        countSkipped++;
        continue;
      }
    }

    // councilMint lives in the inline RealmConfig struct inside the Realm account.
    const councilMint = (realm.config as unknown as { councilMint: PublicKey | null }).councilMint ?? null;

    // Check for voter-weight plugin (VSR) via RealmConfigAccount.
    const vanilla = await checkVanilla(gov, realm);
    if (!vanilla) {
      countPlugin++;
      continue;
    }
    countVanilla++;

    const govAccounts = await fetchGovernanceAccounts(gov, realm);
    if (!govAccounts) continue;

    const governances: GovernanceRisk[] = govAccounts.map((ga) => {
      const cfg = ga.config as GovernanceConfig;
      return assessGovernance({
        governancePubkey: ga.publicKey.toBase58(),
        communityVoteThreshold: cfg.communityVoteThreshold,
        minCommunityWeightToCreateProposal: cfg.minCommunityWeightToCreateProposal,
        votingBaseTime: Number(cfg.votingBaseTime),
        councilMint,
      });
    });

    const worstScore = Math.max(0, ...governances.map(g => g.score)) as DaoRisk['worstScore'];
    const worstGov   = governances.find(g => g.score === worstScore)!;

    riskResults.push({
      name: dao.name,
      symbol: dao.symbol,
      realmPubkey: dao.realmId,
      governances,
      worstScore,
      worstFlags: worstGov.flags,
    });

    console.log(`   council       : ${councilMint ? councilMint.toBase58().slice(0, 8) + '…' : 'none'}`);
    console.log(`   gov accounts  : ${govAccounts.length}`);
    for (const g of governances) {
      const flagStr = g.flags.length ? g.flags.join(', ') : 'none';
      console.log(`   ${g.governancePubkey.slice(0, 8)}…  ${g.threshold.padEnd(14)} ${g.votingPeriod.padEnd(6)}  [${flagStr}]  ${scoreLabel(g.score)}`);
    }
    console.log('');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('═'.repeat(62));
  console.log(`SCAN SUMMARY  (${DAO_LIST.length} DAOs)`);
  console.log(`  vanilla decoded      : ${countVanilla}`);
  console.log(`  voter-weight plugin  : ${countPlugin}`);
  console.log(`  skipped (V1/error)   : ${countSkipped}`);
  console.log('═'.repeat(62));
  console.log('');

  if (riskResults.length === 0) {
    console.log('No vanilla DAOs decoded — no risk table to show.');
    return;
  }

  console.log('## Realms Sentinel — Phase 0 Risk Report\n');
  console.log(`*${DAO_LIST.length} DAOs scanned · ${countVanilla} vanilla decoded · ${countPlugin} VSR plugin · ${countSkipped} skipped*\n`);
  console.log('### Risk flag legend');
  console.log('- **SOLO_VOTE** — community proposals enabled + yesVotePercentage threshold: a single wallet can create a proposal, vote alone, and achieve 100% of cast votes → passes any threshold');
  console.log('- **LOW_THRESHOLD** — yesVotePercentage < 50%: even with competition, only a small fraction of cast votes is needed');
  console.log('- **NO_COUNCIL** — no guardian token with veto rights\n');
  console.log('### Per-governance breakdown\n');
  console.log(renderMarkdownTable(riskResults));
  console.log('');

  // Per-DAO summary
  console.log('### Per-DAO worst-case\n');
  const summaryRows = riskResults.map(dao => [
    `${dao.symbol} (${dao.name})`,
    String(dao.governances.length),
    dao.worstFlags.length ? dao.worstFlags.join(' ') : '—',
    scoreLabel(dao.worstScore),
  ]);
  const sumHeaders = ['DAO', 'Govs', 'Worst flags', 'Risk'];
  const sumWidths = sumHeaders.map((h, i) => Math.max(h.length, ...summaryRows.map(r => r[i]?.length ?? 0)));
  const sumLine = (cells: string[]): string =>
    '| ' + cells.map((c, i) => (c + ' '.repeat(sumWidths[i])).slice(0, sumWidths[i])).join(' | ') + ' |';
  const sumSep  = '| ' + sumWidths.map(w => '-'.repeat(w)).join(' | ') + ' |';
  console.log([sumLine(sumHeaders), sumSep, ...summaryRows.map(sumLine)].join('\n'));
  console.log('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkVanilla(gov: SplGovernance, realm: RealmV2): Promise<boolean> {
  let cfg: RealmConfig | null = null;
  try {
    cfg = await gov.getRealmConfigByRealm(realm.publicKey);
  } catch {
    console.log(`   ✓ No RealmConfigAccount → vanilla`);
    return true;
  }
  const addin = cfg.communityTokenConfig.voterWeightAddin as PublicKey | null;
  if (addin) {
    console.log(`   ⚠  VSR plugin: ${addin.toBase58().slice(0, 8)}…  — skipping.\n`);
    return false;
  }
  console.log(`   ✓ Vanilla (no voter-weight plugin)`);
  return true;
}

async function fetchGovernanceAccounts(
  gov: SplGovernance,
  realm: RealmV2,
): Promise<GovernanceAccount[] | null> {
  try {
    return await gov.getGovernanceAccountsByRealm(realm.publicKey);
  } catch (err) {
    console.log(`   ✗ Governance fetch failed: ${(err as Error).message}\n`);
    return null;
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', (err as Error).message ?? err);
  process.exit(1);
});
