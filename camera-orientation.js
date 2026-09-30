export function cameraCounterTransform(angle, width, height) {
  const normalized = ((Number(angle || 0) + 180) % 360 + 360) % 360 - 180;
  const quarterTurn = Math.abs(normalized) === 90;
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  return {
    rotation: normalized === 0 ? 0 : -normalized,
    scale: quarterTurn ? Math.max(safeWidth / safeHeight, safeHeight / safeWidth) : 1
  };
}

export async function requestPortraitLock(orientation) {
  if (!orientation || typeof orientation.lock !== 'function') return false;
  try {
    await orientation.lock('portrait-primary');
    return true;
  } catch {
    return false;
  }
}
