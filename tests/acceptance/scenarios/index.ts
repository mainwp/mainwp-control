import { configurationScenarios } from './configuration.js';
import { errorScenarios } from './errors.js';
import { readScenarios } from './read.js';
import { safetyScenarios } from './safety.js';
import type { ScenarioDefinition } from './types.js';
import { writeScenarios } from './writes.js';

export const scenarios: ScenarioDefinition[] = [
  ...readScenarios,
  ...errorScenarios,
  ...safetyScenarios,
  ...writeScenarios,
  ...configurationScenarios,
];

const duplicateIds = scenarios
  .map(scenario => scenario.id)
  .filter((id, index, all) => all.indexOf(id) !== index);

if (duplicateIds.length > 0) {
  throw new Error(`Duplicate acceptance scenario IDs: ${duplicateIds.join(', ')}`);
}
