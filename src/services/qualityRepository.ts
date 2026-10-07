/**
 * qualityRepository.ts — API-backed persistence layer for the Production
 * Quality Monitor. The database is the single source of truth: the module
 * always reads from (and writes to) the FastAPI backend, which connects to
 * AWS PostgreSQL. No localStorage / offline cache is kept for Quality Monitor
 * records, so deleted or externally-changed DB rows can never be resurrected
 * as stale UI state.
 *
 * Record structure (preserves data by date + machine + shift + hour):
 *   hourly:  { [machineNo]: { [time]: QualityHourlyEntry } }  (one date)
 *   shifts:  { [shiftId]: { supervisor, executive } }         (one date)
 *
 * The component works with a string-based form model (inputs are string
 * driven). At the API boundary entries are mapped to `QualityEntryPayload`,
 * which matches the database columns and their types exactly:
 *   - numeric columns are sent as numbers (or null)
 *   - qc_hold / sqc are integers, not booleans or strings
 *   - defects stay attached to their entry (hourly_production_defect is a
 *     join of entry_id + defect_id that the backend persists)
 *
 * Concurrency notes:
 *   - `load()` deduplicates concurrent requests per date (StrictMode
 *     double-effects, rapid date navigation) via one shared in-flight promise.
 *   - `getDefects()` caches only the static defect master list, never Quality
 *     Monitor records.
 */

import { apiFetch } from '../utils/api';

export interface QualityHourlyEntry {
  entry_id: string;
  report_id: string;
  machine_no: number;
  shift_id: number;
  production_time: string;
  bottle_id: string;
  weight_front: string;
  weight_middle: string;
  weight_rear: string;
  weight_avg: string;
  speed_per_min: string;
  packing_category: string[];
  packing_size: string;
  cartons: string;
  bottles_in_nos: string;
  efficiency_percentage: string;
  weight_efficiency: string;
  sqc: string;
  qc_hold: number;
  num: string;
  remarks: string;
  defect_ids: string[];
  job_id: string;
  /** Actual production period start label (previous displayed row's time). */
  period_start?: string;
  /** Actual production period end label (own time). */
  period_end?: string;
  /**
   * Logical grouping identifier of one manual split (e.g. "SG001").
   * All time segments created from the same split carry the same id while
   * each keeps its own unique entry_id and row. Grouping/history only —
   * never used by any calculation or report.
   */
  split_group_id?: string;
  /**
   * Row lock state (hourly_production.is_locked). When true the row is
   * frozen: the backend rejects any update or delete of this row with
   * "This row is locked and cannot be edited." Only the dedicated lock API
   * changes it, so this flag always reflects the database — never local state.
   */
  is_locked?: boolean;
}

export interface DefectMasterItem {
  defect_id: number;
  defect_type: 'Critical' | 'Major' | 'Minor';
  defect_sr: number;
  defect_name: string;
  is_active: boolean;
}

/**
 * Database-shaped hourly entry used for request payloads and API responses.
 * Field names and types mirror the database schema exactly:
 * hourly_production (entry_id, report_id, machine_no, shift_id,
 * production_time, bottle_id, weight_front, weight_middle,
 * weight_rear, weight_avg, speed_per_min, packing_category, packing_size,
 * cartons, bottles_in_nos, efficiency_percentage, sqc, qc_hold, num, remarks)
 * plus defect_ids (the per-entry defect names; hourly_production_defect is
 * the entry_id + defect_id join created by the backend).
 */
