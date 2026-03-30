'use strict';

/* ---- DOM refs ---- */
const form = document.getElementById('search-form');
const locationInput = document.getElementById('location-input');
const searchBtn = document.getElementById('search-btn');
const resultsSection = document.getElementById('results-section');
const resultsTitle = document.getElementById('results-title');
const resultsMeta = document.getElementById('results-meta');
const venueList = document.getElementById('venue-list');
const loading = document.getElementById('loading');
const errorSection = document.getElementById('error-section');
const errorMessage = document.getElementById('error-message');
const filterBtns = document.querySelectorAll('.filter-btn');

let allVenues = [];
let currentFilter = 'all';

/* ---- Search form ---- */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const location = locationInput.value.trim();
  if (!location) return;
  await doSearch(location);
});

async function doSearch(location) {
  showLoading(true);
  hideError();
  hideResults();

  try {
    const res = await fetch(`/api/search?location=${encodeURIComponent(location)}&limit=12`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server error ${res.status}`);
    }
    const data = await res.json();
    allVenues = data.venues || [];

    resultsTitle.textContent = `Food hours near "${location}"`;
    resultsMeta.textContent = `${allVenues.length} venue${allVenues.length !== 1 ? 's' : ''} found${data.fromCache ? ' (cached)' : ''}`;

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

function applyFilter(filter) {
  let venues = allVenues;
  if (filter === 'serving') venues = allVenues.filter((v) => v.serving === true);
  if (filter === 'not-serving') venues = allVenues.filter((v) => v.serving === false);
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
