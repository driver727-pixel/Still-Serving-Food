Here is the comprehensive, all-encompassing master document. It includes the strategy, the database architecture, the Precedence Logic algorithm (in TypeScript), and the API/Infrastructure recommendations to make the system complete.


Markdown
# Letsnarf: Master Architecture & Strategy Specification

## 1. Executive Summary & Core Value Proposition
**Letsnarf** (letsnarf.com) solves a specific, high-intent pain point: the gap between "Bar Open" and "Kitchen Open." While major platforms (Google, Yelp) provide general business hours, they lack reliable, real-time data on when kitchens actually stop taking orders.

### The "Moat" (Your Intellectual Property):
1.  **Orchestration:** Resolving conflicting data from fragmented sources (Facebook, Instagram, Google, OSM, Foursquare, Firecrawl).
2.  **Precedence Logic:** A proprietary quality hierarchy with time-decay weighting that determines truth based on source reliability.
3.  **Operational Maintenance:** The continuous calibration of scrapers against anti-bot measures and DOM changes.
4.  **Longitudinal Data:** The historical record of how kitchen hours change over time—a unique asset for B2B analytics.

---

## 2. Product Roadmap (Priority Order)

| Priority | Phase | Goal |
| :--- | :--- | :--- |
| **1** | **Mobile-First App** | Use Capacitor to build a native app optimized for late-night "hungry right now" searches. |
| **2** | **Affiliate Integration** | Embed UberEats/DoorDash/Resy links to monetize high-intent traffic immediately. |
| **3** | **Data Persistence** | Move to a permanent PostgreSQL ledger of all scrapes to build the B2B dataset. |
| **4** | **Subscription Tier** | Add value-add features like "Saved Locations" and "Late-night Alerts." |
| **5** | **B2B Analytics/API** | License longitudinal kitchen-reliability data to delivery and hospitality firms. |

---

## 3. Database Architecture (CQRS Pattern)

We utilize a **Command Query Responsibility Segregation (CQRS)** pattern. We separate high-volume, append-only ingestion logs from the flattened, read-optimized cache tables.

### A. Core Venue Entity
```sql
CREATE TYPE venue_category AS ENUM ('bar', 'restaurant', 'food_truck', 'late_night_window');

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
B. The Scrape Ledger (The B2B Asset)
Rule: NEVER UPDATE or DELETE. Every scrape observation is a new row.

SQL
CREATE TYPE scrape_source AS ENUM (
    'facebook_about', 'instagram_post', 'google_structured', 
    'osm_tags', 'foursquare', 'user_reported', 'venue_claimed'
);

CREATE TABLE kitchen_hours_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id UUID REFERENCES venues(id),
    source scrape_source NOT NULL,
    day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
    kitchen_open_time TIME,
    kitchen_close_time TIME,
    confidence_score DECIMAL(3,2), -- Pre-calculated raw trust score
    raw_scrape_payload JSONB, -- Critical for historical re-parsing
    observed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_hours_log_venue_time ON kitchen_hours_log (venue_id, observed_at DESC);
C. The Read-Optimized Cache (The App Engine)
This table is UPSERTed by the Precedence Algorithm and queried by the mobile app.

SQL
CREATE TABLE current_kitchen_hours (
    venue_id UUID REFERENCES venues(id),
    day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
    kitchen_open_time TIME,
    kitchen_close_time TIME,
    best_source scrape_source,
    overall_confidence_score DECIMAL(3,2),
    last_verified_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (venue_id, day_of_week)
);
CREATE INDEX idx_current_hours_time ON current_kitchen_hours (day_of_week, kitchen_close_time);
4. Core Engine: The Precedence Logic (TypeScript)
This algorithm runs after new scrapes are ingested to determine what data the mobile app should actually show users. It handles conflict resolution and time-decay (an old IG post is less valuable than new Google data).

TypeScript
import { differenceInDays } from 'date-fns';

type ScrapeSource = 'venue_claimed' | 'instagram_post' | 'facebook_about' | 'google_structured' | 'osm_tags' | 'foursquare';

interface ScrapeLog {
  source: ScrapeSource;
  kitchen_close_time: string;
  observed_at: Date;
  raw_confidence: number;
}

// Base weights for sources
const SOURCE_WEIGHTS: Record<ScrapeSource, number> = {
  venue_claimed: 1.0,
  instagram_post: 0.85,  // High intent if recent
  facebook_about: 0.75,
  google_structured: 0.60, // Often wrong for kitchens
  osm_tags: 0.50,
  foursquare: 0.30
};

export function determineWinningHours(logs: ScrapeLog[]): ScrapeLog | null {
  if (logs.length === 0) return null;

  let bestLog = logs[0];
  let highestScore = -1;

  for (const log of logs) {
    const daysOld = differenceInDays(new Date(), log.observed_at);
    let timeDecayPenalty = 0;

    // Time decay logic: Social posts lose value quickly, structured data degrades slowly
    if (log.source === 'instagram_post' || log.source === 'facebook_about') {
        timeDecayPenalty = daysOld * 0.05; // Loses 5% confidence per day
    } else if (log.source === 'google_structured') {
        timeDecayPenalty = daysOld * 0.01; // Loses 1% confidence per day
    }

    // A claimed venue never decays in our system until updated by the owner
    if (log.source === 'venue_claimed') timeDecayPenalty = 0;

    const finalScore = (SOURCE_WEIGHTS[log.source] * log.raw_confidence) - timeDecayPenalty;

    if (finalScore > highestScore) {
      highestScore = finalScore;
      bestLog = log;
    }
  }

  return bestLog; // This winning log is what gets UPSERTED into current_kitchen_hours
}
5. Mobile API Design (Zero-Friction Client)
The mobile app should do almost no thinking. It simply asks the server, "I am here, it is this time, what is open?"

Endpoint: GET /api/v1/venues/open-now
Query Params: lat, lng, radius_miles, time_override (optional, for testing)

Expected JSON Response:

JSON
{
  "venues": [
    {
      "id": "uuid-1234",
      "name": "The Caribou Tavern",
      "category": "bar",
      "distance_miles": 0.4,
      "kitchen_status": {
        "closes_at": "23:00:00",
        "time_remaining_minutes": 45,
        "confidence_score": 0.82,
        "verified_via": "instagram_post",
        "verified_time_ago": "2 hours ago"
      },
      "affiliate_links": {
        "delivery": "[https://doordash.com/store/](https://doordash.com/store/)...",
        "uber": "[https://ubereats.com/](https://ubereats.com/)..."
      }
    }
  ]
}
6. AI Agent Directives & Implementation Guidelines
When acting as a coding assistant on this repository, strictly adhere to the following rules:

Architecture Respect: Never bypass the kitchen_hours_log table. Do not write direct updates to current_kitchen_hours from scraping endpoints. Scrapes must go to the ledger first, then trigger the Precedence algorithm to update the cache.

Defensive Scraping: Assume DOMs change daily and rate limits exist. Wrap all Apify/Firecrawl calls in try/catch blocks with exponential backoff.

Performant Reads: Mobile API queries MUST hit the current_kitchen_hours table using geospatial indexing (e.g., PostGIS if implemented, or standard lat/lng bounds).

Monetization First: If a UI component displays an open restaurant, immediately prompt the integration of the affiliate_links payload for zero-friction conversions.

Graceful Degradation: If the precedence logic yields a score below 0.30, surface a UI warning to the user: "Kitchen hours unverified. Call ahead." Do not pretend bad data is good data.
