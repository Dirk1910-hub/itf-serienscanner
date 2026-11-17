export const SOUND_SLOT_COUNT = 10;
export const MAX_SOUND_BYTES = 15 * 1024 * 1024;
const DB_NAME = 'produktionshelfer-soundboard';
const STORE_NAME = 'sounds';

export function normalizeSoundLabel(value, id) {
  const label = String(value || '').trim().slice(0, 30);
  return label || `Sound ${id}`;
}

export function validateSoundBlob(blob) {
  const type = typeof blob?.type === 'string' ? blob.type.toLowerCase() : '';
  const name = typeof blob?.name === 'string' ? blob.name.toLowerCase() : '';
  const audioExtension = /\.(mp3|wav|m4a|aac|ogg|oga|opus|webm|flac)$/i.test(name);
  const genericType = type === '' || type === 'application/octet-stream';
  if (!blob || (!type.startsWith('audio/') && !(genericType && audioExtension))) {
    return { valid: false, error: 'Bitte eine Audiodatei auswählen oder einen Sound aufnehmen.' };
  }
  if (!(Number(blob.size) > 0)) {
    return { valid: false, error: 'Die Audiodatei ist leer.' };
  }
  if (Number(blob.size) > MAX_SOUND_BYTES) {
    return { valid: false, error: 'Der Sound darf höchstens 15 MB groß sein.' };
  }
  return { valid: true, error: '' };
}

export function createSoundSlots(records = []) {
  const byId = new Map(records
    .filter((record) => Number.isInteger(record?.id) && record.id >= 1 && record.id <= SOUND_SLOT_COUNT)
    .map((record) => [record.id, record]));
  return Array.from({ length: SOUND_SLOT_COUNT }, (_, index) => {
    const id = index + 1;
    const record = byId.get(id);
    const blob = record?.blob;
    return {
      id,
      label: normalizeSoundLabel(record?.label, id),
      blob: blob || null,
      hasAudio: Boolean(blob && Number(blob.size) > 0)
    };
  });
}

function openSoundDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(mode, operation) {
  return openSoundDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => {
      database.close();
      reject(transaction.error);
    };
  }));
}

export function loadSoundRecords() {
  return runTransaction('readonly', (store) => store.getAll());
}

export function saveSoundRecord(record) {
  const normalized = {
    id: Number(record.id),
    label: normalizeSoundLabel(record.label, Number(record.id)),
    blob: record.blob
  };
  const validation = validateSoundBlob(normalized.blob);
  if (!validation.valid) return Promise.reject(new Error(validation.error));
  return runTransaction('readwrite', (store) => store.put(normalized)).then(() => normalized);
}

export function deleteSoundRecord(id) {
  return runTransaction('readwrite', (store) => store.delete(Number(id)));
}

export function clearSoundRecords() {
  return runTransaction('readwrite', (store) => store.clear());
}
