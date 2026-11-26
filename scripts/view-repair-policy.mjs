export const repairBudgetMs = 120_000;
export const repairCallLimit = 3;

export function preferredCandidate(current, candidate) {
  if (candidate.passed) return true;
  if (!candidate.checks) return false;
  if (!current.checks) return true;
  const stages = ['syntax', 'startup', 'fixture'];
  if (regressions(current, candidate).length) {
    return false;
  }
  return stages.some(stage => candidate.checks[stage] === 'pass' && current.checks[stage] !== 'pass') ||
    candidate.checks.typeErrors < current.checks.typeErrors;
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

export function nextRepair(policy, best, latest, calls, escalated, previous) {
  if (policy === 'loop' && latest.failure === 'library-request' && latest.libraryRequest.available) {
    if (previous?.libraryRequest?.package === latest.libraryRequest.package) return null;
    return { kind: 'generate-with-library', think: false };
  }
  if (policy === 'none' || best.passed || !['response', 'truncated', 'validation'].includes(latest.failure)) {
    return null;
  }
  if (policy === 'once') {
    if (calls) return null;
    if (latest.failure === 'truncated') return { kind: 'retry-truncated' };
    return latest.failure === 'validation' ? { kind: 'repair-code' } : null;
  }
  const repeated = previous && failureSignature(previous) === failureSignature(latest);
  if (escalated && (best !== latest || repeated)) return null;
  const think = calls > 0 && !escalated && (best !== latest || repeated);
  if (['response', 'truncated'].includes(best.failure)) return { kind: 'regenerate', think };
  const failure = best.diagnostics?.[0];
  if (think && failure?.stage === 'startup' && /(?:THREE|katex|MathJax|d3|Chart|React|p5|Plotly) is not defined/i.test(failure.message)) {
    return { kind: 'regenerate', think };
  }
  const crossFile = failure && (['bundle', 'fixture', 'startup'].includes(failure.stage) ||
    /(?:element|cannot find name)/i.test(failure.message));
  return { kind: think || crossFile ? 'repair-activity' : 'repair-js', think };
}
