'use strict';

/* ---- DOM refs ---- */
const form = document.getElementById('search-form');
const nameInput = document.getElementById('name-input');
const locationInput = document.getElementById('location-input');
const servingUntilInput = document.getElementById('serving-until-input');
const searchBtn = document.getElementById('search-btn');
const resultsSection = document.getElementById('results-section');
const resultsTitle = document.getElementById('results-title');
const resultsMeta = document.getElementById('results-meta');
const venueList = document.getElementById('venue-list');
const loading = document.getElementById('loading');
const errorSection = document.getElementById('error-section');
const errorMessage = document.getElementById('error-message');
const filterBtns = document.querySelectorAll('.filter-btn');
const refineNameInput = document.getElementById('refine-name');

/* ---- Ad modal refs ---- */
const adModal = document.getElementById('ad-modal');
const adContinueBtn = document.getElementById('ad-continue-btn');
const adCancelBtn = document.getElementById('ad-cancel-btn');
const adProgressBar = document.getElementById('ad-progress-bar');
const adCountdown = document.getElementById('ad-countdown');
const adSeconds = document.getElementById('ad-seconds');

/* ---- Subscriber UI refs ---- */
const upgradeSection = document.getElementById('upgrade-section');
const upgradeBtn = document.getElementById('upgrade-btn');
const subscriberStatusEl = document.getElementById('subscriber-status');
const searchesRemainingEl = document.getElementById('searches-remaining');
const searchHintEl = document.getElementById('search-hint');

/* ---- State ---- */
let allVenues = [];
let currentFilter = 'all';
let adsInitialized = false;

const AD_DURATION_MS = 5000;
const STORAGE_KEY = 'ssf_free_search_used';
const SUBSCRIBER_TOKEN_KEY = 'ssf_subscriber_token';

function hasFreeSearchAvailable() {
  return !sessionStorage.getItem(STORAGE_KEY);
}

function markFreeSearchUsed() {
  sessionStorage.setItem(STORAGE_KEY, '1');
}

/* ---- Subscriber token (localStorage) ---- */
function getSubscriberToken() {
  return localStorage.getItem(SUBSCRIBER_TOKEN_KEY) || null;
}

function setSubscriberToken(token) {
  localStorage.setItem(SUBSCRIBER_TOKEN_KEY, token);
}

function clearSubscriberToken() {
  localStorage.removeItem(SUBSCRIBER_TOKEN_KEY);
}

/**
 * Check subscriber status with the server and update the UI accordingly.
 * Shows the upgrade prompt when no valid token is present.
 */
async function refreshSubscriberUI() {
  const token = getSubscriberToken();
  if (!token) {
    showUpgradePrompt(true);
    return;
  }

  try {
    const res = await fetch(`/api/subscriber-status?subscriberToken=${encodeURIComponent(token)}`);
    if (!res.ok) {
      clearSubscriberToken();
      showUpgradePrompt(true);
      return;
    }
    const data = await res.json();
    showSubscriberStatus(data.searchesRemaining);
  } catch {
    // Network error — leave UI in default state
  }
}

function showUpgradePrompt(show) {
  if (upgradeSection) upgradeSection.classList.toggle('hidden', !show);
  if (subscriberStatusEl) subscriberStatusEl.classList.add('hidden');
  if (searchHintEl) searchHintEl.classList.toggle('hidden', false);
}

function showSubscriberStatus(remaining) {
  if (searchesRemainingEl) searchesRemainingEl.textContent = remaining;
  if (subscriberStatusEl) subscriberStatusEl.classList.remove('hidden');
  if (upgradeSection) upgradeSection.classList.add('hidden');
  if (searchHintEl) searchHintEl.classList.add('hidden');
}

/* ---- Upgrade button ---- */
if (upgradeBtn) {
  upgradeBtn.addEventListener('click', async () => {
    upgradeBtn.disabled = true;
    upgradeBtn.textContent = 'Redirecting to checkout…';
    try {
      const res = await fetch('/api/create-checkout-session', { method: 'POST' });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        showError(data.error || 'Could not start checkout. Please try again.');
        upgradeBtn.disabled = false;
        upgradeBtn.textContent = '🔓 Unlock 100 Searches — $4.99';
      }
    } catch {
      showError('Could not start checkout. Please try again.');
      upgradeBtn.disabled = false;
      upgradeBtn.textContent = '🔓 Unlock 100 Searches — $4.99';
    }
  });
}

