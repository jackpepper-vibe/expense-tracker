// Attendee history for meal/entertainment receipts.
//
// Every name saved on a receipt is remembered with how often and how recently
// it was used, so the Attendees field can suggest it next time. Names the user
// dismisses are removed from the history (they return only if used again).
// Stored on-device alongside trips, and included in backups.

import type { StoredTrip } from './data.ts';

export interface AttendeeEntry {
  /** Display form, as most recently entered. */
  name:     string;
  uses:     number;
  /** ISO timestamp of the most recent use. */
  lastUsed: string;
}

interface StoredDirectory {
  version: 1;
  entries: AttendeeEntry[];
}

const STORAGE_KEY = 'et_attendees_v1';
const SEPARATOR   = ', ';

// ── Name handling ─────────────────────────────────────────────────────────────

/** Comparison key: case-, accent- and spacing-insensitive. */
export function nameKey(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Splits an Attendees field value into distinct, trimmed names. */
export function parseAttendees(value: string | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of (value ?? '').split(',')) {
    const name = raw.replace(/\s+/g, ' ').trim();
    const key  = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function joinAttendees(names: string[]): string {
  return names.join(SEPARATOR);
}

/**
 * Where `query` matches `name`: 0 = start of the name, 1 = start of a later
 * word (e.g. a surname or "(Company)"), null = no match.
 */
function matchRank(nameK: string, queryK: string): 0 | 1 | null {
  if (nameK.startsWith(queryK)) return 0;
  for (let i = 1; i < nameK.length; i++) {
    if (!/[a-z0-9]/.test(nameK[i - 1]) && /[a-z0-9]/.test(nameK[i]) && nameK.startsWith(queryK, i)) return 1;
  }
  return null;
}

// ── Directory ─────────────────────────────────────────────────────────────────

export class AttendeeDirectory {
  private entries = new Map<string, AttendeeEntry>();

  private constructor(entries: AttendeeEntry[]) {
    for (const e of entries) this.entries.set(nameKey(e.name), e);
  }

  /**
   * Loads the saved history. On first run it is built once from the attendees
   * on every receipt already on the device.
   */
  static load(trips: StoredTrip[]): AttendeeDirectory {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredDirectory;
        if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
          return new AttendeeDirectory(parsed.entries.filter(isEntry));
        }
      }
    } catch { /* fall through to a rebuild */ }

    const dir = new AttendeeDirectory(entriesFromTrips(trips));
    dir.save();
    return dir;
  }

  all(): AttendeeEntry[] {
    return [...this.entries.values()];
  }

  /** Best matches for `query`, leaving out names in `exclude`. */
  suggest(query: string, exclude: string[] = [], limit = 6): AttendeeEntry[] {
    const q = nameKey(query);
    if (!q) return [];
    const skip = new Set(exclude.map(nameKey));
    const ranked: { entry: AttendeeEntry; rank: 0 | 1 }[] = [];
    for (const [key, entry] of this.entries) {
      if (skip.has(key)) continue;
      const rank = matchRank(key, q);
      if (rank !== null) ranked.push({ entry, rank });
    }
    return ranked
      .sort((a, b) => a.rank - b.rank
        || b.entry.uses - a.entry.uses
        || b.entry.lastUsed.localeCompare(a.entry.lastUsed)
        || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit)
      .map(r => r.entry);
  }

  /** Records a saved receipt's attendees. Pass the previous value when editing so names aren't double-counted. */
  recordReceipt(attendees: string | undefined, previous?: string): void {
    const before = new Set(parseAttendees(previous).map(nameKey));
    const added  = parseAttendees(attendees).filter(n => !before.has(nameKey(n)));
    if (added.length === 0) return;
    this.record(added, new Date().toISOString());
    this.save();
  }

  /** Stops suggesting a name. */
  forget(name: string): void {
    if (this.entries.delete(nameKey(name))) this.save();
  }

  /** Folds in entries from a backup, keeping the higher count and later use. */
  merge(incoming: AttendeeEntry[]): void {
    for (const e of incoming.filter(isEntry)) {
      const key  = nameKey(e.name);
      const have = this.entries.get(key);
      if (!have) { this.entries.set(key, { ...e }); continue; }
      const newer = e.lastUsed > have.lastUsed;
      this.entries.set(key, {
        name:     newer ? e.name : have.name,
        uses:     Math.max(have.uses, e.uses),
        lastUsed: newer ? e.lastUsed : have.lastUsed,
      });
    }
    this.save();
  }

  private record(names: string[], at: string): void {
    for (const name of names) {
      const key  = nameKey(name);
      const have = this.entries.get(key);
      this.entries.set(key, {
        name,
        uses:     (have?.uses ?? 0) + 1,
        lastUsed: have && have.lastUsed > at ? have.lastUsed : at,
      });
    }
  }

  private save(): void {
    const data: StoredDirectory = { version: 1, entries: this.all() };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* suggestions only */ }
  }
}

/** History entries implied by the attendees on a set of trips' receipts. */
export function entriesFromTrips(trips: StoredTrip[]): AttendeeEntry[] {
  const byKey = new Map<string, AttendeeEntry>();
  for (const trip of trips) {
    for (const r of trip.receipts) {
      const at = r.date || trip.setup.createdAt;
      for (const name of parseAttendees(r.attendees)) {
        const key  = nameKey(name);
        const have = byKey.get(key);
        byKey.set(key, {
          name:     have && have.lastUsed > at ? have.name : name,
          uses:     (have?.uses ?? 0) + 1,
          lastUsed: have && have.lastUsed > at ? have.lastUsed : at,
        });
      }
    }
  }
  return [...byKey.values()];
}

export function isEntry(v: unknown): v is AttendeeEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e['name'] === 'string' && nameKey(e['name']) !== ''
    && typeof e['uses'] === 'number' && typeof e['lastUsed'] === 'string';
}
