/**
 * Default Chat Command for mainwpcontrol
 *
 * Running `mainwpcontrol` without a subcommand enters interactive chat mode.
 * This is the primary interaction surface.
 *
 * INVARIANT: AI is the interaction surface, not the execution authority.
 */

import { Args, Flags } from '@oclif/core';
import * as readline from 'node:readline';
import { BaseCommand, commonFlags } from '../lib/base-command.js';
import { ExitCode } from '../utils/exit-codes.js';
import { ChatEngine, createChatEngine, type ChatResponse } from '../chat/chat-engine.js';
import {
  createProvider,
  resolveProviderSelection,
  type ProviderConfig,
} from '../chat/providers/provider.js';
import type { PreviewResult } from '../core/safety-controller.js';
import { isInteractive } from '../utils/prompt.js';
import { stripControlChars } from '../utils/terminal-sanitizer.js';

// Import providers to register them
import '../chat/providers/index.js';

/**
 * Format preview for display
 */
function formatPreview(preview: PreviewResult): string {
  const lines: string[] = [];

  lines.push(`\n${'='.repeat(60)}`);
  lines.push(`PREVIEW: ${preview.abilityName}`);
  lines.push(`${'='.repeat(60)}`);
  lines.push('');
  lines.push(stripControlChars(preview.summary));

  if (preview.affected.length > 0) {
    lines.push('');
    lines.push('Affected items:');
    for (const item of preview.affected.slice(0, 10)) {
      const itemStr =
        typeof item === 'object' && item !== null
          ? JSON.stringify(item, null, 2)
          : stripControlChars(String(item));
      lines.push(`  - ${itemStr}`);
    }
    if (preview.affected.length > 10) {
      lines.push(`  ... and ${preview.affected.length - 10} more`);
    }
  }

  lines.push('');
  lines.push(`${'='.repeat(60)}`);

  return lines.join('\n');
}

/**
 * Format chat response for display
 */
function formatResponse(response: ChatResponse): string {
  switch (response.type) {
    case 'message':
      return stripControlChars(response.content);

    case 'tool_result':
      if (response.result.success) {
        // JSON.stringify already escapes control chars as \uXXXX — safe
        const data = JSON.stringify(response.result.data, null, 2);
        return `[${stripControlChars(response.tool)}]\n${data}`;
      } else {
        return `[${stripControlChars(response.tool)}] Error: ${stripControlChars(response.result.error?.message ?? 'Unknown error')}`;
      }

    case 'preview':
      return formatPreview(response.preview);

    case 'error':
      return `Error: ${stripControlChars(response.error)}`;
  }
}

export default class ChatCommand extends BaseCommand {
  static override description = 'Interactive chat mode for MainWP Dashboard management';

  static override examples = [
    {
      command: '<%= config.bin %>',
      description: 'Start interactive chat (streaming enabled by default)',
    },
    {
      command: '<%= config.bin %> --no-stream',
      description: 'Disable streaming for complete responses',
    },
    {
      command: '<%= config.bin %> --provider openai',
      description: 'Use OpenAI provider',
    },
    {
      command: '<%= config.bin %> --model gpt-4o',
      description: 'Use specific model',
    },
    {
      command: '<%= config.bin %> --max-context-messages 50',
      description: 'Use larger context window for complex workflows',
    },
  ];

  static override flags = {
    ...commonFlags,
    provider: Flags.string({
      description: 'LLM provider (openai, anthropic, gemini, openrouter, local)',
      env: 'MAINWP_LLM_PROVIDER',
    }),
    model: Flags.string({
      char: 'm',
      description: 'Model to use',
      env: 'MAINWP_LLM_MODEL',
    }),
    'api-key': Flags.string({
      description: 'LLM API key (DEPRECATED: use environment variables instead — CLI args are visible in process list)',
      env: 'MAINWP_LLM_API_KEY',
    }),
    'base-url': Flags.string({
      description: 'Custom API base URL',
    }),
    'max-turns': Flags.integer({
      description: 'Maximum tool calls per turn',
      default: 3,
    }),
    'max-context-messages': Flags.integer({
      description: 'Maximum messages to keep in context (default: 20, 0 = unlimited)',
    }),
    stream: Flags.boolean({
      description: 'Enable streaming responses (progressive output)',
      default: true,
      allowNo: true, // Allow --no-stream to disable
    }),
  };

  static override args = {
    message: Args.string({
      description: 'Single message to send (non-interactive mode)',
      required: false,
    }),
  };

