function bindVerticalPointDrag(plot, handles, values, units, draw) {
  const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
  let drag;
  let engaged = false;

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

  function pointerY(event) {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(plot.getScreenCTM().inverse()).y;
  }

  handles.forEach((handle, index) => {
    handle.addEventListener('touchstart', (event) => {
      // Keep a drag within this frame from scrolling the containing page.
      event.preventDefault();
    }, { passive: false });
    handle.addEventListener('pointerdown', (event) => {
      if (drag || event.button !== 0) return;
      handle.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, startY: pointerY(event), value: values[index] };
    });
    handle.addEventListener('pointermove', (event) => {
      if (drag?.id !== event.pointerId) return;
      move(index, drag.value + (drag.startY - pointerY(event)) / units);
    });
    handle.addEventListener('lostpointercapture', (event) => {
      if (drag?.id === event.pointerId) drag = undefined;
    });
    handle.addEventListener('keydown', (event) => {
      const destinations = { Home: 0, End: 10 };
      const next = destinations[event.key] ?? values[index] + steps[event.key];
      if (!Number.isFinite(next)) return;
      event.preventDefault();
      move(index, next);
    });
  });
}
