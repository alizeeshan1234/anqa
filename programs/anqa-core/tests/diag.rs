//! Offline diagnostics: decode a dumped RiskGroup header with the kernel's
//! own types and print the flags the oracle-reset gate checks.
//!
//! Run: RISK_DUMP=/path/to/risk.bin cargo test -p anqa-core --test diag -- --nocapture

use percolator::MarketGroupV16HeaderAccount;

#[test]
fn dump_risk_group_header() {
    let Ok(path) = std::env::var("RISK_DUMP") else {
        eprintln!("RISK_DUMP not set — skipping");
        return;
    };
    let bytes = std::fs::read(&path).expect("read dump");
    let header: &MarketGroupV16HeaderAccount =
        bytemuck::from_bytes(&bytes[..core::mem::size_of::<MarketGroupV16HeaderAccount>()]);

    println!("mode                      {}", header.mode);
    println!("current_slot              {}", header.current_slot.get());
    println!("slot_last                 {}", header.slot_last.get());
    println!("pnl_pos_tot               {}", header.pnl_pos_tot.get());
    println!("stale_certificate_count   {}", header.stale_certificate_count.get());
    println!("b_stale_account_count     {}", header.b_stale_account_count.get());
    println!("negative_pnl_account_count {}", header.negative_pnl_account_count.get());
    println!("bankruptcy_hlock_active   {}", header.bankruptcy_hlock_active);
    println!("threshold_stress_active   {}", header.threshold_stress_active);
    println!("loss_stale_active         {}", header.loss_stale_active);
    println!("recovery_reason           {:?}", header.recovery_reason);
}

/// Offsets the keeper pins to read the accrual debt without Anchor.
#[test]
fn risk_header_offsets_match_the_keeper() {
    use core::mem::offset_of;
    let current_slot = offset_of!(MarketGroupV16HeaderAccount, current_slot);
    let slot_last = offset_of!(MarketGroupV16HeaderAccount, slot_last);
    let loss_stale = offset_of!(MarketGroupV16HeaderAccount, loss_stale_active);
    println!("header.current_slot      {current_slot}");
    println!("header.slot_last         {slot_last}");
    println!("header.loss_stale_active {loss_stale}");
    // Pinned by app/keeper.ts — move these and the keeper reads garbage.
    assert_eq!(current_slot, CURRENT_SLOT_OFFSET);
    assert_eq!(slot_last, SLOT_LAST_OFFSET);
    assert_eq!(loss_stale, LOSS_STALE_OFFSET);
}

// Filled in after the first run prints them.
const CURRENT_SLOT_OFFSET: usize = 581;
const SLOT_LAST_OFFSET: usize = 573;
const LOSS_STALE_OFFSET: usize = 591;

/// Replay a portfolio refresh offline against dumped chain state.
///
/// Run:
///   RISK_DUMP=risk.bin SLOTS_DUMP=slots.bin PF_DUMP=pf.bin \
///   cargo test -p anqa-core --test diag replay_refresh -- --nocapture
#[test]
fn replay_refresh() {
    use anqa_core::state::{AssetSlots, Portfolio, RiskGroup};
    use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut};

    let (Ok(rp), Ok(sp), Ok(pp)) = (
        std::env::var("RISK_DUMP"),
        std::env::var("SLOTS_DUMP"),
        std::env::var("PF_DUMP"),
    ) else {
        eprintln!("dumps not set — skipping");
        return;
    };
    let mut risk_bytes = std::fs::read(&rp).expect("risk dump");
    let mut slots_bytes = std::fs::read(&sp).expect("slots dump");
    let mut pf_bytes = std::fs::read(&pp).expect("pf dump");

    let risk: &mut RiskGroup = bytemuck::from_bytes_mut(&mut risk_bytes);
    let slots: &mut AssetSlots = bytemuck::from_bytes_mut(&mut slots_bytes);
    let pf: &mut Portfolio = bytemuck::from_bytes_mut(&mut pf_bytes);

    let n = risk.asset_count();
    let mut view = MarketGroupV16ViewMut::new(risk.header_mut(), &mut slots.markets_mut()[..n]);
    let mut pv = PortfolioV16ViewMut::new(pf.account_mut());
    match view.full_account_refresh_not_atomic(&mut pv) {
        Ok(cert) => println!(
            "REFRESH OK — equity {} initial_req {}",
            cert.certified_equity, cert.certified_initial_req
        ),
        Err(e) => println!("REFRESH FAILED — {e:?}"),
    }
}

