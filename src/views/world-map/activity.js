import { geoCentroid, geoMercator, geoPath, select, zoom, zoomIdentity } from 'd3';
import { attempt, context, datasetPicker, history, historyReady, slot, target } from 'vizint';
import { computeCountryMaxDimension, computeGroupProjection, computeMapProjection,
  computeMarkerRadius, interpolateScale, toZoomTransform } from './projection.ts';
import { activityFor, nextExercise, replay } from './scheduler.mjs';

/**
 * @typedef {import('geojson').Feature<import('geojson').Geometry, { code: string, name: string }>} Country
 * @typedef {import('geojson').FeatureCollection<import('geojson').Geometry, { code: string, name: string }>} CountryMap
 * @typedef {import('./scheduler.mjs').Exercise} Exercise
 * @typedef {{
 *   type: string, country: string, zoom?: number, panIndex?: number, options?: string[],
 *   countries?: string[], groupKey?: string, misses: Set<string>, revealed: boolean,
 * }} Question
 */

/** @param {string} id */
const node = id => /** @type {HTMLElement} */ (document.getElementById(id));
const map = node('map');
const prompt = node('prompt');
const answers = node('answers');
const svg = select(map).append('svg').attr('aria-label', 'Interactive world map');
const land = svg.append('g');
const marker = land.append('circle').attr('fill', 'none').attr('stroke-width', 2)
  .attr('vector-effect', 'non-scaling-stroke').style('pointer-events', 'none');
const controls = {
  in: /** @type {HTMLButtonElement} */ (node('zoom-in')),
  out: /** @type {HTMLButtonElement} */ (node('zoom-out')),
  reset: /** @type {HTMLButtonElement} */ (node('reset')),
};
const highlight = '#3b82f6';
const success = '#22c55e';

// Learning targets: one fact per country, shared by every map that shows it.
const topic = target('topic', 'World Map');
const facts = new Map(context.targets.filter(record => record.kind === 'fact')
  .map(record => [/** @type {string} */ (record.id.split('/').at(-1)).toUpperCase(), record]));
const maps = slot('map');
node('toolbar').append(datasetPicker(maps));

/** @type {CountryMap | undefined} */
let geometry;
/** @type {Map<string, Country>} */
let features = new Map();
/** @type {import('./scheduler.mjs').Countries} */
let countries = {};
/** @type {import('./scheduler.mjs').Groups} */
let groups = {};
let mapName = 'map';
/** @type {import('d3').GeoProjection | undefined} */
let projection;
/** @type {Exercise | undefined} */
let exercise;
/** @type {Question | undefined} */
let question;
/** @type {string | undefined} */
let lastCountry;
/** @type {string | undefined} */
let groupKey;
/** @type {string | undefined} */
let selected;
/** @type {'correct' | 'wrong' | 'revealed' | undefined} */
let feedback;
let groupIndex = 0;
let groupCount = 0;
let generation = 0;
let advancing = false;
let initial = zoomIdentity;
let transform = zoomIdentity;
let maxScale = 8;
/** @type {string | undefined} */
let markerCode;
/** @type {import('d3').GeoProjection | undefined} */
let markerProjection;
/** @type {[number, number] | null} */
let markerPosition = null;
let markerDimension = 0;
let markerHidden = false;
/** @type {number | undefined} */
let drawnWidth;
/** @type {number | undefined} */
let drawnHeight;
let revealed = false;
let locked = false;
/** @type {Map<string, HTMLButtonElement>} */
let answerButtons = new Map();

/** @param {string} code */
const countryName = code => features.get(code)?.properties.name ?? code;

function markerStyle() {
  const shape = question && features.get(question.country);
  const show = shape && (question?.options || revealed);
  if (!show || !projection || !question) {
    marker.attr('display', 'none');
    return;
  }
  if (markerCode !== question.country || markerProjection !== projection) {
    markerCode = question.country;
    markerProjection = projection;
    markerPosition = projection(geoCentroid(shape));
    markerDimension = computeCountryMaxDimension(projection, shape);
    markerHidden = false;
  }
  const dimension = markerDimension * transform.k;
  if (dimension > 70) markerHidden = true;
  if (dimension < 50) markerHidden = false;
  if (!markerPosition) return;
  const [x, y] = markerPosition;
  const radius = computeMarkerRadius(map.clientWidth, map.clientHeight);
  marker.attr('cx', x).attr('cy', y).attr('r', radius / transform.k)
    .attr('display', markerHidden ? 'none' : null)
    .attr('stroke', feedback === 'correct' ? success : highlight);
}

