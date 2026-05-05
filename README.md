<img width="255" height="217" alt="hermes-terminal-icon-transparent" src="https://github.com/user-attachments/assets/14317cd8-c808-4310-8a87-097ac876a43d" />
# Obsidian Hermes

**Obsidian Hermes** is an experimental Obsidian desktop plugin adapted for use with **Hermes Agent** and Hermes-compatible OpenAI-style API servers.

It provides a vault-aware chat panel inside Obsidian, supports Hermes Agent slash commands, and adds workflow-oriented commands for working with notes and other vault content. It is designed to run in ordinary Obsidian vaults without requiring a private folder structure.

## Provenance

This plugin is a derivative work based on the original **obsidian-clawdian** plugin:

<https://github.com/Osamadhi/obsidian-clawdian>

The original plugin was designed for OpenClaw Agent + ObsidianMD. This repository adapts that work toward a Hermes Agent-focused Obsidian plugin.

The adaptation was created with assistance from **Hermes Agent**.

## What was changed / implemented

Compared with the original `obsidian-clawdian` plugin, this derivative version has been modified to better fit Hermes Agent workflows and terminology.

Implemented or changed items include:

- Renamed and rebranded the plugin for Hermes Agent use.
- Updated the Obsidian plugin manifest to use the `obsidian-hermes` plugin id.
- Replaced visible OpenClaw / Clawdian branding in the main UI with Hermes-oriented branding.
- Added bundled Hermes Agent iconography:
  - Obsidian ribbon icon replaced with Hermes terminal-style SVG artwork.
  - Chat welcome icon next to “Hey there” replaced with the same colored Hermes terminal-style SVG.
- Added support for Hermes-style commands, including direct slash commands such as:
  - `/setup`
  - `/help`
  - `/commands`
  - `/status`
  - `/model`
  - `/tools`
  - `/skills`
  - `/skill <name>`
  - `/new`
  - `/clear`
  - `/resume`
  - `/save`
- Added support for the explicit command form:
  - `hermes /setup`
  - `hermes /help`
  - and similar Hermes-prefixed command messages.
- Added workflow-oriented slash commands that work without a required vault layout.
- Added built-in workflow commands such as:
  - `/workflow-review-note`
  - `/workflow-create-note`
  - `/workflow-research-pack`
- Added optional dynamic workflow command discovery for Markdown workflow files stored in a user-configured vault-relative folder.

- Updated API naming and defaults for Hermes Agent compatibility.
- Preserved compatibility with OpenAI-style `/v1/chat/completions` endpoints.
- Added or retained support for streaming assistant responses.
- Added vault-aware context behavior, including active note and file attachment context.
- Preserved local conversation storage and Markdown conversation export behavior.
- Improved security handling for AI-proposed file actions:
  - Vault file mutations require explicit user confirmation.
  - File-action paths must be relative vault paths.
  - Absolute paths are rejected.
  - `..` path traversal is rejected.
  - Empty path segments are rejected.
  - Writes into `.obsidian` configuration paths are rejected.
  - Oversized action payloads are rejected.
- Kept some legacy compatibility paths where useful for migration, including legacy OpenClaw action block parsing and environment-variable fallback.

## Features

Current experimental features include:

- Hermes Agent chat panel inside Obsidian.
- Streaming responses from a configured Hermes-compatible API server.
- OpenAI-compatible chat-completions request format.
- Slash command menu.
- Hermes Agent command forwarding.
- `hermes /command` normalization.
- Active-note context.
- Selected-text context.
- `@` file mentions / file attachment context.
- Image paste / image attachment support where supported by the configured model/API.
- Inline editing with diff review.
- Local conversation persistence.
- Markdown conversation export.
- Optional audit log for file actions.
- Workflow commands, with optional discovery from a configured workflow folder.

## Installation in Obsidian

This plugin is not installed through the Obsidian Community Plugins browser. Install it manually as a local plugin.

### 1. Locate your Obsidian vault

Open the folder for the Obsidian vault where you want to use the plugin.

Inside that vault, create this folder if it does not already exist:

```text
.obsidian/plugins/obsidian-hermes/
```

The full path should look like this:

```text
<your-vault>/.obsidian/plugins/obsidian-hermes/
```

### 2. Copy the plugin files

Copy these files into the folder above:

```text
main.js
manifest.json
styles.css
```

The final folder should look like this:

```text
<your-vault>/.obsidian/plugins/obsidian-hermes/
├── main.js
├── manifest.json
└── styles.css
```

