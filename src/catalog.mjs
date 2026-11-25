export const app = 'example.thia.vizint';

export const entries = [
  {
    slug: 'bezier',
    activity: 'bezier-explorer',
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
    slug: 'rounding',
    activity: 'round-to-nearest-tenth',
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
