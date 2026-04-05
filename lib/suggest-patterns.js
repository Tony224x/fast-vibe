'use strict';

// Static pattern matching for auto-suggest (no AI needed)
// Each pattern: { re: RegExp, suggest: string, confidence: 'high'|'medium'|'low' }
// First match wins (ordered by priority)

const PATTERNS = [
  // Permission / confirmation prompts
  { re: /Do you want to (proceed|continue)\??/i, suggest: 'yes', confidence: 'high' },
  { re: /\(y\/n\)/i, suggest: 'yes', confidence: 'high' },
  { re: /\[y\/N\]/i, suggest: 'yes', confidence: 'high' },
  { re: /\[Y\/n\]/i, suggest: 'yes', confidence: 'high' },
  { re: /(Allow|Approve|Permit|Accept|Confirm).*\?/i, suggest: 'yes', confidence: 'high' },
  { re: /Would you like (me )?to /i, suggest: 'yes', confidence: 'high' },
  { re: /Shall I /i, suggest: 'yes', confidence: 'high' },
  { re: /Do you want me to /i, suggest: 'yes', confidence: 'high' },
  { re: /Should I /i, suggest: 'yes', confidence: 'high' },
  { re: /Ready to (start|begin|proceed)\?/i, suggest: 'yes', confidence: 'high' },

  // Error / failure detection
  { re: /error\[\w+\]|Error:|ERROR:|FATAL:/i, suggest: 'fix this error', confidence: 'medium' },
  { re: /tests?\s+(failed|failing|FAIL)|FAILED|✗/i, suggest: 'fix the failing tests and run them again', confidence: 'medium' },
  { re: /build\s+(failed|error)/i, suggest: 'fix the build error', confidence: 'medium' },
  { re: /compile\s*error|compilation\s*failed/i, suggest: 'fix the compilation error', confidence: 'medium' },
  { re: /merge conflict/i, suggest: 'resolve the merge conflicts', confidence: 'medium' },
  { re: /lint\s*(error|warning)s?\s*found/i, suggest: 'fix the lint errors', confidence: 'medium' },
  { re: /type\s*error/i, suggest: 'fix the type error', confidence: 'medium' },

  // Task completion signals
  { re: /commit.*created|Successfully committed/i, suggest: '/compact', confidence: 'low' },
  { re: /PR.*created|pull request.*created/i, suggest: '/compact', confidence: 'low' },
  { re: /All tests pass|✓.*tests?\s+pass/i, suggest: '/compact', confidence: 'low' },
];

/**
 * Match static suggestion patterns against worker output.
 * @param {string} output - ANSI-stripped terminal output (last ~3000 chars)
 * @returns {{ text: string, confidence: string } | null}
 */
function matchStaticSuggestion(output) {
  if (!output || output.length < 5) return null;

  // Check the tail portion (last 1000 chars) for recency
  const tail = output.slice(-1000);

  for (const { re, suggest, confidence } of PATTERNS) {
    if (re.test(tail)) {
      return { text: suggest, confidence };
    }
  }

  return null;
}

module.exports = { matchStaticSuggestion, PATTERNS };
