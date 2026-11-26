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
  'roc-auc': {
    brief: `Teach binary-classifier evaluation with an SVG ROC curve and AUC.
Use a labeled select id="ranking" with options perfect, tied and reversed.
Use two positive and two negative examples with scores in [0, 1]. For
perfect use positive scores 0.9 and 0.8 and negative scores 0.2 and 0.1.
For tied give all examples 0.5. For reversed swap the labels from perfect.
Compute the ROC curve by sweeping distinct score thresholds, grouping
ties, and including both endpoints. Integrate in ascending FPR order.
Display the numeric AUC in id="auc" to at least three decimal places.
Use a labeled range id="threshold" from 0 to 1, step 0.01, to mark the
operating point for scores greater than or equal to the threshold. Give
that SVG circle id="operating-point" and explicit numeric cx and cy.
Keep the SVG plot coordinates fixed when the threshold changes.`,
    async check(frame) {
      const ranking = frame.locator('#ranking');
      const auc = frame.locator('#auc');
      const marker = frame.locator('#operating-point');
      for (const [name, expected] of [['tied', 0.5], ['reversed', 0], ['perfect', 1]]) {
        await ranking.selectOption(name);
        near(parseFloat(await auc.innerText()), expected, 0.002);
      }
      await setRange(frame, '#threshold', 1);
      const none = await point(marker);
      await setRange(frame, '#threshold', 0.5);
      const perfect = await point(marker);
      near(perfect[0], none[0], 0.1);
      assert.ok(perfect[1] < none[1], 'Lowering the threshold should raise TPR without raising FPR');
      near(parseFloat(await auc.innerText()), 1, 0.002);
      await setRange(frame, '#threshold', 0);
      const all = await point(marker);
      assert.ok(all[0] > perfect[0], 'Predicting all positives should raise FPR');
      near(all[1], perfect[1], 0.1);
      near(parseFloat(await auc.innerText()), 1, 0.002);
    },
  },
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
