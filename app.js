import { addScan, createTextFileContent, isValidManualCode, isValidScannedCode } from './scanner-state.js?v=13';
import { decodeFrameCandidates } from './frame-decoder.js?v=13';
import { playSound, unlockSound } from './audio-feedback.js?v=13';
import { cameraCounterTransform, requestPortraitLock } from './camera-orientation.js?v=13';
import { assessCoverage, calculateDailyDeliveries, groupWeeklyDeliveries, inheritPlanSettings, validateDeliveryInput } from './delivery-plan.js?v=13';

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
  tabs: $('#plan-tabs'), panels: $('#delivery-plan-panels'), errors: $('#delivery-errors'),
  results: $('#delivery-results'), resultList: $('#delivery-result-list'), share: $('#export-excel'), download: $('#download-excel'),
  reset: $('#reset-delivery'), shareStatus: $('#delivery-share-status')
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
let currentDeliveries = [];

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

const PLAN_SETTING_FIELDS = ['modelmaster', 'designation', 'press', 'material', 'shortage', 'partKonti', 'grossPerDay', 'leadTimeDays', 'yieldPercent'];

function planPanelMarkup(number) {
  const optionalControls = number === 1 ? '' : `
    <div class="plan-options">
      <label class="option-check" for="active-${number}">
        <input id="active-${number}" data-role="active" type="checkbox">
        <span class="option-copy"><strong>Lieferplan ${number} verwenden</strong><small>Aktivieren, um diesen Zeitraum mitzurechnen</small></span>
        <span class="toggle-state" data-role="active-state">Aus</span>
      </label>
      <label class="option-check" for="inherit-${number}">
        <input id="inherit-${number}" data-role="inherit" type="checkbox" disabled>
        <span class="option-copy"><strong>Einstellungen aus Plan 1 übernehmen</strong><small>Alle Angaben außer Start- und Enddatum</small></span>
        <span class="toggle-state" data-role="inherit-state">Aus</span>
      </label>
    </div>`;
  return `
    <section class="plan-panel${number === 1 ? '' : ' hidden'}" data-plan="${number}" role="tabpanel" aria-label="Lieferplan ${number}">
      <div class="plan-panel-title"><span>Lieferplan ${number}</span><small>${number === 1 ? 'Pflichtplan' : 'optional'}</small></div>
      ${optionalControls}
      <div class="plan-fields">
        <label for="modelmaster-${number}">Modelmaster <span>7-stellig, Buchstaben und Ziffern</span></label>
        <input id="modelmaster-${number}" data-field="modelmaster" type="text" maxlength="7" autocapitalize="characters" autocomplete="off" placeholder="A1B2C3D">
        <label for="designation-${number}">Bezeichnung <span>Name oder Kollektion des Artikels</span></label>
        <input id="designation-${number}" data-field="designation" type="text" maxlength="60" autocomplete="off" placeholder="z. B. Nova 2026">
        <div class="form-grid two">
          <div><label for="press-${number}">Presse <span>4-stellig, alphanumerisch</span></label><input id="press-${number}" data-field="press" type="text" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="DG08"></div>
          <div><label for="material-${number}">Werkstoff</label><select id="material-${number}" data-field="material"><option value="TitanCerm">TitanCerm</option><option value="Vilboplus">Vilboplus</option></select></div>
        </div>
        <label for="shortage-${number}">Fehlmenge <span>optional, nur Zahlen mit maximal 6 Stellen</span></label>
        <input id="shortage-${number}" data-field="shortage" type="text" inputmode="numeric" autocomplete="off" placeholder="z. B. 2500">
        <label class="option-check" for="part-konti-${number}">
          <input id="part-konti-${number}" data-field="partKonti" type="checkbox">
          <span class="option-copy"><strong>Teilkonti</strong><small>Ein: Samstag und Sonntag keine Produktion</small></span>
          <span class="toggle-state" data-role="part-konti-state">Aus</span>
        </label>
        <div class="form-grid two">
          <div><label for="start-date-${number}">Startdatum Einguss</label><input id="start-date-${number}" data-field="startDate" type="date"></div>
          <div><label for="end-date-${number}">Enddatum Einguss</label><input id="end-date-${number}" data-field="endDate" type="date"></div>
        </div>
        <div class="form-grid two">
          <div><label for="gross-day-${number}">Brutto pro Tag</label><input id="gross-day-${number}" data-field="grossPerDay" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="100"></div>
          <div><label for="lead-time-${number}">Durchlaufzeit in Tagen</label><input id="lead-time-${number}" data-field="leadTimeDays" type="number" inputmode="numeric" min="0" step="1" placeholder="7"></div>
        </div>
        <label for="yield-percent-${number}">Yield in %</label>
        <input id="yield-percent-${number}" data-field="yieldPercent" type="number" inputmode="decimal" min="0.01" max="100" step="0.01" placeholder="80">
      </div>
    </section>`;
}

