//! ProofArena — two autonomous agents, one TxLINE feed, duels settled by Merkle proof.
//!
//! Agent A ("Steamer", momentum) and Agent B ("Fader", mean-reversion) read the same
//! demargined consensus. When a pre-kickoff steam signal fires, a DUEL is committed
//! on-chain: both agents' opposing positions, stakes and beliefs, timestamped by the
//! chain BEFORE the match starts — no hindsight, no edited logs. After full time,
//! `settle_duel` performs a CPI into TxLINE's on-chain `validate_stat`, which verifies
//! a 3-stage Merkle proof of the real match statistic against TxLINE's published daily
//! root. The proof — not the operator — decides which agent won.
//!
//! There is no instruction to amend or delete a duel. History is append-only.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

declare_id!("6iDo9DXUcAdXhrdGWCVxuADDZHVdixHuutJPm1g5gD5L");

/// TxLINE "txoracle" program (devnet). CPI target for trustless settlement.
pub const TXORACLE_PROGRAM_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// Anchor discriminator for `validate_stat` (from the on-chain IDL).
pub const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

// comparison / operator codes (mirror TxLINE's Comparison / BinaryExpression enums)
pub const CMP_GT: u8 = 0;
pub const CMP_LT: u8 = 1;
pub const CMP_EQ: u8 = 2;
pub const OP_ADD: u8 = 0;
pub const OP_SUB: u8 = 1;

#[program]
pub mod proofarena {
    use super::*;

    /// Commit a duel on-chain BEFORE kickoff. Stores the pinned predicate and both
    /// agents' positions. Rejected once the match has started — the chain's clock,
    /// not ours, enforces "no hindsight picks".
    pub fn commit_duel(ctx: Context<CommitDuel>, duel_seed: u64, params: DuelParams) -> Result<()> {
        require!(params.comparison <= CMP_EQ, ProofarenaError::BadParams);
        require!(params.op <= OP_SUB, ProofarenaError::BadParams);
        require!(params.steamer.stake > 0 && params.fader.stake > 0, ProofarenaError::BadParams);
        let now = Clock::get()?.unix_timestamp;
        require!(now < params.kickoff_time, ProofarenaError::MatchStarted);

        let d = &mut ctx.accounts.duel;
        d.operator = ctx.accounts.operator.key();
        d.fixture_id = params.fixture_id;
        d.duel_seed = duel_seed;
        d.stat_key_a = params.stat_key_a;
        d.period_a = params.period_a;
        d.use_two_stats = params.use_two_stats;
        d.stat_key_b = params.stat_key_b;
        d.period_b = params.period_b;
        d.op = params.op;
        d.threshold = params.threshold;
        d.comparison = params.comparison;
        d.kickoff_time = params.kickoff_time;
        d.steamer = params.steamer;
        d.fader = params.fader;
        d.committed_at = now;
        d.settled = false;
        d.predicate_true = false;
        d.settled_at = 0;
        d.bump = ctx.bumps.duel;

        emit!(DuelCommitted {
            duel: d.key(),
            fixture_id: d.fixture_id,
            duel_seed,
            committed_at: now,
        });
        Ok(())
    }

    /// Trustlessly settle the duel by CPI'ing into TxLINE `validate_stat` with the
    /// Merkle proof. The predicate is re-checked against what `commit_duel` pinned,
    /// so the settler can only prove the committed question — never change it.
    /// Permissionless: anyone may settle.
    pub fn settle_duel(ctx: Context<SettleDuel>, args: ValidateStatArgs) -> Result<()> {
        let d = &ctx.accounts.duel;
        require!(!d.settled, ProofarenaError::AlreadySettled);

        // ---- bind the proof to THIS duel's committed question ----
        require!(args.fixture_summary.fixture_id == d.fixture_id, ProofarenaError::FixtureMismatch);
        require!(args.predicate.threshold == d.threshold, ProofarenaError::PredicateMismatch);
        require!(cmp_code(&args.predicate.comparison) == d.comparison, ProofarenaError::PredicateMismatch);
        require!(args.stat_a.stat_to_prove.key == d.stat_key_a, ProofarenaError::PredicateMismatch);
        require!(args.stat_a.stat_to_prove.period == d.period_a, ProofarenaError::PredicateMismatch);
        if d.use_two_stats {
            let b = args.stat_b.as_ref().ok_or(ProofarenaError::PredicateMismatch)?;
            require!(b.stat_to_prove.key == d.stat_key_b, ProofarenaError::PredicateMismatch);
            require!(b.stat_to_prove.period == d.period_b, ProofarenaError::PredicateMismatch);
            let op = args.op.as_ref().ok_or(ProofarenaError::PredicateMismatch)?;
            require!(op_code(op) == d.op, ProofarenaError::PredicateMismatch);
        } else {
            require!(args.stat_b.is_none(), ProofarenaError::PredicateMismatch);
        }

        // ---- CPI into TxLINE validate_stat ----
        require_keys_eq!(ctx.accounts.txoracle_program.key(), TXORACLE_PROGRAM_ID, ProofarenaError::BadOracle);
        let mut data = Vec::with_capacity(512);
        data.extend_from_slice(&VALIDATE_STAT_DISC);
        args.serialize(&mut data)?;
        let ix = Instruction {
            program_id: TXORACLE_PROGRAM_ID,
            accounts: vec![AccountMeta::new_readonly(ctx.accounts.daily_scores_merkle_roots.key(), false)],
            data,
        };
        invoke(
            &ix,
            &[
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.txoracle_program.to_account_info(),
            ],
        )?;

        // ---- read the bool result the oracle set via return data ----
        let (ret_program, ret) = get_return_data().ok_or(ProofarenaError::NoOracleResult)?;
        require_keys_eq!(ret_program, TXORACLE_PROGRAM_ID, ProofarenaError::BadOracle);
        let predicate_true = matches!(ret.first(), Some(1));

        let d = &mut ctx.accounts.duel;
        d.settled = true;
        d.predicate_true = predicate_true;
        d.settled_at = Clock::get()?.unix_timestamp;

        // steamer backs the predicate; fader backs its negation
        emit!(DuelSettled {
            duel: d.key(),
            fixture_id: d.fixture_id,
            predicate_true,
            winner: if predicate_true { Agent::Steamer } else { Agent::Fader },
        });
        Ok(())
    }
}