/// Print every domain's backing bucket vs the group clock.
#[test]
fn dump_backing_buckets() {
    use anqa_core::state::{AssetSlots, RiskGroup};
    let (Ok(rp), Ok(sp)) = (std::env::var("RISK_DUMP"), std::env::var("SLOTS_DUMP")) else {
        eprintln!("dumps not set — skipping");
        return;
    };
    let mut risk_bytes = std::fs::read(&rp).expect("risk dump");
    let mut slots_bytes = std::fs::read(&sp).expect("slots dump");
    let risk: &mut RiskGroup = bytemuck::from_bytes_mut(&mut risk_bytes);
    let slots: &mut AssetSlots = bytemuck::from_bytes_mut(&mut slots_bytes);
    let current = risk.header().current_slot.get();
    println!("group current_slot {current}");
    let n = risk.asset_count();
    for (i, m) in slots.markets_mut()[..n].iter_mut().enumerate() {
        let slot = &m.engine.asset;
        let eng = &m.engine;
        let asset = slot.try_to_runtime().unwrap();
        println!(
            "asset {i}: lifecycle {:?} modes {:?}/{:?} target {} effective {} slot_last {} OI {}/{} barriers {}/{}",
            asset.lifecycle,
            asset.mode_long,
            asset.mode_short,
            asset.raw_oracle_target_price,
            asset.effective_price,
            asset.slot_last,
            asset.oi_eff_long_q,
            asset.oi_eff_short_q,
            eng.pending_domain_loss_barrier_long.get(),
            eng.pending_domain_loss_barrier_short.get(),
        );
        for (side, b) in [("long", &eng.backing_long), ("short", &eng.backing_short)] {
            let b = b.try_to_runtime().unwrap();
            println!(
                "asset {i} {side}: status {:?} expiry {} (lapsed: {}) fresh {} liened {}",
                b.status,
                b.expiry_slot,
                b.expiry_slot != 0 && b.expiry_slot <= current,
                b.fresh_unliened_backing_num,
                b.valid_liened_backing_num
            );
        }
    }
}

/// Replay the refused dark fill offline: refresh both accounts, then execute.
#[test]
fn replay_trade() {
    use anqa_core::state::{AssetSlots, Portfolio, RiskGroup};
    use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, TradeRequestV16, POS_SCALE};

    let Ok(sc) = std::env::var("SC") else {
        eprintln!("SC not set — skipping");
        return;
    };
    // Fixed names by default (the 802 incident); REPLAY_* overrides replay any
    // dumped scenario without touching this file again.
    let f = |env: &str, def: &str| -> String {
        std::env::var(env).unwrap_or_else(|_| format!("{sc}/{def}"))
    };
    let mut risk_bytes = std::fs::read(f("REPLAY_RISK", "risk-802.bin")).unwrap();
    let mut slots_bytes = std::fs::read(f("REPLAY_SLOTS", "slots-802.bin")).unwrap();
    let mut taker_bytes = std::fs::read(f("REPLAY_TAKER", "pf-taker-802.bin")).unwrap();
    let mut maker_bytes = std::fs::read(f("REPLAY_MAKER", "pf-maker-802.bin")).unwrap();

    let risk: &mut RiskGroup = bytemuck::from_bytes_mut(&mut risk_bytes);
    let slots: &mut AssetSlots = bytemuck::from_bytes_mut(&mut slots_bytes);
    let taker: &mut Portfolio = bytemuck::from_bytes_mut(&mut taker_bytes);
    let maker: &mut Portfolio = bytemuck::from_bytes_mut(&mut maker_bytes);

    let n = risk.asset_count();
    let mut view = MarketGroupV16ViewMut::new(risk.header_mut(), &mut slots.markets_mut()[..n]);

    {
        let mut tv = PortfolioV16ViewMut::new(taker.account_mut());
        match view.full_account_refresh_not_atomic(&mut tv) {
            Ok(_) => println!("taker refresh OK"),
            Err(e) => println!("taker refresh FAILED — {e:?}"),
        }
    }
    {
        let mut mv = PortfolioV16ViewMut::new(maker.account_mut());
        match view.full_account_refresh_not_atomic(&mut mv) {
            Ok(_) => println!("maker refresh OK"),
            Err(e) => println!("maker refresh FAILED — {e:?}"),
        }
    }

    let env_n = |k: &str, d: i128| -> i128 {
        std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
    };
    let req = TradeRequestV16 {
        asset_index: env_n("REPLAY_ASSET", 0) as usize,
        size_q: env_n("REPLAY_LOTS", 10) * POS_SCALE as i128,
        exec_price: env_n("REPLAY_PRICE", 63_055_000) as u64,
        fee_bps: 0,
    };
    let mut tv = PortfolioV16ViewMut::new(taker.account_mut());
    let mut mv = PortfolioV16ViewMut::new(maker.account_mut());
    match view.execute_trade_with_fee_loss_stale_scoped_not_atomic(&mut tv, &mut mv, req) {
        Ok(o) => println!("TRADE OK — notional {}", o.notional),
        Err(e) => println!("TRADE FAILED — {e:?}"),
    }
}

