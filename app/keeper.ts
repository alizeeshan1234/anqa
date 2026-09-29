/**
 * The engine.
 *
 * A dark venue cannot run itself. Three jobs, none of them optional:
 *
 *   relay    refresh the internal oracle **inside the rollup**. The relay is
 *            delegated (a clone-read snapshot would freeze the mark), and
 *            Pyth's own price account is clone-readable there, so the same
 *            verified feed is available on the inside.
 *   crank    advance mark and funding inside the rollup. Cadence is a
 *            solvency parameter: the kernel accrues bounded segments, so a
 *            crank that falls behind leaves loss-staleness armed and every
 *            fill is refused — and funding under-accrues by however far
 *            behind it is.
 *   settle   execute fills the book matched but nobody could settle, because
 *            on a dark market the taker cannot name its counterparty.
 *
 * Every instruction it sends is permissionless. The keeper adds liveness,
 * never authority: losing it degrades the venue, it cannot steal from it.
 *
 * Run: npx ts-node --transpile-only app/keeper.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { baseConnection, useHttpConfirmation } from "./rpc";
import { spawn } from "child_process";
import bs58 from "bs58";
import fs from "fs";
import { teeRpcFor } from "./tee-auth";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
// Delegation, permissions and the validator fee vault — the same constants
// `provision-hub.ts` uses, needed here because the engine now stands up each
// trader's order mirror itself rather than waiting for the trader to.
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ACL_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const MAGIC_FEE_VAULT = PublicKey.findProgramAddressSync(
  [Buffer.from("magic-fee-vault"), TEE_VALIDATOR.toBuffer()],
  DLP
)[0];
const delegationOf = (a: PublicKey) => ({
  buffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), a.toBuffer()], PROGRAM_ID)[0],
  delegationRecord: PublicKey.findProgramAddressSync([Buffer.from("delegation"), a.toBuffer()], DLP)[0],
  delegationMetadata: PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), a.toBuffer()], DLP)[0],
});
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
/** The cross-margin hub this keeper runs. Every market in it is driven here. */
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);

/** Rollup slots are ~7x base slots; crank often or the clock drifts. */
const CRANK_MS = Number(process.env.ANQA_CRANK_MS ?? 2000);
/** Pyth on devnet moves slowly; the relay does not need the same cadence. */
const RELAY_MS = Number(process.env.ANQA_RELAY_MS ?? 2500);
/** Settlement should feel immediate to whoever just traded. */
const SETTLE_MS = Number(process.env.ANQA_SETTLE_MS ?? 400);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (tag: string, msg: string) => console.log(`${now()}  ${tag.padEnd(7)} ${msg}`);

// A keeper that exits is worse than any error it might swallow: fills stop
// settling and the mark freezes. Network hiccups on public devnet RPCs are
// routine — log them and keep running.
process.on("unhandledRejection", (e) =>
  console.log(`${new Date().toISOString().slice(11, 19)}  guard   unhandled rejection: ${String(e).slice(0, 110)}`)
);
process.on("uncaughtException", (e) =>
  console.log(`${new Date().toISOString().slice(11, 19)}  guard   uncaught exception: ${String(e).slice(0, 110)}`)
);

