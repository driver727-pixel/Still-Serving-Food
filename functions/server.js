'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { searchVenues, scrapeVenue } = require('./scraper');
const venueStore = require('./venueStore');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * GET /api/search?location=Brooklyn,NY&limit=10
 *
 * Search for venues serving food in the given location.
 * Results are cached for 10 minutes.
 */
app.get('/api/search', async (req, res) => {
  const { location, limit } = req.query;

  if (!location || !location.trim()) {
    return res.status(400).json({ error: 'location query parameter is required' });
  }

  const cached = venueStore.get(location);
  if (cached) {
    return res.json({ venues: cached, fromCache: true });
  }

  try {
    const venues = await searchVenues(location, {
      limit: parseInt(limit, 10) || 10,
    });
    venueStore.set(location, venues);
    return res.json({ venues, fromCache: false });
  } catch (err) {
    console.error('[search error]', err.message);
    return res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/scrape
 * Body: { "url": "https://example.com" }
 *
 * Scrape a specific venue URL for its food-service hours.
 */
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'url body field is required' });
  }

  try {
    const venue = await scrapeVenue(url);
    return res.json({ venue });
  } catch (err) {
    console.error('[scrape error]', err.message);
    return res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Still Serving Food server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
