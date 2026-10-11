import { addScan, createTextFileContent, isValidManualCode, isValidScannedCode } from './scanner-state.js';
import { decodeFrameCandidates } from './frame-decoder.js';
import { playSound, unlockSound } from './audio-feedback.js';
import { cameraCounterTransform, requestPortraitLock } from './camera-orientation.js';
import { calculateDailyDeliveries, groupWeeklyDeliveries, validateDeliveryInput } from './delivery-plan.js';

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

const deliveryElements = {
  startScreen: $('#start-screen'), scannerScreen: $('#scanner-screen'), deliveryScreen: $('#delivery-screen'),
  openScanner: $('#open-scanner'), openDelivery: $('#open-delivery'), form: $('#delivery-form'),
  errors: $('#delivery-errors'), results: $('#delivery-results'), model: $('#result-model'), meta: $('#result-meta'),
  tableBody: $('#delivery-table-body'), share: $('#export-excel'), download: $('#download-excel'),
  reset: $('#reset-delivery'), shareStatus: $('#delivery-share-status'), modelInput: $('#modelmaster'), pressInput: $('#press')
};

let scans = loadScans();
let cameraStream = null;
let scanTimer = null;
let scannerActive = false;
let orientationLocked = false;
let frameReader = null;
const frameCanvas = document.createElement('canvas');
const rotatedCanvas = document.createElement('canvas');
const horizontalCropCanvas = document.createElement('canvas');
const rotatedHorizontalCropCanvas = document.createElement('canvas');
const verticalCropCanvas = document.createElement('canvas');
const rotatedVerticalCropCanvas = document.createElement('canvas');
let audioContext = null;
let blockedCode = null;
let lastDecodeAt = 0;
let currentDelivery = null;

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
  const code = String(rawCode);
  if (!isValidScannedCode(code) || code === blockedCode) return;
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
      const result = decodeFrameCandidates(
        frameReader, frameCanvas, rotatedCanvas,
        horizontalCropCanvas, rotatedHorizontalCropCanvas,
        verticalCropCanvas, rotatedVerticalCropCanvas
      );
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
    frameReader.hints?.set?.(3, true);
    frameReader.hints?.set?.(5, Int32Array.from([10]));
    frameReader.setHints?.(frameReader.hints);
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

function formatGermanDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function showScreen(screen) {
  for (const item of [deliveryElements.startScreen, deliveryElements.scannerScreen, deliveryElements.deliveryScreen]) {
    item.classList.toggle('hidden', item !== screen);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function readDeliveryInput() {
  const data = new FormData(deliveryElements.form);
  return {
    modelmaster: String(data.get('modelmaster') || '').toUpperCase(),
    designation: String(data.get('designation') || '').trim(),
    press: String(data.get('press') || '').toUpperCase(),
    material: String(data.get('material') || ''),
    startDate: String(data.get('startDate') || ''),
    endDate: String(data.get('endDate') || ''),
    grossPerDay: Number(data.get('grossPerDay')),
    leadTimeDays: Number(data.get('leadTimeDays')),
    yieldPercent: Number(data.get('yieldPercent'))
  };
}

function showDeliveryErrors(errors) {
  deliveryElements.errors.replaceChildren();
  if (!errors.length) {
    deliveryElements.errors.classList.add('hidden');
    return;
  }
  const list = document.createElement('ul');
  for (const error of errors) {
    const item = document.createElement('li');
    item.textContent = error;
    list.append(item);
  }
  deliveryElements.errors.append(list);
  deliveryElements.errors.classList.remove('hidden');
}

function renderDeliveryResults(plan) {
  deliveryElements.model.textContent = plan.input.modelmaster;
  deliveryElements.meta.textContent = `${plan.input.designation} · Presse ${plan.input.press} · ${plan.input.material}`;
  deliveryElements.tableBody.replaceChildren();
  for (const row of plan.weekly) {
    const tableRow = document.createElement('tr');
    for (const value of [`KW ${row.calendarWeek}`, formatGermanDate(row.fridayDate), row.netTotal.toLocaleString('de-DE')]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tableRow.append(cell);
    }
    deliveryElements.tableBody.append(tableRow);
  }
  deliveryElements.results.classList.remove('hidden');
  deliveryElements.shareStatus.innerHTML = `Beim Teilen kannst du „Mail“ auswählen. Empfänger: <span class="email">${EMAIL}</span>`;
  deliveryElements.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function makeDeliveryExcelFile() {
  if (!currentDelivery || !window.XLSX) return null;
  const { input, daily, weekly } = currentDelivery;
  const summaryRows = [
    ['Lieferplan', input.modelmaster],
    ['Bezeichnung', input.designation],
    ['Presse', input.press],
    ['Werkstoff', input.material],
    ['Startdatum Einguss', formatGermanDate(input.startDate)],
    ['Enddatum Einguss', formatGermanDate(input.endDate)],
    ['Brutto pro Tag', input.grossPerDay],
    ['Durchlaufzeit in Tagen', input.leadTimeDays],
    ['Yield in %', input.yieldPercent],
    [],
    ['Modelmaster', 'Bezeichnung', 'Presse', 'Werkstoff', 'Kalenderwoche', 'Freitag', 'Netto-Lagereingang'],
    ...weekly.map((row) => [row.modelmaster, input.designation, input.press, input.material, row.calendarWeek, formatGermanDate(row.fridayDate), row.netTotal])
  ];
  const detailRows = [
    ['Modelmaster', 'Bezeichnung', 'Presse', 'Werkstoff', 'Eingussdatum', 'Brutto', 'Netto', 'Lagereingang'],
    ...daily.map((row) => [row.modelmaster, input.designation, input.press, input.material, formatGermanDate(row.castingDate), row.gross, row.net, formatGermanDate(row.warehouseDate)])
  ];
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
  summarySheet['!cols'] = [{ wch: 18 }, { wch: 24 }, { wch: 12 }, { wch: 15 }, { wch: 17 }, { wch: 15 }, { wch: 22 }];
  detailSheet['!cols'] = [{ wch: 16 }, { wch: 24 }, { wch: 12 }, { wch: 15 }, { wch: 16 }, { wch: 13 }, { wch: 13 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Wochenplan');
  XLSX.utils.book_append_sheet(workbook, detailSheet, 'Tageswerte');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new File([bytes], `Lieferplan-${input.modelmaster}.xlsx`, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

function downloadDeliveryExcel() {
  const file = makeDeliveryExcelFile();
  if (!file) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  deliveryElements.shareStatus.textContent = 'Excel-Datei wurde heruntergeladen.';
}

async function shareDeliveryExcel() {
  const file = makeDeliveryExcelFile();
  if (!file) return;
  try { await navigator.clipboard?.writeText(EMAIL); } catch { /* Teilen funktioniert auch ohne Zwischenablage. */ }
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ title: `Lieferplan ${currentDelivery.input.modelmaster}`, text: `Bitte an ${EMAIL} senden.`, files: [file] });
      deliveryElements.shareStatus.textContent = 'Excel-Datei wurde zum Teilen übergeben.';
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  downloadDeliveryExcel();
  deliveryElements.shareStatus.textContent = `Excel-Datei gespeichert. Bitte per E-Mail an ${EMAIL} senden.`;
}

function resetDeliveryPlan(ask = true) {
  if (ask && !confirm('Lieferplan und alle Eingaben wirklich zurücksetzen?')) return;
  deliveryElements.form.reset();
  currentDelivery = null;
  showDeliveryErrors([]);
  deliveryElements.tableBody.replaceChildren();
  deliveryElements.results.classList.add('hidden');
  deliveryElements.model.textContent = '';
  deliveryElements.meta.textContent = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

deliveryElements.openScanner.addEventListener('click', () => showScreen(deliveryElements.scannerScreen));
deliveryElements.openDelivery.addEventListener('click', () => showScreen(deliveryElements.deliveryScreen));
document.querySelectorAll('[data-back-home]').forEach((button) => button.addEventListener('click', () => {
  if (scannerActive) stopScanner();
  showScreen(deliveryElements.startScreen);
}));
deliveryElements.modelInput.addEventListener('input', () => {
  deliveryElements.modelInput.value = deliveryElements.modelInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
});
deliveryElements.pressInput.addEventListener('input', () => {
  deliveryElements.pressInput.value = deliveryElements.pressInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});
deliveryElements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = readDeliveryInput();
  const errors = validateDeliveryInput(input);
  showDeliveryErrors(errors);
  if (errors.length) {
    deliveryElements.results.classList.add('hidden');
    return;
  }
  const daily = calculateDailyDeliveries(input);
  currentDelivery = { input, daily, weekly: groupWeeklyDeliveries(daily) };
  renderDeliveryResults(currentDelivery);
});
deliveryElements.share.addEventListener('click', shareDeliveryExcel);
deliveryElements.download.addEventListener('click', downloadDeliveryExcel);
deliveryElements.reset.addEventListener('click', () => resetDeliveryPlan(true));

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