const zoomBehavior = zoom().clickDistance(6).on('zoom', event => {
  transform = event.transform;
  land.attr('transform', transform.toString());
  controls.in.disabled = transform.k >= maxScale - 0.01;
  controls.out.disabled = transform.k <= 1.01;
  controls.reset.disabled = Math.abs(transform.k - initial.k) < 0.01
    && Math.abs(transform.x - initial.x) < 0.5 && Math.abs(transform.y - initial.y) < 0.5;
  markerStyle();
});
svg.call(/** @type {any} */ (zoomBehavior)).on('dblclick.zoom', null);
controls.in.onclick = () => svg.transition().duration(250).call(/** @type {any} */ (zoomBehavior.scaleBy), 1.5);
controls.out.onclick = () => svg.transition().duration(250).call(/** @type {any} */ (zoomBehavior.scaleBy), 1 / 1.5);
controls.reset.onclick = () => svg.transition().duration(250).call(/** @type {any} */ (zoomBehavior.transform), initial);

function fills() {
  land.selectAll('path').attr('fill', /** @param {any} feature */ feature => feature.properties.code === question?.country
    && (question?.options || revealed || feedback === 'correct')
    ? feedback === 'correct' && !question?.options ? success : highlight : '#e6e6e6');
  markerStyle();
}

function setInitial() {
  const width = map.clientWidth;
  const height = map.clientHeight;
  if (!width || !height || !projection || !question || !geometry) return;
  const view = { geoData: geometry, width, height, targetCountry: question.country,
    zoom: question.zoom, panIndex: question.panIndex };
  initial = question.countries
    ? toZoomTransform(projection, computeGroupProjection({ ...view, groupCountries: question.countries }))
    : toZoomTransform(projection, computeMapProjection(view));
  if (initial.k < 1) initial = zoomIdentity;
  maxScale = Math.max(8, initial.k * 3);
  zoomBehavior.scaleExtent([1, maxScale]).translateExtent([[0, 0], [width, height]]);
  svg.interrupt().call(/** @type {any} */ (zoomBehavior.transform), initial);
}

function draw() {
  const width = map.clientWidth;
  const height = map.clientHeight;
  if (!geometry || !width || !height || (width === drawnWidth && height === drawnHeight)) return;
  drawnWidth = width;
  drawnHeight = height;
  svg.attr('width', width).attr('height', height).style('background', '#dcefff');
  projection = geoMercator().fitSize([width, height], geometry);
  const path = geoPath(projection);
  land.selectAll('path').data(geometry.features, /** @param {any} feature */ feature => feature.properties.code)
    .join(enter => enter.insert('path', 'circle').attr('stroke', '#787878').attr('stroke-width', 0.65)
      .attr('vector-effect', 'non-scaling-stroke').on('click', (_, feature) => {
        if (question && !question.options) choose(feature.properties.code);
      })).attr('d', path);
  setInitial();
  fills();
}
new ResizeObserver(draw).observe(map);

function zoomToAnswer() {
  const shape = question && features.get(question.country);
  if (!projection || !shape) return;
  const width = map.clientWidth;
  const height = map.clientHeight;
  const scale = projection.scale();
  const fit = geoMercator().fitSize([width, height], shape).scale();
  const k = Math.min(maxScale, Math.max(1, interpolateScale(scale, fit, 1) / scale));
  const center = projection(geoCentroid(shape));
  if (!center) return;
  svg.transition().duration(250).call(/** @type {any} */ (zoomBehavior.transform),
    zoomIdentity.translate(width / 2 - k * center[0], height / 2 - k * center[1]).scale(k));
}

/** @param {string} label @param {() => void} action */
function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.onclick = action;
  answers.append(element);
  return element;
}

/** @param {'correct' | 'wrong' | 'revealed'} result */
function showFeedback(result) {
  if (!question) return;
  feedback = result;
  const first = /** @type {HTMLButtonElement | null} */ (answers.firstElementChild);
  if (result === 'revealed') {
    revealed = true;
    if (first) first.disabled = true;
    zoomToAnswer();
  }
  if (result === 'wrong' && !question.options) revealed = true;
  const choice = selected && answerButtons.get(selected);
  if (choice) {
    choice.disabled = true;
    choice.classList.add(result);
  }
  locked = result === 'correct';
  if (locked) for (const answer of answers.querySelectorAll('button')) answer.disabled = true;
  fills();
}

