export const repairBudgetMs = 120_000;
export const repairCallLimit = 3;
export const repairPolicies = ['none', 'once', 'loop'];
export const tiers = ['broken', 'starts', 'working', 'publishable'];

/**
 * publishable: interaction checks and strict types pass.
 * working: the fixture's interaction checks pass.
 * starts: the activity loads without errors (custom briefs have no interaction checks).
 */
export function tierOf(checks) {
  if (!checks || checks.syntax !== 'pass' || checks.startup !== 'pass') return 'broken';
  if (checks.fixture !== 'pass') return 'starts';
  return checks.type === 'pass' ? 'publishable' : 'working';
}

/** Accepted by every check available for the brief. */
export function accepted(checks) {
  const tier = tierOf(checks);
  return tier === 'publishable' || (tier === 'starts' && checks.fixture === 'unverified' && checks.type === 'pass');
}

export function preferredCandidate(current, candidate) {
  if (!candidate.checks) return false;
  if (!current.checks) return true;
  const rank = result => tiers.indexOf(tierOf(result.checks));
  if (rank(candidate) !== rank(current)) return rank(candidate) > rank(current);
  if (regressions(current, candidate).length) return false;
  return (candidate.checks.typeErrors ?? Infinity) < (current.checks.typeErrors ?? Infinity);
}

export function regressions(current, candidate) {
  if (!candidate.checks || !current.checks) return [];
  return ['syntax', 'startup', 'fixture'].filter(stage =>
    current.checks[stage] === 'pass' && ['fail', 'skipped'].includes(candidate.checks[stage]));
}

function failureSignature(result) {
  const failure = result.diagnostics?.[0];
  const line = failure?.message?.split('\n')[0]?.replace(/activity\.js(?::\d+|\(\d+,\d+\))/, 'activity.js');
  return [result.failure, failure?.stage, failure?.code ?? line].join(':');
}

/** The next follow-up call for a sample, or null to stop. */
export function nextRepair(policy, best, latest, calls, escalated, previous) {
  if (latest.failure === 'library-request' && latest.libraryRequest?.available) {
    if (previous?.libraryRequest?.package === latest.libraryRequest.package) return null;
    return { kind: 'generate-with-library', think: false };
  }
  if (policy === 'none' || best.passed || !['response', 'truncated', 'validation'].includes(latest.failure)) {
    return null;
  }
  const kind = ['response', 'truncated'].includes(best.failure) || !best.checks ? 'regenerate' : 'repair';
  if (policy === 'once') return calls ? null : { kind, think: false };
  const repeated = previous && failureSignature(previous) === failureSignature(latest);
  if (escalated && (best !== latest || repeated)) return null;
  return { kind, think: calls > 0 && !escalated && (best !== latest || repeated) };
}
