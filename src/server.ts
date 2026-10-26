import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPlatform } from "./platform/index.js";
import { describeAge, formatBytes } from "./format.js";
import { expandHome, tildify, userHome } from "./paths.js";
import { currentJob, loadIndex, startScan, waitForJob, ScanJob } from "./scan/scanner.js";
import { duShallow, sizingEngine } from "./scan/du.js";
import { findDeepest, findExact, ScanIndex, SizeNode } from "./scan/tree.js";
import { growthOver } from "./scan/snapshot.js";
import { ALL_DETECTORS, analyse, formatAnalysis, DetectorName } from "./analyse.js";
import { inspect, formatInspect } from "./inspect.js";
import { createProposal, formatProposal, trashApproved } from "./proposal.js";
import { emptyShownTrash, formatTrashList, listOldTrash, rememberShownList } from "./trash.js";
import { forget, loadHistory, loadNotes, remember } from "./memory.js";
import { discoverUninstalled, formatLeftovers, leftoversFor } from "./detect/leftovers.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `disksweep lets you analyse the user's disk and clean it up with their approval.

How to work:
1. Start with disk_overview. If there is no recent scan, call scan (incremental after the first run; the first full scan takes about a minute).
2. analyse finds known junk (caches, build folders, old downloads, unused apps, leftovers of uninstalled apps) and lists LARGE AND UNEXPLAINED folders. When the user mentions an app they removed, use app_leftovers with its name: it finds even tiny files and decodes bundle ids.
3. Your distinctive job: investigate the unexplained ones with inspect (and browse to drill down). Work out what each folder is from its owner app, file types, ages, names and location. Say how confident you are. Record what you learn with remember so the next conversation doesn't start from zero.
4. Put what you recommend into create_proposal (detector ids, and/or paths you investigated with a clear reason). Show the user the returned numbered list.
5. Only after the user explicitly approves specific item numbers, call trash_approved with exactly those numbers. Never infer approval. Items go to the Trash and can be restored with Put Back.
6. If the user says to keep something, call remember with decision "keep" so it is never suggested again.

Safety: disksweep refuses OS locations, settings, credentials, synced folders and git internals no matter what is requested. Never suggest workarounds (rm, sudo) for anything it refuses. Never claim a folder is safe to delete without evidence; when in doubt, classify it as "review" and explain.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function pressure(freeBytes: number, totalBytes: number): string {
  const pct = freeBytes / totalBytes;
  if (freeBytes < 5e9 || pct < 0.03) return "CRITICAL — macOS needs free space for swap and updates; expect slowdowns and failed saves";
  if (freeBytes < 15e9 || pct < 0.1) return "LOW — clean up soon";
  if (pct < 0.2) return "OK, but getting full";
  return "healthy";
}

function jobStatus(j: ScanJob): string {
  if (j.error) return `Scan failed: ${j.error}`;
  if (j.finishedAt) return `Scan finished (${j.mode}) in ${Math.round((j.finishedAt - j.startedAt) / 1000)}s.`;
  return `Scanning (${j.mode})… ${j.entries.toLocaleString()} items so far, ${Math.round((Date.now() - j.startedAt) / 1000)}s elapsed${j.current ? `, at ${tildify(j.current)}` : ""}. Call scan_status to check again.`;
}

