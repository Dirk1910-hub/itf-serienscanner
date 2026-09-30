import { addScan, createTextFileContent, isValidManualCode } from './scanner-state.js';
import { decodeFrameCandidates } from './frame-decoder.js';
import { playSound, unlockSound } from './audio-feedback.js';
import { cameraCounterTransform, requestPortraitLock } from './camera-orientation.js';

const EMAIL = 'thinnes13@freenet.de';
const STORAGE_KEY = 'itf-scanner-scans-v1';
const $ = (selector) => document.querySelector(selector);

const elements = {
  preview: $('#preview'), cameraCard: $('.camera-card'), placeholder: $('#camera-placeholder'), start: $('#start-scan'), stop: $('#stop-scan'),
  status: $('#status'), count: $('#count'), list: $('#scan-list'), undo: $('#undo'), finish: $('#finish'), reset: $('#reset'),
  panel: $('#finish-panel'), finishCount: $('#finish-count'), email: $('#email'), share: $('#share-file'), continue: $('#continue'),
  manualOpen: $('#manual-open'), manualPanel: $('#manual-panel'), manualForm: $('#manual-form'), manualCode: $('#manual-code'),
  manualCancel: $('#manual-cancel'), manualError: $('#manual-error'), manualCount: $('#manual-count'),
  successSound: $('#success-sound'), duplicateSound: $('#duplicate-sound')
};

let scans = loadScans();
let cameraStream = null;
let scanTimer = null;
let scannerActive = false;
let orientationLocked = false;
let frameReader = null;
const frameCanvas = document.createElement('canvas');
const rotatedCanvas = document.createElement('canvas');
const cropCanvas = document.createElement('canvas');
const rotatedCropCanvas = document.createElement('canvas');
let audioContext = null;
let blockedCode = null;
let lastDecodeAt = 0;

function loadScans() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item) => item && Number.isInteger(item.number) && typeof item.code === 'string');
  } catch { return []; }
}

function saveAndRender() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scans));
  const text = createTextFileContent(scans);
  elements.list.value = text;
  elements.count.textContent = String(scans.length);
  elements.finishCount.textContent = String(scans.length);
  elements.undo.disabled = scans.length === 0;
  elements.finish.disabled = scans.length === 0;
  elements.reset.disabled = scans.length === 0;
  elements.list.scrollTop = elements.list.scrollHeight;
}

