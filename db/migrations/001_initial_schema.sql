-- Letsnarf Database Schema (CQRS Pattern)
-- Migration 001: Initial schema for venues, scrape ledger, and read cache

-- Custom ENUM types
CREATE TYPE venue_category AS ENUM ('bar', 'restaurant', 'food_truck', 'late_night_window');

CREATE TYPE scrape_source AS ENUM (
    'facebook_about', 'instagram_post', 'google_structured',
    'osm_tags', 'foursquare', 'user_reported', 'venue_claimed'
);

-- A. Core Venue Entity
CREATE TABLE venues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(2) NOT NULL,
    lat DECIMAL(10, 8) NOT NULL,
    lng DECIMAL(11, 8) NOT NULL,
    category venue_category,
    place_id_google VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_venues_location ON venues (city, state);
CREATE INDEX idx_venues_coords ON venues (lat, lng);

-- B. The Scrape Ledger (Append-Only — NEVER UPDATE or DELETE)
CREATE TABLE kitchen_hours_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id UUID REFERENCES venues(id),
    source scrape_source NOT NULL,
    day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
    kitchen_open_time TIME,
    kitchen_close_time TIME,
    confidence_score DECIMAL(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
    raw_scrape_payload JSONB,
    observed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_hours_log_venue_time ON kitchen_hours_log (venue_id, observed_at DESC);

-- C. The Read-Optimized Cache (UPSERTed by Precedence Algorithm)
CREATE TABLE current_kitchen_hours (
    venue_id UUID REFERENCES venues(id),
    day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
    kitchen_open_time TIME,
    kitchen_close_time TIME,
    best_source scrape_source,
    overall_confidence_score DECIMAL(3,2) CHECK (overall_confidence_score BETWEEN 0 AND 1),
    last_verified_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (venue_id, day_of_week)
);
CREATE INDEX idx_current_hours_time ON current_kitchen_hours (day_of_week, kitchen_close_time);
