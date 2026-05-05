# TOOLS.md - Hermes Obsidian Tool Guidelines

Use this as optional vault-root context for Hermes Agent.

## Vault tools

- `read`: inspect existing vault files before editing.
- `write`: create new files only.
- `edit`: modify existing files with precise old/new text.
- `rg` / vault search: search large files or the vault when context is incomplete.

## Safety rules

- Never use absolute paths for vault edits.
- Never edit `.obsidian/` configuration files unless explicitly asked.
- Do not expose API keys, gateway tokens, passwords, or private connection strings.
- Prefer small, reviewable edits.
- For source notes, preserve the raw source text and put interpretation in a separate section or note.

## Large files

The plugin can attach relevant excerpts from large active/attached notes. If the provided excerpt is insufficient, ask Hermes to search the vault or use an explicit keyword search.
