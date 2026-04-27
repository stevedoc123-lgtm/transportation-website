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

-- ── Lock down: enable RLS on all trading tables ──
-- No policies = anon/authenticated keys have zero access.
-- Server-side Netlify Functions will use SUPABASE_SERVICE_ROLE_KEY which bypasses RLS.
alter table trade_ideas     enable row level security;
alter table alpaca_api_log  enable row level security;
alter table research_briefs enable row level security;
