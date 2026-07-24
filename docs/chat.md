# Chat Mode

`mainwpcontrol chat` lets you manage your Dashboard in plain English, using your own LLM API key:

```bash
export ANTHROPIC_API_KEY='sk-ant-...'

mainwpcontrol chat
mainwpcontrol chat "list all sites with pending updates"
```

Chat is optional. Every operation it can perform is also a plain `abilities run` command, and nothing else in the CLI depends on it. It earns its place for exploration: when you don't know which ability you need, or you want to chain a few lookups without writing the JSON yourself.

## Providers

Set one API key to enable chat. With multiple keys set, the provider is auto-detected; override with `MAINWP_LLM_PROVIDER` or `--provider`.

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LOCAL_LLM_API_KEY` | Local LLM (with optional `LOCAL_LLM_URL`, defaults to localhost) |

`MAINWP_LLM_API_KEY` works as a generic key for whichever provider is selected. Pick a model with `MAINWP_LLM_MODEL` or `--model`. Persistent defaults (`llmProvider`, `chatContextMessages`) go in `~/.config/mainwpcontrol/settings.json`; see [Configuration](configuration.md#settings-file).

## Flags

| Flag | Description |
|------|-------------|
| `--provider` | Choose the LLM provider explicitly |
| `--model` | Choose the model |
| `--max-turns` | Limit conversation turns |
| `--max-context-messages` | Limit messages kept in context |
| `--no-stream` | Disable streamed responses |
| `--api-key` | API key for the provider; prefer the environment variable, since flags are visible in the process list |
| `--base-url` | Endpoint override for local or proxied providers |

## Safety

The model proposes; it never confirms or executes on its own. Chat runs abilities through the same execution path and policy as the CLI commands, so the classification and confirm rules in [Safety & Destructive Operations](safety.md) apply unchanged:

- Read and write abilities the model calls are executed and the results returned to the conversation.
- A destructive ability stops the conversation: you see a successful preview of what would be affected, and it runs only after your explicit approval at the terminal.
- Approvals are single-use. Approving one deletion does not pre-approve the next one.
- The model cannot set `confirm` or `dry_run` itself; those come from your terminal, never from the conversation.

## What the provider sees

Chat sends more to the LLM provider than the conversation text. Per request, the provider receives:

- your messages and the model's own prior turns
- every discovered ability's name, description, and input JSON schema, sent as tool definitions so the model knows what it can call
- the inputs the model proposes for each call
- ability results and error messages, with credential material redacted before serialization

Your Application Password and your provider API key are never part of the payload. Ability results are your real site data, so treat chat the way you'd treat pasting that data into an AI tool, and pick your provider accordingly (including the local provider, which keeps everything on your machine).

## Scripting note

Chat is interactive by design. In non-TTY environments (pipes, CI), `mainwpcontrol chat` without a message argument exits with guidance instead of hanging. For automation, use `abilities run`; that's what it's for.
