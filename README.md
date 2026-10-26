# disksweep-mcp

**An MCP server that lets Claude, Codex or any MCP client understand your disk and clean it up only with your approval.**

Small-disk laptops fill up silently: browser and app caches, VM images, `node_modules`, AI tool sessions, old downloads, leftovers from apps you uninstalled. GUI tools like OmniDiskSweeper show you *where* space goes, but you still have to figure out *what* each folder is and whether deleting it breaks something.

disksweep gives your assistant the tools to do that work with you:

- **See everything, fast.** It sizes every file on the disk the way OmniDiskSweeper does, but counts APFS clones and hard links once, never triggers iCloud downloads, and keeps an index. Later scans replay macOS's change journal (FSEvents) and re-size only what changed: a 66 s full scan becomes a ~13 s refresh.
- **Know the usual suspects.** Rule packs cover caches, logs, updater leftovers, Xcode, package managers, Docker, Claude, Codex, Cursor and more. They are plain JSON, so contributions are welcome.
- **Investigate the unknown.** Where it really differs: `analyse` lists *large folders nothing explains*, and `inspect` tells the assistant what's inside: owner app, file types, age of contents, databases, media, git data, download source. The model works out what it is and how safe it is to remove. File contents are never read.
- **Remember.** What the assistant learned about a folder, what you said to keep, and what was cleaned, including things that **grow back** after cleaning. The next conversation doesn't start from zero.
- **Never damage your Mac.** See [Safety](#safety).

## Why MCP and not "just ask the assistant to run `du` and `rm`"?

| Ask your assistant to use the shell | disksweep |
|---|---|
| The model writes `rm -rf` commands itself; nothing outside the model checks the path | The only destructive action is "move item #3 of a proposal you saw to the Trash", checked by a guard in code that no prompt can override |
| Every chat starts from scratch; a full `du` takes about a minute and floods the context | A persistent index, incremental rescans and compact summaries |
| No memory of what you decided or cleaned | Notes, keep/never-suggest decisions, cleanup history, grew-back detection |
| `du` counts APFS clones twice | Clone-aware native sizing (`dsize`) |
| Needs a shell, so Claude Desktop and other chat apps can't do it | Works in any MCP client: Claude Code, Codex, Claude Desktop |

## Install

Requires macOS 11+ and Node 20+. (Windows and Linux are planned; everything OS-specific sits behind one interface.)

**Claude Code**
```sh
claude mcp add disksweep -- npx -y disksweep-mcp
```

**Codex** — `~/.codex/config.toml`
```toml
[mcp_servers.disksweep]
command = "npx"
args = ["-y", "disksweep-mcp"]
```

**Claude Desktop** — `claude_desktop_config.json`
```json
{ "mcpServers": { "disksweep": { "command": "npx", "args": ["-y", "disksweep-mcp"] } } }
```

For complete sizes, give the host app (Terminal, Claude, Codex…) **Full Disk Access** in System Settings → Privacy & Security. Without it, folders macOS protects are reported as "at least X".

## Use

Ask for a checkup, or run the bundled prompt (`/mcp__disksweep__disk_checkup` in Claude Code):

> *"Do a disk checkup."*

The assistant scans, analyses, inspects anything large and unexplained, summarises, and shows a numbered proposal. **Nothing moves until you say which numbers.** Approved items go to the Trash, where Finder's Put Back restores them.

### Your own routine

disksweep never schedules itself; you decide if and when it runs. Some options:

- Ask your assistant every morning, or use your client's scheduled tasks or automations with the `disk_checkup` prompt.
- `npx disksweep-mcp report` prints a read-only report (scan + analysis, no deletions) that you can run from cron or launchd and read whenever you like.

## Tools

| Tool | Does |
|---|---|
| `disk_overview` | Free space, urgency, what macOS itself uses (swap, system, preboot), what grew since yesterday |
| `scan` / `scan_status` | Build or refresh the index (full or incremental, runs in the background) |
| `browse` | OmniDiskSweeper-style drill-down into any folder |
| `inspect` | What a folder or file is: owner app, types, ages, signals, notes, grew-back, safe to act on? |
| `analyse` | Candidates by tier (safe / rebuildable / review), fastest-growing folders, large and unexplained folders |
| `app_leftovers` | Everything an uninstalled app left behind, even KB-sized files, or every uninstalled app at once |
| `remember` / `recall` | Save what something is, or "keep" / "never suggest" |
| `create_proposal` | Freeze a numbered list for approval (detector findings or investigated paths with a reason) |
| `trash_approved` | Move only the approved numbers to the Trash, re-checking everything first |
| `list_old_trash` / `empty_old_trash` | See, then (with `confirm: true`) permanently empty, items trashed more than N days ago |
| `cleanup_history` | What was cleaned and how much space it freed |

**Detectors:** rule packs · stale project build folders (`node_modules`, `.venv`, `target`, `.next`… in projects untouched for 30+ days; only the regenerable folder, never your code) · large files · Downloads/Desktop items not used for 60+ days · apps not opened for 90+ days · leftovers of uninstalled apps · duplicates (clone-aware, so APFS copies that share blocks aren't counted as waste).

**Tiers:** *safe* regenerates by itself · *rebuildable* can be recreated with a command or a download · *review* may contain your own stuff.

## Leftovers of uninstalled apps

Dragging an app to the Trash leaves data scattered around: `~/.cursor`, `~/Library/Caches/com.todesktop.230313mzl4w4u92.ShipIt` (that's Cursor's updater; apps often use opaque bundle ids), updater caches, saved state, cookies, the installer in Downloads. `app_leftovers "Cursor"` finds all of it, however small, and says why each item matched:

- It searches only the dozen places where macOS apps keep data, one level deep. It matches bundle IDs and whole-word names, never substrings: `cursor` matches `.cursor`, `cursor-updater` and `Install Cursor.app`, but not `tkMacOSXCursors.h` or a plugin's `.cursor-plugin` folder.
- `rules/app-identities.json` maps apps to their IDs and is easy to extend. Apps not in that file are identified from their bundle IDs on disk and labelled as less certain.
- If the app is installed anywhere (according to Spotlight) or a process is running from its bundle, its data is reported as live, not as leftovers.
- If the app's own data changed in the last 30 days, it's treated as still in use (being updated, moved, or bundled inside another app) and not suggested. A shared folder something else still writes to, like `~/.cursor/skills`, is flagged and left out.
- Preferences, launch agents and cookies are listed for completeness but never removed.

## Safety

The guard (`src/safety/guard.ts`) is **default-deny**, and its rules are code, not configuration:

- It acts only inside your home folder, plus third-party `.app` bundles in `/Applications`.
- **Never touched:** `/System`, `/usr`, `/bin`, `/sbin`, `/private`, `/Library`, `/opt`, `/Volumes` and the rest of the OS. Inside your home: settings and credentials (`~/Library/Preferences`, `Keychains`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, shell dotfiles), synced data (iCloud Drive, `CloudStorage`), Mail, Messages, Safari, Apple's own app data (`com.apple.*`), `.git` internals, the insides of Photos and Music libraries, and the top-level folders themselves (`~/Documents`, `~/Library/Caches`…).
- Before anything moves, it re-checks every path: no symlinked parents, the path wasn't replaced, it isn't SIP-protected, locked or owned by another user, it isn't a mount point, and it isn't an Apple app. Items the user must review are skipped if they changed after you saw them. Apps' data is skipped while the app is running.
- It never uses `sudo`. Items always go to the Trash first. The only permanent deletion is emptying old Trash items, and that requires an explicit confirmation.
- Red-team tests cover tampered proposal files, `..` and symlink tricks, SIP-protected files and locked files.

Add your own never-touch paths in `~/.disksweep/config.json`:
```json
{ "protected": ["~/Documents/Thesis"], "staleProjectDays": 30, "staleDownloadDays": 60, "unusedAppDays": 90 }
```

## How sizing works

`native/dsize.c` walks directories with `getattrlistbulk`, which returns a whole directory's metadata in a few system calls. It counts allocated bytes and:
- counts **exact APFS clones once** (by clone id), and fetches a file's private size only for files that share blocks. Partly modified clones are counted in full, like `du`, so sizes are never too low.
- counts **hard links once**.
- skips **dataless iCloud files** (they count as 0 and are never downloaded).
- stays on one volume and never follows symlinks.

The engine streams results and keeps only folders at or above 10 MB plus the 200 largest files, so the index stays small. If the helper is missing it falls back to `/usr/bin/du`.

Prior art: [OmniDiskSweeper](https://www.omnigroup.com/more) and [OpenSweeper](https://github.com/leavez/OpenSweeper) (GUI apps). disksweep is the agent-native counterpart, and none of their code is used.

## Develop

```sh
npm install
npm run build      # compiles native/dsize (universal arm64 + x86_64) and TypeScript
npm test           # guard red-team tests, scanner vs du, clones, incremental, end-to-end flow
```

Data lives in `~/.disksweep/` (index, daily snapshots, proposals, memory, history).

## License

MIT
