import { scaleLinear, select } from 'd3';

const svg = document.querySelector('svg');
if (!svg) throw new Error('Missing activity SVG');
const x = scaleLinear([0, 10], [15, 185]);
select(svg).append('circle')
  .attr('cx', x(5)).attr('cy', 30).attr('r', 8).attr('fill', 'steelblue');