export interface QualityEntryPayload {
  entry_id: number | string | null;
  report_id: number | string | null;
  machine_no: number;
  shift_id: number;
  production_time: string;
  bottle_id: number | null;
  weight_front: number | null;
  weight_middle: number | null;
  weight_rear: number | null;
  weight_avg: number | null;
  speed_per_min: number | null;
  packing_category: string | null;
  packing_size: number | null;
  cartons: number | null;
  bottles_in_nos: number | null;
  efficiency_percentage: number | null;
  weight_efficiency: number | null;
  sqc: number | null;
  qc_hold: number;
  num: number | null;
  remarks: string | null;
  defect_ids: string[];
  job_id: string | null;
  /** Logical split-group identifier (e.g. "SG001") — persisted verbatim, never calculated. */
  split_group_id: string | null;
  /**
   * Lock state of the row, mirrored for shape fidelity with the schema. The
   * daily save never writes this column — only POST .../daily/lock/ does — so
   * echoing it back cannot unlock a row behind the backend's back.
   */
  is_locked?: boolean;
}

export interface QualityShiftAssignment {
  supervisor: string;
  executive: string;
}

export type QualityShiftMap = Record<number, QualityShiftAssignment>;
export type QualityHourlyStore =
  Record<string, Record<string, Record<string, QualityHourlyEntry>>>;
/** One date's hourly map: { [machineNo]: { [time]: entry } } */
export type QualityDayHourly =
  Record<string, Record<string, QualityHourlyEntry>>;

// A row counts as "content" when any meaningful field is filled. Empty
// default-shape slots (the API returns a full 24 x 4 grid) are ignored, so
// they never shadow real local rows and never bloat a save payload.
export const hasMeaningfulData = (e?: QualityHourlyEntry | null): boolean => {
  if (!e) return false;
  if (e.bottle_id || e.job_id) return true;
  if (e.weight_front || e.weight_middle || e.weight_rear || e.weight_avg) return true;
  if (e.speed_per_min || e.packing_size || e.cartons || e.bottles_in_nos || e.efficiency_percentage || e.weight_efficiency) return true;
  if (e.sqc || e.num || e.remarks) return true;
  if (Number(e.qc_hold ?? 0) !== 0) return true;
  if ((e.packing_category?.length ?? 0) > 0) return true;
  if ((e.defect_ids?.length ?? 0) > 0) return true;
  return false;
};

/** One day load result: the DB state plus whether the request actually worked. */
export interface QualityDayLoad {
  hourly: QualityDayHourly;
  shifts: QualityShiftMap;
  ok?: boolean;
  /** Human readable reason when `ok` is false — surfaced to the user. */
  error?: string;
}

export interface QualitySaveResult {
  ok: boolean;
  persisted: boolean;
  hourly?: QualityDayHourly;
  continuation?: QualityDayHourly;
  continuationDate?: string;
  error?: string;
}

/**
 * One machine + Job ID row of the job-wise production summary
 * (GET /api/production/quality/daily/jobs/?date=). The backend derives the
 * start from the job's earliest hourly row inside its 9 AM production day and
 * sums the ACTUAL bottles of that Job ID from its start through the selected
 * report date — never planned or speed-based quantities.
 */
export interface QualityJobRow {
  machine_no: number;
  job_id: string;
  bottle_id: number | null;
  /** Production date + start clock time (a 12 AM-8:59 AM start keeps the previous production date). */
  job_start_time: string;
  job_end_time: string | null;
  status: string;
  /** Job-level remark from hpr_job — null/blank when none exists. */
  remarks: string | null;
  production_units: number;
}

/** One job-wise load result: the rows plus whether the request actually worked. */
export interface QualityJobsLoad {
  rows: QualityJobRow[];
  ok?: boolean;
  error?: string;
}

// Deduplicates concurrent job-wise load requests per date (StrictMode
// double-effects, Refresh, rapid date navigation share one in-flight request).
const inFlightJobLoads = new Map<string, Promise<QualityJobsLoad>>();

// Deduplicates concurrent load requests per date (StrictMode double-effects,
// rapid date navigation, etc. all share one in-flight request).
const inFlightLoads = new Map<string, Promise<QualityDayLoad>>();

const defectNamesCache: {
  resolved: DefectMasterItem[] | null;
  pending: Promise<DefectMasterItem[]> | null;
} = { resolved: null, pending: null };

