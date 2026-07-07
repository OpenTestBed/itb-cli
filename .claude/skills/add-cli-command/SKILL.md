---
name: add-cli-command
description: Add or modify an itb CLI command. Use for new subcommands or flags in the plugins/suite groups.
---
1. Commands live in src/commands/<group>/<name>.ts; keep groups symmetric.
2. Anything that changes state must go through the lockfile module (src/compose) —
   no direct docker or file mutations from command code.
3. All ITB REST access via src/itb-client (never poke MySQL — that was an
   itb-test-manager anti-pattern).
4. Every command: --json output mode, non-zero exit on failure, e2e case.
