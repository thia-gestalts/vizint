export const app = 'example.thia.vizint';

const plotFrameHeight = 'calc(clamp(0px, 50vw - 1rem, 27rem) + 6rem)';
const verticalPointDrag = 'src/vertical-point-drag.js';

export const entries = [
  {
    slug: 'bezier',
    activity: 'bezier-explorer',
    frameHeight: plotFrameHeight,
    title: 'Bézier explorer',
    intro: 'Drag a control point to reshape the curve. Move t to see how repeated interpolation locates a point on it.',
    type: 'engagement',
    target: {
      kind: 'topic',
      id: 'name:62c3a97a69657220637572766573',
      name: 'Bézier Curves',
    },
    source: 'Inspired by “How a Bézier curve is drawn” in the Gestalts visualization examples.',
  },
  {
    slug: 'mse',
    activity: 'mean-squared-error',
    frameHeight: plotFrameHeight,
    sharedScript: verticalPointDrag,
    title: 'Mean squared error (MSE)',
    intro: 'Drag the three points up or down. Each dashed segment shows the distance to the prediction. Square those distances and average them to get the MSE.',
    type: 'engagement',
    target: {
      kind: 'topic',
      id: 'name:6d65616e2073717561726564206572726f72',
      name: 'Mean Squared Error',
    },
  },
  {
    slug: 'squared-errors',
    activity: 'squared-errors',
    frameHeight: plotFrameHeight,
    sharedScript: verticalPointDrag,
    title: 'Squared errors',
    intro: 'Drag the three points up or down. The vertical gap to the truth line forms one side of each square. Its area is the squared error for that point.',
    type: 'engagement',
    target: {
      kind: 'topic',
      id: 'name:73717561726564206572726f72',
      name: 'Squared Error',
    },
  },
  {
    slug: 'rounding',
    activity: 'round-to-nearest-tenth',
    frameHeight: '21rem',
    title: 'Rounding to the nearest tenth',
    intro: 'Choose the value rounded to one decimal place. The hundredths digit tells you whether to round up.',
    type: 'attempt',
    target: {
      kind: 'skill',
      id: `key:${app}:rounding/nearest-tenth`,
      name: 'Round to the nearest tenth',
    },
    source: 'Exercise format inspired by Stembridge’s rounding drills (CC BY 4.0).',
  },
];
