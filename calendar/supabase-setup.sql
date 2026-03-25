-- ============================================
-- Production Calendar — Supabase Setup
-- Run this in Supabase SQL Editor (one time)
-- ============================================

-- Schedule days table
CREATE TABLE schedule_days (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  production_id UUID REFERENCES productions(id) NOT NULL,
  shoot_day INTEGER,
  shoot_date DATE NOT NULL,
  location_1_name TEXT,
  location_1_address TEXT,
  location_1_type TEXT CHECK (location_1_type IN ('stage', 'location')),
  location_1_color TEXT DEFAULT '#60a5fa',
  has_move BOOLEAN DEFAULT FALSE,
  location_2_name TEXT,
  location_2_address TEXT,
  location_2_type TEXT CHECK (location_2_type IN ('stage', 'location')),
  location_2_color TEXT DEFAULT '#fbbf24',
  two_room TEXT,
  three_room TEXT,
  bg_count TEXT,
  notes TEXT,
  is_off_day BOOLEAN DEFAULT FALSE,
  off_day_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(production_id, shoot_date)
);

CREATE INDEX idx_schedule_days_date ON schedule_days(shoot_date);
CREATE INDEX idx_schedule_days_production ON schedule_days(production_id);

-- RLS
ALTER TABLE schedule_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on schedule_days" ON schedule_days FOR ALL USING (true) WITH CHECK (true);
