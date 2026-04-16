'use strict';

(() => {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  const SOUND_PREF_KEY = 'ssf_sound_enabled';
  const MIN_RAMP_FREQUENCY = 20;
  const ENVELOPE_FLOOR = 0.001;
  const ENVELOPE_ATTACK = 0.01;
  const soundToggleButtons = document.querySelectorAll('[data-sound-toggle]');
  let audioContext;
  let soundEnabled = localStorage.getItem(SOUND_PREF_KEY) !== '0';

  function getAudioContext() {
    if (!audioContext) audioContext = new AudioCtx();
    return audioContext;
  }

  function unlockAudio() {
    const ctx = getAudioContext();
    if (ctx.state !== 'suspended') {
      removeUnlockListeners();
      return;
    }
    ctx.resume().then(removeUnlockListeners).catch(() => {});
  }

  function playTone({
    frequency,
    endFrequency = frequency,
    duration = 0.08,
    volume = 0.025,
    type = 'square',
    delay = 0,
  }) {
    const ctx = getAudioContext();
    const startAt = ctx.currentTime + delay;
    const endAt = startAt + duration;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(endFrequency, MIN_RAMP_FREQUENCY), endAt);

    gain.gain.setValueAtTime(ENVELOPE_FLOOR, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + ENVELOPE_ATTACK);
    gain.gain.linearRampToValueAtTime(ENVELOPE_FLOOR, endAt);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(endAt);
  }

  function playSound(kind) {
    if (!soundEnabled) return;
    unlockAudio();

    if (kind === 'soda') {
      playTone({ frequency: 620, endFrequency: 480, duration: 0.07, volume: 0.03, type: 'square' });
      playTone({ frequency: 380, endFrequency: 220, duration: 0.09, volume: 0.018, type: 'triangle', delay: 0.035 });
      return;
    }

    if (kind === 'toggle') {
      playTone({ frequency: 520, endFrequency: 420, duration: 0.05, volume: 0.018, type: 'square' });
      return;
    }

    if (kind === 'blip') {
      playTone({ frequency: 700, endFrequency: 540, duration: 0.05, volume: 0.016, type: 'triangle' });
      return;
    }

    playTone({ frequency: 410, endFrequency: 280, duration: 0.08, volume: 0.024, type: 'sawtooth' });
    playTone({ frequency: 610, endFrequency: 490, duration: 0.06, volume: 0.015, type: 'triangle', delay: 0.03 });
  }

  function updateSoundToggleUi() {
    soundToggleButtons.forEach((button) => {
      button.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
      button.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
    });
  }

  updateSoundToggleUi();

  soundToggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const wasEnabled = soundEnabled;
      soundEnabled = !soundEnabled;
      localStorage.setItem(SOUND_PREF_KEY, soundEnabled ? '1' : '0');
      updateSoundToggleUi();
      if (!wasEnabled && soundEnabled) playSound('toggle');
    });
  });

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-sound]');
    if (!trigger) return;
    playSound(trigger.dataset.sound || 'action');
  });

  function removeUnlockListeners() {
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  }

  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio);
})();