/** The learner picked a country, on the map or as an answer. @param {string} code */
function choose(code) {
  if (!question || locked || advancing || !exercise) return;
  locked = true;
  selected = code;
  if (question.options && (!question.options.includes(code) || question.misses.has(code))) {
    locked = false;
    return;
  }
  if (code !== question.country) {
    question.misses.add(code);
    showFeedback('wrong');
    return;
  }
  attempt({
    score: Number(!question.misses.size && !question.revealed),
    targets: [facts.get(question.country), topic].filter(record => record !== undefined),
    activity: activityFor(exercise),
  });
  showFeedback('correct');
  advancing = true;
  const request = generation;
  setTimeout(() => {
    advancing = false;
    if (request === generation) advance();
  }, 600);
}

function reveal() {
  if (!question || locked || question.options || question.revealed) return;
  question.revealed = true;
  showFeedback('revealed');
}

function advance() {
  if (exercise?.countries && groupIndex < exercise.countries.length - 1) {
    groupIndex += 1;
    present();
  } else {
    selectNext();
  }
}

function selectNext() {
  exercise = nextExercise(countries, groups, replay(history(), context.app, facts), lastCountry);
  groupIndex = 0;
  if (!exercise) {
    question = undefined;
    prompt.textContent = 'No countries are available to practice.';
    answers.replaceChildren();
    return;
  }
  groupKey = undefined;
  lastCountry = exercise.countries?.at(-1) ?? exercise.country;
  present();
}

function present() {
  if (!exercise) return;
  const { type, zoom: level, panIndex, countries: sequence } = exercise;
  const country = /** @type {string} */ (sequence ? sequence[groupIndex] : exercise.country);
  const others = sequence?.filter(code => code !== country);
  const distractor = others ? others[Math.floor(Math.random() * others.length)] : exercise.distractor;
  const options = distractor ? (Math.random() < 0.5 ? [country, distractor] : [distractor, country]) : undefined;
  const key = sequence ? `group-${groupIndex === 0 ? ++groupCount : groupCount}` : undefined;
  question = { type, country, zoom: level, panIndex, options, countries: sequence, groupKey: key,
    misses: new Set(), revealed: false };
  selected = feedback = undefined;
  locked = revealed = false;
  const name = countryName(country);
  /** @type {Record<string, string>} */
  const text = {
    'find-in-neighborhood': `Find ${name} in its neighborhood`,
    'find-on-world-map': `Find ${name} on the ${mapName}`,
    'distractor-choice': 'Which country is highlighted?',
  };
  prompt.textContent = text[type] ?? 'Which country is this?';
  answers.replaceChildren();
  answerButtons = new Map();
  if (options) {
    for (const code of options) answerButtons.set(code, button(countryName(code), () => choose(code)));
  } else {
    button('I have no idea', reveal);
  }
  land.selectAll('path').attr('data-pickable', options ? null : '');
  if (!key || groupKey !== key) setInitial();
  groupKey = key;
  fills();
}

// Loads the selected map, then schedules from the learner's history.
async function start() {
  const request = ++generation;
  question = exercise = undefined;
  answers.replaceChildren();
  prompt.textContent = 'Loading…';
  try {
    const pack = await maps.load();
    const [geo, content, regions] = await Promise.all(['map.geo.json', 'countries.json', 'groups.json'].map(path => pack.json(path)));
    await historyReady();
    if (request !== generation) return;
    geometry = geo;
    features = new Map(geo.features.map(/** @param {Country} feature */ feature => [feature.properties.code, feature]));
    countries = content;
    groups = regions;
    mapName = typeof pack.meta.mapName === 'string' ? pack.meta.mapName : 'map';
    drawnWidth = drawnHeight = undefined;
    lastCountry = undefined;
    draw();
    selectNext();
  } catch (error) {
    if (request !== generation) return;
    prompt.textContent = /** @type {{ code?: string }} */ (error).code === 'needs-file'
      ? /** @type {Error} */ (error).message
      : 'Could not load the map.';
  }
}

maps.onChange(() => void start());
void start();
