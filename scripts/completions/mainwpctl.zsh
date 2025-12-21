#compdef mainwpctl
# mainwpctl zsh completion script
#
# Installation:
#   source /path/to/mainwpctl/scripts/completions/mainwpctl.zsh
#
# Or add to ~/.zshrc:
#   source /path/to/mainwpctl/scripts/completions/mainwpctl.zsh

# Determine the directory where this script is located
_MAINWPCTL_COMPLETION_DIR="${0:A:h}"

# Source the profile completer helper
if [[ -f "${_MAINWPCTL_COMPLETION_DIR}/profile-completer.sh" ]]; then
    source "${_MAINWPCTL_COMPLETION_DIR}/profile-completer.sh"
fi

# Helper function to get profile names for completion
_mainwpctl_profiles() {
    local profiles
    if (( $+functions[_mainwpctl_get_profiles] )); then
        profiles=("${(@f)$(_mainwpctl_get_profiles)}")
        _describe -t profiles 'profile' profiles
    fi
}

# Main completion function
_mainwpctl() {
    local curcontext="$curcontext" state line
    typeset -A opt_args

    # Common flags available on all commands
    local -a common_flags
    common_flags=(
        '--debug[Show debug output]'
        '--help[Show help]'
        '--json[Output JSON (for scripting/CI)]'
        '(-p --profile)'{-p,--profile}'[Use a specific profile]:profile:_mainwpctl_profiles'
    )

    # Top-level commands
    local -a commands
    commands=(
        'abilities:Manage and execute abilities'
        'autocomplete:Display autocomplete installation instructions'
        'chat:Interactive chat mode for MainWP Dashboard management'
        'doctor:Check configuration and connectivity'
        'help:Display help for a command'
        'jobs:Manage batch jobs'
        'login:Authenticate with a MainWP Dashboard'
        'profile:Manage connection profiles'
    )

    _arguments -C \
        $common_flags \
        '1: :->command' \
        '*:: :->args'

    case "$state" in
        command)
            _describe -t commands 'mainwpctl commands' commands
            ;;
        args)
            case "$words[1]" in
                abilities)
                    _mainwpctl_abilities
                    ;;
                autocomplete)
                    _mainwpctl_autocomplete
                    ;;
                chat)
                    _mainwpctl_chat
                    ;;
                doctor)
                    _mainwpctl_doctor
                    ;;
                help)
                    _mainwpctl_help
                    ;;
                jobs)
                    _mainwpctl_jobs
                    ;;
                login)
                    _mainwpctl_login
                    ;;
                profile)
                    _mainwpctl_profile
                    ;;
            esac
            ;;
    esac
}

# Abilities command completions
_mainwpctl_abilities() {
    local -a subcommands
    subcommands=(
        'info:Get detailed information about an ability'
        'list:List available abilities'
        'run:Execute an ability'
    )

    _arguments -C \
        $common_flags \
        '1: :->subcommand' \
        '*:: :->args'

    case "$state" in
        subcommand)
            _describe -t commands 'abilities subcommands' subcommands
            ;;
        args)
            case "$words[1]" in
                info)
                    _arguments \
                        $common_flags \
                        '1:ability name:'
                    ;;
                list)
                    _arguments \
                        $common_flags \
                        '--category[Filter by category]:category:(sites clients updates plugins themes core tags batch)'
                    ;;
                run)
                    _arguments \
                        $common_flags \
                        '(-i --input)'{-i,--input}'[Input parameters as JSON]:input:' \
                        '--dry-run[Preview changes without executing]' \
                        '--confirm[Execute destructive ability (after preview)]' \
                        '--force[Skip confirmation prompt (use with --confirm)]' \
                        '1:ability name:'
                    ;;
            esac
            ;;
    esac
}

# Autocomplete command completions
_mainwpctl_autocomplete() {
    _arguments \
        '1:shell:(bash zsh)'
}

# Chat command completions
_mainwpctl_chat() {
    _arguments \
        $common_flags \
        '--provider[LLM provider]:provider:(anthropic gemini local openai openrouter)' \
        '(-m --model)'{-m,--model}'[Model to use]:model:' \
        '--api-key[LLM API key (overrides environment)]:api key:' \
        '--base-url[Custom API base URL]:url:' \
        '--max-turns[Maximum tool calls per turn]:turns:' \
        '--max-context-messages[Maximum messages to keep in context]:messages:' \
        '--stream[Enable streaming responses]' \
        '--no-stream[Disable streaming responses]' \
        '1:message:'
}

# Doctor command completions
_mainwpctl_doctor() {
    _arguments \
        $common_flags \
        '(-v --verbose)'{-v,--verbose}'[Verbose output]'
}

# Help command completions
_mainwpctl_help() {
    local -a commands
    commands=(
        'abilities'
        'autocomplete'
        'chat'
        'doctor'
        'help'
        'jobs'
        'login'
        'profile'
    )

    _arguments \
        '1:command:($commands)'
}

# Jobs command completions
_mainwpctl_jobs() {
    local -a subcommands
    subcommands=(
        'watch:Monitor a batch job'
    )

    _arguments -C \
        $common_flags \
        '1: :->subcommand' \
        '*:: :->args'

    case "$state" in
        subcommand)
            _describe -t commands 'jobs subcommands' subcommands
            ;;
        args)
            case "$words[1]" in
                watch)
                    _arguments \
                        $common_flags \
                        '--timeout[Maximum time to wait in seconds]:seconds:' \
                        '--initial-delay[Initial polling delay in seconds]:seconds:' \
                        '--max-delay[Maximum polling delay in seconds]:seconds:' \
                        '--no-progress[Disable progress output]' \
                        '1:job id:'
                    ;;
            esac
            ;;
    esac
}

# Login command completions
_mainwpctl_login() {
    _arguments \
        $common_flags \
        '(-u --url)'{-u,--url}'[Dashboard URL]:url:' \
        '--username[WordPress admin username]:username:' \
        '--password[Application password]:password:' \
        '(-n --name)'{-n,--name}'[Profile name]:name:' \
        '--skip-ssl-verify[Skip SSL certificate verification]'
}

# Profile command completions
_mainwpctl_profile() {
    local -a subcommands
    subcommands=(
        'delete:Delete a profile'
        'list:List all profiles'
        'use:Switch active profile'
    )

    _arguments -C \
        $common_flags \
        '1: :->subcommand' \
        '*:: :->args'

    case "$state" in
        subcommand)
            _describe -t commands 'profile subcommands' subcommands
            ;;
        args)
            case "$words[1]" in
                delete)
                    _arguments \
                        $common_flags \
                        '1:profile name:_mainwpctl_profiles'
                    ;;
                list)
                    _arguments \
                        $common_flags
                    ;;
                use)
                    _arguments \
                        $common_flags \
                        '1:profile name:_mainwpctl_profiles'
                    ;;
            esac
            ;;
    esac
}

# Register the completion function
compdef _mainwpctl mainwpctl
