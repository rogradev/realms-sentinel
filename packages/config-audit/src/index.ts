import { Connection, PublicKey } from '@solana/web3.js';
import {
  SplGovernance,
  type GovernanceConfig,
  type RealmV2,
  type RealmConfig,
  type GovernanceAccount,
} from 'governance-idl-sdk';
import { createRequire } from 'module';
import {
  assessGovernance,
  renderMarkdownTables,
  renderSummaryTable,
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
// Error classification for V2/V1 fallback (Fix 5)
// ---------------------------------------------------------------------------

// A deserialization error is a RangeError thrown by Node's Buffer when Borsh
// tries to read past the end of an account whose layout doesn't match the IDL.
// Network errors (timeouts, 429s, RPC errors) are plain Errors with different
// message patterns.  We only attempt V1 fallback for deserialization failures —
// misclassifying a network error as V1 would mask transient RPC problems.
function isDeserializationError(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const msg = (err as Error).message ?? '';
  // Node buffer bounds error pattern
  return msg.includes('out of range') || msg.includes('offset');
}

// ---------------------------------------------------------------------------
// Mint info (Fix 3)
// ---------------------------------------------------------------------------

interface MintInfo {
  decimals: number;
  supply: string;
}

async function fetchMintInfo(
  connection: Connection,
  mint: PublicKey,
): Promise<MintInfo | null> {
  try {
    const info = await connection.getParsedAccountInfo(mint);
    const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number; supply?: string } } })?.parsed?.info;
    if (!parsed || parsed.decimals === undefined || !parsed.supply) return null;
    return { decimals: parsed.decimals, supply: parsed.supply };
  } catch {
    return null;
  }
}

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
  let countV1      = 0;
  let countError   = 0;

  const riskResults: DaoRisk[] = [];

  for (const dao of DAO_LIST) {
    console.log(`── ${dao.symbol}  ${dao.name}`);

    const gov = new SplGovernance(connection, new PublicKey(dao.programId));

    // --- Realm fetch with V2/V1 distinction (Fix 5) ---
    let realm: RealmV2;
    try {
      realm = await gov.getRealmByPubkey(new PublicKey(dao.realmId));
    } catch (err) {
      if (isDeserializationError(err)) {
        // Confirmed IDL mismatch: try V1 layout to log the name, then skip.
        try {
          const v1 = await gov.getRealmV1ByPubkey(new PublicKey(dao.realmId));
          console.log(`   ⓘ  RealmV1 layout (${(v1 as unknown as { name: string }).name}) — Phase 0 decodes V2 only.\n`);
          countV1++;
        } catch {
          // Even V1 fails: the account is present but neither layout matches.
          console.log(`   ⓘ  RealmV1 fallback also failed — IDL mismatch or corrupt account.\n`);
          countV1++;
        }
      } else {
        // Network error, RPC error, or account not found — not an IDL issue.
        console.log(`   ✗ Fetch error (network/RPC): ${(err as Error).message}\n`);
        countError++;
      }
      continue;
    }

    // --- Council mint (from inline RealmConfig, inside RealmV2) ---
    // The type cast is necessary because governance-idl-sdk does not re-export
    // the inner RealmConfig struct as a TypeScript interface, only as an IDL type.
    const councilMint = (realm.config as unknown as { councilMint: PublicKey | null }).councilMint ?? null;

    // --- Mint metadata for human-readable weight display (Fix 3) ---
    const mintInfo = await fetchMintInfo(connection, realm.communityMint);

    // --- Vanilla check — now also tests maxVoterWeightAddin (Fix 4) ---
    const vanillaResult = await checkVanilla(gov, realm);
    if (!vanillaResult) {
      countPlugin++;
      continue;
    }
    countVanilla++;

    // --- Governance accounts ---
    const govAccounts = await fetchGovernanceAccounts(gov, realm);
    if (!govAccounts) continue;

    const governances: GovernanceRisk[] = govAccounts.map((ga) => {
      const cfg = ga.config as GovernanceConfig & {
        minTransactionHoldUpTime: number;
        votingCoolOffTime: number;
        councilVetoVoteThreshold: unknown;
      };
      return assessGovernance({
        governancePubkey:                   ga.publicKey.toBase58(),
        communityVoteThreshold:             cfg.communityVoteThreshold,
        minCommunityWeightToCreateProposal: cfg.minCommunityWeightToCreateProposal,
        votingBaseTime:                     Number(cfg.votingBaseTime),
        minTransactionHoldUpTime:           cfg.minTransactionHoldUpTime,
        votingCoolOffTime:                  cfg.votingCoolOffTime,
        councilVetoVoteThreshold:           cfg.councilVetoVoteThreshold,
        councilMint,
        mintDecimals: mintInfo?.decimals ?? 0,
        mintSupply:   mintInfo?.supply ?? null,
        tokenSymbol:  dao.symbol,
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

    console.log(`   council mint  : ${councilMint ? councilMint.toBase58().slice(0, 8) + '…' : 'none'}`);
    console.log(`   mint dec/supply: ${mintInfo?.decimals ?? '?'} / ${mintInfo?.supply ?? '?'}`);
    console.log(`   gov accounts  : ${govAccounts.length}`);
    for (const g of governances) {
      const flagStr = g.flags.length ? g.flags.join(', ') : 'none';
      console.log(
        `   ${g.governancePubkey.slice(0, 8)}…` +
        `  ${g.threshold.padEnd(12)}` +
        `  minW: ${g.minWeightHuman.padEnd(16)} (${g.minWeightPct})` +
        `  holdUp: ${g.holdUpTime}  coolOff: ${g.coolOffTime}` +
        `  veto: ${g.vetoThreshold}` +
        `  [${flagStr}]  ${scoreLabel(g.score)}`
      );
    }
    console.log('');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('═'.repeat(70));
  console.log(`SCAN SUMMARY  (${DAO_LIST.length} DAOs)`);
  console.log(`  vanilla decoded        : ${countVanilla}`);
  console.log(`  voter-weight plugin    : ${countPlugin}`);
  console.log(`  RealmV1 layout (skip)  : ${countV1}`);
  console.log(`  network / fetch error  : ${countError}`);
  console.log('═'.repeat(70));
  console.log('');

  if (riskResults.length === 0) {
    console.log('No vanilla DAOs decoded — no risk table to show.');
    return;
  }

  console.log('## Realms Sentinel — Phase 0 Risk Report\n');
  console.log(
    `*${DAO_LIST.length} DAOs scanned · ` +
    `${countVanilla} vanilla decoded · ` +
    `${countPlugin} VSR plugin · ` +
    `${countV1} RealmV1 · ` +
    `${countError} network error*\n`
  );

  console.log('### Risk flag definitions');
  console.log('- **SOLO_VOTE** — community proposals enabled (minWeight ≠ u64::MAX) + yesVotePercentage threshold. A single wallet above minWeight can vote alone and achieve 100% of cast votes, passing any threshold.');
  console.log('- **LOW_THRESHOLD** — yesVotePercentage < 50%. Even with competition, a minority of cast votes suffices.');
  console.log('- **NO_COUNCIL** — community proposals enabled AND the council veto threshold is disabled or 0%. Fires only when there is something to veto (proposals enabled); silent when community proposals are disabled.\n');

  console.log('**Column notes:**');
  console.log('- *HoldUp*: `minTransactionHoldUpTime` from GovernanceConfig — governance-level execution delay (0s = executes immediately after proposal passes). Distinct from per-proposal `holdUpTime` in ProposalTransaction (not decoded in Phase 0).');
  console.log('- *CoolOff*: `votingCoolOffTime` — post-voting buffer during which council can veto before execution begins.');
  console.log('- *Council veto*: `councilVetoVoteThreshold` — threshold for council to veto a passed community proposal. ⚠ = non-functional (disabled or 0%).\n');

  console.log(renderMarkdownTables(riskResults));
  console.log('');

  console.log('### Per-DAO worst-case\n');
  console.log(renderSummaryTable(riskResults));
  console.log('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fix 4: checks both voterWeightAddin AND maxVoterWeightAddin.
async function checkVanilla(gov: SplGovernance, realm: RealmV2): Promise<boolean> {
  let cfg: RealmConfig | null = null;
  try {
    cfg = await gov.getRealmConfigByRealm(realm.publicKey);
  } catch {
    console.log(`   ✓ No RealmConfigAccount → vanilla (no plugin possible)`);
    return true;
  }

  const addin    = cfg.communityTokenConfig.voterWeightAddin    as PublicKey | null;
  const maxAddin = cfg.communityTokenConfig.maxVoterWeightAddin as PublicKey | null;

  if (addin) {
    console.log(`   ⚠  voterWeightAddin: ${addin.toBase58().slice(0, 8)}… — not vanilla, skipping.\n`);
    return false;
  }
  if (maxAddin) {
    console.log(`   ⚠  maxVoterWeightAddin: ${maxAddin.toBase58().slice(0, 8)}… — not vanilla, skipping.\n`);
    return false;
  }

  console.log(`   ✓ Vanilla (voterWeightAddin=null, maxVoterWeightAddin=null)`);
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