async function main() {
  const conn = useHttpConfirmation(baseConnection(RPC));
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"),
          "utf-8"
        )
      )
    )
  );
  // The TEE endpoint filters reads per account; a signed session tells
  // it who we are. Without this the keeper reads back nulls.
  const er = useHttpConfirmation(
    new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed")
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const mk = (c: Connection) =>
    new Program(
      idl,
      new anchor.AnchorProvider(c, new anchor.Wallet(keeper), {
        commitment: "confirmed",
        skipPreflight: true, // latency matters more than a pre-flight here
      })
    ) as any;
  const pBase = mk(conn);
  const pEr = mk(er);

  const mpda = (t: string, id: BN, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(id), ...e], PROGRAM_ID)[0];
  const gpda = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];

  // ─────────────────────────── one keeper, N markets ───────────────────────
  //
  // Everything that carries risk is **hub-scoped**: one risk engine, one slab
  // of asset slots, one clock, one portfolio per trader. Only six accounts are
  // actually per-market. So a process per market was never buying isolation —
  // it was running the same group-wide work N times over identical data, and
  // the portfolio scan (a full `getProgramAccounts`) is the most expensive
  // call the keeper makes. Nine copies of it every 15s is what exhausted the
  // RPC's connection limit and starved the makers.
  //
  // Here the group work runs once and the per-market work loops. Adding a
  // market costs six PDAs and a few more transactions per tick, not another
  // process, another RPC connection and another full scan.
  const riskGroup = gpda("anqa_risk");
  const assetSlots = gpda("anqa_assets");
  const venueClock = gpda("anqa_clock");
  const portfolioOf = (k: PublicKey) => gpda("anqa_portfolio", [k.toBuffer()]);

  type Mkt = {
    id: BN;
    asset: number;
    market: PublicKey;
    book: PublicKey;
    oracleState: PublicKey;
    internalOracle: PublicKey;
    tape: PublicKey;
    depth: PublicKey;
    feed: PublicKey;
    /** Per-market requote state; a stalled maker must not back off the others. */
    requoting: boolean;
    failures: number;
    /** When the ladder was last re-laid for drift, so it cannot thrash. */
    lastDrift: number;
    cranks: number;
    relays: number;
  };

  /** `id:asset:feed` per market, comma separated. Defaults to this hub's nine. */
  const MARKET_SPEC =
    process.env.ANQA_MARKETS ??
    [
      "0:4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
      "1:7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
      "2:42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC",
      "3:Ae3LGcV5Wt5Z11xvhxSX1h65uNyjuX4qYFFbgifLx5eX",
      "4:681QkKLoAQrB5h23Ewq9c8rjM19RBuzqwXZf2RPr9Pyw",
      "5:7bWHpGtb2j3jqbpA5gFctdmgZELubiZDBxmt1pEzkBHR",
      "6:HUBqpBf3aGJdVQndFHmMUd1eMcixt7S4swYPCx8A93K1",
      "7:GgV3a7YeVRga9prjNGEDBG9NwatSaD8rwjZ4GNjPiXTq",
      "8:A3qp5QG9xGeJR1gexbW9b9eMMsMDLzx3rhud9SnNhwb4",
    ]
      .map((s, i) => `${GROUP_ID.addn(i).toString()}:${s}`)
      .join(",");

  const MK: Mkt[] = MARKET_SPEC.split(",")
    .filter(Boolean)
    .map((spec) => {
      const [idS, assetS, feedS] = spec.split(":");
      const id = new BN(idS);
      return {
        id,
        asset: Number(assetS),
        market: mpda("anqa_market", id),
        book: mpda("anqa_book", id),
        oracleState: mpda("anqa_oracle", id),
        internalOracle: mpda("anqa_int_oracle", id),
        tape: mpda("anqa_tape", id),
        depth: mpda("anqa_depth", id),
        feed: new PublicKey(feedS),
        requoting: false,
        failures: 0,
        lastDrift: 0,
        cranks: 0,
        relays: 0,
      };
    });

  /** Any market will do for instructions that only read hub-scoped state. */
  const anyMarket = MK[0].market;

  log(
    "start",
    `${MK.length} market(s) ${MK[0].id}–${MK[MK.length - 1].id} · keeper ${keeper.publicKey
      .toBase58()
      .slice(0, 8)}…`
  );
  log("start", `crank ${CRANK_MS}ms · settle ${SETTLE_MS}ms · relay ${RELAY_MS}ms`);

  let cranks = 0;
  let prints = 0;
  let lastErr = "";

  // `current_slot` is group-wide while each asset carries its own
  // `slot_last`. If two crank/settle loops overlap, a crank for market B can
  // advance the group clock after market A was refreshed but before A's fill
  // executes. The kernel then (correctly) rejects A as loss-stale. Serialize
  // the clock-sensitive work, and let settlement refresh its own asset last.
  let riskTail: Promise<void> = Promise.resolve();
  const riskJob = <T>(fn: () => Promise<T>): Promise<T> => {
    const job = riskTail.catch(() => undefined).then(fn);
    riskTail = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  };

  /** Never let one failure kill a loop; a keeper that exits is worse. */
  const guard = async (tag: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 110);
      if (msg !== lastErr) {
        log(tag, `· ${msg}`);
        lastErr = msg;
      }
    }
  };

  /** Run `fn` for every market, one at a time — bursts are what get rate-limited. */
  const forEachMarket = async (tag: string, fn: (m: Mkt) => Promise<void>) => {
    for (const m of MK) await guard(tag, () => fn(m));
  };

  // relay: inside the rollup, against the clone-readable Pyth feed.
  const relay = (m: Mkt) =>
    (async () => {
      await pEr.methods
        .syncInternalOracle()
        .accounts({
          keeper: keeper.publicKey,
          market: m.market,
          internalOracle: m.internalOracle,
          priceUpdate: m.feed,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      m.relays++;
      if (m.relays % 20 === 1) log("relay", `${m.id} oracle refreshed (${m.relays})`);
    })();

  // crank: inside the rollup, off the relay.
  const crankTx = (m: Mkt) =>
    (async () => {
      await pEr.methods
        .crank(m.asset, new BN(0))
        .accounts({
          cranker: keeper.publicKey,
          market: m.market,
          riskGroup,
          assetSlots,
          oracleState: m.oracleState,
          internalOracle: m.internalOracle,
          venueClock,
        })
        .rpc();
      m.cranks++;
      cranks++;
      if (m.cranks % 30 === 0) {
        const os1: any = await pEr.account.oracleState.fetch(m.oracleState);
        log("crank", `${m.id} ${m.cranks} ticks · mark $${(Number(os1.lastPrice) / 1e6).toLocaleString()}`);
      }
    })();
  // How far this asset's accrual clock trails the group header.
  //
  // A crank accrues its asset by at most `max_accrual_dt_slots` (100) — but
  // it also ticks the venue clock by up to 100, and so does every neighbour's
  // crank and every sweep. On a host producing ~100 slots/s (MagicBlock
  // devnet since 2026-09; it was ~15/s when this keeper was tuned) a tick is
  // always the full 100, so a lone crank gains no ground and the asset stays
  // loss-stale forever — and the kernel refuses every risk-increasing fill
  // as LockActive. Cranks fired back-to-back land faster than the host makes
  // 100 slots, so each one in a burst gains net ground. Offsets pinned by
  // app/diag-assets.ts and programs/anqa-core/tests/diag.rs.
  const HDR_CURRENT_SLOT = 8 + 581; // RiskGroup: disc + header.current_slot (slot_last is at 573)
  const SLOT_STRIDE = 1293; // sizeof(PercMarket<AssetTag>)
  const ASSET_SLOT_LAST = 8 + 41; // tag + AssetStateV16.slot_last
  const assetLag = async (m: Mkt): Promise<number> => {
    const [rg, as] = await Promise.all([
      er.getAccountInfo(riskGroup),
      er.getAccountInfo(assetSlots),
    ]);
    if (!rg || !as) return 0;
    const header = Number(rg.data.readBigUInt64LE(HDR_CURRENT_SLOT));
    const slotLast = Number(
      as.data.readBigUInt64LE(8 + m.asset * SLOT_STRIDE + ASSET_SLOT_LAST)
    );
    return header - slotLast;
  };
  // A burst of cranks, pipelined: signed up front and sent without waiting
  // for each confirmation. Sent one-at-a-time, each crank lands ~300ms apart
  // — 30 host slots — so the venue clock ticks 30 and the asset accrues 100,
  // a gain of 70 per crank while every *other* asset loses 30. Three live
  // assets at that rate is a treadmill. Pipelined, cranks land a few slots
  // apart, the clock ticks a few and the asset still accrues 100 per crank,
  // so a burst closes thousands of slots in a second and costs its
  // neighbours almost nothing. Each transaction carries a distinct priority
  // fee so identical instructions on one blockhash still sign differently.
  const crankBurst = async (m: Mkt, count: number) => {
    const { blockhash } = await er.getLatestBlockhash();
    const txs = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const tx = await pEr.methods
          .crank(m.asset, new BN(0))
          .accounts({
            cranker: keeper.publicKey,
            market: m.market,
            riskGroup,
            assetSlots,
            oracleState: m.oracleState,
            internalOracle: m.internalOracle,
            venueClock,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: i + 1 })])
          .transaction();
        tx.feePayer = keeper.publicKey;
        tx.recentBlockhash = blockhash;
        tx.sign(keeper);
        return tx.serialize();
      })
    );
    // Sent in parallel chunks: a serial send is ~15ms each, which caps a
    // burst at ~60 cranks/s; an 18-million-slot debt (seven idle weeks on a
    // 100-slot/s host) is 180k cranks, and that has to finish in minutes,
    // not hours. Dropped sends are fine — the next round measures what
    // actually landed.
    let sent = 0;
    for (let i = 0; i < txs.length; i += 32) {
      const results = await Promise.allSettled(
        txs.slice(i, i + 32).map((raw) => er.sendRawTransaction(raw, { skipPreflight: true }))
      );
      sent += results.filter((r) => r.status === "fulfilled").length;
    }
    m.cranks += sent;
    cranks += sent;
    return sent;
  };
  /**
   * Crank until the asset's accrual clock has caught the header, or `rounds`
   * bursts. Each round sizes its burst to the measured lag.
   */
  /** Debt beyond this is weeks of idle host — the walk-off loop's job, not a pass's. */
  const DEEP_DEBT = 50_000;
  const crankUntilCurrent = async (m: Mkt, rounds: number, walkOff = false): Promise<number> => {
    const start = await assetLag(m);
    let lag = start;
    let i = 0;
    let sent = 0;
    // One confirmed crank first, always: it is what pushes the fresh mark into
    // the oracle state the terminal and the maker read, so it must land even
    // when the accrual clock is already current. It also probes: a market
    // whose oracle is stale refuses every crank (6020), and this one throws
    // instead of a burst of silent refusals, so the caller's guard logs it
    // once and moves on.
    await crankTx(m);
    sent++;
    lag = await assetLag(m);
    // A pass only pushes the mark on a deep-debt market; bursting here would
    // hold every other market's mark and settlement behind it for minutes.
    if (!walkOff && lag > DEEP_DEBT) return lag;
    for (; i < rounds && lag > 0; i++) {
      sent += await crankBurst(m, Math.min(Math.ceil(lag / 90) + 1, 256));
      await sleep(700);
      lag = await assetLag(m);
    }
    if (start > 2_000 || lag > 0) {
      log("crank", `${m.id} lag ${start.toLocaleString()} → ${lag.toLocaleString()} slots after ${sent} crank(s) in ${i} burst(s)`);
    }
    return lag;
  };
  const crank = (m: Mkt) => riskJob(() => crankUntilCurrent(m, 8).then(() => undefined));

  // walk-off: grind deep accrual debt down in bounded bursts, one market at a
  // time, between the passes. Each job is a few seconds inside `riskJob`, so
  // marks and settlements on the healthy markets keep their cadence.
  const walkOff = async () => {
    // A market whose crank refuses (stale oracle, 6020) would otherwise be
    // picked again immediately, forever, and starve the ones that can move.
    const retryAt = new Map<number, number>();
    for (;;) {
      let worst: Mkt | null = null;
      let worstLag = DEEP_DEBT;
      for (const m of MK) {
        if ((retryAt.get(m.id) ?? 0) > Date.now()) continue;
        const lag = await assetLag(m).catch(() => 0);
        if (lag > worstLag) {
          worst = m;
          worstLag = lag;
        }
      }
      if (!worst) {
        await sleep(30_000);
        continue;
      }
      const m = worst;
      try {
        await riskJob(() => crankUntilCurrent(m, 2, true));
      } catch (e: any) {
        const msg = String(e?.msg ?? e?.message ?? e).slice(0, 90);
        if (msg !== lastErr) {
          log("walkoff", `${m.id} · ${msg} — retrying in 60s`);
          lastErr = msg;
        }
        retryAt.set(m.id, Date.now() + 60_000);
      }
      await sleep(250);
    }
  };

  // settle: drain whatever the book matched, oldest first.
  //
  // `settle_fill` sweeps every lapsed backing domain inside the fill
  // transaction. Doing eighteen separate sweep transactions here only adds
  // latency and creates more opportunities for another crank to move the
  // group clock between the target asset's refresh and settlement.
  const settle = (m: Mkt) =>
    (async () => {
      const bk: any = await pEr.account.book.fetch(m.book);
      let n = Number(bk.pendingCount ?? 0);
      if (n === 0) return;
      await riskJob(async () => {
        // This must be the last clock advance before the fill. A group holds
        // multiple assets, and cranking any neighbour makes this asset stale —
        // so crank until this asset's accrual clock has actually caught the
        // header, not just once.
        await crankUntilCurrent(m, 12);

        for (let i = 0; i < Math.min(n, 4); i++) {
          const cur: any = await pEr.account.book.fetch(m.book);
          if (Number(cur.pendingCount) === 0) break;
          const head = cur.pending[cur.pendingHead];
          const signature = await pEr.methods
            .settleFill()
            .accounts({
              caller: keeper.publicKey,
              market: m.market,
              book: m.book,
              riskGroup,
              assetSlots,
              oracleState: m.oracleState,
              takerPortfolio: portfolioOf(new PublicKey(head.taker)),
              makerPortfolio: portfolioOf(new PublicKey(head.maker)),
              tape: m.tape,
            })
            // A settle refreshes two accounts through the kernel and its cost
            // scales with how much accrual each must replay — the default 200k
            // CU budget is not always enough, and a starved settle stalls the
            // whole FIFO queue behind it.
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
            .rpc();

          // A consumed refusal is an intentionally successful transaction.
          // Inspect the program outcome before calling it a fill; the old log
          // lied about every LockActive rejection and hid the outage.
          const tx = await er.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const logs = tx?.meta?.logMessages ?? [];
          if (logs.some((line) => line.includes("dark fill settled"))) {
            prints++;
            log("settle", `${m.id} ${head.baseLots}@${head.priceInTicks} · ${prints} filled`);
          } else {
            const reason = logs.find((line) => line.includes("kernel refused"));
            const reasonText = reason?.split(": ").pop() ?? "fill consumed";
            log(
              "reject",
              `${m.id} ${head.baseLots}@${head.priceInTicks} · ${reasonText}`
            );
          }
        }
      });
    })();

  // mark-to-market: the kernel only recomputes an account's PnL when the
  // account is refreshed, so a position's unrealised PnL is frozen at its
  // last settlement until someone asks. Refresh every portfolio that holds a
  // position on a slow tick — the terminal then shows live PnL for free.
  const MAX_ASSETS_SLOTS = 12; // mirrors constants::MAX_ASSETS
  // disc + owner + market_id tag + bump + reserved_margin + claimed_high_water
  const HEADER = 8 + 32 + 8 + 1 + 16 + 8;
  // Isolated margin: collateral and blended entry per asset sit between the
  // header and the kernel bytes, so every raw offset past here shifts by both.
  const COLLATERAL = HEADER;
  const ENTRY = COLLATERAL + MAX_ASSETS_SLOTS * 16;
  const INNER = ENTRY + MAX_ASSETS_SLOTS * 16;
  const PF_SIZE = 3124 + 2 * MAX_ASSETS_SLOTS * 16; // account size incl. discriminator
  const LEGS = INNER + 340;
  const LEG_STRIDE = 144;
  const LEG_ASSET_INDEX = 1;
  const LEG_SIDE = 13;
  const LEG_BASIS = 14;
  const POS_SCALE = 1_000_000;
  const TICK_SIZE = Number(process.env.ANQA_TICK ?? 1000);

  /** This asset's open position, straight off the account bytes. */
  const readPosition = (data: Buffer, idx: number) => {
    for (let n = 0; n < 4; n++) {
      const base = LEGS + n * LEG_STRIDE;
      if (data[base] !== 1) continue;
      if (data.readUInt32LE(base + LEG_ASSET_INDEX) !== idx) continue;
      const raw = data.readBigInt64LE(base + LEG_BASIS);
      if (raw === 0n) continue;
      return {
        isLong: data[base + LEG_SIDE] === 0,
        lots: Number((raw < 0n ? -raw : raw) / BigInt(POS_SCALE)),
      };
    }
    return null;
  };
  // The scan is the expensive half, the refresh the cheap one — so scan for
  // position holders on a slow tick and re-mark the known holders on a fast
  // one. A position opened between scans waits at most one scan interval.
  let positionHolders: PublicKey[] = [];
  // Every portfolio in the group, holders or not — a trader who just closed
  // is flat but still carries junior pnl awaiting promotion.
  let groupPortfolios: PublicKey[] = [];
  const scanHolders = async () => {
    const accounts = await er.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: PF_SIZE }],
    });
    const holders: PublicKey[] = [];
    const portfolios: PublicKey[] = [];
    for (const { pubkey, account } of accounts) {
      // The wrapper tag is now the MARKET id (isolated portfolios). Accept
      // the whole hub's id range so the lead keeper can realize/checkpoint
      // every portfolio; markets are numbered group..group+15 at most.
      const tag = account.data.readBigUInt64LE(8 + 32);
      const g = BigInt(GROUP_ID.toString());
      if (tag < g || tag >= g + 16n) continue;
      portfolios.push(pubkey);
      for (let n = 0; n < 4; n++) {
        if (account.data[LEGS + n * LEG_STRIDE] === 1) {
          holders.push(pubkey);
          break;
        }
      }
    }
    positionHolders = holders;
    groupPortfolios = portfolios;
    // The owner is the first field after the discriminator. Reading it here
    // means the mirror pass never has to re-fetch a portfolio it already saw.
    groupOwners = accounts
      .filter(({ pubkey }) => portfolios.some((p) => p.equals(pubkey)))
      .map(({ account }) => new PublicKey(account.data.subarray(8, 40)));
  };
  const markToMarket = async () => {
    for (const pubkey of positionHolders) {
      await pEr.methods
        .refreshPortfolio()
        .accounts({ market: anyMarket, riskGroup, assetSlots, portfolio: pubkey })
        .rpc()
        .catch(() => {});
    }
  };

  // checkpoint: commit the **aggregate** risk engine to base on a slow tick.
  // Commits are explicit-only (commit_frequency_ms = u32::MAX), so base knows
  // nothing newer than the last one — and an unplanned undelegation (validator
  // wedge, rollup death) strands everything since. Hub 820 died exactly that
  // way; one tick bounds the next incident.
  //
  // Portfolios are deliberately **not** checkpointed here any more.
  //
  // A commit is a plaintext write to base layer, and base layer is public
  // Solana — no permission record reaches it, because there is nowhere to put
  // a filter. So checkpointing a portfolio that holds an open position
  // publishes that position: size, entry, margin and therefore the liquidation
  // price, to anyone who calls `getAccountInfo`. This loop was doing that for
  // every trader in the group, on a timer, which quietly undid the venue's one
  // real promise.
  //
  // The rule the venue keeps instead: **never commit a portfolio while it
  // holds a position; commit freely once it is flat.** A flat portfolio
  // reveals nothing base does not already know from the deposit ledger, so
  // settlement still has a truthful point to land on. What that costs is
  // unrealised PnL if the rollup dies mid-position — the trader exits against
  // their last flat commit and keeps their collateral. That is the honest
  // trade a dark venue makes, and it is bounded by the risk-group checkpoint
  // below, which is aggregate and carries no trader's name.
  const MAGIC = {
    magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
    magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
  };
  const checkpoint = async () => {
    await pEr.methods
      .commitRiskGroup()
      .accounts({ payer: keeper.publicKey, riskGroup, ...MAGIC })
      .rpc()
      .catch(() => {});
    await pEr.methods
      .commitAssetSlots()
      .accounts({ payer: keeper.publicKey, assetSlots, ...MAGIC })
      .rpc()
      .catch(() => {});
    log("commit", "risk engine checkpointed — portfolios left in the rollup, unpublished");
  };

  // depth: rebuild the book's public mirror. The book is permissioned, so
  // only something inside the rollup that is allowed to read it can publish
  // the aggregate — and a taker who cannot size a trade goes elsewhere, so
  // this runs on the same tick as settlement.
  const publishDepth = (m: Mkt) =>
    pEr.methods
      .publishDepth()
      .accounts({ caller: keeper.publicKey, market: m.market, book: m.book, depth: m.depth })
      .rpc();

  // The same idea as depth, aimed the other way: depth publishes everyone's
  // size without the owners, this publishes one owner's rows without anyone
  // else's. A trader cannot read the book — membership would show them the
  // whole thing — so the engine projects their own orders into an account
  // only they can read.
  //
  // Driven for every portfolio the group knows about. A trader with nothing
  // resting gets an empty mirror, which is the correct answer and also proves
  // to the terminal that the mirror is live rather than stale.
  const ORDERS_SEED = Buffer.from("anqa_myorders");
  const mirrorOf = (m: Mkt, owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [ORDERS_SEED, m.id.toArrayLike(Buffer, "le", 8), owner.toBuffer()],
      PROGRAM_ID
    )[0];

  // Owners known to have a mirror, and when the set was last rebuilt. Without
  // this the publisher costs one rollup read per portfolio per tick on every
  // keeper — nine markets multiplying the same question — and this venue has
  // already learned once what happens when its own processes become the load.
  // Mirrors are created by hand, rarely, so a stale answer costs at most one
  // discovery interval before a new trader's rows appear.
  const mirrorOwners = new Map<string, PublicKey[]>();
  const mirrorsScannedAt = new Map<string, number>();
  const MIRROR_RESCAN_MS = 30_000;

  /// Stand a mirror up for a trader who has none.
  ///
  /// Three steps on two layers: create and delegate on base, hide inside the
  /// rollup. The engine does all of it because none of it needs the trader —
  /// the permission's member list is fixed by the program to the owner and
  /// this engine, so provisioning grants the provisioner nothing. That is the
  /// whole point: a trader should never sign, or deposit, for the privilege of
  /// seeing their own orders.
  const provisionMirror = async (m: Mkt, owner: PublicKey) => {
    const orders = mirrorOf(m, owner);
    if (!(await conn.getAccountInfo(orders).catch(() => null))) {
      await pBase.methods
        .initializeTraderOrders(m.id)
        .accounts({ payer: keeper.publicKey, owner, market: m.market, orders })
        .rpc();
    }
    // Base-layer permission record, before delegation. The rollup-side hide
    // extends this rather than creating it, and skipping it fails at
    // transaction verification with no program log to explain why.
    const permission = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), orders.toBuffer()],
      ACL_PROGRAM
    )[0];
    if (!(await conn.getAccountInfo(permission).catch(() => null))) {
      await pBase.methods
        .createTraderOrdersPermission(m.id)
        .accounts({
          payer: keeper.publicKey,
          owner,
          market: m.market,
          orders,
          permission,
          permissionProgram: ACL_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    const onBase = await conn.getAccountInfo(orders).catch(() => null);
    if (onBase && !onBase.owner.equals(DLP)) {
      const d = delegationOf(orders);
      await pBase.methods
        .delegateTraderOrders(m.id)
        .accounts({
          payer: keeper.publicKey,
          owner,
          orders,
          bufferOrders: d.buffer,
          delegationRecordOrders: d.delegationRecord,
          delegationMetadataOrders: d.delegationMetadata,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DLP,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    if (!(await er.getAccountInfo(permission).catch(() => null))) {
      await pEr.methods
        .setTraderOrdersPrivate()
        .accounts({
          payer: keeper.publicKey,
          owner,
          orders,
          market: m.market,
          permission,
          vault: MAGIC_FEE_VAULT,
          magicProgram: MAGIC_PROGRAM,
          permissionProgram: ACL_PROGRAM,
        })
        .rpc();
    }
  };

  // Owners are hub-wide, so resolve them once per scan rather than re-reading
  // every portfolio for every market.
  let groupOwners: PublicKey[] = [];

  const discoverMirrors = async (m: Mkt) => {
    const key = m.id.toString();
    const owners: PublicKey[] = [];
    for (const owner of groupOwners) {
      if (!(await er.getAccountInfo(mirrorOf(m, owner)).catch(() => null))) {
        // One trader's provisioning failure is that trader's stale view, not
        // the venue's problem — log it and carry on to the next.
        await provisionMirror(m, owner).catch((e: any) =>
          log("mirrors", `${m.id} provision ${owner.toBase58().slice(0, 8)}: ${String(e?.message ?? e).slice(0, 60)}`)
        );
        if (!(await er.getAccountInfo(mirrorOf(m, owner)).catch(() => null))) continue;
      }
      owners.push(owner);
    }
    if (owners.length !== (mirrorOwners.get(key)?.length ?? -1)) {
      log("mirrors", `${m.id}: ${owners.length} trader view(s) live`);
    }
    mirrorOwners.set(key, owners);
    mirrorsScannedAt.set(key, Date.now());
  };

  const publishOrderMirrors = async (m: Mkt) => {
    if (groupOwners.length === 0) return;
    const key = m.id.toString();
    if (Date.now() - (mirrorsScannedAt.get(key) ?? 0) > MIRROR_RESCAN_MS) await discoverMirrors(m);
    for (const owner of mirrorOwners.get(key) ?? []) {
      // One trader's failure must never stop the rest: a mirror that has been
      // undelegated, or a transient rollup error, is that trader's stale view
      // and nobody else's problem.
      await pEr.methods
        .publishTraderOrders()
        .accounts({ caller: keeper.publicKey, market: m.market, book: m.book, owner, orders: mirrorOf(m, owner) })
        .rpc()
        .catch(() => {});
    }
  };

  // isolated liquidation: enforce that a position can only lose the collateral
  // put behind it. The kernel liquidates per ACCOUNT, so without this a bad
  // position eats a trader's whole balance before anything fires. Anqa records
  // collateral and blended entry per asset in the portfolio; the check here
  // mirrors `isolated_underwater` on-chain exactly, and the instruction refuses
  // if we are early — so calling it optimistically is safe.
  const isolatedSweep = async (m: Mkt) => {
    const os1: any = await pEr.account.oracleState.fetch(m.oracleState).catch(() => null);
    if (!os1) return;
    const mark = Number(os1.lastPrice);
    for (const pubkey of positionHolders) {
      const info = await er.getAccountInfo(pubkey).catch(() => null);
      if (!info) continue;
      const collateral = Number(info.data.readBigUInt64LE(COLLATERAL + m.asset * 16));
      const entry = Number(info.data.readBigUInt64LE(ENTRY + m.asset * 16));
      if (collateral === 0 || entry === 0) continue;
      const leg = readPosition(info.data, m.asset);
      if (!leg || leg.lots === 0) continue;

      // Mirrors `isolated_underwater` on-chain; the instruction refuses if we
      // are early, so calling optimistically costs nothing.
      const pnl = leg.isLong ? (mark - entry) * leg.lots : (entry - mark) * leg.lots;
      const maintenance = (mark * leg.lots * 250) / 10_000;
      if (collateral + pnl > maintenance) continue;

      const worst = leg.isLong ? Math.floor(mark * 0.9) : Math.ceil(mark * 1.1);
      await pEr.methods
        .liquidateIsolated(new BN(Math.floor(worst / TICK_SIZE)))
        .accounts({
          trader: keeper.publicKey,
          session: null,
          market: m.market,
          book: m.book,
          riskGroup,
          assetSlots,
          oracleState: m.oracleState,
          portfolio: pubkey,
        })
        .rpc()
        .then(() => log("isolated", `${pubkey.toBase58().slice(0, 8)}… margin spent — liquidated`))
        .catch(() => {}); // refused: the position still has margin
    }
  };

  // realize: promote proven-backed junior profit into withdrawable capital.
  // Wins land junior ("losses are senior, wins are junior") and stay
  // unwithdrawable until `realize_pnl` promotes them; nothing else in the
  // system fires it. Permissionless and a no-op when nothing qualifies, so
  // it runs blind over every group portfolio — but from the group-lead
  // keeper only, or nine keepers would send nine copies.
  const realize = async () => {
    for (const pubkey of groupPortfolios) {
      await pEr.methods
        .realizePnl()
        .accounts({ caller: keeper.publicKey, market: anyMarket, riskGroup, assetSlots, portfolio: pubkey })
        .rpc()
        .catch(() => {}); // nothing to promote, or the domain is mid-refresh
    }
  };

  // sweep: expire lapsed positive-PnL backing buckets. A `Fresh` bucket past
  // its expiry makes every account refresh in its domain refuse with `Stale`
  // — one winner's expired winnings can wedge the asset. The kernel refuses
  // the sweep unless the bucket has actually lapsed, so calling it blind on
  // both domains is safe and cheap.
  /** 0 disables the sweep entirely — see the note above on what it destroys. */
  const SWEEP_MS = Number(process.env.ANQA_SWEEP_MS ?? 30_000);
  const sweep = async (m: Mkt) => {
    if (SWEEP_MS <= 0) return;
    for (const domain of [m.asset * 2, m.asset * 2 + 1]) {
      await pEr.methods
        .sweepBacking(domain)
        .accounts({ caller: keeper.publicKey, market: m.market, riskGroup, assetSlots })
        .rpc()
        .then(() => log("sweep", `lapsed backing bucket expired — domain ${domain}`))
        .catch(() => {}); // not lapsed — the normal case
    }
  };


  // The deposit rail.
  //
  // A deposit is two halves: USDC moves into custody on base layer, and the
  // rollup credits the portfolio from that ledger. Only the first half is
  // signed by the trader. If the second never lands, their money sits in the
  // ledger uncredited, the terminal sees no collateral and asks them to
  // deposit *again* — which is exactly what happened live, and it costs the
  // trader real money every time they click.
  //
  // So the venue does not rely on the browser for it. `claim_deposit` is
  // permissionless and idempotent by design — it derives the credit from the
  // ledger, so anyone may run it for anyone — and this is the loop that was
  // always implied by that design and never actually built.
  //
  // Only the lead keeper runs it; the ledger is group-wide, so nine keepers
  // claiming the same deposits would be nine times the work for one result.
  const LEDGER_BYTES = 73;
  const claimDeposits = () =>
    guard("deposit", async () => {
      const ledgers = await conn.getProgramAccounts(PROGRAM_ID, {
        filters: [
          { dataSize: LEDGER_BYTES },
          { memcmp: { offset: 8 + 32, bytes: bs58.encode(le8(GROUP_ID)) } },
        ],
      });
      for (const { account } of ledgers) {
        const owner = new PublicKey(account.data.subarray(8, 40));
        const deposited = account.data.readBigUInt64LE(8 + 32 + 8);
        if (deposited === 0n) continue;
        // Claim only what has not been credited yet. `claim_deposit` is
        // idempotent, so sending it regardless would be harmless — but it
        // would also be a transaction every few seconds per trader, forever,
        // and a log line that says "credited" when nothing moved.
        const pf: any = await pEr.account.portfolio
          .fetch(portfolioOf(owner))
          .catch(() => null);
        if (!pf) continue; // no account opened yet
        const claimed = BigInt(new BN(pf.claimedHighWater, 10, "le").toString());
        if (deposited <= claimed) continue;
        try {
          await pEr.methods
            .claimDeposit()
            .accounts({
              caller: keeper.publicKey,
              market: anyMarket,
              riskGroup,
              assetSlots,
              portfolio: portfolioOf(owner),
              ledger: gpda("anqa_ledger", [owner.toBuffer()]),
              receipt: null,
              magicContext: null,
              magicProgram: null,
            } as never)
            .rpc();
          log(
            "deposit",
            `credited ${owner.toBase58().slice(0, 8)}… with $${(
              Number(deposited - claimed) / 1e6
            ).toLocaleString()}`
          );
        } catch {
          // Already credited is the common case and costs one failed
          // simulation; a missing portfolio means they have not opened an
          // account yet. Neither is worth logging every four seconds.
        }
      }
    });

  await forEachMarket("relay", relay);
  await forEachMarket("sweep", sweep);
  await claimDeposits();

  // A keeper outage leaves every asset with an accrual-slot debt — and so
  // does a fast host (see `assetLag`). Measure each asset's own lag against
  // the header and burst-crank it down before anything else runs. The old
  // check compared the rollup's slot against the venue clock, two clocks in
  // different frames, and so never fired.
  const catchUp = async () => {
    for (const m of MK) {
      await guard("catchup", async () => {
        const lag = await assetLag(m);
        if (lag <= 0) return;
        // A debt this size is weeks of idle host. Do not hold every other
        // loop hostage to it here; the crank pass walks it off in bursts
        // while the healthy markets keep trading.
        if (lag > 2_000_000) {
          return log("catchup", `${m.id} accrual clock ${lag.toLocaleString()} slots behind — walking off in the crank pass`);
        }
        log("catchup", `${m.id} accrual clock ${lag.toLocaleString()} slots behind — cranking hard`);
        const left = await crankUntilCurrent(m, 200);
        log(
          "catchup",
          left > 0 ? `${m.id} still ${left.toLocaleString()} behind — gave up` : `${m.id} caught up`
        );
      });
    }
  };
  await catchUp();

  await forEachMarket("crank", crank);

  // requote watchdog: a taker big enough to eat a whole side leaves the next
  // trader — often the same one, trying to close — with nothing to cross,
  // and an IoC close against an empty side just fails. When either side goes
  // dark, re-run the maker to lay the ladder again.
  //
  // The watchdog backs off when the maker keeps failing. On a fixed 15s
  // interval a maker that cannot start — a rate-limited RPC, say — gets
  // respawned four times a minute per market forever, and nine markets doing
  // that is enough load to *cause* the failure it is reacting to. Growing the
  // delay after each failure lets the endpoint recover; one success resets it.
  const REQUOTE_MS = 15_000;
  const REQUOTE_MAX_MS = 5 * 60_000;
  const requoteDelay = (m: Mkt) =>
    Math.min(REQUOTE_MS * 2 ** m.failures, REQUOTE_MAX_MS) * (1 + Math.random() * 0.3);

  // Only one maker at a time across the whole venue. Nine concurrent spawns is
  // nine node processes each opening its own RPC connection — the exact burst
  // that starves them all and leaves every book empty.
  let makerBusy = false;

  // A ladder does not have to be empty to be wrong.
  //
  // The maker quotes a configurable multi-level ladder around the mark and
  // then exits — it is a
  // one-shot, not a daemon. So when the mark walks away, the rungs stay where
  // they were: the near side is now through the mark and free to be picked
  // off, the far side is nowhere near tradeable, and the watchdog's original
  // "is a side empty?" test says everything is fine, because both sides still
  // hold orders. The book looks healthy and quotes a price that no longer
  // exists.
  //
  // So drift is a requote trigger in its own right. The measure is the mid
  // against the mark: a fresh ladder is symmetric, so any gap between the two
  // is exactly how far the quotes have been left behind.
  const DRIFT_BPS = Number(process.env.ANQA_REQUOTE_DRIFT_BPS ?? 5);
  /** Visible price levels the demo terminal should maintain on each side. */
  const MAKER_LEVELS = Math.max(
    1,
    Math.min(12, Number(process.env.ANQA_MAKER_LEVELS ?? 10))
  );
  /** Floor between drift requotes. Emptiness is urgent; drift is not, and a
   *  ladder that re-lays every tick costs transactions and cancels fills that
   *  were about to happen. */
  const DRIFT_MIN_MS = Number(process.env.ANQA_REQUOTE_DRIFT_MS ?? 45_000);

  const requote = (m: Mkt) =>
    guard("requote", async () => {
      if (makerBusy || m.requoting) return;
      // Reserve the global slot before the first await. Without this, two
      // timers can both pass the idle check and spawn makers concurrently.
      makerBusy = true;
      m.requoting = true;
      const releaseMaker = () => {
        makerBusy = false;
        m.requoting = false;
      };
      const bk: any = await pEr.account.book.fetch(m.book).catch((e: any) => {
        releaseMaker();
        throw e;
      });
      const visibleLevels = (s: any) =>
        new Set(
          s.orders
            .filter((o: any) => o.active === 1 && !o.hidden)
            .map((o: any) => Number(o.priceInTicks))
        ).size;
      let reason: string | null = null;
      const bidLevels = visibleLevels(bk.bids);
      const askLevels = visibleLevels(bk.asks);

      if (bidLevels < MAKER_LEVELS || askLevels < MAKER_LEVELS) {
        reason = `ladder has ${bidLevels} bid / ${askLevels} ask levels (target ${MAKER_LEVELS})`;
      } else {
        // Both sides quoting — but are they quoting the right price?
        const live = (s: any) =>
          s.orders.filter((o: any) => o.active === 1).map((o: any) => Number(o.priceInTicks));
        const bestBid = Math.max(...live(bk.bids));
        const bestAsk = Math.min(...live(bk.asks));
        const os1: any = await pEr.account.oracleState.fetch(m.oracleState).catch(() => null);
        // Book prices are ticks; the oracle carries quote atoms per lot, and a
        // tick is 1,000 of them.
        const markTicks = os1 ? Number(os1.lastPrice) / 1_000 : 0;
        if (markTicks > 0 && Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
          const mid = (bestBid + bestAsk) / 2;
          const driftBps = (Math.abs(mid - markTicks) / markTicks) * 10_000;
          const cool = Date.now() - m.lastDrift >= DRIFT_MIN_MS;
          if (driftBps > DRIFT_BPS && cool) {
            reason = `quotes ${driftBps.toFixed(1)}bps off the mark (mid ${Math.round(mid)} vs ${Math.round(markTicks)})`;
            m.lastDrift = Date.now();
          }
        }
      }

      if (!reason) {
        m.failures = 0;
        releaseMaker();
        return;
      }
      log("requote", `${m.id} ${reason} — re-running the maker`);
      const child = spawn(
        "npx",
        ["ts-node", "--transpile-only", "app/demo-maker.ts"],
        {
          env: {
            ...process.env,
            ANQA_DEMO_MARKET: m.id.toString(),
            ANQA_GROUP: GROUP_ID.toString(),
            ANQA_ASSET_INDEX: String(m.asset),
            ANQA_FEED_ACCT: m.feed.toBase58(),
          },
          stdio: "ignore",
        }
      );
      child.on("error", (e) => {
        releaseMaker();
        m.failures++;
        log("requote", `${m.id} maker failed to start: ${String(e).slice(0, 80)}`);
      });
      child.on("exit", (code) => {
        releaseMaker();
        if (code === 0) {
          m.failures = 0;
          log("requote", `${m.id} ladder restored`);
        } else {
          m.failures++;
          log("requote", `${m.id} maker exited ${code} — retry in ${Math.round(requoteDelay(m) / 1000)}s`);
        }
      });
    });

  /** Self-scheduling so the delay can grow; `setInterval` cannot back off. */
  const scheduleRequote = (m: Mkt) =>
    setTimeout(async () => {
      await requote(m);
      scheduleRequote(m);
    }, requoteDelay(m));

  // Per-market work: one pass over every market per tick, sequential inside
  // the pass. Cadences are per *pass*, not per market, so adding markets
  // lengthens a pass rather than multiplying concurrent requests.
  const every = (ms: number, tag: string, fn: (m: Mkt) => Promise<void>) => {
    let running = false;
    setInterval(async () => {
      if (running) return; // a slow pass must not stack on itself
      running = true;
      try {
        await forEachMarket(tag, fn);
      } finally {
        running = false;
      }
    }, ms);
  };

  every(RELAY_MS, "relay", relay);
  every(CRANK_MS, "crank", crank);
  every(SETTLE_MS, "settle", settle);
  every(1_500, "depth", publishDepth);
  every(2_000, "mirrors", publishOrderMirrors);
  every(4_000, "isolated", isolatedSweep);
  if (SWEEP_MS > 0) every(SWEEP_MS, "sweep", sweep);
  void walkOff();

  // Hub-wide work: once, not once per market. This is the half that made a
  // process-per-market design cost N times more than it had any reason to.
  setInterval(() => guard("mtm-scan", scanHolders), 15_000);
  setInterval(() => guard("mtm", markToMarket), 1_500);
  setInterval(() => guard("realize", realize), 20_000);
  setInterval(claimDeposits, 6_000);
  setInterval(() => guard("commit", checkpoint), 300_000);

  // The legacy watchdog re-spawns `app/demo-maker.ts` on drift — a full
  // cancel/re-lay per requote. When the resident `app/maker-daemon.ts` is
  // running it owns quoting instead, so set ANQA_NO_KEEPER_MAKER=1 to stop the
  // keeper from spawning a competing maker on the same books.
  if (process.env.ANQA_NO_KEEPER_MAKER === "1") {
    log("maker", "keeper requote spawning disabled (resident daemon owns quoting)");
  } else {
    for (const m of MK) scheduleRequote(m);
  }
  void guard("mtm-scan", scanHolders);

  process.on("SIGINT", () => {
    log("stop", `${cranks} cranks, ${prints} fills settled`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
