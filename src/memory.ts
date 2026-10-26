/**
 * What disksweep remembers between conversations:
 *  - notes:     what a folder is, learned by investigating it ("Wispr Flow keeps
 *               dictation audio here; safe to clear recordings older than 30d").
 *  - decisions: the user's standing choices ("keep", "never suggest").
 *  - history:   everything cleaned, so we can report totals and spot things
 *               that grow back after cleaning.
 */
import fs from "node:fs";
import { dataPath, isWithin, readJson, writeJson } from "./paths.js";
import { withLockSync } from "./lock.js";

export type Decision = "keep" | "never-suggest";

export interface Note {
  path: string;
  note: string;
  decision?: Decision;
  at: number;
}

export interface HistoryEntry {
  at: number;
  path: string;
  size: number;
  title: string;
  proposalId: string;
  action: "trashed" | "emptied-from-trash";
}

const notesFile = () => dataPath("memory.json");
const historyFile = () => dataPath("history.jsonl");

export function loadNotes(): Record<string, Note> {
  return readJson<Record<string, Note>>(notesFile(), {});
}

export function remember(path: string, note: string | undefined, decision: Decision | undefined): Note {
  return withLockSync("memory", "saving a note", () => rememberLocked(path, note, decision));
}

function rememberLocked(path: string, note: string | undefined, decision: Decision | undefined): Note {
  const notes = loadNotes();
  const prev = notes[path];
  const next: Note = {
    path,
    note: note ?? prev?.note ?? "",
    decision: decision ?? prev?.decision,
    at: Date.now(),
  };
  notes[path] = next;
  writeJson(notesFile(), notes);
  return next;
}

export function forget(path: string): boolean {
  return withLockSync("memory", "forgetting a note", () => forgetLocked(path));
}

function forgetLocked(path: string): boolean {
  const notes = loadNotes();
  if (!notes[path]) return false;
  delete notes[path];
  writeJson(notesFile(), notes);
  return true;
}

/** The note for a path or its nearest annotated ancestor. */
export function noteFor(path: string, notes = loadNotes()): Note | undefined {
  let best: Note | undefined;
  for (const n of Object.values(notes)) {
    if (isWithin(path, n.path) && (!best || n.path.length > best.path.length)) best = n;
  }
  return best;
}

/** True if the user asked never to suggest this path (or something containing it). */
export function isExcluded(path: string, notes = loadNotes()): Note | undefined {
  return Object.values(notes).find(
    (n) => (n.decision === "keep" || n.decision === "never-suggest") && (isWithin(path, n.path) || isWithin(n.path, path)),
  );
}

export function recordHistory(entries: HistoryEntry[]): void {
  if (!entries.length) return;
  fs.appendFileSync(historyFile(), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function loadHistory(sinceMs = 0): HistoryEntry[] {
  let raw = "";
  try {
    raw = fs.readFileSync(historyFile(), "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HistoryEntry;
      if (e.at >= sinceMs) out.push(e);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Most recent time this exact path was cleaned, if ever. */
export function lastCleaned(path: string, history = loadHistory()): HistoryEntry | undefined {
  let hit: HistoryEntry | undefined;
  for (const e of history) if (e.path === path && e.action === "trashed" && (!hit || e.at > hit.at)) hit = e;
  return hit;
}