// ─── Mapping helpers (string-based UI form <-> database-typed payload) ───────

const toNumOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Whole-number columns (bottle_id, cartons, ...). The grid's numeric
 * inputs accept any keystroke, so "12.5" would otherwise travel to the API as a
 * fractional float, be rejected with a 422 and abort the save of the ENTIRE
 * day. Truncating here keeps the payload inside the database's integer columns.
 */
const toIntOrNull = (v: unknown): number | null => {
  const n = toNumOrNull(v);
  return n === null ? null : Math.trunc(n);
};

const toIntOrZero = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
};

const toStrOrEmpty = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  return String(v);
};

const toPackingArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => toStrOrEmpty(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

const toPackingString = (v: unknown): string | null => {
  const list = toPackingArray(v);
  return list.length > 0 ? list.join(', ') : null;
};

const toDefectArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((d: unknown) =>
      typeof d === 'string'
        ? d
        : toStrOrEmpty((d as { defect_name?: unknown; defect_id?: unknown })?.defect_name ??
            (d as { defect_id?: unknown })?.defect_id)
    )
    .filter(Boolean);
};

/** Maps a string-based form entry to the database-shaped payload.
 * period_start/period_end are frontend-only (derived from row ordering) and
 * are intentionally NOT sent: the backend identifies rows by production_time
 * and derives the same period from ordering, so no schema change is needed.
 * split_group_id IS sent: it is the persisted logical grouping of one split's
 * time segments (each keeps its own entry_id and row).
 */
const toDbEntry = (entry: QualityHourlyEntry): QualityEntryPayload => ({
  entry_id: entry.entry_id || null,
  report_id: entry.report_id || null,
  machine_no: entry.machine_no,
  shift_id: entry.shift_id,
  production_time: entry.production_time,
  bottle_id: toIntOrNull(entry.bottle_id),
  weight_front: toNumOrNull(entry.weight_front),
  weight_middle: toNumOrNull(entry.weight_middle),
  weight_rear: toNumOrNull(entry.weight_rear),
  weight_avg: toNumOrNull(entry.weight_avg),
  speed_per_min: toNumOrNull(entry.speed_per_min),
  packing_category: toPackingString(entry.packing_category),
  packing_size: toIntOrNull(entry.packing_size),
  cartons: toIntOrNull(entry.cartons),
  bottles_in_nos: toIntOrNull(entry.bottles_in_nos),
  efficiency_percentage: toNumOrNull(entry.efficiency_percentage),
  weight_efficiency: toNumOrNull(entry.weight_efficiency),
  sqc: toIntOrNull(entry.sqc),
  qc_hold: toIntOrZero(entry.qc_hold),
  num: toIntOrNull(entry.num),
  remarks: toStrOrEmpty(entry.remarks) || null,
  defect_ids: toDefectArray(entry.defect_ids),
  job_id: entry.job_id || null,
  split_group_id: entry.split_group_id?.trim() ? entry.split_group_id.trim() : null,
  is_locked: entry.is_locked === true,
});

