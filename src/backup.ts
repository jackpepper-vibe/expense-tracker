// Backup & restore of all trip data.
//
// Trips live only in this device's localStorage, and iOS deletes a home-screen
// web app's storage when the app is removed. A backup is a single JSON file
// holding every trip, receipt and photo, saved through the share sheet (iOS
// "Save to Files") or as a download. Restoring merges — it never deletes or
// overwrites anything already on the device.

import { nextReceiptNo, type StoredTrip, type Receipt } from './data.ts';

const BACKUP_FORMAT  = 'expense-tracker-backup';
const BACKUP_VERSION = 1;
const LAST_BACKUP_KEY = 'et_last_backup_v1';

/** Days without a backup before the trips screen shows a reminder. */
export const BACKUP_REMINDER_DAYS = 7;

interface BackupFile {
  format:     typeof BACKUP_FORMAT;
  version:    number;
  exportedAt: string;
  trips:      StoredTrip[];
}

/** A backup file that can't be read; `message` is safe to show the user. */
export class BackupError extends Error {}

export interface RestoreSummary {
  tripsAdded:    number;
  receiptsAdded: number;
}

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

// ── Last-backup bookkeeping ───────────────────────────────────────────────────

export function lastBackupAt(): Date | null {
  try {
    const iso = localStorage.getItem(LAST_BACKUP_KEY);
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  } catch { return null; }
}

function recordBackup(at: Date): void {
  try { localStorage.setItem(LAST_BACKUP_KEY, at.toISOString()); } catch { /* reminder only */ }
}

/** True when there is data worth protecting and no recent backup. */
export function backupIsDue(trips: StoredTrip[], now = new Date()): boolean {
  if (!trips.some(t => t.receipts.length > 0)) return false;
  const last = lastBackupAt();
  return !last || now.getTime() - last.getTime() > BACKUP_REMINDER_DAYS * 86_400_000;
}

// ── Create & save ─────────────────────────────────────────────────────────────

function backupFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `expense-tracker-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}

function createBackupFile(trips: StoredTrip[], at: Date): File {
  const payload: BackupFile = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: at.toISOString(), trips };
  return new File([JSON.stringify(payload)], backupFileName(at), { type: 'application/json' });
}

/**
 * Hands the backup to the user: the share sheet where available (on iPhone this
 * offers "Save to Files" / iCloud Drive), otherwise a file download.
 * Must be called from a user gesture.
 */
export async function saveBackup(trips: StoredTrip[]): Promise<SaveOutcome> {
  const now  = new Date();
  const file = createBackupFile(trips, now);

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Expense Tracker backup' });
      recordBackup(now);
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Share failed for another reason — fall through to a plain download.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  recordBackup(now);
  return 'downloaded';
}

// ── Read & validate ───────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isReceipt(v: unknown): v is Receipt {
  return isObject(v)
    && typeof v['id'] === 'string'
    && typeof v['no'] === 'number'
    && typeof v['date'] === 'string'
    && typeof v['amount'] === 'number'
    && typeof v['category'] === 'string';
}

function isTrip(v: unknown): v is StoredTrip {
  return isObject(v)
    && typeof v['id'] === 'string'
    && isObject(v['setup'])
    && typeof v['setup']['tripName'] === 'string'
    && typeof v['setup']['createdAt'] === 'string'
    && (v['status'] === 'active' || v['status'] === 'submitted')
    && Array.isArray(v['receipts'])
    && v['receipts'].every(isReceipt);
}

export interface BackupContents {
  trips:      StoredTrip[];
  exportedAt: Date | null;
}

export async function readBackupFile(file: File): Promise<BackupContents> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new BackupError("That file isn't an Expense Tracker backup");
  }
  if (!isObject(data) || data['format'] !== BACKUP_FORMAT) {
    throw new BackupError("That file isn't an Expense Tracker backup");
  }
  if (typeof data['version'] !== 'number' || data['version'] > BACKUP_VERSION) {
    throw new BackupError('This backup is from a newer version of the app — reload and try again');
  }
  const trips = data['trips'];
  if (!Array.isArray(trips) || !trips.every(isTrip)) {
    throw new BackupError('This backup file is damaged and could not be restored');
  }
  const exportedAt = typeof data['exportedAt'] === 'string' ? new Date(data['exportedAt']) : null;
  return { trips, exportedAt: exportedAt && !Number.isNaN(exportedAt.getTime()) ? exportedAt : null };
}

/**
 * After a restore the device holds everything in that backup, so the backup's
 * own date counts as the last backup (unless a newer one is already recorded).
 */
export function noteRestoredBackup(exportedAt: Date | null): void {
  if (!exportedAt) return;
  const last = lastBackupAt();
  if (!last || last < exportedAt) recordBackup(exportedAt);
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merges backed-up trips into the device's trips without removing or changing
 * anything already there: unknown trips are added whole, and for trips present
 * on both sides only receipts missing from the device are added (renumbered if
 * their number is already taken).
 */
export function mergeTrips(device: StoredTrip[], backup: StoredTrip[]): { trips: StoredTrip[]; summary: RestoreSummary } {
  const merged  = device.map(t => ({ ...t, receipts: [...t.receipts] }));
  const byId    = new Map(merged.map(t => [t.id, t]));
  const summary: RestoreSummary = { tripsAdded: 0, receiptsAdded: 0 };

  for (const incoming of backup) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      const trip = { ...incoming, receipts: [...incoming.receipts] };
      merged.push(trip);
      byId.set(trip.id, trip);
      summary.tripsAdded++;
      summary.receiptsAdded += trip.receipts.length;
      continue;
    }
    const have = new Set(existing.receipts.map(r => r.id));
    for (const r of incoming.receipts) {
      if (have.has(r.id)) continue;
      const taken = existing.receipts.some(x => x.no === r.no);
      existing.receipts.push(taken ? { ...r, no: nextReceiptNo(existing.receipts) } : r);
      have.add(r.id);
      summary.receiptsAdded++;
    }
  }
  return { trips: merged, summary };
}
