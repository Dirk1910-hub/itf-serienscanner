export function rotateCanvasQuarterTurn(sourceCanvas, targetCanvas = document.createElement('canvas')) {
  targetCanvas.width = sourceCanvas.height;
  targetCanvas.height = sourceCanvas.width;
  const context = targetCanvas.getContext('2d', { alpha: false });
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  context.translate(targetCanvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(sourceCanvas, 0, 0);
  return targetCanvas;
}

export function decodeCanvasBothOrientations(
  reader,
  sourceCanvas,
  rotatedCanvas,
  rotate = rotateCanvasQuarterTurn
) {
  try {
    return reader.decodeFromCanvas(sourceCanvas);
  } catch {
    return reader.decodeFromCanvas(rotate(sourceCanvas, rotatedCanvas));
  }
}

export function cropCanvasCenter(sourceCanvas, targetCanvas = document.createElement('canvas')) {
  const cropWidth = Math.max(1, Math.round(sourceCanvas.width * 0.94));
  const cropHeight = Math.max(1, Math.round(sourceCanvas.height * 0.62));
  const sourceX = Math.round((sourceCanvas.width - cropWidth) / 2);
  const sourceY = Math.round((sourceCanvas.height - cropHeight) / 2);
  targetCanvas.width = cropWidth;
  targetCanvas.height = cropHeight;
  const context = targetCanvas.getContext('2d', { alpha: false });
  context.drawImage(sourceCanvas, sourceX, sourceY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return targetCanvas;
}

export function decodeFrameCandidates(
  reader,
  fullCanvas,
  rotatedFullCanvas,
  cropCanvas,
  rotatedCropCanvas,
  crop = cropCanvasCenter,
  decodeBoth = decodeCanvasBothOrientations
) {
  try {
    return decodeBoth(reader, crop(fullCanvas, cropCanvas), rotatedCropCanvas);
  } catch {
    return decodeBoth(reader, fullCanvas, rotatedFullCanvas);
  }
}