Note: the required Obsidian stylesheet file is named `styles.css`, not `style.css`.

### 3. Enable community plugins

In Obsidian:

1. Open **Settings**.
2. Go to **Community plugins**.
3. If restricted mode is enabled, disable restricted mode.
4. Find **Hermes Agent** in the installed plugins list.
5. Enable the plugin.

### 4. Open the plugin

After enabling it, use one of these methods:

- Click the Hermes icon in the left ribbon.
- Open the command palette and run **Open Hermes**.

## Configuration

Open:

```text
Obsidian → Settings → Hermes Agent
```

Typical settings:

| Setting | Suggested value |
|---|---|
| Gateway URL | `http://127.0.0.1:8642` or your Hermes Agent API server URL |
| Gateway Token | Your Hermes API token, if required |
| Default model | `hermes/obsidian` or the model routed by your server |
| Scopes header | Leave empty unless your Hermes API server explicitly requires `x-hermes-scopes` |
| Workflow folder | Optional vault-relative folder for Markdown workflows, e.g. `Hermes/workflows` or `_agent/workflows`; leave empty if unused |

The plugin sends chat requests to an OpenAI-compatible endpoint:

```text
/v1/chat/completions
```

## Using Hermes Agent commands

You can type Hermes commands directly into the chat box, for example:

```text
/setup
/help
/commands
/status
/tools
/skills
```

You can also use the explicit Hermes form:

```text
hermes /setup
```

The plugin normalizes `hermes /setup` to `/setup` before forwarding it to the configured Hermes Agent API server.

## Workflow commands

The plugin includes built-in workflow helper commands:

| Command | Purpose |
|---|---|
| `/workflow-review-note` | Review the active note for structure, claims, links, tags, stale claims, and next edits. |
| `/workflow-create-note` | Draft a new vault-native Markdown note. |
| `/workflow-research-pack` | Build a concise research/context pack. |

These built-in commands do not require any special vault folders.

If you configure **Settings → Hermes Agent → Advanced → Workflow folder** with a vault-relative folder, the plugin can expose Markdown files in that folder as workflow commands using this pattern:

```text
/workflow-<workflow-file-name>
```

For example, if the workflow folder is `Hermes/workflows`, a file like:

```text
Hermes/workflows/review-note.md
```

may be exposed as:

```text
/workflow-review-note
```

Each generated workflow command asks Hermes Agent to read and apply the corresponding workflow file. The folder is optional and may be any vault-relative path; `_agent/workflows` is supported only if the user explicitly configures it.

## Data storage

The plugin may create or use these vault-local paths:

| Data | Location |
|---|---|
| Conversations | `<vault>/Hermes/conversations/*.json` |
| Markdown exports | `<vault>/Hermes/conversations/md/*.md` |
| Settings | `<vault>/.obsidian/plugins/obsidian-hermes/data.json` |
| Optional audit log | `<vault>/Hermes/audit-log.md` |

## Security notes

This plugin can send vault content to the configured API server.

Depending on how you use it, sent content may include:

- Your messages.
- Active-note text.
- Selected text.
- Attached files.
- File paths and note names.
- Pasted or attached images.
- Conversation history.

Only connect the plugin to API servers you trust.

The adaptation includes some security mitigations for AI-proposed file operations, including confirmation prompts and path validation. However, these mitigations do not make the plugin risk-free.

Important cautions:

- Review every proposed file action before approving it.
- Do not connect the plugin to unknown or untrusted API endpoints.
- Do not paste secrets, private keys, passwords, tokens, or confidential material unless you intentionally want the configured API endpoint to receive them.
- Back up your vault before testing file-editing features.
- Treat AI-generated edits as suggestions requiring human review.

## Disclaimer

This plugin is provided **as is**.

It is an experimental derivative of `obsidian-clawdian`, adapted with the assistance of **Hermes Agent** and other AI-assisted development workflows.

Security risks were considered and mitigation steps were requested and implemented where practical, but there is **no guarantee** that all security issues, bugs, data-loss risks, privacy risks, or compatibility problems have been found or fixed.

This plugin has **not been fully tested**.

Use it with caution, with backups, and with the understanding that it is in an **alpha / “alfa” state**.

You are responsible for deciding whether it is appropriate to use with your vault, your data, and your configured AI/API endpoint.

## License

This repository is a derivative of the original `obsidian-clawdian` project:

<https://github.com/Osamadhi/obsidian-clawdian>

The original project is licensed under the MIT License. This derivative should preserve the original license terms and attribution.
