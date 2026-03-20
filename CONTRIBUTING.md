# Contributing to MainWP Control

MainWP Control is in maintenance mode post-v1.0. The following types of contributions are accepted:

## Accepted

- **Bug fixes** that correct broken functionality
- **Security patches** and dependency updates
- **Abilities API compatibility** changes (when the upstream API evolves)

## Not Accepted

- New commands, flags, or features
- UI/UX enhancements beyond correctness
- Refactoring for style preferences

## Requirements

All contributions must:

1. Include tests that validate the change
2. Pass `npm run lint && npm run typecheck && npm test`
3. Not break existing exit code or JSON output contracts
4. Follow the safety model (destructive actions require preview + confirm)

## Development

```bash
# Install dependencies
npm ci

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Safety Invariants

These must never be violated:

- `--dry-run` and `--confirm` are mutually exclusive
- Destructive abilities always require explicit flags
- All `--json` output follows the `CLIOutput<T>` envelope
- Exit codes are stable (0-5 mapping documented in README)