/* ---- Ad token ---- */
let pendingAdToken = null;
let pendingSearchParams = null;

function showAdModal(searchParams) {
  pendingSearchParams = searchParams;
  pendingAdToken = null;
  adContinueBtn.disabled = true;
  adProgressBar.style.width = '0%';
  adSeconds.textContent = Math.ceil(AD_DURATION_MS / 1000);
  adModal.classList.remove('hidden');
  adModal.setAttribute('aria-hidden', 'false');
  runAdCountdown();
}

function hideAdModal() {
  adModal.classList.add('hidden');
  adModal.setAttribute('aria-hidden', 'true');
}

function runAdCountdown() {
  const start = Date.now();
  const tick = () => {
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, AD_DURATION_MS - elapsed);
    const progress = Math.min(100, (elapsed / AD_DURATION_MS) * 100);
    adProgressBar.style.width = `${progress}%`;
    adSeconds.textContent = Math.ceil(remaining / 1000);

    if (remaining > 0) {
      requestAnimationFrame(tick);
    } else {
      adCountdown.textContent = 'Ad complete!';
      adContinueBtn.disabled = false;
      // Pre-fetch a token so it is ready when user clicks continue
      fetch('/api/ad-token')
        .then((r) => r.json())
        .then((d) => {
          pendingAdToken = d.token || null;
        })
        .catch(() => {
          pendingAdToken = null;
        });
    }
  };
  requestAnimationFrame(tick);
}

adContinueBtn.addEventListener('click', async () => {
  hideAdModal();
  if (pendingSearchParams) {
    await doSearch(pendingSearchParams, pendingAdToken, null);
  }
});

adCancelBtn.addEventListener('click', () => {
  hideAdModal();
  pendingSearchParams = null;
});

/* ---- Search form ---- */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const params = getSearchParams();
  if (!params.name && !params.location) {
    showError('Please enter a restaurant name or location to search.');
    return;
  }
  hideError();

  const subscriberToken = getSubscriberToken();
  if (subscriberToken) {
    await doSearch(params, null, subscriberToken);
  } else if (hasFreeSearchAvailable()) {
    markFreeSearchUsed();
    await doSearch(params, null, null);
  } else {
    showAdModal(params);
  }
});

function getSearchParams() {
  return {
    name: nameInput.value.trim(),
    location: locationInput.value.trim(),
    servingUntil: servingUntilInput.value.trim(),
  };
}

async function doSearch(params, adToken, subscriberToken) {
  showLoading(true);
  hideError();
  hideResults();

  try {
    const qs = new URLSearchParams({ limit: '12' });
    if (params.name) qs.set('name', params.name);
    if (params.location) qs.set('location', params.location);
    if (params.servingUntil) qs.set('servingUntil', params.servingUntil);
    if (adToken) qs.set('adToken', adToken);
    if (subscriberToken) qs.set('subscriberToken', subscriberToken);

    const res = await fetch(`/api/search?${qs.toString()}`);

    if (res.status === 402) {
      const body = await res.json().catch(() => ({}));

      if (body.error === 'search_limit_reached') {
        // Subscriber has exhausted their 100-search pass
        clearSubscriberToken();
        showUpgradePrompt(true);
        showError('You\'ve used all your searches. Purchase another pass to continue.');
        return;
      }

      // Ad required — server says the free quota is exhausted for this IP
      // (e.g. token was stale); prompt user to watch another ad
      markFreeSearchUsed();
      showAdModal(params);
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || `Server error ${res.status}`);
    }

    const data = await res.json();
    allVenues = data.venues || [];

    const titleParts = [];
    if (params.name) titleParts.push(`"${params.name}"`);
    if (params.location) titleParts.push(`near "${params.location}"`);
    if (params.servingUntil) titleParts.push(`serving until ${params.servingUntil}`);
    resultsTitle.textContent = `Results${titleParts.length ? ': ' + titleParts.join(' ') : ''}`;
    resultsMeta.textContent = `${allVenues.length} venue${allVenues.length !== 1 ? 's' : ''} found${data.fromCache ? ' (cached)' : ''}`;

    // Clear refine filter on new search
    if (refineNameInput) refineNameInput.value = '';

    applyFilter(currentFilter);
    showResults(true);

    // Refresh subscriber count display after a successful search
    if (subscriberToken) {
      await refreshSubscriberUI();
    }
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

/* ---- Filter buttons ---- */
filterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    applyFilter(currentFilter);
  });
});

