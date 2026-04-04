'use strict';

/* ---- API base URL (Capacitor native vs. web) ---- */
const API_BASE = (typeof window !== 'undefined' && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())
  ? 'https://letsnarf.com'
  : '';

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

/* ---- State ---- */
let allVenues = [];
let currentFilter = 'all';
let adsInitialized = false;

const AD_DURATION_MS = 5000;
const STORAGE_KEY = 'ssf_free_search_used';

function hasFreeSearchAvailable() {
  return !sessionStorage.getItem(STORAGE_KEY);
}

function markFreeSearchUsed() {
  sessionStorage.setItem(STORAGE_KEY, '1');
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
      fetch(`${API_BASE}/api/ad-token`)
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
    await doSearch(pendingSearchParams, pendingAdToken);
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

  if (hasFreeSearchAvailable()) {
    markFreeSearchUsed();
    await doSearch(params, null);
  } else {
    showAdModal(params);
  }
});

function getSearchParams() {
  return {
    name: nameInput.value.trim(),
    location: locationInput.value.trim(),
    servingUntil: servingUntilInput.value.trim(),
    // Send the browser's UTC offset so the server compares venue hours in
    // the user's local time rather than the server's clock (typically UTC).
    utcOffset: -new Date().getTimezoneOffset(),
  };
}