/** Maps a database-shaped entry (or already-normalised form entry) back to the form model. */
const fromDbEntry = (raw: Record<string, unknown>): QualityHourlyEntry => ({
  entry_id: toStrOrEmpty(raw.entry_id),
  report_id: toStrOrEmpty(raw.report_id),
  machine_no: toNumOrNull(raw.machine_no) ?? 0,
  shift_id: toNumOrNull(raw.shift_id) ?? 1,
  production_time: toStrOrEmpty(raw.production_time),
  bottle_id: toStrOrEmpty(raw.bottle_id),
  weight_front: toStrOrEmpty(raw.weight_front),
  weight_middle: toStrOrEmpty(raw.weight_middle),
  weight_rear: toStrOrEmpty(raw.weight_rear),
  weight_avg: toStrOrEmpty(raw.weight_avg),
  speed_per_min: toStrOrEmpty(raw.speed_per_min),
  packing_category: toPackingArray(raw.packing_category),
  packing_size: toStrOrEmpty(raw.packing_size),
  cartons: toStrOrEmpty(raw.cartons),
  bottles_in_nos: toStrOrEmpty(raw.bottles_in_nos),
  efficiency_percentage: toStrOrEmpty(raw.efficiency_percentage),
  weight_efficiency: toStrOrEmpty(raw.weight_efficiency),
  sqc: toStrOrEmpty(raw.sqc),
  qc_hold: toIntOrZero(raw.qc_hold),
  num: toStrOrEmpty(raw.num),
  remarks: toStrOrEmpty(raw.remarks),
  defect_ids: toDefectArray(raw.defect_ids),
  job_id: toStrOrEmpty(raw.job_id),
  // Split-group id survives the round-trip verbatim; absent on pre-split rows.
  ...(toStrOrEmpty(raw.split_group_id)
    ? { split_group_id: toStrOrEmpty(raw.split_group_id) }
    : {}),
  // Row lock: the database flag, mapped straight through from the API.
  is_locked: raw.is_locked === true || raw.is_locked === 1 || raw.is_locked === 'true',
  // Periods are (re)derived from ordering after load; passed through when present.
  ...(toStrOrEmpty(raw.period_start)
    ? { period_start: toStrOrEmpty(raw.period_start) }
    : {}),
  ...(toStrOrEmpty(raw.period_end)
    ? { period_end: toStrOrEmpty(raw.period_end) }
    : {}),
});

type NestedPayload =
  Record<string, Record<string, QualityEntryPayload>>;
type NestedForm =
  Record<string, Record<string, QualityHourlyEntry>>;

const buildDbHourly = (hourly: NestedForm): NestedPayload => {
  const out: NestedPayload = {};
  for (const machineKey of Object.keys(hourly ?? {})) {
    out[machineKey] = {};
    const byTime = hourly[machineKey] ?? {};
    for (const timeKey of Object.keys(byTime)) {
      out[machineKey][timeKey] = toDbEntry(byTime[timeKey]);
    }
  }
  return out;
};

const normalizeDbHourly = (raw: Record<string, Record<string, Record<string, unknown>>>): NestedForm => {
  const out: NestedForm = {};
  for (const machineKey of Object.keys(raw ?? {})) {
    out[machineKey] = {};
    const byTime = raw[machineKey] ?? {};
    for (const timeKey of Object.keys(byTime)) {
      out[machineKey][timeKey] = fromDbEntry(byTime[timeKey] ?? {});
    }
  }
  return out;
};

