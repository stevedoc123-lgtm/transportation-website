-- ============================================
-- Vehicle Check System — Supabase Setup
-- Run this in Supabase SQL Editor (one time)
-- ============================================

-- 1. Productions table
CREATE TABLE productions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Vehicle checks table
CREATE TABLE vehicle_checks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  production_id UUID REFERENCES productions(id) NOT NULL,
  check_type TEXT NOT NULL CHECK (check_type IN ('OUT', 'IN', 'DOT')),
  check_date DATE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  unit_number TEXT NOT NULL,
  tag_number TEXT NOT NULL,
  odometer TEXT NOT NULL,
  photo_front TEXT,
  photo_left TEXT,
  photo_right TEXT,
  photo_rear TEXT,
  has_damage BOOLEAN DEFAULT FALSE,
  damage_photo_1 TEXT,
  damage_photo_2 TEXT,
  damage_photo_3 TEXT,
  damage_comments TEXT,
  has_registration BOOLEAN,
  registration_photo TEXT,
  has_inspection TEXT CHECK (has_inspection IN ('YES', 'NO', 'NOT_REQUIRED')),
  inspection_photo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Indexes for fast lookups
CREATE INDEX idx_vehicle_checks_unit ON vehicle_checks(unit_number);
CREATE INDEX idx_vehicle_checks_production ON vehicle_checks(production_id);

-- 4. Enable Row Level Security
ALTER TABLE productions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_checks ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies — allow all operations with anon key
-- (We can lock this down with auth later)
CREATE POLICY "Allow all on productions" ON productions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on vehicle_checks" ON vehicle_checks FOR ALL USING (true) WITH CHECK (true);

-- 6. Create storage bucket for vehicle photos
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle-photos', 'vehicle-photos', true);

-- 7. Storage policies — allow upload and read
CREATE POLICY "Allow public read on vehicle-photos" ON storage.objects FOR SELECT USING (bucket_id = 'vehicle-photos');
CREATE POLICY "Allow anon upload on vehicle-photos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'vehicle-photos');