/* ---- Refine by name (client-side) ---- */
if (refineNameInput) {
  refineNameInput.addEventListener('input', () => {
    applyFilter(currentFilter);
  });
}

function applyFilter(filter) {
  let venues = allVenues;
  if (filter === 'serving') venues = venues.filter((v) => v.serving === true);
  if (filter === 'not-serving') venues = venues.filter((v) => v.serving === false);

  const refineTerm = refineNameInput ? refineNameInput.value.trim().toLowerCase() : '';
  if (refineTerm) {
    venues = venues.filter((v) => v.name && v.name.toLowerCase().includes(refineTerm));
  }

  renderVenues(venues);
}

/* ---- Render ---- */
function renderVenues(venues) {
  venueList.innerHTML = '';

  if (!venues.length) {
    venueList.innerHTML = '<p style="color:var(--muted);text-align:center;padding:2rem">No venues match the selected filter.</p>';
    return;
  }

  venues.forEach((venue) => {
    venueList.appendChild(buildCard(venue));
  });
}

function buildCard(venue) {
  const serving = venue.serving;
  const hasHours = venue.hourBlocks && venue.hourBlocks.length > 0;

  const statusClass = serving === true ? 'serving' : serving === false ? 'not-serving' : 'unknown';
  const statusLabel =
    serving === true
      ? '🟢 Serving Food Now'
      : serving === false
        ? '🔴 Not Serving'
        : '🟡 Hours Unknown';

  const card = document.createElement('article');
  card.className = `venue-card ${statusClass}`;

  let hoursHtml = '';
  if (venue.closesAt) {
    hoursHtml += `<div class="venue-hours">Kitchen closes at <strong>${venue.closesAt}</strong></div>`;
  } else if (venue.opensAt) {
    hoursHtml += `<div class="venue-hours">Next food service opens at <strong>${venue.opensAt}</strong></div>`;
  }

  let hoursTableHtml = '';
  if (hasHours) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const rows = venue.hourBlocks
      .map(
        (b) =>
          `<tr><td>${days[b.day]}</td><td>${minsToTime(b.open)}</td><td>${minsToTime(b.close)}</td></tr>`,
      )
      .join('');
    hoursTableHtml = `
      <details class="hours-detail">
        <summary>Show all food hours</summary>
        <table class="hours-table">
          <thead><tr><th>Day</th><th>Opens</th><th>Closes</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  const urlHtml = venue.url
    ? `<div class="venue-url"><a href="${escapeHtml(venue.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(venue.url)}</a></div>`
    : '';

  card.innerHTML = `
    <div class="venue-header">
      <a class="venue-name" href="${escapeHtml(venue.url || '#')}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(venue.name)}
      </a>
      <span class="status-badge ${statusClass}">${statusLabel}</span>
    </div>
    ${venue.description ? `<p class="venue-desc">${escapeHtml(venue.description)}</p>` : ''}
    ${hoursHtml}
    ${hoursTableHtml}
    ${urlHtml}
  `;

  return card;
}

/* ---- Ads ---- */
/**
 * Push each AdSense slot the first time results are displayed.
 * Called once per page load; subsequent calls are no-ops.
 * Replace YOUR_AD_SLOT_ID placeholders in index.html with real slot IDs
 * from your AdSense account once the account is approved.
 */
function initAds() {
  if (adsInitialized) return;
  adsInitialized = true;
  const slots = document.querySelectorAll('.adsbygoogle');
  // adsbygoogle.push({}) processes slots sequentially — call it once per <ins> element
  for (let i = 0; i < slots.length; i++) {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (e) {
      // adsbygoogle script may be blocked or not yet loaded
    }
  }
}

/* ---- Helpers ---- */
function minsToTime(mins) {
  if (mins == null) return '?';
  if (mins >= 24 * 60) mins -= 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showLoading(show) {
  loading.classList.toggle('hidden', !show);
  searchBtn.disabled = show;
}

function showResults(show) {
  resultsSection.classList.toggle('hidden', !show);
  if (show) initAds();
}

function hideResults() {
  resultsSection.classList.add('hidden');
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorSection.classList.remove('hidden');
}

function hideError() {
  errorSection.classList.add('hidden');
}

// Initialise subscriber UI on page load
refreshSubscriberUI();