async function doSearch(params, adToken) {
  showLoading(true);
  hideError();
  hideResults();

  try {
    const qs = new URLSearchParams({ limit: '12' });
    if (params.name) qs.set('name', params.name);
    if (params.location) qs.set('location', params.location);
    if (params.servingUntil) qs.set('servingUntil', params.servingUntil);
    if (params.utcOffset !== undefined) qs.set('utcOffset', params.utcOffset);
    if (adToken) qs.set('adToken', adToken);

    const res = await fetch(`${API_BASE}/api/search?${qs.toString()}`);

    if (res.status === 402) {
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

  // AdSense policy: only show ads alongside actual content, never on empty states
  const adsTop = document.getElementById('results-ads-top');
  const adsBottom = document.getElementById('results-ads-bottom');

  if (!venues.length) {
    venueList.innerHTML = '<p style="color:var(--muted);text-align:center;padding:2rem">No venues match the selected filter.</p>';
    // Hide ads when there are no results (low-value / empty content screen)
    if (adsTop) adsTop.classList.add('hidden');
    if (adsBottom) adsBottom.classList.add('hidden');
    return;
  }

  // Show ads only when actual venue content is rendered
  if (adsTop) adsTop.classList.remove('hidden');
  if (adsBottom) adsBottom.classList.remove('hidden');

  const regularVenues = venues.filter((v) => !v.is24Hours);
  const venues24Hr = venues.filter((v) => v.is24Hours);

  regularVenues.forEach((venue) => {
    venueList.appendChild(buildCard(venue));
  });

  if (venues24Hr.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'chain-separator';
    sep.innerHTML = '<span>24-Hour Establishments</span>';
    venueList.appendChild(sep);
    venues24Hr.forEach((venue) => {
      venueList.appendChild(buildCard(venue));
    });
  }
}

function buildCard(venue) {
  const is24Hours = venue.is24Hours === true;
  const serving = venue.serving;
  const hasHours = venue.hourBlocks && venue.hourBlocks.length > 0;

  let statusClass, statusLabel;
  if (is24Hours) {
    statusClass = 'serving';
    statusLabel = '🕐 Open 24 Hours';
  } else if (serving === true) {
    statusClass = 'serving';
    statusLabel = '🟢 Serving Food Now';
  } else if (serving === false) {
    statusClass = 'not-serving';
    statusLabel = '🔴 Not Serving';
  } else {
    statusClass = 'unknown';
    statusLabel = '🟡 Hours Unknown';
  }

  const card = document.createElement('article');
  card.className = `venue-card ${statusClass}`;

  let hoursHtml = '';
  if (venue.closesAt) {
    hoursHtml += `<div class="venue-hours">Kitchen closes at <strong>${venue.closesAt}</strong></div>`;
  } else if (venue.opensAt) {
    hoursHtml += `<div class="venue-hours">Next food service opens at <strong>${venue.opensAt}</strong></div>`;
  }

  // Confidence warning per spec: scores below 0.30 trigger a warning
  let confidenceHtml = '';
  if (venue.kitchen_status && !venue.kitchen_status.is_verified) {
    confidenceHtml = `<div class="venue-confidence-warning">⚠️ Kitchen hours unverified. Call ahead.</div>`;
  } else if (venue.kitchen_status && venue.kitchen_status.confidence_score) {
    const pct = Math.round(venue.kitchen_status.confidence_score * 100);
    confidenceHtml = `<div class="venue-confidence"><span class="confidence-badge">${pct}% confidence</span> via ${escapeHtml(venue.kitchen_status.verified_via || 'unknown')}</div>`;
  }

  let ownerTextHtml = '';
  const ownerTextUpdate = venue.kitchen_status && venue.kitchen_status.owner_text_update;
  if (ownerTextUpdate && ownerTextUpdate.recent) {
    const updatedAgo = relativeTime(ownerTextUpdate.updated_at);
    if (ownerTextUpdate.type === 'open_until' && ownerTextUpdate.display_closes_at) {
      ownerTextHtml = `<div class="venue-confidence">📱 Text-confirmed open until <strong>${escapeHtml(ownerTextUpdate.display_closes_at)}</strong> · updated ${escapeHtml(updatedAgo)}</div>`;
    } else if (ownerTextUpdate.type === 'closed_until' && ownerTextUpdate.display_closed_until) {
      ownerTextHtml = `<div class="venue-confidence">📱 Owner texted closed until <strong>${escapeHtml(ownerTextUpdate.display_closed_until)}</strong> · updated ${escapeHtml(updatedAgo)}</div>`;
    } else {
      ownerTextHtml = `<div class="venue-confidence">📱 Owner text update received ${escapeHtml(updatedAgo)}</div>`;
    }
  }

  // Affiliate links (delivery + reservation)
  let affiliateHtml = '';
  if (venue.affiliate_links) {
    const links = [];
    if (venue.affiliate_links.delivery) {
      if (venue.affiliate_links.delivery.doordash) {
        links.push(`<a href="${escapeHtml(venue.affiliate_links.delivery.doordash)}" target="_blank" rel="noopener noreferrer" class="affiliate-link doordash">🚗 DoorDash</a>`);
      }
      if (venue.affiliate_links.delivery.ubereats) {
        links.push(`<a href="${escapeHtml(venue.affiliate_links.delivery.ubereats)}" target="_blank" rel="noopener noreferrer" class="affiliate-link ubereats">🛵 UberEats</a>`);
      }
    }
    if (venue.affiliate_links.reservation && venue.affiliate_links.reservation.resy) {
      links.push(`<a href="${escapeHtml(venue.affiliate_links.reservation.resy)}" target="_blank" rel="noopener noreferrer" class="affiliate-link resy">📅 Resy</a>`);
    }
    if (links.length) {
      affiliateHtml = `<div class="venue-affiliates">${links.join('')}</div>`;
    }
  }

  let hoursTableHtml = '';
  if (hasHours) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Only show explicit hour blocks in the table; skip closing-hint fallback rows.
    const displayBlocks = venue.hourBlocks.filter((b) => !b.fromHint);
    if (displayBlocks.length) {
      const rows = displayBlocks
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
  }

  const urlHtml = venue.url
    ? `<div class="venue-url"><a href="${escapeHtml(venue.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(venue.url)}</a></div>`
    : '';

  const contactHtml =
    venue.callForHours && venue.url
      ? `<div class="venue-contact"><a href="${escapeHtml(venue.url)}" target="_blank" rel="noopener noreferrer">📞 Contact for current hours</a></div>`
      : '';

  const userReportHtml = buildUserReportWidget(venue);

  card.innerHTML = `
    <div class="venue-header">
      <a class="venue-name" href="${escapeHtml(venue.url || '#')}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(venue.name)}
      </a>
      <span class="status-badge ${statusClass}">${statusLabel}</span>
    </div>
    ${venue.description ? `<p class="venue-desc">${escapeHtml(venue.description)}</p>` : ''}
    ${hoursHtml}
    ${confidenceHtml}
    ${ownerTextHtml}
    ${contactHtml}
    ${affiliateHtml}
    ${hoursTableHtml}
    ${urlHtml}
    ${userReportHtml}
  `;

  return card;
}

/**
 * Build the "Still taking orders?" user-report widget for a venue card.
 * After a user votes, the button row is replaced with a thank-you message.
 * Votes are stored in sessionStorage to prevent duplicate votes per session.
 *
 * @param {object} venue
 * @returns {string} HTML string
 */
function buildUserReportWidget(venue) {
  const rawKey     = `${(venue.name || '').trim()}||${(venue.url || '').trim()}`;
  const storageKey = `ssf_voted_${rawKey}`;
  const alreadyVoted = sessionStorage.getItem(storageKey);

  let summary = '';
  if (venue.kitchen_status && venue.kitchen_status.user_report_summary) {
    const { vote_count, yes_count } = venue.kitchen_status.user_report_summary;
    if (vote_count > 0) {
      summary = `<span class="report-tally">${yes_count}/${vote_count} say still serving</span>`;
    }
  }

  if (alreadyVoted) {
    return `<div class="venue-feedback"><span class="venue-feedback-thanks">✅ Thanks for your report!</span>${summary}</div>`;
  }

  return `
    <div class="venue-feedback" data-venue-name="${escapeHtml(venue.name || '')}" data-venue-url="${escapeHtml(venue.url || '')}" data-storage-key="${escapeHtml(storageKey)}">
      <span class="venue-feedback-label">Still taking orders?</span>
      <button class="feedback-btn feedback-yes" type="button" aria-label="Yes, still taking orders">👍 Yes</button>
      <button class="feedback-btn feedback-no"  type="button" aria-label="No, kitchen is closed">👎 No</button>
      ${summary}
    </div>`;
}

/* ---- User-report click handler (event delegation on venue list) ---- */
venueList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.feedback-btn');
  if (!btn) return;

  const widget = btn.closest('.venue-feedback');
  if (!widget) return;

  const isServing   = btn.classList.contains('feedback-yes');
  const venueName   = widget.dataset.venueName;
  const venueUrl    = widget.dataset.venueUrl;
  const storageKey  = widget.dataset.storageKey;

  // Optimistically replace buttons with thanks message
  const summary = widget.querySelector('.report-tally') ? widget.querySelector('.report-tally').outerHTML : '';
  widget.innerHTML = `<span class="venue-feedback-thanks">✅ Thanks for your report!</span>${summary}`;

  sessionStorage.setItem(storageKey, '1');

  try {
    await fetch(`${API_BASE}/api/user-report`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ venue_name: venueName, venue_url: venueUrl, is_serving: isServing }),
    });
  } catch (_err) {
    // Best-effort — the UI already shows thanks regardless of network state
  }
});

/* ---- Ads ---- */
/**
 * Push each VISIBLE AdSense slot the first time results with actual content
 * are displayed. Per AdSense policy, ads must only appear alongside
 * substantial publisher-provided content — never on empty, loading,
 * error, or purely behavioral screens.
 *
 * Called once per page load; subsequent calls are no-ops.
 */
function initAds() {
  if (adsInitialized) return;
  // Only initialize ads when there are actual venue results to show
  if (!allVenues || allVenues.length === 0) return;
  adsInitialized = true;
  // Only push visible ad slots (not hidden ones from empty-result states)
  const slots = document.querySelectorAll('.search-ad:not(.hidden) .adsbygoogle');
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

function relativeTime(isoString) {
  if (!isoString) return 'recently';
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return 'recently';
  const diffMinutes = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes === 1) return '1 min ago';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  const diffDays = Math.round(diffHours / 24);
  return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
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