function setStatus(message, kind = 'neutral') {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`;
}

async function prepareAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass && !audioContext) audioContext = new AudioContextClass();
  const unlocks = [elements.successSound, elements.duplicateSound]
    .filter(Boolean)
    .map((sound) => unlockSound(sound));
  await Promise.all(unlocks);
  if (audioContext?.state === 'suspended') {
    try { await audioContext.resume(); } catch { /* Audiodatei bleibt die Hauptlösung. */ }
  }
}

async function beep(kind = 'success') {
  const sound = kind === 'success' ? elements.successSound : elements.duplicateSound;
  if (sound && await playSound(sound)) return;
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch { return; }
  }
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const start = audioContext.currentTime;
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(kind === 'success' ? 980 : 260, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(kind === 'success' ? 0.24 : 0.17, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + (kind === 'success' ? 0.16 : 0.28));
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + (kind === 'success' ? 0.17 : 0.29));
}

function storeCode(rawCode, source = 'scan') {
  const code = String(rawCode);
  const result = addScan(scans, code);
  scans = result.scans;
  if (result.status === 'duplicate') {
    void beep('duplicate');
    setStatus(`Bereits erfasst: ${code}`, 'warning');
    return result;
  }
  void beep('success');
  saveAndRender();
  const label = source === 'manual' ? 'Manuell gespeichert' : `Scan ${scans.length} gespeichert`;
  setStatus(`${label}: ${code}`, 'success');
  return result;
}

function handleDetectedCode(rawCode) {
  const code = String(rawCode).trim();
  if (!code || code === blockedCode) return;
  blockedCode = code;
  lastDecodeAt = Date.now();
  storeCode(code);
}

function currentScreenAngle() {
  if (Number.isFinite(screen.orientation?.angle)) return screen.orientation.angle;
  return Number(window.orientation) || 0;
}

function applyCameraOrientation() {
  if (!scannerActive || orientationLocked) {
    elements.preview.style.transform = '';
    elements.preview.dataset.counterRotation = '0';
    return;
  }
  const rect = elements.cameraCard.getBoundingClientRect();
  const { rotation, scale } = cameraCounterTransform(currentScreenAngle(), rect.width, rect.height);
  elements.preview.style.transform = `rotate(${rotation}deg) scale(${scale})`;
  elements.preview.dataset.counterRotation = String(rotation);
}

function scheduleCameraOrientationUpdate() {
  requestAnimationFrame(() => requestAnimationFrame(applyCameraOrientation));
}

function scanNextFrame() {
  if (!scannerActive) return;
  if (elements.preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && elements.preview.videoWidth) {
    const sourceWidth = elements.preview.videoWidth;
    const sourceHeight = elements.preview.videoHeight;
    const scale = Math.min(1, 1920 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (frameCanvas.width !== width || frameCanvas.height !== height) {
      frameCanvas.width = width;
      frameCanvas.height = height;
    }
    const context = frameCanvas.getContext('2d', { alpha: false });
    context.drawImage(elements.preview, 0, 0, width, height);
    try {
      const result = decodeFrameCandidates(frameReader, frameCanvas, rotatedCanvas, cropCanvas, rotatedCropCanvas);
      lastDecodeAt = Date.now();
      handleDetectedCode(result.getText());
    } catch {
      if (blockedCode && Date.now() - lastDecodeAt > 1200) blockedCode = null;
    }
  }
  scanTimer = setTimeout(scanNextFrame, 180);
}

async function startScanner() {
  const orientationLockPromise = requestPortraitLock(screen.orientation);
  await prepareAudio();
  orientationLocked = await orientationLockPromise;
  if (scannerActive) return;
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    setStatus('Die Kamera benötigt eine sichere HTTPS-Verbindung.', 'error');
    return;
  }
  if (!window.ZXingBrowser) {
    setStatus('Der Barcode-Scanner konnte nicht geladen werden.', 'error');
    return;
  }
  try {
    frameReader = new ZXingBrowser.BrowserMultiFormatReader();
    frameReader.possibleFormats = [ZXingBrowser.BarcodeFormat.ITF];
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        frameRate: { ideal: 30 }
      }
    });
    const cameraTrack = cameraStream.getVideoTracks()[0];
    try {
      const capabilities = cameraTrack.getCapabilities?.() || {};
      const advanced = {};
      if (capabilities.focusMode?.includes?.('continuous')) advanced.focusMode = 'continuous';
      if (capabilities.exposureMode?.includes?.('continuous')) advanced.exposureMode = 'continuous';
      if (capabilities.whiteBalanceMode?.includes?.('continuous')) advanced.whiteBalanceMode = 'continuous';
      if (Object.keys(advanced).length) await cameraTrack.applyConstraints({ advanced: [advanced] });
    } catch { /* iOS ignoriert nicht unterstützte Kameraoptionen. */ }
    elements.preview.srcObject = cameraStream;
    await elements.preview.play();
    scannerActive = true;
    scheduleCameraOrientationUpdate();
    scanNextFrame();
    elements.placeholder.classList.add('hidden');
    elements.start.classList.add('hidden');
    elements.stop.classList.remove('hidden');
    setStatus('Kamera aktiv – Bildausrichtung fixiert', 'neutral');
  } catch (error) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    const denied = error?.name === 'NotAllowedError';
    setStatus(denied ? 'Kamerazugriff wurde nicht erlaubt.' : 'Kamera konnte nicht gestartet werden.', 'error');
  }
}

function stopScanner() {
  scannerActive = false;
  if (orientationLocked && typeof screen.orientation?.unlock === 'function') screen.orientation.unlock();
  orientationLocked = false;
  elements.preview.style.transform = '';
  elements.preview.dataset.counterRotation = '0';
  clearTimeout(scanTimer);
  scanTimer = null;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  elements.preview.srcObject = null;
  elements.stop.classList.add('hidden');
  elements.start.classList.remove('hidden');
  elements.placeholder.classList.remove('hidden');
  setStatus('Kamera gestoppt', 'neutral');
}

function makeTextFile() {
  const date = new Date().toISOString().slice(0, 10);
  return new File([createTextFileContent(scans)], `ITF-Scans-${date}.txt`, { type: 'text/plain;charset=utf-8' });
}

async function shareTextFile() {
  const file = makeTextFile();
  try { await navigator.clipboard?.writeText(EMAIL); } catch { /* Teilen funktioniert auch ohne Zwischenablage. */ }
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ title: 'ITF-Scans', text: `Bitte an ${EMAIL} senden.`, files: [file] });
      setStatus('TXT-Datei wurde zum Teilen übergeben.', 'success');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`TXT-Datei gespeichert. E-Mail-Adresse: ${EMAIL}`, 'success');
}

function openEmail() {
  const subject = `ITF-Scans (${scans.length})`;
  const body = `Erfasste ITF-Barcodes:\n\n${createTextFileContent(scans)}`;
  if (body.length > 1800) {
    setStatus('Für eine lange Liste bitte „TXT-Datei teilen“ verwenden.', 'warning');
    return;
  }
  location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function closeManualPanel() {
  elements.manualPanel.classList.add('hidden');
  elements.manualOpen.classList.remove('hidden');
  elements.manualCode.value = '';
  elements.manualCode.removeAttribute('aria-invalid');
  elements.manualError.classList.add('hidden');
  elements.manualCount.textContent = '0/10';
}

function showManualError(message) {
  elements.manualError.textContent = message;
  elements.manualError.classList.remove('hidden');
  elements.manualCode.setAttribute('aria-invalid', 'true');
  elements.manualCode.focus();
}

function openManualPanel() {
  if (scannerActive) stopScanner();
  elements.manualOpen.classList.add('hidden');
  elements.manualPanel.classList.remove('hidden');
  elements.manualError.classList.add('hidden');
  elements.manualCode.removeAttribute('aria-invalid');
  elements.manualPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => elements.manualCode.focus(), 150);
}

function submitManualCode(event) {
  event.preventDefault();
  const code = elements.manualCode.value;
  if (!isValidManualCode(code)) {
    showManualError('Bitte genau 10 Ziffern eingeben.');
    return;
  }
  const result = storeCode(code, 'manual');
  if (result.status === 'duplicate') {
    showManualError('Diese Nummer wurde bereits erfasst.');
    return;
  }
  closeManualPanel();
}

elements.start.addEventListener('click', startScanner);
elements.stop.addEventListener('click', stopScanner);
elements.manualOpen.addEventListener('click', openManualPanel);
elements.manualCancel.addEventListener('click', closeManualPanel);
elements.manualForm.addEventListener('submit', submitManualCode);
elements.manualCode.addEventListener('input', () => {
  const digits = elements.manualCode.value.replace(/\D/g, '').slice(0, 10);
  if (elements.manualCode.value !== digits) elements.manualCode.value = digits;
  elements.manualCount.textContent = `${digits.length}/10`;
  elements.manualCode.removeAttribute('aria-invalid');
  elements.manualError.classList.add('hidden');
});
elements.undo.addEventListener('click', () => {
  if (!scans.length) return;
  const removed = scans.at(-1).code;
  scans = scans.slice(0, -1).map((scan, index) => ({ ...scan, number: index + 1 }));
  saveAndRender();
  setStatus(`Gelöscht: ${removed}`, 'neutral');
});
elements.reset.addEventListener('click', () => {
  if (!scans.length || !confirm('Wirklich alle erfassten Nummern löschen?')) return;
  scans = [];
  saveAndRender();
  setStatus('Liste wurde vollständig gelöscht.', 'neutral');
});
elements.finish.addEventListener('click', () => {
  stopScanner();
  elements.panel.classList.remove('hidden');
  elements.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
elements.email.addEventListener('click', openEmail);
elements.share.addEventListener('click', shareTextFile);
elements.continue.addEventListener('click', () => {
  elements.panel.classList.add('hidden');
  startScanner();
});
window.addEventListener('orientationchange', scheduleCameraOrientationUpdate);
window.addEventListener('resize', scheduleCameraOrientationUpdate);
screen.orientation?.addEventListener?.('change', scheduleCameraOrientationUpdate);

saveAndRender();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

window.__ITF_TEST__ = { handleDetectedCode, getScans: () => scans.map((scan) => ({ ...scan })) };