function topLevelSummary(idx: ScanIndex, depthNode: SizeNode = idx.tree, limit = 12): string {
  const kids = depthNode.children ?? [];
  const rest = depthNode.size - kids.reduce((s, c) => s + c.size, 0);
  const L = kids.slice(0, limit).map((c) => `  ${formatBytes(c.size).padStart(9)}  ${tildify(c.path)}${c.isFile ? "" : "/"}${c.partial ? " (at least)" : ""}`);
  if (kids.length > limit || rest > 0) L.push(`  ${formatBytes(rest + kids.slice(limit).reduce((s, c) => s + c.size, 0)).padStart(9)}  (everything else)`);
  return L.join("\n");
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "disksweep", version: VERSION }, { instructions: INSTRUCTIONS });
  const platform = getPlatform();

  server.registerTool(
    "disk_overview",
    {
      title: "Disk overview",
      description: "How full the disk is, how urgent cleanup is, when it was last scanned and what changed since. Instant; call this first.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const d = await platform.diskInfo("/");
      const idx = loadIndex();
      const L = [
        `Disk: ${formatBytes(d.totalBytes)} total, ${formatBytes(d.usedBytes)} used, ${formatBytes(d.freeBytes)} free (${d.percentUsed}% full).`,
        `Status: ${pressure(d.freeBytes, d.totalBytes)}.`,
      ];
      const vols = (await platform.volumes()).filter((v) => v.role !== "Data" && v.bytes > 1e9);
      if (vols.length) {
        const label: Record<string, string> = {
          System: "macOS system (read-only, can't be reduced)",
          VM: "swap / sleep image (shrinks after closing apps or restarting; grows when memory and disk are tight)",
          Preboot: "boot files and pending macOS updates",
          Recovery: "recovery system",
          Update: "staged macOS update",
        };
        L.push(`Used by macOS itself (${formatBytes(vols.reduce((s, v) => s + v.bytes, 0))}, outside your files):`);
        for (const v of vols.sort((a, b) => b.bytes - a.bytes)) L.push(`  ${formatBytes(v.bytes).padStart(9)}  ${label[v.role] ?? `${v.name} (${v.role})`}`);
      }
      if (idx) {
        L.push(`Last scan: ${describeAge(idx.scannedAt)} (${new Date(idx.scannedAt).toLocaleString()}), ${idx.mode}, root ${idx.root}.`);
        const g = growthOver(1, 5);
        if (g.items.length) L.push(`Grew most since ${g.since}:`, ...g.items.map((x) => `  +${formatBytes(x.delta)}  ${tildify(x.path)}`));
        L.push("Biggest areas:", topLevelSummary(idx, findExact(idx.tree, userHome()) ?? idx.tree, 10));
      } else {
        L.push("No scan yet. Call scan to build the size index (first scan visits every file; about a minute on a typical laptop).");
      }
      const j = currentJob();
      if (j && !j.finishedAt) L.push(jobStatus(j));
      return text(L.join("\n"));
    },
  );

  server.registerTool(
    "scan",
    {
      title: "Scan disk",
      description:
        "Build or refresh the size index (like OmniDiskSweeper: every file is visited; APFS clones and hard links counted once; iCloud-only files not downloaded). 'incremental' re-sizes only folders that changed since the last scan using the macOS change journal and falls back to full when needed. Runs in the background; waits up to wait_seconds.",
      inputSchema: {
        mode: z.enum(["incremental", "full"]).default("incremental"),
        path: z.string().optional().describe("Folder to scan instead of the whole disk (advanced)."),
        wait_seconds: z.number().min(0).max(110).default(45),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ mode, path, wait_seconds }) => {
      const j = startScan(mode, path ? expandHome(path) : undefined);
      const idx = await waitForJob(j, wait_seconds * 1000);
      if (!idx) return text(jobStatus(j));
      return text(
        [
          jobStatus(j) + (j.note ? ` (${j.note})` : ""),
          `Indexed ${formatBytes(idx.tree.size)} under ${idx.root} using ${sizingEngine().name}.`,
          idx.denied.length ? `${idx.denied.length} folder(s) could not be read (sizes there are lower bounds). Granting Full Disk Access to this app fixes that.` : "",
          "Top level:",
          topLevelSummary(idx),
        ].filter(Boolean).join("\n"),
      );
    },
  );

  server.registerTool(
    "scan_status",
    { title: "Scan status", description: "Progress of the running or last scan.", annotations: { readOnlyHint: true } },
    async () => {
      const j = currentJob();
      return text(j ? jobStatus(j) : "No scan has run in this session.");
    },
  );

  server.registerTool(
    "browse",
    {
      title: "Browse folder sizes",
      description: "OmniDiskSweeper-style drill-down: the biggest items in a folder, largest first, with last activity. Uses the index when possible, otherwise measures live.",
      inputSchema: {
        path: z.string().default("~").describe("Folder to list, e.g. ~/Library or /Applications"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, limit }) => {
      const target = expandHome(path);
      const idx = loadIndex();
      let node = idx ? findExact(idx.tree, target) : undefined;
      let source = "index";
      // Index only keeps items above a threshold; for small folders, or when children are missing, measure live.
      if (!node || !node.children?.length) {
        node = await duShallow(target);
        source = "measured now";
      }
      const kids = node.children ?? [];
      const shown = kids.slice(0, limit);
      const rest = node.size - shown.reduce((s, c) => s + c.size, 0);
      const L = [`${tildify(node.path)}: ${formatBytes(node.size)}${node.partial ? " (at least; some folders unreadable)" : ""} — ${source}${idx && source === "index" ? `, scanned ${describeAge(idx.scannedAt)}` : ""}`];
      for (const c of shown) L.push(`  ${formatBytes(c.size).padStart(9)}  ${tildify(c.path)}${c.isFile ? "" : "/"}${c.mtime ? `  (last activity ${describeAge(c.mtime)})` : ""}`);
      if (rest > 0) L.push(`  ${formatBytes(rest).padStart(9)}  (smaller items)`);
      if (idx && !findDeepest(idx.tree, target)) L.push("(outside the scanned area)");
      return text(L.join("\n"));
    },
  );

  server.registerTool(
    "inspect",
    {
      title: "Inspect a folder or file",
      description:
        "Investigate what something is before deciding about it: owner app (and whether it's running), file types, age of contents, largest/recent files, signals (cache area, databases, media, git), your saved notes, whether it grew back after a previous cleanup, download source, and whether disksweep may act on it. Metadata only; never reads file contents.",
      inputSchema: { path: z.string().describe("Absolute path or ~/…") },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => text(formatInspect(await inspect(expandHome(path)))),
  );

  server.registerTool(
    "analyse",
    {
      title: "Find what's wasting space",
      description:
        "Runs detectors and returns cleanup candidates grouped by tier (safe / rebuildable / review) with ids, plus fast-growing folders and large folders nothing explains (investigate those with inspect). Respects the user's saved decisions. Run scan first for best results.",
      inputSchema: {
        detectors: z
          .array(z.enum(ALL_DETECTORS as [DetectorName, ...DetectorName[]]))
          .optional()
          .describe("Default: everything except 'duplicates' (slower, hashes files in Documents/Downloads/Desktop/Movies/Music/Pictures)."),
        limit: z.number().int().min(1).max(200).default(12).describe("Max items listed per tier."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ detectors, limit }) => {
      const idx = loadIndex();
      const a = await analyse(idx, detectors);
      return text((idx ? "" : "Note: no scan index yet, so project folders, large files and growth are missing. Call scan.\n\n") + formatAnalysis(a, { limit }));
    },
  );

  server.registerTool(
    "app_leftovers",
    {
      title: "Leftovers of uninstalled apps",
      description:
        "Find everything an app left behind after being uninstalled, however small: ~/.name folders, Application Support, Caches, Containers, Group Containers, Logs, saved state, web data, updater caches, installers in Downloads. Resolves opaque bundle ids (e.g. com.todesktop.230313mzl4w4u92 = Cursor). With no app, lists every uninstalled app that left data. Refuses if the app is still installed anywhere. Each item shows why it matched and what it contains; items still being written to are flagged. Ids can go into create_proposal.",
      inputSchema: { app: z.string().optional().describe("App name, e.g. 'Cursor'. Omit to list all uninstalled apps with leftovers.") },
      annotations: { readOnlyHint: true },
    },
    async ({ app }) => {
      if (app) return text(formatLeftovers(await leftoversFor(app)));
      const reports = await discoverUninstalled();
      const size = (r: (typeof reports)[number]) => r.items.reduce((s, i) => s + i.size, 0);
      const gone = reports.filter((r) => r.status === "leftover");
      const big = gone.filter((r) => size(r) >= 1e6);
      const small = gone.filter((r) => size(r) < 1e6);
      const active = reports.filter((r) => r.status === "recently-active");
      if (!gone.length && !active.length) return text("No leftovers from uninstalled apps found.");
      const L = [`${gone.length} uninstalled app(s) left data behind, ${formatBytes(gone.reduce((s, r) => s + size(r), 0))} in total.`];
      for (const r of big.slice(0, 25)) L.push("", formatLeftovers(r, false));
      const rest = [...big.slice(25), ...small];
      if (rest.length) {
        L.push("", `Plus ${rest.length} more app(s) with small leftovers (${formatBytes(rest.reduce((s, r) => s + size(r), 0))}): ${rest.slice(0, 40).map((r) => r.app).join(", ")}${rest.length > 40 ? ", …" : ""}`);
      }
      if (active.length) {
        L.push("", "Probably still in use (no installed copy found, but their data changed in the last 30 days; not suggested):");
        for (const r of active) L.push(`  - ${r.app}: ${formatBytes(size(r))}`);
      }
      L.push("", "Call app_leftovers with an app name for details (why each item matched, what's inside, activity).");
      return text(L.join("\n"));
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a finding or decision",
      description:
        "Save what a folder is (learned by inspecting it) and/or the user's decision about it. decision 'keep' or 'never-suggest' hides it from future analyses. Notes appear in later inspect/analyse results.",
      inputSchema: {
        path: z.string(),
        note: z.string().optional().describe("What it is and what you learned, e.g. 'Wispr Flow dictation audio; app re-creates; user fine clearing >30 days'"),
        decision: z.enum(["keep", "never-suggest"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ path, note, decision }) => {
      const n = remember(expandHome(path), note, decision);
      return text(`Saved for ${tildify(n.path)}${n.decision ? ` [${n.decision}]` : ""}${n.note ? `: ${n.note}` : ""}`);
    },
  );

  server.registerTool(
    "recall",
    {
      title: "What disksweep remembers",
      description: "List saved notes and decisions, and optionally forget one.",
      inputSchema: { forget_path: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ forget_path }) => {
      const L: string[] = [];
      if (forget_path) L.push(forget(expandHome(forget_path)) ? `Forgot ${forget_path}.` : `Nothing saved for ${forget_path}.`);
      const notes = Object.values(loadNotes()).sort((a, b) => b.at - a.at);
      if (!notes.length) L.push("Nothing remembered yet.");
      for (const n of notes) L.push(`- ${tildify(n.path)}${n.decision ? ` [${n.decision}]` : ""}${n.note ? `: ${n.note}` : ""} (${describeAge(n.at)})`);
      return text(L.join("\n"));
    },
  );

  server.registerTool(
    "create_proposal",
    {
      title: "Create a cleanup proposal",
      description:
        "Freeze a numbered list of items for the user to approve. Use candidate ids from analyse and/or items you investigated (path + reason; always tier 'review'). Every path is safety-checked. Show the returned list to the user and ask which numbers to move to the Trash. Does not delete anything.",
      inputSchema: {
        candidate_ids: z.array(z.string()).default([]),
        items: z
          .array(z.object({ path: z.string(), reason: z.string().describe("Evidence-based explanation for the user"), title: z.string().optional() }))
          .default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ candidate_ids, items }) => {
      const { proposal, rejected } = await createProposal(candidate_ids, items);
      const L = [proposal.items.length ? formatProposal(proposal) : "Nothing could be added to a proposal."];
      if (rejected.length) L.push("", "Not included:", ...rejected.map((r) => `  - ${r}`));
      if (proposal.items.length) L.push("", "Ask the user which item numbers to move to the Trash. Do not call trash_approved until they say.");
      return text(L.join("\n"));
    },
  );

  server.registerTool(
    "trash_approved",
    {
      title: "Move approved items to the Trash",
      description:
        "Moves ONLY the item numbers the user explicitly approved from a proposal to the Trash (restorable via Put Back). Re-checks every path immediately before acting; skips anything changed, protected, or belonging to a running app.",
      inputSchema: {
        proposal_id: z.string(),
        item_numbers: z.array(z.number().int().positive()).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ proposal_id, item_numbers }) => {
      const before = await platform.diskInfo("/");
      const r = await trashApproved(proposal_id, item_numbers);
      const L = r.results.map((x) => `${x.n}. ${x.status}: ${x.detail}`);
      L.push(
        "",
        `Moved ${formatBytes(r.freed)} to the Trash. Files in the Trash still use space until it's emptied (free now: ${formatBytes(before.freeBytes)}).`,
        "Use list_old_trash / empty_old_trash, or empty the Trash in Finder, to get the space back.",
      );
      return text(L.join("\n"));
    },
  );

  server.registerTool(
    "list_old_trash",
    {
      title: "List old Trash items",
      description:
        "What's in the Trash and has been there longer than N days, with sizes. Returns a list token: empty_old_trash deletes exactly this list (valid 15 minutes, once). Read-only.",
      inputSchema: { older_than_days: z.number().int().min(0).default(7) },
      annotations: { readOnlyHint: true },
    },
    async ({ older_than_days }) => {
      const { items, error } = await listOldTrash(older_than_days);
      if (error) return text(error);
      if (!items.length) return text(formatTrashList(items, older_than_days));
      const token = rememberShownList(items);
      return text(`${formatTrashList(items, older_than_days)}\n\nList token: ${token}. Show this list to the user; if they confirm, call empty_old_trash with this token.`);
    },
  );

  server.registerTool(
    "empty_old_trash",
    {
      title: "Permanently delete old Trash items",
      description:
        "PERMANENTLY deletes exactly the Trash items from a list_old_trash result (by its token), after the user explicitly confirmed that list. Items replaced since are skipped.",
      inputSchema: { list_token: z.string(), confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ list_token }) => {
      const r = await emptyShownTrash(list_token);
      const d = await platform.diskInfo("/");
      return text(
        [`Permanently deleted ${r.removed.length} item(s), ${formatBytes(r.freed)}. Free space now: ${formatBytes(d.freeBytes)}.`, ...r.errors.map((e) => `  - ${e}`)].join("\n"),
      );
    },
  );

  server.registerTool(
    "cleanup_history",
    {
      title: "Cleanup history",
      description: "What disksweep cleaned and how much space it freed over a period.",
      inputSchema: { days: z.number().int().min(1).default(30) },
      annotations: { readOnlyHint: true },
    },
    async ({ days }) => {
      const h = loadHistory(Date.now() - days * 86_400_000);
      if (!h.length) return text(`Nothing cleaned in the last ${days} days.`);
      const trashed = h.filter((e) => e.action === "trashed");
      const total = trashed.reduce((s, e) => s + e.size, 0);
      const L = [`Last ${days} days: ${trashed.length} item(s) moved to Trash, ${formatBytes(total)}.`];
      for (const e of h.slice(-30).reverse()) L.push(`  ${new Date(e.at).toLocaleDateString()}  ${formatBytes(e.size).padStart(8)}  ${e.action === "trashed" ? "trashed" : "emptied"}  ${tildify(e.path)}`);
      return text(L.join("\n"));
    },
  );

  server.registerPrompt(
    "disk_checkup",
    {
      title: "Disk checkup",
      description: "Check how full the disk is, find what's wasting space (including things nothing recognises), and clean up with your approval.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Run a disk checkup with disksweep:
1. disk_overview, then scan (incremental) and analyse.
2. Inspect the top "large and unexplained" folders and anything growing fast; figure out what they are and remember what you learn.
3. Give me a short summary (at most 10 lines): how full the disk is, what's growing, the biggest wins by tier, and anything surprising you found.
4. Create one proposal with your recommendations (safe items first) and show me the numbered list.
5. Wait for me to say which numbers to clean. Don't move anything without my explicit approval.`,
          },
        },
      ],
    }),
  );

  return server;
}
