import assert from 'node:assert/strict';

async function setRange(frame, id, value) {
  await frame.locator(id).fill(String(value));
}

async function point(marker) {
  const coordinates = await marker.evaluate(element => ['cx', 'cy'].map(name => {
    const value = element.getAttribute(name);
    return value?.trim() ? Number(value) : NaN;
  }));
  assert.ok(coordinates.every(Number.isFinite), 'Expected numeric circle coordinates');
  return coordinates;
}

function near(actual, expected, tolerance = 1) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${expected} ± ${tolerance}, got ${actual}`);
}

export const fixtures = {
  bezier: {
    brief: `Teach cubic Bézier curves through repeated linear interpolation. Use SVG
with viewBox 0 0 640 320. Start with control points [48,265], [168,42],
[466,42], [592,265]. Make all four points draggable and keyboard-accessible.
Show the curve, control polygon, and the two levels of intermediate
segments. Give the SVG id="plot", the four control circles a parent with
id="handles", the interpolated point circle id="curve-point", the two
intermediate paths ids "level-one" and "level-two", and the labeled range
input id="parameter", with min=0, max=1 and step=0.01.`,
    async check(frame, page) {
      const handles = frame.locator('#handles circle');
      const marker = frame.locator('#curve-point');
      assert.equal(await handles.count(), 4);
      for (const [t, expected] of [[0, [48, 265]], [0.5, [317.75, 97.75]], [1, [592, 265]]]) {
        await setRange(frame, '#parameter', t);
        (await point(marker)).forEach((value, i) => near(value, expected[i]));
      }
      await setRange(frame, '#parameter', 0.5);
      for (const id of ['level-one', 'level-two']) {
        assert.ok(await frame.locator('#' + id).getAttribute('d'), `Expected an interpolation path for ${id}`);
      }
      const handle = handles.nth(1);
      const original = await point(handle);
      const midpoint = await point(marker);
      await handle.press('ArrowRight');
      const moved = await point(handle);
      assert.ok(moved[0] > original[0], 'ArrowRight should move the control point');
      near((await point(marker))[0], midpoint[0] + (moved[0] - original[0]) * 0.375, 0.1);

      const box = await handle.boundingBox();
      assert.ok(box, 'Expected a visible draggable point');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 35, y + 20, { steps: 4 });
      await page.mouse.up();
      assert.ok((await point(handle))[0] > moved[0], 'Pointer drag should move the control point');
      near((await point(marker))[0], midpoint[0] + ((await point(handle))[0] - original[0]) * 0.375, 0.1);
    },
  },
  spring: {
    brief: `Teach how stiffness and mass affect a spring–mass oscillator. Show
an animated mass attached to a spring, labeled sliders for stiffness and mass,
and a visible numeric frequency output in Hz. Use id="stiffness" for a range
input from 4 to 32 (step 1), id="mass" for a range input from 1 to 8 (step 1),
and id="frequency" for the numeric output (at least three decimal places).
Honor reduced motion by displaying a static diagram.`,
    async check(frame) {
      for (const [stiffness, mass] of [[8, 2], [16, 2], [8, 4]]) {
        await setRange(frame, '#stiffness', stiffness);
        await setRange(frame, '#mass', mass);
        const frequency = await frame.locator('#frequency').innerText();
        near(parseFloat(frequency), Math.sqrt(stiffness / mass) / (2 * Math.PI), 0.002);
      }
    },
  },
};
