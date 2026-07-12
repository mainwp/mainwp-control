/**
 * Tool Envelope Parser for mainwpcontrol
 *
 * Parses and validates LLM tool call responses.
 * Supports both native function calling (from provider) and JSON in content.
 *
 * Contract (from CHAT_PROMPT.md):
 * - Tool call: { "tool": "<tool_name>", "input": { ... } }
 * - Answer: { "answer": "<human-readable response>" }
 */

import type { ToolCall, LLMResponse } from './providers/provider.js';
import type { Ability } from '../core/abilities-executor.js';

/**
 * Parsed response types
 */
export type ParsedResponse =
  | {
      type: 'tool';
      tool: string;
      input: Record<string, unknown>;
      id?: string;
      thoughtSignature?: string;
    }
  | { type: 'answer'; answer: string }
  | { type: 'error'; error: string; retryable: boolean };

/**
 * Parse result with metadata
 */
export interface ParseResult {
  response: ParsedResponse;
  /** Raw content from LLM */
  rawContent: string;
  /** Whether this came from native function calling */
  nativeFunctionCall: boolean;
  /** Parse attempt count */
  attempts: number;
}

/**
 * Tool envelope parser options
 */
export interface ParserOptions {
  /** Known abilities for validation */
  abilities?: Ability[];
  /** Whether to validate tool exists in abilities list */
  validateToolExists?: boolean;
  /** Whether to validate input against schema */
  validateInput?: boolean;
  /** Protocol-safe tool name to real ability name */
  toolAliases?: ReadonlyMap<string, string>;
}

/**
 * JSON extraction patterns
 */
const JSON_PATTERNS = [
  // Code block with json
  /```json\s*\n?([\s\S]*?)\n?```/,
  // Code block without language
  /```\s*\n?([\s\S]*?)\n?```/,
  // Raw JSON object
  /(\{[\s\S]*\})/,
];

/**
 * Parse LLM response to extract tool call or answer
 */
export function parseResponse(
  response: LLMResponse,
  options: ParserOptions = {}
): ParseResult {
  if (
    response.finishReason === 'length' ||
    response.finishReason === 'content_filter'
  ) {
    return protocolError(
      `Cannot process a response with finish reason "${response.finishReason}"`,
      response.content
    );
  }

  // First, check for native function calling
  if (response.toolCalls && response.toolCalls.length > 0) {
    if (response.finishReason !== 'tool_calls') {
      return protocolError(
        `Tool calls require finish reason "tool_calls", received "${response.finishReason}"`,
        JSON.stringify(response.toolCalls)
      );
    }

    if (response.toolCalls.length !== 1) {
      return protocolError(
        `Expected exactly one tool call, received ${response.toolCalls.length}`,
        JSON.stringify(response.toolCalls)
      );
    }

    const firstToolCall = response.toolCalls[0];
    if (firstToolCall) {
      return parseNativeToolCall(firstToolCall, options);
    }
  }

  // Otherwise, parse JSON from content
  return parseContentJson(response.content, options);
}

/**
 * Parse native tool call from provider
 */
function parseNativeToolCall(
  toolCall: ToolCall,
  options: ParserOptions
): ParseResult {
  if (!isObjectInput(toolCall.arguments)) {
    return protocolError(
      `Tool input for "${toolCall.name}" must be a JSON object`,
      JSON.stringify(toolCall)
    );
  }

  const toolName = resolveToolName(toolCall.name, options);
  const validation = validateToolCall(toolName, toolCall.arguments, options);

  if (validation) {
    return {
      response: { type: 'error', error: validation, retryable: false },
      rawContent: JSON.stringify(toolCall),
      nativeFunctionCall: true,
      attempts: 1,
    };
  }

  return {
    response: {
      type: 'tool',
      tool: toolName,
      input: toolCall.arguments,
      id: toolCall.id,
      ...(toolCall.thoughtSignature !== undefined
        ? { thoughtSignature: toolCall.thoughtSignature }
        : {}),
    },
    rawContent: JSON.stringify(toolCall),
    nativeFunctionCall: true,
    attempts: 1,
  };
}

/**
 * Parse JSON from content string
 */
