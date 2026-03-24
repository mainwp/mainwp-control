#!/bin/bash
# mainwpcontrol bash completion script
#
# Installation:
#   source /path/to/mainwpcontrol/scripts/completions/mainwpcontrol.bash
#
# Or add to ~/.bashrc:
#   source /path/to/mainwpcontrol/scripts/completions/mainwpcontrol.bash

# Determine the directory where this script is located
_MAINWPCTL_COMPLETION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the profile completer helper
if [[ -f "${_MAINWPCTL_COMPLETION_DIR}/profile-completer.sh" ]]; then
    source "${_MAINWPCTL_COMPLETION_DIR}/profile-completer.sh"
fi

_mainwpcontrol_completions() {
    local cur prev words cword
    _init_completion -n : || return

    # All top-level commands
    local commands="abilities autocomplete chat doctor help jobs login profile"

    # Subcommands by topic
    local abilities_commands="info list run"
    local jobs_commands="watch"
    local profile_commands="delete list use"

    # Common flags (available on all commands)
    local common_flags="--debug --help --json --profile -p"

    # Command-specific flags
    local abilities_run_flags="--confirm --dry-run --force --input -i"
    local abilities_list_flags="--category"
    local chat_flags="--api-key --base-url --max-context-messages --max-turns --model --no-stream --provider --stream -m"
    local doctor_flags="--verbose -v"
    local jobs_watch_flags="--initial-delay --max-delay --no-progress --timeout"
    local login_flags="--name --password --skip-ssl-verify --url --username -n -u"

    # Get the position in the command structure
    local cmd_depth=0
    local main_cmd=""
    local sub_cmd=""

    for ((i=1; i < cword; i++)); do
        case "${words[i]}" in
            -*)
                # Skip flags and their values
                if [[ "${words[i]}" =~ ^--(profile|input|model|provider|api-key|base-url|max-turns|max-context-messages|category|timeout|initial-delay|max-delay|url|username|password|name)$ ]]; then
                    ((i++))  # Skip the value too
                fi
                ;;
            abilities|chat|doctor|help|jobs|login|profile|autocomplete)
                if [[ -z "$main_cmd" ]]; then
                    main_cmd="${words[i]}"
                    cmd_depth=1
                fi
                ;;
            info|list|run|watch|use|delete)
                if [[ -n "$main_cmd" && -z "$sub_cmd" ]]; then
                    sub_cmd="${words[i]}"
                    cmd_depth=2
                fi
                ;;
        esac
    done

    # Handle flag value completions
    case "$prev" in
        --profile|-p)
            # Complete with profile names
            local profiles
            if type _mainwpcontrol_get_profiles &>/dev/null; then
                profiles=$(_mainwpcontrol_get_profiles)
                COMPREPLY=($(compgen -W "$profiles" -- "$cur"))
            fi
            return 0
            ;;
        --provider)
            COMPREPLY=($(compgen -W "anthropic gemini local openai openrouter" -- "$cur"))
            return 0
            ;;
        --category)
            COMPREPLY=($(compgen -W "sites clients updates plugins themes core tags batch" -- "$cur"))
            return 0
            ;;
        --input|-i|--model|-m|--api-key|--base-url|--max-turns|--max-context-messages|--timeout|--initial-delay|--max-delay|--url|-u|--username|--password|--name|-n)
            # These flags require user input, no completion
            return 0
            ;;
    esac

    # Top-level command completion
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$commands" -- "$cur"))
        return 0
    fi

    # Subcommand and flag completion based on context
    case "$main_cmd" in
        abilities)
            if [[ -z "$sub_cmd" ]]; then
                # Complete subcommands or flags
                if [[ "$cur" == -* ]]; then
                    COMPREPLY=($(compgen -W "$common_flags" -- "$cur"))
                else
                    COMPREPLY=($(compgen -W "$abilities_commands" -- "$cur"))
                fi
            else
                # Complete flags for abilities subcommands
                case "$sub_cmd" in
                    run)
                        COMPREPLY=($(compgen -W "$common_flags $abilities_run_flags" -- "$cur"))
                        ;;
                    list)
                        COMPREPLY=($(compgen -W "$common_flags $abilities_list_flags" -- "$cur"))
                        ;;
                    info)
                        COMPREPLY=($(compgen -W "$common_flags" -- "$cur"))
                        ;;
                esac
            fi
            ;;
        chat)
            COMPREPLY=($(compgen -W "$common_flags $chat_flags" -- "$cur"))
            ;;
        doctor)
            COMPREPLY=($(compgen -W "$common_flags $doctor_flags" -- "$cur"))
            ;;
        help)
            # Complete with command names for help
            COMPREPLY=($(compgen -W "$commands" -- "$cur"))
            ;;
        jobs)
            if [[ -z "$sub_cmd" ]]; then
                if [[ "$cur" == -* ]]; then
                    COMPREPLY=($(compgen -W "$common_flags" -- "$cur"))
                else
                    COMPREPLY=($(compgen -W "$jobs_commands" -- "$cur"))
                fi
            else
                case "$sub_cmd" in
                    watch)
                        COMPREPLY=($(compgen -W "$common_flags $jobs_watch_flags" -- "$cur"))
                        ;;
                esac
            fi
            ;;
        login)
            COMPREPLY=($(compgen -W "$common_flags $login_flags" -- "$cur"))
            ;;
        profile)
            if [[ -z "$sub_cmd" ]]; then
                if [[ "$cur" == -* ]]; then
                    COMPREPLY=($(compgen -W "$common_flags" -- "$cur"))
                else
                    COMPREPLY=($(compgen -W "$profile_commands" -- "$cur"))
                fi
            else
                case "$sub_cmd" in
                    use|delete)
                        # Complete with profile names for these subcommands
                        if [[ "$cur" != -* ]]; then
                            local profiles
                            if type _mainwpcontrol_get_profiles &>/dev/null; then
                                profiles=$(_mainwpcontrol_get_profiles)
                                COMPREPLY=($(compgen -W "$profiles" -- "$cur"))
                            fi
                        else
                            COMPREPLY=($(compgen -W "$common_flags" -- "$cur"))
                        fi
                        ;;
                    list)
                        COMPREPLY=($(compgen -W "$common_flags" -- "$cur"))
                        ;;
                esac
            fi
            ;;
        autocomplete)
            COMPREPLY=($(compgen -W "bash zsh" -- "$cur"))
            ;;
        *)
            # Default: complete commands
            COMPREPLY=($(compgen -W "$commands" -- "$cur"))
            ;;
    esac

    return 0
}

# Register the completion function
complete -F _mainwpcontrol_completions mainwpcontrol
