#!/usr/bin/env bash
# Start the venue's engine, the feed pusher, and the resident market maker.
#
#   bash app/run-keepers.sh          # start
#   pkill -f "app/keeper.ts"; pkill -f "app/maker-daemon.ts"   # stop
#
# Logs: app/.keeper-hub.log (engine), app/.maker-daemon.log (quoting).
#
# Quoting is owned by the resident daemon (app/maker-daemon.ts), a warm,
# oracle-driven engine that moves only the rungs that changed and manages
# inventory. The keeper's legacy spawn-a-maker-per-requote watchdog is disabled
# here (ANQA_NO_KEEPER_MAKER=1) so the two do not quote the same books.
#
# **One keeper drives every market in the hub**, and the plural in this
# script's name is history. There used to be one process per market, which was
# never buying isolation: everything that carries risk is hub-scoped — one risk
# engine, one asset-slot slab, one clock, one portfolio per trader — and only
# six accounts are actually per-market. So N processes ran the same full
# `getProgramAccounts` portfolio scan N times every fifteen seconds and spawned
# N makers at once, which is enough load on its own to exhaust a public RPC's
# connection limit, 429 the makers before they can read their own balance, and
# leave every book empty. Nine markets did exactly that on 2026-08-05.
#
# Markets come from ANQA_MARKETS ("id:asset:feed,…") or default to the hub's
# nine, so a hundred markets is a longer string, not a hundred processes.

set -euo pipefail
cd "$(dirname "$0")/.."

# Hub 920 was retired. Keep the launcher aligned with the frontend and the
# currently provisioned devnet venue so an operator cannot silently bring up
# an engine that maintains the wrong books.
GROUP=${ANQA_GROUP:-930}

# Resident-maker quoting defaults. Tighter than the daemon's own fallbacks so
# the public demo visibly follows the oracle while a small reprice cooldown
# keeps it from churning a transaction on every price tick.
export ANQA_MM_LEVELS=${ANQA_MM_LEVELS:-6}
export ANQA_MM_STEP_BPS=${ANQA_MM_STEP_BPS:-3}
export ANQA_MM_REPRICE_BPS=${ANQA_MM_REPRICE_BPS:-2}
export ANQA_MM_TICK_MS=${ANQA_MM_TICK_MS:-1500}

# Markets the daemon quotes ("id:asset:feedHex,…"); defaults to the hub's nine.
MM_MARKETS=${ANQA_MM_MARKETS:-${ANQA_MARKETS:-930:0,931:1,932:2,933:3,934:4,935:5,936:6,937:7,938:8}}

# The long-tail feeds have no devnet sponsor — one pusher keeps every feed's
# fixed shard-0 account fresh.
ANQA_PUSH_LOOP_SECS=${ANQA_PUSH_LOOP_SECS:-15} nohup npx ts-node --transpile-only app/push-feed.ts \
  >"app/.push-feed.log" 2>&1 &
echo "feed pusher pid $!"

# The engine, with its legacy per-requote maker spawner turned off.
ANQA_GROUP=$GROUP ANQA_NO_KEEPER_MAKER=1 nohup npx ts-node --transpile-only app/keeper.ts \
  >"app/.keeper-hub.log" 2>&1 &
echo "keeper pid $! — hub $GROUP, every market (legacy maker spawn OFF)"

# The resident market maker: one warm process quoting every market on its own
# funded key, following the oracle by moving only the rungs that changed.
ANQA_MM_GROUP=$GROUP ANQA_MM_MARKETS=$MM_MARKETS nohup npx ts-node --transpile-only app/maker-daemon.ts \
  >"app/.maker-daemon.log" 2>&1 &
echo "maker daemon pid $! — hub $GROUP, markets $MM_MARKETS"

echo "tail app/.keeper-hub.log and app/.maker-daemon.log to watch them"
