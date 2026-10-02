export function addScan(scans, rawCode) {
  const code = String(rawCode).trim();
  if (scans.some((scan) => scan.code === code)) {
    return { status: 'duplicate', scans };
  }
  return {
    status: 'added',
    scans: [...scans, { number: scans.length + 1, code }]
  };
}

export function createTextFileContent(scans) {
  return scans.map((scan) => scan.code).join('\n') + (scans.length ? '\n' : '');
}

export function isValidManualCode(value) {
  return /^\d{10}$/.test(String(value));
}