/// Print the asset's price-lag state — the trade preflight gate ingredients.
#[test]
fn dump_asset_prices() {
    use anqa_core::state::{AssetSlots, RiskGroup};
    let Ok(sc) = std::env::var("SC") else {
        eprintln!("SC not set — skipping");
        return;
    };
    let mut risk_bytes = std::fs::read(format!("{sc}/risk-802.bin")).unwrap();
    let mut slots_bytes = std::fs::read(format!("{sc}/slots-802.bin")).unwrap();
    let risk: &mut RiskGroup = bytemuck::from_bytes_mut(&mut risk_bytes);
    let slots: &mut AssetSlots = bytemuck::from_bytes_mut(&mut slots_bytes);
    let n = risk.asset_count();
    println!("header current_slot {}", risk.header().current_slot.get());
    for (i, m) in slots.markets_mut()[..n].iter_mut().enumerate() {
        let a = m.engine.asset;
        println!(
            "asset {i}: raw_oracle_target {} effective {} (lag: {}) slot_last {}",
            a.raw_oracle_target_price.get(),
            a.effective_price.get(),
            a.raw_oracle_target_price.get() != a.effective_price.get(),
            a.slot_last.get(),
        );
    }
}

/// Replay `settle_fill`'s exact sequence — sweep every domain against the
/// header clock, refresh taker then maker, then trade — and print each step.
/// Same env as `replay_trade`.
#[test]
fn replay_settle() {
    use anqa_core::state::{AssetSlots, Portfolio, RiskGroup};
    use percolator::{MarketGroupV16ViewMut, PortfolioV16ViewMut, TradeRequestV16, POS_SCALE};

    let Ok(sc) = std::env::var("SC") else {
        eprintln!("SC not set — skipping");
        return;
    };
    let f = |env: &str, def: &str| -> String {
        std::env::var(env).unwrap_or_else(|_| format!("{sc}/{def}"))
    };
    let mut risk_bytes = std::fs::read(f("REPLAY_RISK", "risk.bin")).unwrap();
    let mut slots_bytes = std::fs::read(f("REPLAY_SLOTS", "assets.bin")).unwrap();
    let mut taker_bytes = std::fs::read(f("REPLAY_TAKER", "pf1.bin")).unwrap();
    let mut maker_bytes = std::fs::read(f("REPLAY_MAKER", "pf0.bin")).unwrap();

    let risk: &mut RiskGroup = bytemuck::from_bytes_mut(&mut risk_bytes);
    let slots: &mut AssetSlots = bytemuck::from_bytes_mut(&mut slots_bytes);
    let taker: &mut Portfolio = bytemuck::from_bytes_mut(&mut taker_bytes);
    let maker: &mut Portfolio = bytemuck::from_bytes_mut(&mut maker_bytes);

    let n = risk.asset_count();
    let now_slot = risk.header().current_slot.get();
    println!("header current_slot {now_slot}, {n} assets");
    let mut view = MarketGroupV16ViewMut::new(risk.header_mut(), &mut slots.markets_mut()[..n]);
    for domain in 0..n * 2 {
        match view.expire_source_backing_bucket_not_atomic(domain, now_slot) {
            Ok(()) => println!("sweep domain {domain}: expired"),
            Err(e) => println!("sweep domain {domain}: {e:?}"),
        }
    }
    {
        let mut tv = PortfolioV16ViewMut::new(taker.account_mut());
        match view.full_account_refresh_not_atomic(&mut tv) {
            Ok(_) => println!("taker refresh OK"),
            Err(e) => println!("taker refresh FAILED — {e:?}"),
        }
    }
    {
        let mut mv = PortfolioV16ViewMut::new(maker.account_mut());
        match view.full_account_refresh_not_atomic(&mut mv) {
            Ok(_) => println!("maker refresh OK"),
            Err(e) => println!("maker refresh FAILED — {e:?}"),
        }
    }
    let env_n = |k: &str, d: i128| -> i128 {
        std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
    };
    let req = TradeRequestV16 {
        asset_index: env_n("REPLAY_ASSET", 0) as usize,
        size_q: env_n("REPLAY_LOTS", 10) * POS_SCALE as i128,
        exec_price: env_n("REPLAY_PRICE", 63_055_000) as u64,
        fee_bps: 0,
    };
    let mut tv = PortfolioV16ViewMut::new(taker.account_mut());
    let mut mv = PortfolioV16ViewMut::new(maker.account_mut());
    match view.execute_trade_with_fee_loss_stale_scoped_not_atomic(&mut tv, &mut mv, req) {
        Ok(o) => println!("TRADE OK — notional {}", o.notional),
        Err(e) => println!("TRADE FAILED — {e:?}"),
    }
    println!("LOCKACTIVE first line {} last line {}", percolator::LOCK_ACTIVE_FIRST.load(core::sync::atomic::Ordering::Relaxed), percolator::LOCK_ACTIVE_LAST.load(core::sync::atomic::Ordering::Relaxed));
}