function parseContentJson(
  content: string,
  options: ParserOptions
): ParseResult {
  const trimmed = content.trim();

  // Try to extract JSON
  let jsonStr: string | null = null;
  let attempts = 0;

  for (const pattern of JSON_PATTERNS) {
    attempts++;
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      jsonStr = match[1].trim();
      break;
    }
  }

  // If no pattern matched, try the whole content
  if (!jsonStr) {
    jsonStr = trimmed;
    attempts++;
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return {
      response: {
        type: 'error',
        error: `Invalid JSON in response: ${jsonStr.slice(0, 100)}...`,
        retryable: true,
      },
      rawContent: content,
      nativeFunctionCall: false,
      attempts,
    };
  }

  // Validate structure
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      response: {
        type: 'error',
        error: 'Response must be a JSON object',
        retryable: true,
      },
      rawContent: content,
      nativeFunctionCall: false,
      attempts,
    };
  }

  const obj = parsed as Record<string, unknown>;

  if ('answer' in obj && 'tool' in obj) {
    return {
      response: {
        type: 'error',
        error: 'Response cannot contain both "answer" and "tool" properties',
        retryable: true,
      },
      rawContent: content,
      nativeFunctionCall: false,
      attempts,
    };
  }

  // Check for answer format
  if ('answer' in obj && typeof obj['answer'] === 'string') {
    return {
      response: { type: 'answer', answer: obj['answer'] },
      rawContent: content,
      nativeFunctionCall: false,
      attempts,
    };
  }

  // Check for tool format
  if ('tool' in obj && typeof obj['tool'] === 'string') {
    const toolName = resolveToolName(obj['tool'], options);
    if (!isObjectInput(obj['input'])) {
      return {
        response: {
          type: 'error',
          error: `Tool input for "${toolName}" must be a JSON object`,
          retryable: true,
        },
        rawContent: content,
        nativeFunctionCall: false,
        attempts,
      };
    }
    const input = obj['input'];

    const validation = validateToolCall(toolName, input, options);

    if (validation) {
      return {
        response: { type: 'error', error: validation, retryable: false },
        rawContent: content,
        nativeFunctionCall: false,
        attempts,
      };
    }

    return {
      response: { type: 'tool', tool: toolName, input },
      rawContent: content,
      nativeFunctionCall: false,
      attempts,
    };
  }

  // Invalid format
  return {
    response: {
      type: 'error',
      error:
        'Response must have either "tool" with "input" or "answer" property',
      retryable: true,
    },
    rawContent: content,
    nativeFunctionCall: false,
    attempts,
  };
}

function protocolError(error: string, rawContent: string): ParseResult {
  return {
    response: { type: 'error', error, retryable: true },
    rawContent,
    nativeFunctionCall: true,
    attempts: 1,
  };
}

function isObjectInput(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveToolName(name: string, options: ParserOptions): string {
  return options.toolAliases?.get(name) ?? name;
}

/**
 * Validate tool call against known abilities
 */
function validateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  options: ParserOptions
): string | null {
  // Validate tool exists if abilities provided
  if (options.validateToolExists && options.abilities) {
    const ability = findAbility(toolName, options.abilities);
    if (!ability) {
      const availableTools = options.abilities.map((a) => a.name).join(', ');
      return `Unknown tool: "${toolName}". Available tools: ${availableTools}`;
    }

    // Validate required inputs if schema available
    if (options.validateInput && ability.input_schema) {
      const requiredError = validateRequiredInputs(input, ability.input_schema);
      if (requiredError) {
        return requiredError;
      }
    }
  }

  return null;
}

/**
 * Find ability by name (supports short name and full name)
 */
function findAbility(name: string, abilities: Ability[]): Ability | undefined {
  // Exact match
  const exact = abilities.find((a) => a.name === name);
  if (exact) return exact;

  // Short name match (e.g., "list-sites-v1" matches "mainwp/list-sites-v1")
  const shortMatch = abilities.find((a) => {
    const parts = a.name.split('/');
    return parts[parts.length - 1] === name;
  });
  if (shortMatch) return shortMatch;

  // Prefix match (e.g., "mainwp/list-sites-v1" matches "list-sites-v1")
  const prefixMatch = abilities.find((a) => a.name.endsWith(`/${name}`));
  return prefixMatch;
}

/**
 * Validate required inputs are present
 */
function validateRequiredInputs(
  input: Record<string, unknown>,
  schema: Record<string, unknown>
): string | null {
  const required = schema['required'] as string[] | undefined;
  if (!required || required.length === 0) {
    return null;
  }

  const missing = required.filter(
    (key) => !(key in input) || input[key] === undefined
  );

  if (missing.length > 0) {
    return `Missing required parameters: ${missing.join(', ')}`;
  }

  return null;
}

/**
 * Format tool call for display
 */
export function formatToolCall(
  tool: string,
  input: Record<string, unknown>
): string {
  const inputStr = JSON.stringify(input, null, 2);
  return `Tool: ${tool}\nInput: ${inputStr}`;
}

/**
 * Format parsed response for display
 */
export function formatParsedResponse(result: ParseResult): string {
  const { response } = result;

  switch (response.type) {
    case 'tool':
      return formatToolCall(response.tool, response.input);
    case 'answer':
      return response.answer;
    case 'error':
      return `Error: ${response.error}`;
  }
}

/**
 * Check if response is retryable
 */
export function isRetryable(result: ParseResult): boolean {
  return result.response.type === 'error' && result.response.retryable;
}

/**
 * Build retry prompt for invalid JSON
 */
export function buildRetryPrompt(result: ParseResult): string {
  if (result.response.type !== 'error') {
    return '';
  }

  return `Your previous response was not valid JSON. Error: ${result.response.error}

Please respond with a valid JSON object in one of these formats:

Tool call:
\`\`\`json
{
  "tool": "ability-name-v1",
  "input": { "param1": "value1" }
}
\`\`\`

Or answer:
\`\`\`json
{
  "answer": "Your response here"
}
\`\`\``;
}
