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

/* ---- State ---- */
let allVenues = [];
let currentFilter = 'all';

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
      fetch('https://api.letsnarf.com/api/ad-token')
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
    if (adToken) qs.set('adToken', adToken);

    const res = await fetch(`https://api.letsnarf.com/api/search?${qs.toString()}`);

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
