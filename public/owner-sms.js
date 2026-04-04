'use strict';

const API_BASE = (typeof window !== 'undefined' && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())
  ? 'https://letsnarf.com'
  : '';

const tokenForm = document.getElementById('token-form');
const phoneForm = document.getElementById('phone-form');
const verifyForm = document.getElementById('verify-form');
const tokenInput = document.getElementById('token-input');
const phoneInput = document.getElementById('phone-input');
const codeInput = document.getElementById('code-input');
const ownerStatus = document.getElementById('owner-status');
const webhookUrl = document.getElementById('webhook-url');

const OWNER_TOKEN_KEY = 'ssf_owner_token';
const OWNER_PHONE_KEY = 'ssf_owner_phone';

function setStatus(message, isError = false) {
  ownerStatus.textContent = message;
  ownerStatus.classList.toggle('owner-sms-status-error', isError);
}

function getStoredToken() {
  return localStorage.getItem(OWNER_TOKEN_KEY) || '';
}

function getAuthHeaders() {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function populateFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    localStorage.setItem(OWNER_TOKEN_KEY, token);
  }
  tokenInput.value = getStoredToken();

  const storedPhone = localStorage.getItem(OWNER_PHONE_KEY);
  if (storedPhone) {
    phoneInput.value = storedPhone;
  }

  webhookUrl.textContent = `${window.location.origin || ''}/api/business/inbound-text`;
}

tokenForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Paste a business token first.', true);
    return;
  }
  localStorage.setItem(OWNER_TOKEN_KEY, token);
  setStatus('Owner token saved in this browser.');
});

phoneForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const phone = phoneInput.value.trim();
  if (!phone) {
    setStatus('Enter a phone number first.', true);
    return;
  }
  if (!getStoredToken()) {
    setStatus('Save your business token before requesting a code.', true);
    return;
  }

  const response = await fetch(`${API_BASE}/api/business/text-number`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ phone }),
  });

  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || 'Failed to request verification code.', true);
    return;
  }

  localStorage.setItem(OWNER_PHONE_KEY, data.phone);
  phoneInput.value = data.phone;
  if (data.verification_code) {
    codeInput.value = data.verification_code;
    setStatus(`Verification code generated. Dev code: ${data.verification_code}`);
    return;
  }
  setStatus(`Verification code sent to ${data.phone}.`);
});

verifyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const phone = phoneInput.value.trim();
  const code = codeInput.value.trim();

  if (!phone || !code) {
    setStatus('Enter both the phone number and verification code.', true);
    return;
  }
  if (!getStoredToken()) {
    setStatus('Save your business token before verifying the phone number.', true);
    return;
  }

  const response = await fetch(`${API_BASE}/api/business/text-number/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ phone, code }),
  });

  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || 'Failed to verify phone number.', true);
    return;
  }

  localStorage.setItem(OWNER_PHONE_KEY, data.phone);
  setStatus(`Phone verified. You can now text OPEN 10, CLOSED, REOPEN 6, or MON-FRI 11-9.`);
});

populateFromQuery();
