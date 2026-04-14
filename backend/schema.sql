-- Hypurrmium Auto-Buy — SQLite schema

CREATE TABLE IF NOT EXISTS strategies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    address         TEXT    NOT NULL,                 -- user wallet (lowercased)
    agent_authorized INTEGER NOT NULL DEFAULT 0,      -- 1 = user signed approveAgent
    pe_trigger      REAL    NOT NULL,                 -- buy when P/E < this
    order_type      TEXT    NOT NULL DEFAULT 'market', -- 'market' | 'limit'
    alert_metric    TEXT    NOT NULL DEFAULT 'mc',     -- 'mc' | 'fdv' | 'price'
    price_source    TEXT    NOT NULL DEFAULT 'spot',   -- 'spot' | 'median'
    limit_offset_pct REAL,                            -- e.g. -2.0 (only for limit)
    amount_usdc     REAL    NOT NULL,                 -- per-trigger amount in USDC
    max_triggers    INTEGER NOT NULL DEFAULT 3,
    triggers_used   INTEGER NOT NULL DEFAULT 0,
    total_budget    REAL    NOT NULL,
    budget_used     REAL    NOT NULL DEFAULT 0,
    cooldown_seconds INTEGER NOT NULL DEFAULT 14400,  -- 4 hours default
    last_triggered_at TEXT,                           -- ISO timestamp
    expires_at      TEXT    NOT NULL,                 -- ISO timestamp
    active          INTEGER NOT NULL DEFAULT 1,
    market_type     TEXT    NOT NULL DEFAULT 'spot',    -- 'spot' | 'perp'
    notify_email    TEXT,                             -- email for notifications
    notify_enabled  INTEGER NOT NULL DEFAULT 0,       -- 1 = send email on order
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id     INTEGER NOT NULL REFERENCES strategies(id),
    address         TEXT    NOT NULL,
    pe_at_trigger   REAL    NOT NULL,
    price           REAL    NOT NULL,
    size_hype       REAL    NOT NULL,
    amount_usdc     REAL    NOT NULL,
    order_type      TEXT    NOT NULL,
    hl_response     TEXT,                             -- JSON response from Hyperliquid
    status          TEXT    NOT NULL DEFAULT 'filled', -- 'filled' | 'failed'
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
