#!/bin/sh
# profile-completer.sh - Helper script to get available mainwpcontrol profile names
# This script is sourced by shell completion scripts to provide dynamic profile completion.
#
# Usage: source this file, then call _mainwpcontrol_get_profiles
#
# Returns profile names one per line, empty if no profiles exist or config is missing.

_mainwpcontrol_get_profiles() {
    local config_file="${XDG_CONFIG_HOME:-$HOME/.config}/mainwpcontrol/profiles.json"

    # Exit silently if config file doesn't exist
    if [ ! -f "$config_file" ]; then
        return 0
    fi

    # Try jq first (most reliable JSON parsing)
    if command -v jq >/dev/null 2>&1; then
        jq -r '.profiles | keys[]' "$config_file" 2>/dev/null
        return 0
    fi

    # Fallback: use grep/sed for simple JSON parsing
    # This handles: {"profiles":{"name1":{...},"name2":{...}}}
    # Extract keys after "profiles": and before their values
    grep -o '"profiles"[[:space:]]*:[[:space:]]*{[^}]*}' "$config_file" 2>/dev/null | \
        grep -o '"[^"]*"[[:space:]]*:' | \
        sed 's/"//g; s/[[:space:]]*://g' | \
        grep -v '^profiles$' 2>/dev/null
}

# If called directly (not sourced), output profile names
if [ "${0##*/}" = "profile-completer.sh" ]; then
    _mainwpcontrol_get_profiles
fi