function planPanel(number) {
  return deliveryElements.panels.querySelector(`[data-plan="${number}"]`);
}

function planField(number, name) {
  return planPanel(number).querySelector(`[data-field="${name}"]`);
}

function readPlanInput(number) {
  const shortageValue = planField(number, 'shortage').value;
  const activeInput = planPanel(number).querySelector('[data-role="active"]');
  return {
    active: number === 1 || Boolean(activeInput?.checked),
    modelmaster: planField(number, 'modelmaster').value.toUpperCase(),
    designation: planField(number, 'designation').value.trim(),
    press: planField(number, 'press').value.toUpperCase(),
    material: planField(number, 'material').value,
    shortage: shortageValue === '' ? null : Number(shortageValue),
    partKonti: planField(number, 'partKonti').checked,
    startDate: planField(number, 'startDate').value,
    endDate: planField(number, 'endDate').value,
    grossPerDay: Number(planField(number, 'grossPerDay').value),
    leadTimeDays: Number(planField(number, 'leadTimeDays').value),
    yieldPercent: Number(planField(number, 'yieldPercent').value)
  };
}

function writePlanInput(number, input) {
  for (const name of ['modelmaster', 'designation', 'press', 'material', 'startDate', 'endDate', 'grossPerDay', 'leadTimeDays', 'yieldPercent']) {
    planField(number, name).value = input[name] ?? '';
  }
  planField(number, 'shortage').value = input.shortage ?? '';
  planField(number, 'partKonti').checked = Boolean(input.partKonti);
  const activeInput = planPanel(number).querySelector('[data-role="active"]');
  if (activeInput) activeInput.checked = Boolean(input.active);
  updatePartKontiState(number);
}

function updatePartKontiState(number) {
  planPanel(number).querySelector('[data-role="part-konti-state"]').textContent = planField(number, 'partKonti').checked ? 'Ein' : 'Aus';
}

function syncInheritedPlan(number) {
  writePlanInput(number, inheritPlanSettings(readPlanInput(1), readPlanInput(number)));
}

function updatePlanAvailability(number) {
  if (number === 1) return;
  const panel = planPanel(number);
  const active = panel.querySelector('[data-role="active"]').checked;
  const inheritInput = panel.querySelector('[data-role="inherit"]');
  const inherited = active && inheritInput.checked;
  panel.querySelector('[data-role="active-state"]').textContent = active ? 'Ein' : 'Aus';
  panel.querySelector('[data-role="inherit-state"]').textContent = inherited ? 'Ein' : 'Aus';
  inheritInput.disabled = !active;
  for (const control of panel.querySelectorAll('.plan-fields input, .plan-fields select')) control.disabled = !active;
  if (active && inherited) {
    syncInheritedPlan(number);
    for (const name of PLAN_SETTING_FIELDS) planField(number, name).disabled = true;
  }
  panel.classList.toggle('plan-disabled', !active);
}

