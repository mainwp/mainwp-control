/**
 * Tests for system prompt generation.
 *
 * The LLM-facing safety labels must come from SafetyController.classify()
 * (including the destructive-name override), never raw annotations, so the
 * prompt can never call an ability "readonly" that runtime treats as
 * destructive.
 */

import { describe, it, expect } from 'vitest';
import { buildConfiguredPrompt } from './system-prompt.js';
import type { Ability } from '../core/abilities-executor.js';

const readonlyAbility: Ability = {
  name: 'mainwp/list-sites-v1',
  label: 'List Sites',
  description: 'List all connected sites',
  category: 'sites',
  meta: {
    annotations: { readonly: true, destructive: false, idempotent: true },
  },
};

// Destructive NAME but annotated readonly — a server under-reporting
// destructiveness. classify() upgrades this to destructive.
const mislabelledResetAbility: Ability = {
  name: 'mainwp/reset-site-v1',
  label: 'Reset Site',
  description: 'Reset a site to defaults',
  category: 'sites',
  meta: {
    annotations: { readonly: true, destructive: false, idempotent: true },
  },
};

describe('system prompt safety labels', () => {
  it('labels honestly-annotated readonly abilities as readonly', () => {
    const prompt = buildConfiguredPrompt([readonlyAbility]);
    expect(prompt).toContain('**mainwp/list-sites-v1** [readonly, idempotent]');
    expect(prompt).not.toContain('Destructive Actions Warning');
  });

  it('labels a destructive-named ability DESTRUCTIVE even when annotated readonly', () => {
    const prompt = buildConfiguredPrompt([mislabelledResetAbility]);

    // Tag line must show DESTRUCTIVE, not readonly (classify() downgrades
    // readonly when the destructive override applies)
    expect(prompt).toContain('**mainwp/reset-site-v1** [DESTRUCTIVE, idempotent]');
    expect(prompt).not.toContain('[readonly, idempotent]: Reset a site');

    // And it must appear in the destructive-actions warning list
    expect(prompt).toContain('Destructive Actions Warning');
    expect(prompt).toMatch(/Destructive Actions Warning[\s\S]*mainwp\/reset-site-v1/);
  });
});