fn cmp_code(c: &Comparison) -> u8 {
    match c {
        Comparison::GreaterThan => CMP_GT,
        Comparison::LessThan => CMP_LT,
        Comparison::EqualTo => CMP_EQ,
    }
}
fn op_code(o: &BinaryExpression) -> u8 {
    match o {
        BinaryExpression::Add => OP_ADD,
        BinaryExpression::Subtract => OP_SUB,
    }
}

// ===================== Accounts =====================

#[derive(Accounts)]
#[instruction(duel_seed: u64, params: DuelParams)]
pub struct CommitDuel<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        init,
        payer = operator,
        space = 8 + Duel::SIZE,
        seeds = [b"duel", params.fixture_id.to_le_bytes().as_ref(), duel_seed.to_le_bytes().as_ref()],
        bump
    )]
    pub duel: Account<'info, Duel>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleDuel<'info> {
    /// Anyone may settle — the proof is the authority, not this signer.
    pub settler: Signer<'info>,
    #[account(mut, seeds = [b"duel", duel.fixture_id.to_le_bytes().as_ref(), duel.duel_seed.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    /// CHECK: TxLINE daily-scores root PDA, validated inside the CPI to validate_stat.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: must be the TxLINE program; enforced by address check before CPI.
    #[account(address = TXORACLE_PROGRAM_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
}

// ===================== State =====================

/// One agent's side of a duel. Stakes are virtual units from the agent's public
/// bankroll ledger; odds are the fair consensus price at commit time ×1000;
/// belief is the agent's model probability in basis points.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct AgentPosition {
    pub stake: u64,
    pub odds_milli: u32,
    pub belief_bp: u16,
}
impl AgentPosition {
    pub const SIZE: usize = 8 + 4 + 2;
}

#[account]
pub struct Duel {
    pub operator: Pubkey,
    pub fixture_id: i64,
    pub duel_seed: u64,
    // pinned predicate — the committed question
    pub stat_key_a: u32,
    pub period_a: i32,
    pub use_two_stats: bool,
    pub stat_key_b: u32,
    pub period_b: i32,
    pub op: u8,
    pub threshold: i32,
    pub comparison: u8,
    pub kickoff_time: i64,
    // the two positions
    pub steamer: AgentPosition,
    pub fader: AgentPosition,
    // lifecycle
    pub committed_at: i64,
    pub settled: bool,
    pub predicate_true: bool,
    pub settled_at: i64,
    pub bump: u8,
}
impl Duel {
    pub const SIZE: usize =
        32 + 8 + 8 + 4 + 4 + 1 + 4 + 4 + 1 + 4 + 1 + 8 + AgentPosition::SIZE * 2 + 8 + 1 + 1 + 8 + 1;
}

// ===================== Args / mirrored TxLINE types =====================

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DuelParams {
    pub fixture_id: i64,
    pub stat_key_a: u32,
    pub period_a: i32,
    pub use_two_stats: bool,
    pub stat_key_b: u32,
    pub period_b: i32,
    pub op: u8,
    pub threshold: i32,
    pub comparison: u8,
    pub kickoff_time: i64,
    pub steamer: AgentPosition,
    pub fader: AgentPosition,
}

/// Exact borsh mirror of TxLINE `validate_stat` args (order + types matter for the CPI).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ValidateStatArgs {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub predicate: TraderPredicate,
    pub stat_a: StatTerm,
    pub stat_b: Option<StatTerm>,
    pub op: Option<BinaryExpression>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

// ===================== Events =====================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    Steamer,
    Fader,
}

#[event]
pub struct DuelCommitted {
    pub duel: Pubkey,
    pub fixture_id: i64,
    pub duel_seed: u64,
    pub committed_at: i64,
}
#[event]
pub struct DuelSettled {
    pub duel: Pubkey,
    pub fixture_id: i64,
    pub predicate_true: bool,
    pub winner: Agent,
}

// ===================== Errors =====================

#[error_code]
pub enum ProofarenaError {
    #[msg("Invalid duel parameters")] BadParams,
    #[msg("Match already started — commitments must precede kickoff")] MatchStarted,
    #[msg("Duel already settled")] AlreadySettled,
    #[msg("Proof fixture does not match duel")] FixtureMismatch,
    #[msg("Predicate does not match committed duel")] PredicateMismatch,
    #[msg("Invalid TxLINE oracle program")] BadOracle,
    #[msg("Oracle returned no result")] NoOracleResult,
}
