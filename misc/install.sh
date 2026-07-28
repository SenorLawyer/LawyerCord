#!/usr/bin/env bash

set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
    echo "Run this wrapper as a normal user, not as root." >&2
    exit 1
fi

if [[ -z "${LAWYERCORD_INSTALLER_PATH:-}" ]]; then
    echo "Refusing to download and execute a mutable installer release." >&2
    echo "Set LAWYERCORD_INSTALLER_PATH to an installer binary you built or verified locally." >&2
    exit 1
fi

installer_path="$(realpath "$LAWYERCORD_INSTALLER_PATH")"
if [[ ! -f "$installer_path" || ! -x "$installer_path" ]]; then
    echo "LAWYERCORD_INSTALLER_PATH must point to an existing executable file." >&2
    exit 1
fi

privilege_command=""
for candidate in sudo doas; do
    if command -v "$candidate" >/dev/null 2>&1; then
        privilege_command="$candidate"
        break
    fi
done

if [[ -z "$privilege_command" ]]; then
    echo "Neither sudo nor doas is available." >&2
    exit 1
fi

exec "$privilege_command" "$installer_path" "$@"
