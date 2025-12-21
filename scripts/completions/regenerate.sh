#!/bin/bash
# regenerate.sh - Regenerate shell completion scripts for mainwpctl
#
# This script helps developers update completion scripts after CLI changes.
# Run this after adding, removing, or modifying commands or flags.
#
# Usage: ./scripts/completions/regenerate.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Shell Completion Regeneration Helper"
echo "====================================="
echo ""
echo "The mainwpctl completion scripts are manually maintained to provide"
echo "optimal completion behavior with dynamic profile name completion."
echo ""
echo "After adding, removing, or modifying commands/flags, you should update:"
echo ""
echo "  1. $SCRIPT_DIR/mainwpctl.bash"
echo "     - Update 'commands' variable for new top-level commands"
echo "     - Update '*_commands' variables for new subcommands"
echo "     - Update '*_flags' variables for new flags"
echo ""
echo "  2. $SCRIPT_DIR/mainwpctl.zsh"
echo "     - Update 'commands' array for new top-level commands"
echo "     - Update subcommand arrays in respective functions"
echo "     - Update _arguments calls for new flags"
echo ""
echo "Testing completions:"
echo "  # Bash"
echo "  source $SCRIPT_DIR/mainwpctl.bash"
echo "  mainwpctl <TAB>"
echo ""
echo "  # Zsh"
echo "  source $SCRIPT_DIR/mainwpctl.zsh"
echo "  mainwpctl <TAB>"
echo ""

# Verify files exist
echo "Checking completion files..."

if [[ -f "$SCRIPT_DIR/mainwpctl.bash" ]]; then
    echo "  [OK] mainwpctl.bash"
else
    echo "  [MISSING] mainwpctl.bash"
fi

if [[ -f "$SCRIPT_DIR/mainwpctl.zsh" ]]; then
    echo "  [OK] mainwpctl.zsh"
else
    echo "  [MISSING] mainwpctl.zsh"
fi

if [[ -f "$SCRIPT_DIR/profile-completer.sh" ]]; then
    echo "  [OK] profile-completer.sh"
else
    echo "  [MISSING] profile-completer.sh"
fi

echo ""
echo "Extracting current CLI structure..."
echo ""

# Try to extract commands from the built CLI
if [[ -x "$PROJECT_ROOT/bin/run.js" ]]; then
    echo "Top-level commands:"
    "$PROJECT_ROOT/bin/run.js" --help 2>/dev/null | grep -E '^\s+[a-z]+\s' | awk '{print "  - " $1}' || echo "  (could not extract)"
    echo ""
else
    echo "Note: Build the project first to extract command structure:"
    echo "  npm run build"
    echo ""
fi

echo "Done. Remember to commit your changes after updating completion scripts."