export const qualityRepository = {
  /**
   * Fetches active defects from GET /api/production/quality/defects/?active_only=true.
   * The result is cached so master data is never fetched more than once, and
   * concurrent callers share a single in-flight request.
   */
  async getDefects(activeOnly: boolean = true): Promise<DefectMasterItem[]> {
    if (!activeOnly) {
      const res = await apiFetch('/api/production/quality/defects/?active_only=false');
      return Array.isArray(res) ? (res as DefectMasterItem[]) : [];
    }
    if (defectNamesCache.resolved) return defectNamesCache.resolved;
    if (!defectNamesCache.pending) {
      // Failures propagate to the caller instead of being converted into an
      // empty list: an empty dropdown must be reported, never mistaken for
      // "there are no defects". Only the pending marker is always cleared, so a
      // transient failure can be retried later.
      defectNamesCache.pending = (async () => {
        try {
          const res = await apiFetch('/api/production/quality/defects/?active_only=true');
          const list = Array.isArray(res) ? (res as DefectMasterItem[]) : [];
          defectNamesCache.resolved = list;
          return list;
        } finally {
          defectNamesCache.pending = null;
        }
      })();
    }
    return defectNamesCache.pending;
  },

  /**
   * Loads the hourly + shift assignment data for a single production date
   * straight from the backend. The returned state is exactly what the database
   * currently holds for that date — no local cache or previously loaded rows
   * are merged in, so records deleted from the DB never reappear.
   *
   * `ok` is true only when the API responded successfully. On any failure the
   * result is an empty store with `ok: false` so the caller can surface an
   * error state instead of silently reusing stale data. The backend always
   * returns the full 24 x 4 grid for a reachable date (even when the day has
   * no records), so the UI correctly shows an empty grid when no rows exist.
   * Concurrent calls for the same date share one request.
   */
  async load(dateKey: string): Promise<QualityDayLoad> {
    const pending = inFlightLoads.get(dateKey);
    if (pending) return pending;
    const promise = this._load(dateKey).finally(() => {
      inFlightLoads.delete(dateKey);
    });
    inFlightLoads.set(dateKey, promise);
    return promise;
  },

  async _load(dateKey: string): Promise<QualityDayLoad> {
    try {
      const res = await apiFetch(`/api/production/quality/daily/?date=${dateKey}`);
      if (res && typeof res === 'object') {
        const body = res as {
          hourly?: Record<string, Record<string, Record<string, unknown>>>;
          shift_assignments?: QualityShiftMap;
        };
        if (body.hourly && typeof body.hourly === 'object') {
          return {
            hourly: normalizeDbHourly(body.hourly),
            shifts: body.shift_assignments ?? {},
            ok: true,
          };
        }
        return { hourly: {}, shifts: {}, ok: false, error: 'The server returned an unexpected response.' };
      }
      return { hourly: {}, shifts: {}, ok: false, error: 'The server returned an empty response.' };
    } catch (err) {
      // API endpoint unavailable or the request was rejected (expired session,
      // missing permission, validation error). Report the reason; never fall
      // back to a local cache that may hold rows deleted from the database.
      return {
        hourly: {},
        shifts: {},
        ok: false,
        error: err instanceof Error && err.message ? err.message : 'Could not load saved data.',
      };
    }
  },

  /**
   * Loads the job-wise production summary for a single production date. Used
   * by the Daily Production Performance Report's job table and refreshed by
   * the same date changes / Refresh cycle as the hourly data. Concurrent calls
   * for the same date share one in-flight request.
   *
   * `ok` is true only when the API responded with a row list. On any failure
   * the result is an empty list with `ok: false` — never a throw — so the
   * caller can fall back to deriving the rows from its already-loaded hourly
   * records instead of breaking the existing report.
   */
  async loadJobs(dateKey: string): Promise<QualityJobsLoad> {
    const pending = inFlightJobLoads.get(dateKey);
    if (pending) return pending;
    const promise = this._loadJobs(dateKey).finally(() => {
      inFlightJobLoads.delete(dateKey);
    });
    inFlightJobLoads.set(dateKey, promise);
    return promise;
  },

  async _loadJobs(dateKey: string): Promise<QualityJobsLoad> {
    try {
      const res = await apiFetch(`/api/production/quality/daily/jobs/?date=${dateKey}`);
      if (Array.isArray(res)) {
        return { rows: res as QualityJobRow[], ok: true };
      }
      return { rows: [], ok: false, error: 'The server returned an unexpected response.' };
    } catch (err) {
      return {
        rows: [],
        ok: false,
        error: err instanceof Error && err.message ? err.message : 'Could not load job data.',
      };
    }
  },

  /**
   * Persists the lock checkbox of exactly ONE hourly row to the backend
   * (POST /api/production/quality/daily/lock/). The server writes only
   * hourly_production.is_locked for that row — no other field, no other row
   * and no reload of the day — so toggling a lock can never disturb the rest
   * of the Quality Module.
   *
   * The lock lives in the database rather than in component state: Refresh,
   * a new session and a second browser all read the same flag, and the write
   * APIs reject a locked row even if this client is bypassed entirely.
   *
   * Never throws: `ok` is false with the server's reason on any failure so the
   * caller can undo the optimistic checkbox flip and tell the user why.
   */
  async setRowLock(params: {
    dateKey: string;
    machineNo: number;
    productionTime: string;
    isLocked: boolean;
  }): Promise<{ ok: boolean; is_locked: boolean; error?: string }> {
    try {
      const res = await apiFetch('/api/production/quality/daily/lock/', {
        method: 'POST',
        body: JSON.stringify({
          production_date: params.dateKey,
          machine_no: params.machineNo,
          production_time: params.productionTime,
          is_locked: params.isLocked,
        }),
      });
      const body = res as { is_locked?: boolean } | null;
      if (!body || typeof body !== 'object') {
        return { ok: false, is_locked: !params.isLocked, error: 'The server did not confirm the lock.' };
      }
      return { ok: true, is_locked: body.is_locked === true };
    } catch (err) {
      return {
        ok: false,
        is_locked: !params.isLocked,
        error: err instanceof Error && err.message ? err.message : 'The row lock could not be saved.',
      };
    }
  },

  /**
   * Persists one day of hourly production + shift assignments to the backend.
   * No local cache is written: the database is the source of truth, so a
   * failed POST fails loudly instead of pretending the data was saved.
   *
   * The backend owns job_id: on success it returns the full day's state with
   * the DB-generated job ids, which are returned to the caller so the frontend
   * can reuse them verbatim.
   *
   * `options.keepalive` marks the request as one the browser must let finish
   * even if the page is being torn down. It is used by the module's unload
   * flush; the payload there is a handful of changed rows, so it stays well
   * inside the browser's keepalive size limit.
   */
  async save(
    dateKey: string,
    hourly: QualityDayHourly,
    shifts: QualityShiftMap,
    options: { keepalive?: boolean; deletedSplits?: Record<string, string[]> } = {}
  ): Promise<QualitySaveResult> {
    try {
      const res = await apiFetch('/api/production/quality/daily/', {
        method: 'POST',
        keepalive: options.keepalive === true,
        body: JSON.stringify({
          production_date: dateKey,
          hourly: buildDbHourly(hourly),
          shift_assignments: shifts,
          ...(options.deletedSplits && Object.keys(options.deletedSplits).length > 0
            ? { deleted_splits: options.deletedSplits }
            : {}),
        }),
      });
      const body = res as {
        hourly?: Record<string, Record<string, Record<string, unknown>>>;
        continuation?: Record<string, Record<string, Record<string, unknown>>>;
      } | null;
      // The backend commits the transaction and only then re-queries the day it
      // just wrote, so a 200 response carrying that state IS the proof that the
      // rows were persisted. Anything else is reported as a failed save instead
      // of letting the caller show a success message for unverified data.
      if (!body || typeof body !== 'object' || !body.hourly) {
        return {
          ok: false,
          persisted: false,
          error: 'The server did not confirm the save. Please try again.',
        };
      }
      const result: QualitySaveResult = {
        ok: true,
        persisted: true,
        hourly: normalizeDbHourly(body.hourly),
      };
      if (body.continuation && typeof body.continuation === 'object') {
        result.continuation = normalizeDbHourly(body.continuation);
        const nextDate = new Date(`${dateKey}T00:00:00`);
        nextDate.setDate(nextDate.getDate() + 1);
        const pad = (n: number) => String(n).padStart(2, '0');
        result.continuationDate = `${nextDate.getFullYear()}-${pad(nextDate.getMonth() + 1)}-${pad(nextDate.getDate())}`;
      }
      return result;
    } catch (err) {
      // API unreachable or the backend rejected the payload — nothing was
      // persisted. Keep the reason so the caller can tell the user WHY the
      // save failed instead of silently dropping the changes.
      return {
        ok: false,
        persisted: false,
        error: err instanceof Error && err.message ? err.message : 'Save request failed.',
      };
    }
  },
};
