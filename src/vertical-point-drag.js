/**
 * @param {SVGSVGElement} plot
 * @param {NodeListOf<SVGGElement>} handles
 * @param {number[]} values
 * @param {number} units
 * @param {() => void} draw
 */
function bindVerticalPointDrag(plot, handles, values, units, draw) {
  /** @type {Partial<Record<string, number>>} */
  const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
  /** @type {Partial<Record<string, number>>} */
  const destinations = { Home: 0, End: 10 };
  /** @type {{ id: number, startY: number, value: number } | undefined} */
  let drag;
  let engaged = false;

  /**
   * @param {number} index
   * @param {number} value
   */
  function move(index, value) {
    const next = Math.max(0, Math.min(10, Math.round(value)));
    if (values[index] === next) return;
    values[index] = next;
    draw();
    if (!engaged) {
      engaged = true;
      parent.postMessage({ type: 'control-point-moved' }, '*');
    }
  }

  /** @param {PointerEvent} event */
  function pointerY(event) {
    const matrix = plot.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()).y : undefined;
  }

  handles.forEach((handle, index) => {
    handle.addEventListener('touchstart', (event) => {
      // Keep a drag within this frame from scrolling the containing page.
      event.preventDefault();
    }, { passive: false });
    handle.addEventListener('pointerdown', (event) => {
      if (drag || event.button !== 0) return;
      const startY = pointerY(event);
      if (startY === undefined) return;
      handle.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, startY, value: values[index] };
    });
    handle.addEventListener('pointermove', (event) => {
      if (drag?.id !== event.pointerId) return;
      const y = pointerY(event);
      if (y === undefined) return;
      move(index, drag.value + (drag.startY - y) / units);
    });
    handle.addEventListener('lostpointercapture', (event) => {
      if (drag?.id === event.pointerId) drag = undefined;
    });
    handle.addEventListener('keydown', (event) => {
      const next = destinations[event.key] ?? values[index] + (steps[event.key] ?? NaN);
      if (!Number.isFinite(next)) return;
      event.preventDefault();
      move(index, next);
    });
  });
}
