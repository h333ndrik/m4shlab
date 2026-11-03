const MAX_TARGET_LONG_SIDE = 720;

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function capNormalizationDimensions(width, height, maxLongSide = MAX_TARGET_LONG_SIDE) {
  const safeWidth = Math.max(2, Number(width) || 0);
  const safeHeight = Math.max(2, Number(height) || 0);
  const scale = Math.min(1, maxLongSide / Math.max(safeWidth, safeHeight));
  return {
    width: even(safeWidth * scale),
    height: even(safeHeight * scale),
  };
}

export { MAX_TARGET_LONG_SIDE };
