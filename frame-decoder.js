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
