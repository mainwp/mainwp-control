/**
 * System Prompt for MainWP Control chat
 *
 * Embeds the runtime AI behavior contract from CHAT_PROMPT.md.
 * This is executable configuration, not documentation.
 *
 * INVARIANT: AI is the primary interaction surface, NOT the execution authority.
 */

import type { Ability } from '../core/abilities-executor.js';
import { getSafetyController } from '../core/safety-controller.js';

/**
 * Core system prompt content
 * Derived from CHAT_PROMPT.md (authoritative document)
 */
const CORE_PROMPT = `You are an AI assistant embedded in MainWP Control (\`mainwpcontrol\`), a command-line tool for MainWP Dashboard management.

## Role

You are the **primary interaction surface**.
You are **NOT** an execution authority.

## Absolute Prohibitions

You must NEVER:
- Execute actions directly
- Bypass validation or safety checks
- Invent abilities or parameters that don't exist
- Auto-confirm destructive operations
- Retry execution automatically without user knowledge

Only the MainWP Abilities API executes actions. You propose tool calls; the system executes them.

## Tool Usage Contract

Each turn, you MUST output exactly ONE of:
- A tool call: \`{ "tool": "<tool_name>", "input": { ... } }\`
- An answer: \`{ "answer": "<human-readable response>" }\`

NEVER output both in the same turn.
NEVER output anything else.

## Destructive Safety Rules

If an ability is marked destructive, you MUST follow this flow:
1. First call with \`dry_run: true\` to preview changes
2. Present the preview results to the user
3. Ask for explicit user approval
4. Only after approval, call with \`confirm: true\`

NEVER skip the preview step for destructive actions.
NEVER inject \`confirm: true\` without explicit user approval.

## Error Handling

- Missing required inputs → Ask the user to provide them
- Invalid tool call → System will inform you; reformulate
- Repeated failures → Explain the situation and suggest next steps

Always fail safely and visibly.

## Response Format

Your response MUST be valid JSON in one of these formats:

Tool call format:
\`\`\`json
{
  "tool": "ability-name-v1",
  "input": {
    "param1": "value1"
  }
}
\`\`\`

Answer format:
\`\`\`json
{
  "answer": "Your response to the user"
}
\`\`\`

## Key Principle

AI is the primary interaction surface, NOT the execution authority.
You interpret intent, explain consequences, and summarize results.
The system handles all actual execution through the Abilities API.`;

/**
 * Format ability for inclusion in system prompt
 */
function formatAbility(ability: Ability): string {
  // Labels come from SafetyController.classify(), not raw annotations, so the
  // LLM-facing text always matches the runtime safety classification
  // (including the destructive-name override).
  const classification = getSafetyController().classify(ability);
  const tags: string[] = [];

  if (classification.isReadOnly) tags.push('readonly');
  if (classification.isDestructive) tags.push('DESTRUCTIVE');
  if (classification.isIdempotent) tags.push('idempotent');

  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

  return `- **${ability.name}**${tagStr}: ${ability.description}`;
}


/**
 * Build abilities section for system prompt
 */
function buildAbilitiesSection(abilities: Ability[]): string {
  if (abilities.length === 0) {
    return '\n## Available Tools\n\nNo abilities available. Please check Dashboard connection.';
  }

  // Group by category
  const byCategory = new Map<string, Ability[]>();
  for (const ability of abilities) {
    const category = ability.category || 'Other';
    const list = byCategory.get(category) ?? [];
    list.push(ability);
    byCategory.set(category, list);
  }

  const sections: string[] = ['\n## Available Tools\n'];

  for (const [category, categoryAbilities] of byCategory.entries()) {
    sections.push(`### ${category}\n`);
    for (const ability of categoryAbilities) {
      sections.push(formatAbility(ability));
    }
    sections.push('');
  }

  // Add destructive actions reminder (same classification source as runtime)
  const destructive = abilities.filter(
    (a) => getSafetyController().classify(a).isDestructive
  );
  if (destructive.length > 0) {
    sections.push('\n## Destructive Actions Warning\n');
    sections.push(
      'The following abilities are DESTRUCTIVE and require the preview → approval flow:\n'
    );
    for (const ability of destructive) {
      sections.push(`- ${ability.name}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Build complete system prompt with abilities
 */
function buildSystemPrompt(abilities: Ability[]): string {
  return CORE_PROMPT + buildAbilitiesSection(abilities);
}

/**
 * System prompt configuration
 */
export interface SystemPromptConfig {
  /** Maximum number of tool calls per turn */
  maxToolCalls: number;
  /** Maximum JSON parse retries */
  maxParseRetries: number;
  /** Whether to include detailed schemas */
  includeSchemas: boolean;
  /** Maximum messages to keep in context (excluding system prompt). undefined = no limit */
  maxContextMessages?: number;
}

/**
 * Default system prompt configuration
 */
export const defaultConfig: SystemPromptConfig = {
  maxToolCalls: 3,
  maxParseRetries: 2,
  includeSchemas: false,
  maxContextMessages: 20,
};

/**
 * Build system prompt with configuration
 */
export function buildConfiguredPrompt(
  abilities: Ability[],
  config: Partial<SystemPromptConfig> = {}
): string {
  const mergedConfig = { ...defaultConfig, ...config };

  let prompt = buildSystemPrompt(abilities);

  // Add configuration constraints
  prompt += `\n## Constraints\n`;
  prompt += `- Maximum tool calls per turn: ${mergedConfig.maxToolCalls}\n`;
  prompt += `- If you need more tool calls, explain and ask to continue\n`;

  // Add context window constraints (omit if 0/unlimited to avoid misleading text)
  if (mergedConfig.maxContextMessages !== undefined && mergedConfig.maxContextMessages > 0) {
    prompt += `- Context window: ${mergedConfig.maxContextMessages} messages (older messages may be truncated)\n`;
  }

  return prompt;
}
