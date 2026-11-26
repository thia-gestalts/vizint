export const app = 'example.thia.vizint';

const plotFrameHeight = 'calc(clamp(0px, 50vw - 1rem, 27rem) + 6rem)';
const verticalPointDrag = 'src/vertical-point-drag.js';
const reference = ({ kind, id }) => ({ kind, id });
const topic = (hex, name) => ({ kind: 'topic', id: `name:${hex}`, name });
const fact = (key, statement) => ({ kind: 'fact', id: `key:${app}:${key}`, statement });
const skill = (key, name) => ({ kind: 'skill', id: `key:${app}:${key}`, name });
const question = (id, text) => ({ kind: 'question', id, text });

const bezierCurves = topic('62c3a97a69657220637572766573', 'Bézier Curves');
const linearInterpolation = topic('6c696e65617220696e746572706f6c6174696f6e', 'Linear Interpolation');
const repeatedInterpolation = fact('bezier/repeated-interpolation',
  'Repeated linear interpolation between the control points gives a point on the cubic Bézier curve.');
const bezierQuestion = question('0d74cc9b-e190-4096-aab4-0163191c1253',
  'How does repeated interpolation trace a cubic Bézier curve?');
const squaredError = topic('73717561726564206572726f72', 'Squared Error');
const squaredErrorDefinition = fact('squared-error/definition',
  'An individual squared error is the square of the difference between the observed and reference values.');
const squaredErrorQuestion = question('96cf56b2-3154-45db-845c-e8ae9ea24a3c',
  'How do you calculate the squared error for one observation?');
const meanSquaredError = topic('6d65616e2073717561726564206572726f72', 'Mean Squared Error');
const meanSquaredErrorDefinition = fact('mean-squared-error/definition',
  'Mean squared error is the arithmetic mean of the individual squared errors.');
const mseQuestion = question('32dfd8d1-9023-4e73-bede-bf2432d46c9c',
  'How do you calculate mean squared error?');
const calculateMean = skill('arithmetic/calculate-mean', 'Calculate an arithmetic mean');
const rounding = topic('726f756e64696e67', 'Rounding');
const decimalPlaceValue = topic('646563696d616c20706c6163652076616c7565', 'Decimal Place Value');
const roundingRule = fact('rounding/hundredths-digit',
  'When rounding a positive decimal to the nearest tenth, the hundredths digit determines whether to round up.');
const roundToNearestTenth = skill('rounding/nearest-tenth', 'Round to the nearest tenth');
const roundingQuestion = question('bc64e437-1e88-4abc-9c09-b94e04f4e298',
  'Which digit tells you whether to round up to the nearest tenth?');

export const entries = [
  {
    slug: 'bezier',
    activity: 'bezier-explorer',
    frameHeight: plotFrameHeight,
    title: 'Bézier explorer',
    intro: 'Drag a control point to reshape the curve. Move t to see how repeated interpolation locates a point on it.',
    type: 'engagement',
    learning: {
      records: [bezierCurves, linearInterpolation, repeatedInterpolation, bezierQuestion],
      topics: [
        { target: reference(bezierCurves), weight: 1 },
        { target: reference(linearInterpolation), weight: 0.7 },
      ],
      teaches: [{ target: reference(repeatedInterpolation) }],
      answers: [{ target: reference(bezierQuestion) }],
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
    learning: {
      records: [meanSquaredError, meanSquaredErrorDefinition, calculateMean, mseQuestion],
      topics: [
        { target: reference(meanSquaredError), weight: 1 },
        { target: reference(squaredError), weight: 0.7 },
      ],
      teaches: [{ target: reference(meanSquaredErrorDefinition) }],
      answers: [{ target: reference(mseQuestion) }],
      prerequisites: [
        {
          target: { kind: 'view', id: 'squared-errors' },
          weight: 0.8,
          reason: 'See how each vertical error becomes an individual squared error.',
        },
        {
          target: reference(calculateMean),
          weight: 0.6,
          reason: 'The final step averages the squared errors.',
        },
      ],
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
    learning: {
      records: [squaredError, squaredErrorDefinition, squaredErrorQuestion],
      topics: [{ target: reference(squaredError), weight: 1 }],
      teaches: [{ target: reference(squaredErrorDefinition) }],
      answers: [{ target: reference(squaredErrorQuestion) }],
    },
  },
  {
    slug: 'rounding',
    activity: 'round-to-nearest-tenth',
    frameHeight: '21rem',
    title: 'Rounding to the nearest tenth',
    intro: 'Choose the value rounded to one decimal place. The hundredths digit tells you whether to round up.',
    type: 'attempt',
    learning: {
      records: [rounding, decimalPlaceValue, roundingRule, roundingQuestion],
      topics: [
        { target: reference(rounding), weight: 1 },
        { target: reference(decimalPlaceValue), weight: 0.6 },
      ],
      teaches: [{ target: reference(roundingRule) }],
      answers: [{ target: reference(roundingQuestion) }],
      exercises: [{
        id: 'nearest-tenth',
        title: 'Round to the nearest tenth',
        records: [roundToNearestTenth],
        practices: [{ target: reference(roundToNearestTenth) }],
        assesses: [{ target: reference(roundToNearestTenth) }],
      }],
    },
    source: 'Exercise format inspired by Stembridge’s rounding drills (CC BY 4.0).',
  },
];
