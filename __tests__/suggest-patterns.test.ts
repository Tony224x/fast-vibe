import { matchStaticSuggestion, PATTERNS } from '../src/suggest-patterns';

describe('matchStaticSuggestion', () => {
  test('returns null for empty/short output', () => {
    expect(matchStaticSuggestion('')).toBeNull();
    expect(matchStaticSuggestion(null as unknown as string)).toBeNull();
    expect(matchStaticSuggestion('hi')).toBeNull();
  });

  // ── Permission prompts (high confidence) ──

  test('matches y/n prompt', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Do you want to proceed? (y/n)');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  test('matches [Y/n] prompt', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Continue? [Y/n]');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  test('matches [y/N] prompt', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Overwrite? [y/N]');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  test('matches "Allow" question', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Allow access to filesystem?');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  test('matches "Would you like to"', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Would you like to install dependencies?');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  test('matches "Shall I"', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Shall I continue?');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  test('matches "Should I"', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Should I proceed with the refactor?');
    expect(result).toEqual({ text: 'yes', confidence: 'high' });
  });

  // ── Error detection (medium confidence) ──

  test('matches error output', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Error: Cannot find module');
    expect(result).toEqual({ text: 'fix this error', confidence: 'medium' });
  });

  test('matches test failure', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + '3 tests failed');
    expect(result).toEqual({ text: 'fix the failing tests and run them again', confidence: 'medium' });
  });

  test('matches build failure', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'build error in module X');
    expect(result).toEqual({ text: 'fix the build error', confidence: 'medium' });
  });

  test('matches compilation error', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'compile error in App.tsx');
    expect(result).toEqual({ text: 'fix the compilation error', confidence: 'medium' });
  });

  test('matches merge conflict', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'CONFLICT: merge conflict in file.js');
    expect(result).toEqual({ text: 'resolve the merge conflicts', confidence: 'medium' });
  });

  test('matches lint errors', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + '12 lint errors found');
    expect(result).toEqual({ text: 'fix the lint errors', confidence: 'medium' });
  });

  test('matches type error', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'found a type error in component');
    expect(result).toEqual({ text: 'fix the type error', confidence: 'medium' });
  });

  // ── Task completion (low confidence) ──

  test('matches commit created', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'commit abc123 created');
    expect(result).toEqual({ text: '/compact', confidence: 'low' });
  });

  test('matches PR created', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'pull request #42 created');
    expect(result).toEqual({ text: '/compact', confidence: 'low' });
  });

  test('matches all tests pass', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'All tests pass');
    expect(result).toEqual({ text: '/compact', confidence: 'low' });
  });

  // ── No match ──

  test('returns null for normal output', () => {
    const result = matchStaticSuggestion('a'.repeat(100) + 'Working on the feature...');
    expect(result).toBeNull();
  });

  // ── Recency (only checks last 1000 chars) ──

  test('only matches in last 1000 chars', () => {
    const output = 'Error: old error\n' + 'x'.repeat(2000) + 'All fine now';
    const result = matchStaticSuggestion(output);
    expect(result).toBeNull();
  });

  test('matches within last 1000 chars', () => {
    const output = 'x'.repeat(2000) + 'Error: recent error';
    const result = matchStaticSuggestion(output);
    expect(result).toEqual({ text: 'fix this error', confidence: 'medium' });
  });
});
