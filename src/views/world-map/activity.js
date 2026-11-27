import { geoCentroid, geoMercator, geoPath, select, zoom, zoomIdentity } from 'd3';
import { computeCountryMaxDimension, computeGroupProjection, computeMapProjection,
  computeMarkerRadius, interpolateScale, toZoomTransform } from './projection.ts';

const node = id => document.getElementById(id);
const send = message => parent.postMessage(message, '*');
const map = node('map');
const svg = select(map).append('svg').attr('aria-label', 'Interactive world map');
const land = svg.append('g');
const marker = land.append('circle').attr('fill', 'none').attr('stroke-width', 2)
  .attr('vector-effect', 'non-scaling-stroke').style('pointer-events', 'none');
const controls = { in: node('zoom-in'), out: node('zoom-out'), reset: node('reset') };
let geometry, features, projection, question, groupKey, selected, feedback;
let initial = zoomIdentity;
let transform = zoomIdentity;
let maxScale = 8;
let markerCode, markerProjection, markerPosition, markerDimension;
let markerHidden = false;
let drawnWidth, drawnHeight;
let revealed = false;
let locked = false;
let answerButtons = new Map();
const highlight = '#3b82f6';
const success = '#22c55e';

function markerStyle() {
  const target = question && features.get(question.country);
  const show = target && (question.options || revealed);
  if (!show || !projection) {
    marker.attr('display', 'none');
    return;
  }
  if (markerCode !== question.country || markerProjection !== projection) {
    markerCode = question.country;
    markerProjection = projection;
    markerPosition = projection(geoCentroid(target));
    markerDimension = computeCountryMaxDimension(projection, target);
    markerHidden = false;
  }
  const dimension = markerDimension * transform.k;
  if (dimension > 70) markerHidden = true;
  if (dimension < 50) markerHidden = false;
  const [x, y] = markerPosition;
  const radius = computeMarkerRadius(map.clientWidth, map.clientHeight);
  marker.attr('cx', x).attr('cy', y).attr('r', radius / transform.k)
    .attr('display', markerHidden ? 'none' : null)
    .attr('stroke', feedback === 'correct' ? success : highlight);
}

const zoomBehavior = zoom().clickDistance(6).on('zoom', event => {
  transform = event.transform;
  land.attr('transform', transform);
  controls.in.disabled = transform.k >= maxScale - 0.01;
  controls.out.disabled = transform.k <= 1.01;
  controls.reset.disabled = Math.abs(transform.k - initial.k) < 0.01
    && Math.abs(transform.x - initial.x) < 0.5 && Math.abs(transform.y - initial.y) < 0.5;
  markerStyle();
});
svg.call(zoomBehavior).on('dblclick.zoom', null);
controls.in.onclick = () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1.5);
controls.out.onclick = () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1 / 1.5);
controls.reset.onclick = () => svg.transition().duration(250).call(zoomBehavior.transform, initial);

function choose(code) {
  if (!question || locked) return;
  locked = true;
  selected = code;
  send({ type: 'pick', id: question.id, code });
}

function fills() {
  land.selectAll('path').attr('fill', feature => feature.properties.code === question?.country
    && (question.options || revealed || feedback === 'correct')
    ? feedback === 'correct' && !question.options ? success : highlight : '#e6e6e6');
  markerStyle();
}

function setInitial() {
  const width = map.clientWidth;
  const height = map.clientHeight;
  if (!width || !height || !projection || !question) return;
  const target = { geoData: geometry, width, height, targetCountry: question.country,
    zoom: question.zoom, panIndex: question.panIndex };
  initial = question.countries
    ? toZoomTransform(projection, computeGroupProjection({ ...target, groupCountries: question.countries }))
    : toZoomTransform(projection, computeMapProjection(target));
  if (initial.k < 1) initial = zoomIdentity;
  maxScale = Math.max(8, initial.k * 3);
  zoomBehavior.scaleExtent([1, maxScale]).translateExtent([[0, 0], [width, height]]);
  svg.interrupt().call(zoomBehavior.transform, initial);
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
  land.selectAll('path').data(geometry.features, feature => feature.properties.code)
    .join(enter => enter.insert('path', 'circle').attr('stroke', '#787878').attr('stroke-width', 0.65)
      .attr('vector-effect', 'non-scaling-stroke').on('click', (_, feature) => {
        if (question && !question.options) choose(feature.properties.code);
      })).attr('d', path);
  setInitial();
  fills();
}
new ResizeObserver(draw).observe(map);

function reveal() {
  if (!projection) return;
  const feature = features.get(question.country);
  const width = map.clientWidth;
  const height = map.clientHeight;
  const scale = projection.scale();
  const fit = geoMercator().fitSize([width, height], feature).scale();
  const k = Math.min(maxScale, Math.max(1, interpolateScale(scale, fit, 1) / scale));
  const [x, y] = projection(geoCentroid(feature));
  svg.transition().duration(250).call(zoomBehavior.transform,
    zoomIdentity.translate(width / 2 - k * x, height / 2 - k * y).scale(k));
}

function button(label, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.onclick = action;
  node('answers').append(element);
  return element;
}

function showQuestion(next) {
  question = next;
  selected = feedback = undefined;
  locked = revealed = false;
  const name = features.get(next.country).properties.name;
  const text = {
    'find-in-neighborhood': `Find ${name} in its neighborhood`,
    'find-on-world-map': `Find ${name} on the world map`,
    'distractor-choice': 'Which country is highlighted?',
  };
  node('prompt').textContent = text[next.type] ?? 'Which country is this?';
  node('answers').replaceChildren();
  answerButtons = new Map();
  if (next.options) for (const code of next.options) {
    answerButtons.set(code, button(features.get(code).properties.name, () => choose(code)));
  } else {
    button('I have no idea', () => {
      if (locked || revealed && node('answers').firstElementChild.disabled) return;
      locked = true;
      send({ type: 'reveal', id: next.id });
    });
  }
  land.selectAll('path').attr('data-pickable', next.options ? null : '');
  if (!next.groupKey || groupKey !== next.groupKey) setInitial();
  groupKey = next.groupKey;
  fills();
}

addEventListener('message', ({ source, data }) => {
  if (source !== parent || !data) return;
  switch (data.type) {
    case 'geometry':
      geometry = data.geometry;
      features = new Map(geometry.features.map(feature => [feature.properties.code, feature]));
      draw();
      break;
    case 'question': showQuestion(data.question); break;
    case 'status': node('prompt').textContent = data.text; break;
    case 'feedback': {
      if (data.id !== question?.id) break;
      feedback = data.result;
      if (data.result === 'revealed') {
        revealed = true;
        node('answers').firstElementChild.disabled = true;
        reveal();
      }
      if (data.result === 'wrong' && !question.options) revealed = true;
      const choice = answerButtons.get(selected);
      if (choice) {
        choice.disabled = true;
        choice.classList.add(data.result);
      }
      locked = data.result === 'correct';
      if (locked) for (const answer of node('answers').children) answer.disabled = true;
      fills();
      break;
    }
  }
});
send({ type: 'ready' });
