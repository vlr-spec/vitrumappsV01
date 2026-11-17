/**
 * repackingRepository.ts — API-backed persistence layer for the Repacking Module
 * (Numbering and SQC/QC HOLD).
 *
 * Interacts with FastAPI backend endpoints:
 *   - /api/production/repacking/numbering
 *   - /api/production/repacking/sqc-qc-hold
 *   - /api/production/repacking/employees
 */

import { apiFetch } from '../utils/api';

export interface RepackingNumberingEntry {
  entry_id: string;
  entry_ids?: string[];
  production_date: string;
  machine_no: number;
  job_id: string;
  bottle_id: number | null;
  bottle_name?: string | null;
  pack_type: string | null;
  shift: number;
  entry_time: string;
  pcs_per_pack: number | null;
  cartons: number | null;
  defective_bottles: number | null;
  defect_id: string | null;
  defect_ids?: string[];
  defect_name?: string | null;
  defect_names?: string[];
  mould: string | null;
  section_no: string | null;
  checker_id: string | null;
  checker_name?: string | null;
  qa_shift_ex_id: string | null;
  qa_shift_ex_name?: string | null;
  /** Free-text remarks (sqc.repacking_* .remarks). */
  remarks?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RepackingSqcQcHoldEntry {
  entry_id: string;
  entry_ids?: string[];
  production_date: string;
  machine_no: number;
  job_id: string;
  bottle_id: number | null;
  bottle_name?: string | null;
  pack_type: string | null;
  lot_no: string | null;
  shift: number;
  entry_time: string;
  pcs_per_pack: number | null;
  cartons: number | null;
  defective_bottles: number | null;
  defect_id: string | null;
  defect_ids?: string[];
  defect_name?: string | null;
  defect_names?: string[];
  mould: string | null;
  section_no: string | null;
  checker_id: string | null;
  checker_name?: string | null;
  qa_shift_ex_id: string | null;
  qa_shift_ex_name?: string | null;
  /** Free-text remarks (sqc.repacking_* .remarks). */
  remarks?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Display-only bottle lookup returned by the combined repacking GET. */
export interface BottleNameItem {
  /** production.bottle_master.bottle_id — the numeric ID stored in the DB. */
  bottle_id: number;
  /** production.bottle_master.bottle_name — for the JOB NAME column only. */
  bottle_name: string;
}

export interface EmployeeItem {
  /** ``hpr.employee_master.employee_id`` — always a string so leading zeros ("0003") survive. */
  employee_id: string;
  employee_name: string;
  /** ACTIVE ``sqc.sqc_role`` role codes held by the employee (CHECKER, QA_EXECUTIVE, ...). */
  roles?: string[];
}

let employeesCache: EmployeeItem[] | null = null;

// Cache for combined repacking data, keyed by production date (YYYY-MM-DD).
// Avoids re-fetching numbering + SQC/QC HOLD when revisiting the same date
// (e.g. navigating away and back, or switching layouts on a previously loaded date).
const repackingDataCache: Record<
  string,
  {
    numbering: RepackingNumberingEntry[];
    sqc: RepackingSqcQcHoldEntry[];
    bottleNames: BottleNameItem[];
  } | null
> = {};

export const repackingRepository = {
  // --- Employee list ---
  async getEmployees(): Promise<EmployeeItem[]> {
    if (employeesCache && employeesCache.length > 0) return employeesCache;
    try {
      const data = (await apiFetch('/api/production/repacking/employees')) as EmployeeItem[];
      if (Array.isArray(data)) {
        employeesCache = data;
        return data;
      }
      return [];
    } catch (err) {
      console.error('Failed to fetch employees:', err);
      return [];
    }
  },

  /**
   * Fetch both numbering and SQC/QC HOLD entries for one production date in a
   * single API request (GET /api/production/repacking/). Results are cached by
   * date so revisiting the same date does not trigger a repeated request.
   * Falls back to the two legacy endpoints if the combined endpoint is not yet
   * available. Use invalidateRepackingCache() to evict a date after a save.
   */
  async getRepackingData(
    productionDate: string
  ): Promise<{
    numbering: RepackingNumberingEntry[];
    sqc: RepackingSqcQcHoldEntry[];
    bottleNames: BottleNameItem[];
  }> {
    const cached = repackingDataCache[productionDate];
    if (cached) return cached;

    try {
      const qs = new URLSearchParams({ production_date: productionDate }).toString();
      const data = (await apiFetch(`/api/production/repacking/?${qs}`)) as {
        numbering?: unknown;
        sqc_qc_hold?: unknown;
        bottle_names?: unknown;
      };

      const result = {
        numbering: Array.isArray(data?.numbering) ? (data.numbering as RepackingNumberingEntry[]) : [],
        sqc: Array.isArray(data?.sqc_qc_hold) ? (data.sqc_qc_hold as RepackingSqcQcHoldEntry[]) : [],
        bottleNames: Array.isArray(data?.bottle_names) ? (data.bottle_names as BottleNameItem[]) : [],
      };

      repackingDataCache[productionDate] = result;
      return result;
    } catch (combinedErr) {
      // Fallback: fetch numbering and SQC/QC HOLD separately (legacy endpoints).
      const [numbering, sqc] = await Promise.all([
        this.getNumbering(productionDate),
        this.getSqcQcHold(productionDate),
      ]);
      const result = { numbering, sqc, bottleNames: [] as BottleNameItem[] };
      repackingDataCache[productionDate] = result;
      return result;
    }
  },

  /** Evict the cached repacking data for a date so the next fetch is fresh (call after a save). */
  invalidateRepackingCache(productionDate: string): void {
    delete repackingDataCache[productionDate];
  },

  // --- Numbering APIs ---
  async getNumbering(
    productionDate?: string,
    machineNo?: number,
    jobId?: string
  ): Promise<RepackingNumberingEntry[]> {
    const params = new URLSearchParams();
    if (productionDate) params.append('production_date', productionDate);
    if (machineNo !== undefined) params.append('machine_no', String(machineNo));
    if (jobId) params.append('job_id', jobId);

    const qs = params.toString();
    const url = `/api/production/repacking/numbering${qs ? `?${qs}` : ''}`;
    const data = (await apiFetch(url)) as RepackingNumberingEntry[];
    return Array.isArray(data) ? data : [];
  },

  async createNumbering(payload: Partial<RepackingNumberingEntry>): Promise<RepackingNumberingEntry> {
    return (await apiFetch('/api/production/repacking/numbering', {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as RepackingNumberingEntry;
  },

  async updateNumbering(
    entryId: string,
    payload: Partial<RepackingNumberingEntry>
  ): Promise<RepackingNumberingEntry> {
    return (await apiFetch(`/api/production/repacking/numbering/${entryId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })) as RepackingNumberingEntry;
  },

  async deleteNumbering(entryId: string): Promise<boolean> {
    const res = (await apiFetch(`/api/production/repacking/numbering/${entryId}`, {
      method: 'DELETE',
    })) as { ok: boolean };
    return !!res?.ok;
  },

  async saveNumberingBatch(
    inserts: Partial<RepackingNumberingEntry>[],
    updates: (Partial<RepackingNumberingEntry> & { entry_id: string })[]
  ): Promise<RepackingNumberingEntry[]> {
    const data = (await apiFetch('/api/production/repacking/numbering/save', {
      method: 'POST',
      body: JSON.stringify({ inserts, updates }),
    })) as RepackingNumberingEntry[];
    return Array.isArray(data) ? data : [];
  },

  // --- SQC/QC HOLD APIs ---
  async getSqcQcHold(
    productionDate?: string,
    machineNo?: number,
    jobId?: string
  ): Promise<RepackingSqcQcHoldEntry[]> {
    const params = new URLSearchParams();
    if (productionDate) params.append('production_date', productionDate);
    if (machineNo !== undefined) params.append('machine_no', String(machineNo));
    if (jobId) params.append('job_id', jobId);

    const qs = params.toString();
    const url = `/api/production/repacking/sqc-qc-hold${qs ? `?${qs}` : ''}`;
    const data = (await apiFetch(url)) as RepackingSqcQcHoldEntry[];
    return Array.isArray(data) ? data : [];
  },

  async createSqcQcHold(payload: Partial<RepackingSqcQcHoldEntry>): Promise<RepackingSqcQcHoldEntry> {
    return (await apiFetch('/api/production/repacking/sqc-qc-hold', {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as RepackingSqcQcHoldEntry;
  },

  async updateSqcQcHold(
    entryId: string,
    payload: Partial<RepackingSqcQcHoldEntry>
  ): Promise<RepackingSqcQcHoldEntry> {
    return (await apiFetch(`/api/production/repacking/sqc-qc-hold/${entryId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })) as RepackingSqcQcHoldEntry;
  },

  async deleteSqcQcHold(entryId: string): Promise<boolean> {
    const res = (await apiFetch(`/api/production/repacking/sqc-qc-hold/${entryId}`, {
      method: 'DELETE',
    })) as { ok: boolean };
    return !!res?.ok;
  },

  async saveSqcQcHoldBatch(
    inserts: Partial<RepackingSqcQcHoldEntry>[],
    updates: (Partial<RepackingSqcQcHoldEntry> & { entry_id: string })[]
  ): Promise<RepackingSqcQcHoldEntry[]> {
    const data = (await apiFetch('/api/production/repacking/sqc-qc-hold/save', {
      method: 'POST',
      body: JSON.stringify({ inserts, updates }),
    })) as RepackingSqcQcHoldEntry[];
    return Array.isArray(data) ? data : [];
  },
};
