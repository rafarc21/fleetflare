#!/usr/bin/env bash
# junior.sh — delegate a mechanical edit to a Workers AI model. See SKILL.md.
set -euo pipefail
exec bun "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src/main.ts" "$@"
