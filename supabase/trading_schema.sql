-- Trading research + execution tracking
-- Run once in Supabase SQL Editor: dashboard.supabase.com → SQL Editor → New query → paste → Run.

-- ── Trade ideas: every thesis (paper or live), with explicit max-loss + invalidation ──
create table if not exists trade_ideas (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz default now(),

    -- lifecycle
    status text not null default 'idea',
        -- idea | approved | paper_open | paper_closed | live_open | live_closed | rejected | expired
    rejected_reason text,

    -- what + why
    symbol text not null,                          -- e.g. SPY, NVDA
    strategy text not null,                        -- long_call, long_put, long_stock, put_credit_spread, call_debit_spread, csp, etc.
    structure jsonb,                               -- {legs: [{side, type, strike, expiry}], qty: 1}
    thesis text,                                   -- why we think this works
    invalidation text,                             -- what would change our mind / exit early
    target_dte int,                                -- target days-to-expiration when entered
    target_delta numeric(5,3),                     -- target option delta when entered

    -- planned economics (filled at idea/approved stage)
    planned_entry_price numeric(12,4),
    planned_position_size_usd numeric(12,2),
    planned_max_loss_usd numeric(12,2),
    planned_max_gain_usd numeric(12,2),            -- null if uncapped

    -- alpaca linkage
    alpaca_order_id text,
    alpaca_request_id text,                        -- X-Request-ID from order submission

    -- realized economics
    opened_at timestamptz,
    closed_at timestamptz,
    actual_entry_price numeric(12,4),
    actual_exit_price numeric(12,4),
    realized_pnl_usd numeric(12,2),
    realized_pnl_pct numeric(7,3),

    -- post-mortem
    notes text,
    tags text[]                                    -- e.g. ['earnings', 'megacap', 'momentum']
);
create index if not exists idx_trade_ideas_status on trade_ideas(status);
create index if not exists idx_trade_ideas_symbol on trade_ideas(symbol);
create index if not exists idx_trade_ideas_created on trade_ideas(created_at desc);

-- ── Alpaca API log: persists every X-Request-ID for support ──
create table if not exists alpaca_api_log (
    id bigserial primary key,
    created_at timestamptz default now(),
    method text not null,
    path text not null,
    status_code int,
    request_id text,                               -- X-Request-ID from response
    duration_ms int,
    error text,
    related_idea_id uuid references trade_ideas(id) on delete set null
);
create index if not exists idx_alpaca_log_created on alpaca_api_log(created_at desc);
create index if not exists idx_alpaca_log_request_id on alpaca_api_log(request_id);

-- ── Weekly research briefs (so you can see what was sent and when) ──
create table if not exists research_briefs (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz default now(),
    sent_at timestamptz,
    market_read text,                              -- bullish | bearish | range | unclear
    summary text,
    idea_ids uuid[]                                -- references to trade_ideas surfaced in this brief
);

-- ── Trailing-exit support: track peak natural exit credit per spread ──
-- One ALTER per existing schema: adds the peak_credit column used by trade-exit.js.
alter table trade_ideas add column if not exists peak_credit numeric(7,2);

-- ── Automation heartbeat: one row per scheduled-job run, used to detect
--    silent failures (Mac mini asleep, network outage, etc.) ──
create table if not exists automation_runs (
    id bigserial primary key,
    name text not null,                            -- 'trade-exit', 'trade-cycle', etc.
    source text not null,                          -- 'netlify-scheduled' | 'mac-mini-cron' | 'manual'
    status text not null,                          -- 'ok' | 'errored'
    started_at timestamptz,
    completed_at timestamptz default now(),
    summary jsonb                                  -- the run's result payload
);
create index if not exists idx_automation_runs_name_completed on automation_runs(name, completed_at desc);
alter table automation_runs enable row level security;

-- ── IV history: one ATM-IV reading per symbol per day, used to build IV rank over time ──
create table if not exists iv_history (
    id bigserial primary key,
    captured_at timestamptz default now(),
    captured_date date not null,                   -- YYYY-MM-DD of the reading (one per symbol per day)
    symbol text not null,
    underlying_price numeric(12,4),
    atm_iv numeric(7,4),                           -- avg of ATM call + put IV (annualized, e.g. 0.34 = 34%)
    expiry_used date,                              -- which expiry we sampled (~30 DTE target)
    dte_used int,
    hv_20d numeric(7,4),                           -- 20d realized vol from price bars (annualized, decimal)
    iv_hv_ratio numeric(7,3),                      -- atm_iv / hv_20d
    iv_rank numeric(5,2),                          -- rolling 252d percentile (null until enough history)
    iv_percentile numeric(5,2),                    -- pct of prior days where iv was below today (rolling 252d)
    sample_count int                               -- how many prior days backed the rank/percentile
);
create unique index if not exists idx_iv_history_symbol_date on iv_history(symbol, captured_date);
create index if not exists idx_iv_history_symbol_captured on iv_history(symbol, captured_at desc);

-- ── Lock down: enable RLS on all trading tables ──
-- No policies = anon/authenticated keys have zero access.
-- Server-side Netlify Functions will use SUPABASE_SERVICE_ROLE_KEY which bypasses RLS.
alter table trade_ideas     enable row level security;
alter table alpaca_api_log  enable row level security;
alter table research_briefs enable row level security;
alter table iv_history      enable row level security;