  private chatEngine: ChatEngine | null = null;
  private rl: readline.Interface | null = null;
  private isStreaming = false;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ChatCommand);

    await this.initCommon(flags);

    // Non-interactive without a message: show help, exit
    if (!isInteractive() && !args.message) {
      this.logToStderr('Error: Interactive chat requires a terminal. Provide a message argument or use abilities run.');
      this.logToStderr('  mainwpcontrol "list all sites"              # single message');
      this.logToStderr('  mainwpcontrol abilities run list-sites-v1   # direct command');
      this.exit(ExitCode.INPUT_ERROR);
    }

    // SECURITY: Warn about process-visible API key
    if (flags['api-key'] && !process.env['MAINWP_LLM_API_KEY']) {
      this.logToStderr('Warning: Passing API keys via --api-key flag exposes them in the process list. Use environment variables instead.');
    }

    const providerResolution = resolveProviderSelection({
      flagProvider: flags.provider,
      settingsProvider: this.settings.llmProvider,
      apiKey: flags['api-key'],
      baseUrl: flags['base-url'],
      model: flags.model,
      timeout: this.settings.timeout,
    });

    for (const warning of providerResolution.warnings) {
      this.logToStderr(`Warning: ${warning}`);
    }

    if (!providerResolution.name) {
      this.error(
        'No LLM provider configured. Set one of:\n' +
          '  - ANTHROPIC_API_KEY for Anthropic Claude\n' +
          '  - OPENAI_API_KEY for OpenAI\n' +
          '  - GOOGLE_API_KEY for Google Gemini\n' +
          '  - OPENROUTER_API_KEY for OpenRouter\n' +
          '  - LOCAL_LLM_API_KEY for local endpoints (optional LOCAL_LLM_URL)\n' +
          'Or specify --provider and environment variables / --api-key.',
        { exit: 2 }
      );
    }

    const providerName = providerResolution.name;
    const providerConfig: ProviderConfig = providerResolution.config;

    if (!providerResolution.configured) {
      this.error(
        `No API key for ${providerName}. Set the appropriate environment variable or use --api-key.`,
        { exit: 2 }
      );
    }

    // Create provider
    const provider = createProvider(providerName, providerConfig);

    // Get executor
    const executor = await this.getExecutor();

    // Determine if streaming should be enabled
    // Disable streaming for JSON output since we need clean JSON structure
    this.isStreaming = flags.stream && !this.jsonOutput;

    const maxContextMessages = flags['max-context-messages'] ?? this.settings.chatContextMessages;
    this.debugLog('Resolved LLM provider', {
      provider: providerName,
      source: providerResolution.source,
      timeoutMs: this.settings.timeout,
      maxContextMessages,
      streaming: this.isStreaming,
    });

    // Create chat engine
    const engineOptions: Parameters<typeof createChatEngine>[0] = {
      provider,
      executor,
      maxToolCallsPerTurn: flags['max-turns'],
      stream: this.isStreaming,
    };

    // Add streaming callback if streaming is enabled
    if (this.isStreaming) {
      engineOptions.onStreamChunk = (content: string) => {
        // SECURITY: Sanitize streamed content from untrusted LLM provider
        process.stdout.write(stripControlChars(content));
      };
    }

    if (flags.model) {
      engineOptions.model = flags.model;
    }

    // Handle context window configuration
    // 0 = unlimited (no truncation), positive number = that limit, undefined = use default (20)
    if (maxContextMessages !== undefined) {
      engineOptions.maxContextMessages = maxContextMessages;
    }

    this.chatEngine = createChatEngine(engineOptions);

    // Initialize
    if (!this.jsonOutput) {
      this.log('Initializing chat...');
    }
    await this.chatEngine.initialize();

    const info = this.chatEngine.getProviderInfo();
    if (!this.jsonOutput) {
      this.log(`Connected to ${info.name} (${info.model})`);
      this.log(`Loaded ${this.chatEngine.getAbilities().length} abilities`);
      this.log('');
    }

    // Check for single message (non-interactive)
    if (args.message) {
      await this.handleSingleMessage(args.message);
      return;
    }

    // Interactive mode
    await this.runInteractive();
  }

  /**
   * Handle a single message (non-interactive mode)
   */
  private async handleSingleMessage(message: string): Promise<void> {
    const responses = await this.chatEngine!.sendMessage(message);

    if (this.jsonOutput) {
      // Select the terminal-state response for JSON output.
      // preview/error: singular (loop breaks after producing one), so find() is correct.
      // tool_result: multiple can accumulate in multi-step turns, so findLast()
      // ensures we return the final outcome, not an intermediate step.
      const jsonResponse =
        responses.find((response) => response.type === 'preview') ??
        responses.find((response) => response.type === 'error') ??
        responses.findLast((response) => response.type === 'tool_result') ??
        responses.at(-1);

      if (jsonResponse) {
        this.log(JSON.stringify(jsonResponse, null, 2));
      }

      return;
    }

    for (const response of responses) {
      // Add newline after streamed content (streaming doesn't include final newline)
      if (this.isStreaming && response.type === 'message') {
        this.log(''); // Blank line after streamed content
      }

      // For streaming message responses, content already displayed via callback
      // Skip duplicate display but still handle other response types
      if (!(this.isStreaming && response.type === 'message')) {
        this.log(formatResponse(response));
      }

      // If preview is pending, we can't continue in non-interactive
      if (response.type === 'preview') {
        if (!this.jsonOutput) {
          this.log('\nDestructive action requires approval.');
          this.log('Run in interactive mode to approve.');
        }
        return;
      }
    }
  }

  /**
   * Run interactive chat loop
   */
  private async runInteractive(): Promise<void> {
    this.log('Type your message and press Enter. Type "exit" or Ctrl+C to quit.');
    this.log('');

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Handle Ctrl+C gracefully
    this.rl.on('close', () => {
      this.log('\nGoodbye!');
      this.exit(0);
    });

    const prompt = () => {
      const pendingPreview = this.chatEngine!.hasPendingPreview();
      const promptText = pendingPreview
        ? 'Approve? (yes/no): '
        : 'You: ';

      this.rl!.question(promptText, async (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          prompt();
          return;
        }

        // Exit commands
        if (
          trimmed.toLowerCase() === 'exit' ||
          trimmed.toLowerCase() === 'quit' ||
          trimmed.toLowerCase() === 'q'
        ) {
          this.log('Goodbye!');
          this.rl!.close();
          return;
        }

        // Help command
        if (trimmed.toLowerCase() === 'help') {
          this.printHelp();
          prompt();
          return;
        }

        // Clear history
        if (trimmed.toLowerCase() === 'clear') {
          this.chatEngine!.clearHistory();
          this.log('Conversation cleared.');
          prompt();
          return;
        }

        // Cancel pending preview
        if (
          pendingPreview &&
          (trimmed.toLowerCase() === 'cancel' || trimmed.toLowerCase() === 'no')
        ) {
          this.chatEngine!.cancelPendingPreview();
          this.log('Operation cancelled.');
          prompt();
          return;
        }

        try {
          const responses = await this.chatEngine!.sendMessage(trimmed);

          for (const response of responses) {
            // Add newline before response
            this.log('');

            // Handle streaming: content already displayed via callback
            if (this.isStreaming && response.type === 'message') {
              // Content was streamed, just add spacing
              // No need to display again
            } else {
              this.log(formatResponse(response));
            }
          }

          // Check for pending preview
          if (this.chatEngine!.hasPendingPreview()) {
            this.log('');
            this.log('This is a destructive action. Type "yes" to approve or "no" to cancel.');
          }
        } catch (error) {
          this.logToStderr(
            `Error: ${stripControlChars(error instanceof Error ? error.message : String(error))}`
          );
        }

        this.log('');
        prompt();
      });
    };

    prompt();

    // Keep process alive
    await new Promise(() => {});
  }

  /**
   * Print help information
   */
  private printHelp(): void {
    this.log('');
    this.log('Commands:');
    this.log('  help    - Show this help message');
    this.log('  clear   - Clear conversation history');
    this.log('  exit    - Exit chat');
    this.log('');
    this.log('Examples:');
    this.log('  "List all sites"');
    this.log('  "Show me plugins with updates"');
    this.log('  "Delete site example.com" (will ask for confirmation)');
    this.log('');
    this.log('Streaming:');
    this.log('  Responses stream by default for faster feedback.');
    this.log('  Use --no-stream flag to wait for complete responses.');
    this.log('');
    this.log('Destructive actions will show a preview and require approval.');
    this.log('');
  }

  /**
   * Cleanup on exit
   */
  protected override async finally(_: Error | undefined): Promise<void> {
    if (this.rl) {
      this.rl.close();
    }
  }
}