function showPlanTab(number) {
  for (const panel of deliveryElements.panels.querySelectorAll('.plan-panel')) panel.classList.toggle('hidden', Number(panel.dataset.plan) !== number);
  for (const tab of deliveryElements.tabs.querySelectorAll('.plan-tab')) {
    const selected = Number(tab.dataset.planTab) === number;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
}

function initializeDeliveryPlans() {
  deliveryElements.panels.innerHTML = [1, 2, 3].map(planPanelMarkup).join('');
  updatePlanAvailability(2);
  updatePlanAvailability(3);
  showPlanTab(1);
}

initializeDeliveryPlans();

function coverageMessage(coverage) {
  const number = (value) => value.toLocaleString('de-DE');
  if (coverage.status === 'not-provided') return 'Keine Fehlmenge angegeben – es wird nur die Gesamtsumme ausgewiesen.';
  if (coverage.status === 'exact') return 'Fehlmenge exakt abgedeckt. Es sind weder zusätzliche noch weniger Produktionstage erforderlich.';
  if (coverage.status === 'shortfall') {
    return `Nicht abgedeckt: Es fehlen ${number(-coverage.difference)} Teile. Mindestens ${coverage.additionalDays} zusätzliche${coverage.additionalDays === 1 ? 'r Produktionstag' : ' Produktionstage'} mit zusammen ${number(coverage.projectedTotal - coverage.totalNet)} Teilen ${coverage.additionalDays === 1 ? 'ist' : 'sind'} nötig. Danach beträgt der Lagereingang ${number(coverage.projectedTotal)} Teile und übersteigt die Fehlmenge um ${number(coverage.projectedSurplus)} Teile.`;
  }
  const reduction = coverage.reducibleDays > 0
    ? `Der Plan kann um bis zu ${coverage.reducibleDays} volle${coverage.reducibleDays === 1 ? 'n Produktionstag' : ' Produktionstage'} verkürzt werden. Danach verbleiben ${number(coverage.remainingTotal)} Teile Lagereingang.`
    : 'Ein voller Produktionstag kann nicht entfallen, ohne die Fehlmenge zu unterschreiten.';
  return `Fehlmenge abgedeckt: Der Lagereingang übersteigt sie um ${number(coverage.difference)} Teile. ${reduction}`;
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

function renderDeliveryResults(plans) {
  deliveryElements.resultList.replaceChildren();
  for (const plan of plans) {
    const card = document.createElement('article');
    card.className = 'plan-result';
    card.dataset.resultPlan = String(plan.planNumber);

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const title = document.createElement('h3');
    title.textContent = `Lieferplan ${plan.planNumber}`;
    const badge = document.createElement('strong');
    badge.className = 'model-badge';
    badge.textContent = plan.input.modelmaster;
    heading.append(title, badge);

    const meta = document.createElement('p');
    meta.className = 'result-meta';
    meta.textContent = `${plan.input.designation} · Presse ${plan.input.press} · ${plan.input.material} · Teilkonti ${plan.input.partKonti ? 'ein' : 'aus'} · ${formatGermanDate(plan.input.startDate)}–${formatGermanDate(plan.input.endDate)}`;

    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-wrap';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>KW</th><th>Freitag</th><th>Netto</th></tr></thead>';
    const tableBody = document.createElement('tbody');
    for (const row of plan.weekly) {
      const tableRow = document.createElement('tr');
      for (const value of [`KW ${row.calendarWeek}`, formatGermanDate(row.fridayDate), row.netTotal.toLocaleString('de-DE')]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        tableRow.append(cell);
      }
      tableBody.append(tableRow);
    }
    table.append(tableBody);
    tableWrap.append(table);

    const coverage = document.createElement('div');
    coverage.className = 'coverage-summary';
    const total = document.createElement('p');
    total.append(document.createTextNode('Komplette Summe Lagereingang '));
    const totalValue = document.createElement('strong');
    totalValue.textContent = `${plan.coverage.totalNet.toLocaleString('de-DE')} Teile`;
    total.append(totalValue);
    const status = document.createElement('p');
    status.className = `coverage-status ${plan.coverage.status}`;
    status.textContent = coverageMessage(plan.coverage);
    coverage.append(total, status);

    card.append(heading, meta, tableWrap, coverage);
    deliveryElements.resultList.append(card);
  }
  deliveryElements.results.classList.remove('hidden');
  deliveryElements.shareStatus.innerHTML = `Beim Teilen kannst du „Mail“ auswählen. Empfänger: <span class="email">${EMAIL}</span>`;
  deliveryElements.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function makeDeliveryExcelFile() {
  if (!currentDeliveries.length || !window.XLSX) return null;
  const summaryRows = [];
  for (const plan of currentDeliveries) {
    const { input, weekly, coverage, planNumber } = plan;
    summaryRows.push(
      [`Lieferplan ${planNumber}`, input.modelmaster],
      ['Bezeichnung', input.designation],
      ['Presse', input.press],
      ['Werkstoff', input.material],
      ['Teilkonti', input.partKonti ? 'Ein – Samstag/Sonntag keine Produktion' : 'Aus – Produktion an allen Kalendertagen'],
      ['Startdatum Einguss', formatGermanDate(input.startDate)],
      ['Enddatum Einguss', formatGermanDate(input.endDate)],
      ['Brutto pro Tag', input.grossPerDay],
      ['Durchlaufzeit in Tagen', input.leadTimeDays],
      ['Yield in %', input.yieldPercent],
      ['Fehlmenge', input.shortage === null ? 'nicht angegeben' : input.shortage],
      ['Komplette Summe Lagereingang', coverage.totalNet],
      ['Deckungsprüfung', coverageMessage(coverage)],
      [],
      ['Plan', 'Modelmaster', 'Bezeichnung', 'Presse', 'Werkstoff', 'Kalenderwoche', 'Freitag', 'Netto-Lagereingang'],
      ...weekly.map((row) => [planNumber, row.modelmaster, input.designation, input.press, input.material, row.calendarWeek, formatGermanDate(row.fridayDate), row.netTotal]),
      []
    );
  }
  const detailRows = [
    ['Plan', 'Modelmaster', 'Bezeichnung', 'Presse', 'Werkstoff', 'Teilkonti', 'Eingussdatum', 'Brutto', 'Netto', 'Lagereingang'],
    ...currentDeliveries.flatMap(({ planNumber, input, daily }) => daily.map((row) => [
      planNumber, row.modelmaster, input.designation, input.press, input.material, input.partKonti ? 'Ein' : 'Aus',
      formatGermanDate(row.castingDate), row.gross, row.net, formatGermanDate(row.warehouseDate)
    ]))
  ];
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
  summarySheet['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 24 }, { wch: 12 }, { wch: 15 }, { wch: 17 }, { wch: 15 }, { wch: 22 }];
  detailSheet['!cols'] = [{ wch: 8 }, { wch: 16 }, { wch: 24 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 16 }, { wch: 13 }, { wch: 13 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Wochenpläne');
  XLSX.utils.book_append_sheet(workbook, detailSheet, 'Tageswerte');
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const filename = currentDeliveries.length === 1
    ? `Lieferplan-${currentDeliveries[0].input.modelmaster}.xlsx`
    : `Lieferplaene-${currentDeliveries.length}.xlsx`;
  return new File([bytes], filename, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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
      await navigator.share({ title: 'Lieferpläne', text: `Bitte an ${EMAIL} senden.`, files: [file] });
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
  if (ask && !confirm('Alle Lieferpläne und Eingaben wirklich zurücksetzen?')) return;
  deliveryElements.form.reset();
  currentDeliveries = [];
  showDeliveryErrors([]);
  deliveryElements.resultList.replaceChildren();
  deliveryElements.results.classList.add('hidden');
  updatePartKontiState(1);
  updatePlanAvailability(2);
  updatePlanAvailability(3);
  showPlanTab(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

deliveryElements.openScanner.addEventListener('click', () => showScreen(deliveryElements.scannerScreen));
deliveryElements.openDelivery.addEventListener('click', () => showScreen(deliveryElements.deliveryScreen));
document.querySelectorAll('[data-back-home]').forEach((button) => button.addEventListener('click', () => {
  if (scannerActive) stopScanner();
  showScreen(deliveryElements.startScreen);
}));
deliveryElements.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-plan-tab]');
  if (tab) showPlanTab(Number(tab.dataset.planTab));
});
deliveryElements.form.addEventListener('input', (event) => {
  const panel = event.target.closest('[data-plan]');
  if (!panel) return;
  const number = Number(panel.dataset.plan);
  const fieldName = event.target.dataset.field;
  if (fieldName === 'modelmaster') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
  if (fieldName === 'press') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (fieldName === 'shortage') event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
  if (number === 1) {
    for (const target of [2, 3]) {
      const inheritInput = planPanel(target).querySelector('[data-role="inherit"]');
      if (inheritInput.checked && !inheritInput.disabled) updatePlanAvailability(target);
    }
  }
});
deliveryElements.form.addEventListener('change', (event) => {
  const panel = event.target.closest('[data-plan]');
  if (!panel) return;
  const number = Number(panel.dataset.plan);
  if (event.target.matches('[data-role="active"], [data-role="inherit"]')) updatePlanAvailability(number);
  if (event.target.dataset.field === 'partKonti') updatePartKontiState(number);
  if (number === 1) {
    for (const target of [2, 3]) {
      const inheritInput = planPanel(target).querySelector('[data-role="inherit"]');
      if (inheritInput.checked && !inheritInput.disabled) updatePlanAvailability(target);
    }
  }
});
deliveryElements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const plans = [];
  const errors = [];
  let firstInvalidPlan = null;
  for (const planNumber of [1, 2, 3]) {
    const input = readPlanInput(planNumber);
    if (!input.active) continue;
    const planErrors = validateDeliveryInput(input);
    if (planErrors.length && firstInvalidPlan === null) firstInvalidPlan = planNumber;
    errors.push(...planErrors.map((error) => `Lieferplan ${planNumber}: ${error}`));
    plans.push({ planNumber, input });
  }
  showDeliveryErrors(errors);
  if (errors.length) {
    deliveryElements.results.classList.add('hidden');
    showPlanTab(firstInvalidPlan);
    return;
  }
  currentDeliveries = plans.map(({ planNumber, input }) => {
    const daily = calculateDailyDeliveries(input);
    return { planNumber, input, daily, weekly: groupWeeklyDeliveries(daily), coverage: assessCoverage(input, daily) };
  });
  renderDeliveryResults(currentDeliveries);
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
