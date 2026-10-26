<div align="center">

# DiskSweep MCP

**Find what is filling your Mac. Understand it. Review what goes.**

A local Model Context Protocol (MCP) server for disk analysis and cleanup.
Connect it to your assistant to inspect disk usage, investigate unfamiliar folders, and prepare a cleanup proposal.

[![npm](https://img.shields.io/npm/v/disksweep-mcp?style=flat-square&color=cb3837)](https://www.npmjs.com/package/disksweep-mcp)
[![Tests](https://img.shields.io/github/actions/workflow/status/gautamjajoo/disksweep-mcp/test.yml?branch=main&style=flat-square&label=tests)](https://github.com/gautamjajoo/disksweep-mcp/actions/workflows/test.yml)
[![macOS](https://img.shields.io/badge/macOS-11%2B-111827?style=flat-square&logo=apple)](#requirements)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square&logo=nodedotjs&logoColor=white)](#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [Usage](#usage) · [Tools](#tools) · [Safety](#safety) · [Contributing](#contributing)

</div>

## Why DiskSweep?

Disk usage tools show where space goes. DiskSweep gives your assistant the measurements and context to help explain what those folders are, what can be recreated, and what needs your review.

- **Measure actual disk usage.** A native macOS scanner accounts for exact APFS clones and hard links. Later scans use the macOS change journal to refresh changed folders when possible.
- **Find common cleanup candidates.** Rules cover app caches, logs, package managers, development tools, and AI tools. Other detectors find stale build folders, old downloads, unused apps, and app leftovers.
- **Investigate the unfamiliar.** Large folders without a matching rule appear separately. Inspect their file types, ages, likely owner app, and signs of databases or media before making a recommendation.
- **Keep context between chats.** Save findings, remember what to keep, review cleanup history, and see when a folder grows back.
- **Review a concrete proposal.** Cleanup operates on numbered proposal items. The server checks paths again before moving them to the Trash.

## Quick start

### Requirements

- **macOS 11 or later**, on Apple Silicon or Intel. Windows and Linux are not supported yet.
- **Node.js 20 or later** to run the server. For building and testing, use Node.js 22.12 or later.
- An MCP client that can launch a local server over **stdio**, the standard input/output connection used by this package.

### Run with npm

```sh
npx -y disksweep-mcp --version
```

No global installation is needed. Your MCP client starts the server through `npx` when it connects.

### Connect your assistant

Add this server to your client's MCP configuration. The client will download and run the npm package.

```json
{
  "mcpServers": {
    "disksweep": {
      "command": "npx",
      "args": ["-y", "disksweep-mcp"]
    }
  }
}
```

<details>
<summary><strong>Claude Code</strong></summary>

```sh
claude mcp add disksweep -- npx -y disksweep-mcp
```

See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for scope and connection settings.

</details>

<details>
<summary><strong>Codex</strong></summary>

Add this entry to `~/.codex/config.toml`:

```toml
[mcp_servers.disksweep]
command = "npx"
args = ["-y", "disksweep-mcp"]
```

See the [Codex MCP documentation](https://developers.openai.com/codex/mcp/) for connection and tool approval settings.

</details>

<details>
<summary><strong>Claude Desktop, Cursor, and other local MCP clients</strong></summary>

Use the JSON configuration above in the client's MCP settings. Claude Desktop uses `claude_desktop_config.json`; [Cursor](https://cursor.com/docs/mcp) uses `.cursor/mcp.json` in a project or `~/.cursor/mcp.json` globally. Other clients may use a different configuration structure. The server command is `npx`, with `-y` and `disksweep-mcp` as its arguments.

If a desktop client cannot find `npx`, run `command -v npx` in your terminal and use the returned absolute path as `command`.

</details>

For more complete scan results, give the app running the server **Full Disk Access** in **System Settings → Privacy & Security**. Without it, protected folders can be unreadable and reported sizes are lower bounds. Restart the host app after changing permissions.

## Usage

Start with a request like:

> Do a disk checkup. Explain the largest cleanup candidates and show me a proposal before moving anything.

Or ask a more focused question:

> What is this large folder in Application Support? Inspect it and explain what might be lost if I remove it.

> I uninstalled Cursor. Find its leftover files and explain why each one matches.

> Keep my Downloads/Research folder and do not suggest it again.

The bundled `disk_checkup` MCP prompt guides the assistant through this workflow:

```text
Scan → Analyse → Inspect → Propose → User selects items → Move to Trash
```

A proposal includes item numbers, sizes, paths, reasons, and a cleanup tier. You can approve specific numbers and leave the rest. The client must wait for your approval before calling the cleanup tool. See [Safety](#safety) for the boundary between client approval and server checks.

**Moving files to the Trash does not free their space yet.** They remain there until the Trash is emptied. Use Finder to restore items before permanent deletion.

### Read-only report

```sh
npx -y disksweep-mcp report
```

This scans, updates the local index, and prints an analysis without deleting user files. You can run it from your own `cron` or `launchd` routine. DiskSweep does not schedule itself.

## What it adds to an AI chat

The assistant supplies the reasoning. DiskSweep supplies local measurements, disk-specific rules, persistent context, and a constrained cleanup interface.

| Task | Plain chat, without local tools | Assistant with DiskSweep |
| :--- | :--- | :--- |
| Find what uses space | Explains commands or asks you to share output | Measures your Mac and returns focused summaries |
| Understand an unfamiliar folder | Reasons from what you describe | Inspects names, sizes, ages, file types, and likely app ownership |
| Find common cleanup candidates | Suggests general places to look | Applies rule packs and detectors to local evidence |
| Continue next time | Needs the relevant context again | Loads its saved index, notes, keep decisions, and cleanup history |
| Act on findings | Gives you instructions | Moves selected proposal items to the Trash after server checks |

**An assistant with shell access can already do much of this.** DiskSweep packages the work into reusable tools, adds APFS-aware sizing and incremental scans, and applies path checks in code. It does not make the model inherently smarter, and it cannot prove that every unfamiliar file is disposable.

## Tools

| Area | Tool | Purpose |
| :--- | :--- | :--- |
| Overview | `disk_overview` | Free space, disk pressure, macOS volumes, scan age, and recorded growth |
| Scanning | `scan`, `scan_status` | Build or refresh the index and check progress |
| Investigation | `browse`, `inspect` | Drill into folder sizes and inspect metadata, likely ownership, and saved context |
| Analysis | `analyse` | Find candidates by tier, growing folders, and large unexplained folders |
| App leftovers | `app_leftovers` | Find data associated with an uninstalled app and explain each match |
| Memory | `remember`, `recall` | Save findings and keep decisions, list them, or forget an entry |
| Proposal | `create_proposal` | Freeze a numbered list from detector results or investigated paths |
| Cleanup | `trash_approved` | Re-check and move selected proposal items to the Trash |
| Trash | `list_old_trash`, `empty_old_trash` | List old Trash items, then permanently delete the token-bound set |
| History | `cleanup_history` | Review recorded cleanup actions and item sizes |

### Cleanup tiers

| Tier | Meaning | Typical example |
| :--- | :--- | :--- |
| `safe` | Expected to regenerate automatically | Recognised app caches or logs |
| `rebuildable` | Can be recreated with a command or download | Dependencies in a stale project |
| `review` | May contain personal data or work | Old downloads, large files, or an unfamiliar folder |

Tiers help prioritise review. They are not guarantees, and every tier uses the proposal workflow. Paths proposed by the assistant without a detector match always use `review`.

<details>
<summary><strong>Detectors and app leftover matching</strong></summary>

- **Rule packs:** JSON rules in [`rules/`](rules) cover apps, system caches, development tools, and AI tools.
- **Stale projects:** finds regenerable folders such as `node_modules`, `.venv`, `target`, and `.next` in projects inactive for 30 days by default.
- **Files:** finds large files and Downloads/Desktop items unused for 60 days by default.
- **Unused apps:** checks apps not opened for 90 days by default.
- **App leftovers:** searches common app data locations using bundle IDs and whole-word names. [`rules/app-identities.json`](rules/app-identities.json) maps known apps to their IDs. Inferred matches carry lower confidence. Installed apps and recently active data are excluded from leftover suggestions; protected items can be reported without being removable.
- **Duplicates:** optional content hashing identifies matching files. Native sizing accounts for shared APFS blocks when estimating wasted space. Duplicate detection is excluded from the default analysis; request it through the `detectors` argument to `analyse`.

</details>

## Safety

DiskSweep separates **the client's approval workflow** from **checks enforced by the server**.

The server instructions tell the assistant to show a proposal and wait for approval of specific item numbers. The server accepts a proposal ID and item numbers, but it cannot independently verify that a human approved them. Keep your MCP client's confirmation controls enabled for destructive tools.

Within DiskSweep, the cleanup path applies these checks:

- **Restricted locations.** Cleanup is limited to allowed paths inside your home folder and third-party app bundles directly in `/Applications`. The guard blocks operating-system paths, credential stores, synced data, Git internals, and other protected locations.
- **Checks before moving.** Paths must use their exact on-disk spelling. The guard checks parent paths, ownership, protected file flags, mount points, and app restrictions. Proposal items also record file identity; items in the `review` tier are skipped if their contents changed since the proposal.
- **Trash first.** Normal cleanup moves items to the Trash. Proposals expire after 24 hours. DiskSweep does not use `sudo`.
- **Separate permanent deletion.** `empty_old_trash` requires a list token and `confirm: true`. Tokens expire after 15 minutes and can be used once. The deletion code limits itself to the recorded set and skips replaced items. Lists longer than 30 items are abbreviated in the current tool output; use Finder if you need to inspect every item before deletion.

These checks govern DiskSweep tools. They do not restrict an assistant's separate shell tools or protect against a process that can change the server or its local state. Review the proposed paths and reasons before cleanup.

<details>
<summary><strong>Protected paths and implementation</strong></summary>

The guard protects system locations such as `/System`, `/usr`, `/bin`, `/private`, and `/Library`. Home-folder protections include credentials, preferences, Mail, Messages, Safari data, cloud sync folders, Apple app data, and the internals of media libraries. Standard folders such as `~/Documents` and `~/Library/Caches` cannot themselves be removed.

Some rules have narrow exceptions, such as individual Mail Downloads attachments. A whole media library can be proposed for review even though its internals are protected. See [`src/safety/guard.ts`](src/safety/guard.ts) for the exact rules.

Proposal execution is in [`src/proposal.ts`](src/proposal.ts). Permanent Trash deletion has its own checks in [`src/trash.ts`](src/trash.ts).

</details>

## Configuration and privacy

Add optional settings to `~/.disksweep/config.json`:

```json
{
  "protected": ["~/Documents/Thesis"],
  "staleProjectDays": 30,
  "staleDownloadDays": 60,
  "unusedAppDays": 90
}
```

The index, daily snapshots, proposals, notes, and cleanup history live in `~/.disksweep/`. Keep decisions and additional protected paths exclude items from new proposals.

Scanning and folder inspection use metadata. **Optional duplicate detection reads file contents locally to calculate hashes.** App detection also reads app metadata. Tool results can contain file names, paths, sizes, dates, download URLs, and saved notes; your MCP client may send those results to its model provider. DiskSweep itself does not need a model API key.

## How sizing works

The native [`dsize`](native/dsize.c) helper uses macOS `getattrlistbulk` to read directory metadata in batches. It counts allocated bytes, deduplicates exact APFS clones and hard links within a scan, and skips cloud-only files without downloading them. It stays on one volume and does not follow symlinks.

Partly modified clones are counted in full, so shared blocks can still be overcounted. The index retains folders above a configurable threshold, 10 MB by default, and up to 200 large files. Incremental scans use FSEvents, the macOS file-change journal, with a full-scan fallback when needed. If the native helper is unavailable, sizing falls back to `/usr/bin/du` with reduced capabilities.

Scan time depends on your disk, file count, permissions, and changed folders. Reported sizes are estimates of disk usage, not a promise of space reclaimed after deletion.

## Contributing

### Build from source

Use Node.js 22.12 or later and Apple Command Line Tools with `clang`:

```sh
git clone https://github.com/gautamjajoo/disksweep-mcp.git
cd disksweep-mcp
npm ci
npm run build
npm test
```

The build compiles TypeScript and a universal native scanner for Apple Silicon and Intel. To use your local build, set your MCP server command to `node` and its argument to the absolute path of `dist/index.js` in your checkout.

The test suite covers path guards, proposal execution, app leftovers, locking, clone-aware sizing, and incremental scans. Run `npm run build` after code changes and before testing changes to the native helper.

Contributions to rule packs and app identities are welcome. Include the paths you want to match, what they contain, how the data is recreated, and any cases where removing it could lose user data. Report bugs through [GitHub Issues](https://github.com/gautamjajoo/disksweep-mcp/issues).

Inspired by the disk exploration workflow of [OmniDiskSweeper](https://www.omnigroup.com/more) and [OpenSweeper](https://github.com/leavez/OpenSweeper). DiskSweep does not use their code.

## License

[MIT](LICENSE)
