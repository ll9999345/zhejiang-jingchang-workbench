// Pointer devices may publish more updates than the display can show. Keep
// the latest position and flush it before committing a drag to persistence.
export function canvasFrameQueue(apply, {
  request = callback => requestAnimationFrame(callback),
  cancel = id => cancelAnimationFrame(id),
} = {}) {
  let frame = null, latest = null;
  function flush() {
    if (frame !== null) cancel(frame);
    frame = null;
    const value = latest;
    latest = null;
    if (value !== null) apply(value);
  }
  return {
    push(value) {
      latest = value;
      if (frame === null) frame = request(flush);
    },
    flush,
    clear() {
      if (frame !== null) cancel(frame);
      frame = null;
      latest = null;
    },
  };
}
