import React, { useEffect, useMemo, useState } from 'react';
import { Download, Printer, Save } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import {
  repackingRepository,
  RepackingSqcQcHoldEntry,
  BottleNameItem,
} from '../../services/repackingRepository';
import { qualityRepository } from '../../services/qualityRepository';
import { useERP } from '../../context/ERPContext';
import { useAuth, MODULES } from '../../context/AuthContext';
import {
  groupDefectsByType,
  styleForDefectCategory,
  type DefectGroup,
} from '../../utils/defectCategories';

/**
 * Resorting Module — classic, print-friendly report sheets.
 *
 *   • Numbering Report   — static 17-column pallet-sorting register shell
 *   • SQC / QC HOLD (QA-F-10) — LIVE report built from the same saved entries
 *     the Quality Module's SQC/QC HOLD tab uses, via repackingRepository.
 *
 * The left-hand resorting logs act as a master list: a bottle must be selected
 * before its detail sheet is shown. All progress is tracked in packs.
 */

const MACHINE_NUMBERS = [1, 2, 3, 4] as const;
type MachineNo = (typeof MACHINE_NUMBERS)[number];
type MachineFilter = 'all' | MachineNo;

const NUMBERING_BOTTLE_ROWS = [0, 1, 2, 3, 4];
const NUMBERING_SHIFT_ROWS = ['1st Shift', '2nd Shift', '3rd Shift'];
const RESORTING_LOG_STORAGE_KEY = 'vitrum-sqc-qc-resorting-log-v2';

const ROMAN_SHIFT: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III' };

/** Status filter shared by every SQC / QC HOLD table on the report tab. */
type StatusFilter = 'pending' | 'completed' | 'all';
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  pending: 'Pending',
  completed: 'Completed',
  all: 'All',
};
const STATUS_FILTER_CAPTION: Record<StatusFilter, string> = {
  pending: 'Showing Pending entries across all dates',
  completed: 'Showing Completed entries across all dates',
  all: 'Showing All entries across all dates',
};
/** Independent pagination for each of the four SQC / QC HOLD tables. */
const PAGE_SIZE = 20;
type PageKey = 'sqcLog' | 'qcLog' | 'sqc' | 'qc';
type PageState = Record<PageKey, number>;
const INITIAL_PAGE_STATE: PageState = { sqcLog: 1, qcLog: 1, sqc: 1, qc: 1 };
const matchesStatus = (balance: number, status: StatusFilter): boolean =>
  status === 'all' || (status === 'pending' ? balance > 0 : balance === 0);
const pageSlice = <T,>(rows: T[], page: number): T[] =>
  rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
const pageTotal = (rowCount: number): number => Math.max(1, Math.ceil(rowCount / PAGE_SIZE));

/**
 * Exact Excel-matched 15-column proportions for BOTH right-hand detail grids.
 * The <colgroup> is the only width source; no per-cell width classes compete
 * with it. Reason, Bottle Name and Remarks stay generous while numeric,
 * shift/lot and progress columns remain compact.
 */
const DETAIL_TABLE_COL_WIDTHS = [
  '4%', // M/c.
  '6%', // Date
  '14.5%', // Bottle Name
  '3.5%', // Shift
  '4.5%', // Lot
  '6%', // Pcs / Pack
  '6%', // Pack Type
  '4.5%', // Packs
  '5%', // Qty
  '15.5%', // Reason
  '6.5%', // Cav.
  '4.5%', // OK Qty
  '4.5%', // Rejected
  '4.5%', // Balance
  '14.5%', // Remarks
] as const;
/** Tailwind classes on the M/c. <th>/<td> in both sheets (width comes from <colgroup>). */
const MC_CELL_CLASS = 'prm-mc-cell prm-mc-cell--sqc px-1 text-center whitespace-nowrap';

// ─── Date helpers (local calendar date, no timezone drift) ──────────────────
const pad2 = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const shiftIso = (iso: string, days: number): string => {
  const d = fromIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
};
/** YYYY-MM-DD → DD.MM.YYYY (the format printed in the QA-F-10 header). */
const toDisplayDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d || '00'}.${m || '00'}.${y || '0000'}`;
};
const isValidIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ─── Small value helpers ────────────────────────────────────────────────────
const asNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const asText = (v: unknown): string => (v == null ? '' : String(v).trim());
/** Pack type is optional on older saved rows, so keep the fallback clean. */
const packTypeOf = (entry: RepackingSqcQcHoldEntry): string =>
  asText(entry.pack_type) ||
  asText((entry as RepackingSqcQcHoldEntry & { packing_type?: unknown }).packing_type);
/** Entry date for the new Date column; blank when a legacy row has no date. */
const formatEntryDate = (iso: string): string =>
  isValidIso(iso) ? toDisplayDate(iso) : asText(iso);
const dedupe = (values: string[]): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = asText(raw);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.join(', ');
};
/** DEFECTS are saved as defect_ids and returned by the backend as names. */
const defectNamesOf = (entry: RepackingSqcQcHoldEntry): string[] => {
  if (Array.isArray(entry.defect_names) && entry.defect_names.length > 0) {
    return entry.defect_names.map((n) => asText(n)).filter(Boolean);
  }
  return asText(entry.defect_name)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
};
// ─── Strict SQC / QC classification ─────────────────────────────────────────
/** Numeric lot value; `NaN` for blank/non-numeric lots. */
const lotNumber = (entry: RepackingSqcQcHoldEntry): number => {
  const raw = asText(entry.lot_no);
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
};
/** QC HOLD is only an explicitly entered Lot No. 0 with tracking details. */
const isQcHoldEntry = (entry: RepackingSqcQcHoldEntry): boolean => {
  if (asText(entry.lot_no) !== '0') return false;
  const filled = (v: unknown) => v !== null && v !== undefined && asText(v) !== '';
  return (
    filled(entry.pcs_per_pack) ||
    filled(entry.cartons) ||
    filled(entry.defective_bottles) ||
    defectNamesOf(entry).length > 0 ||
    !!asText(entry.mould) ||
    !!asText(entry.section_no) ||
    !!asText(entry.checker_name) ||
    !!asText(entry.qa_shift_ex_name) ||
    !!asText(entry.remarks)
  );
};
/** SQC is only an explicitly positive Lot No.; zero and blank lots never land here. */
const isSqcEntry = (entry: RepackingSqcQcHoldEntry): boolean => {
  const lot = lotNumber(entry);
  return Number.isFinite(lot) && lot > 0;
};
/** Qty is always derived per entry, never copied from raw cartons/packs. */
const entryQty = (entry: RepackingSqcQcHoldEntry): number =>
  asNum(entry.cartons) * asNum(entry.pcs_per_pack) + asNum(entry.defective_bottles);

// ─── Aggregated report row ──────────────────────────────────────────────────
interface SqcGroupRow {
  key: string;
  /** localStorage key: exact merged-row key plus the SQC kind prefix. */
  sourceKey: string;
  /** The report date the source entry was saved on (the batch's origin date). */
  productionDate: string;
  machineNo: MachineNo;
  /** First source Job ID for reference only; never part of the grouping key. */
  jobId: string;
  jobName: string;
  shift: number;
  lotNo: string;
  pcsPerPack: number;
  packType: string;
  packs: number;
  looseBottles: number;
  qty: number;
  reason: string;
  cav: string;
  sec: string;
  remarks: string;
  /** True for a job/bottle with no cartons or bottles entered (all-zero row). */
  isZero: boolean;
}

/** A saved QC HOLD line, kept separate from the SQC "kept aside" sheet. */
interface QcHoldGroupRow {
  key: string;
  /** localStorage key: exact merged-row key plus the QC kind prefix. */
  sourceKey: string;
  /** The report date the source entry was saved on (the batch's origin date). */
  productionDate: string;
  machineNo: MachineNo;
  /** First source Job ID for reference only; never part of the grouping key. */
  jobId: string;
  jobName: string;
  shift: number;
  /** String so a genuine lot `0` is preserved. */
  lotNo: string;
  pcsPerPack: number;
  packType: string;
  packs: number;
  /** Per-entry (Cartons × Pack Size) + Loose Bottles, summed for the lot. */
  qty: number;
  mould: string;
  defects: string;
  checker: string;
  remarks: string;
}

// ─── Resorting log — UI-only state, saved to localStorage (never to the DB) ──
interface ResortingEntry {
  id: string;
  /** Editable sorting date for this step of the batch. */
  date: string;
  okQty: number;
  rejected: number;
}

interface ResortingBatch {
  id: string;
  /** Which tracking matrix this batch belongs to. */
  kind: 'sqc' | 'qc';
  /** Exact merged-row identity; one batch per visible detail line. */
  sourceKey: string;
  /** First source job ID (display only; never part of the grouping key). */
  jobId: string;
  /** Exact production date from the live database records. */
  originDate: string;
  machineNo: MachineNo;
  bottleName: string;
  lotNo: string;
  shift: number;
  /** Combined Pack count of every entry merged into this detail row. */
  initialHold: number;
  /** One entry per batch; its progress is edited on the detail row. */
  entries: ResortingEntry[];
}

/** One (Date + Bottle Name) line in the left-side pending queue (packs). */
interface ResortingLogRow {
  id: string;
  kind: 'sqc' | 'qc';
  /** Exact ISO production date shared by every entry behind this row. */
  date: string;
  bottleName: string;
  /** Combined pending packs across all lots/entries of this bottle on this date. */
  balance: number;
}

/** The left table only supplies the exact Date + Bottle Name to the detail pane. */
interface ResortingSelection {
  kind: 'sqc' | 'qc';
  date: string;
  bottleName: string;
}

let logSeq = 0;
const logId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(logSeq += 1).toString(36)}`;
/** Normalized key fragments shared by aggregation and progress tracking. */
const normalizedPackType = (entry: RepackingSqcQcHoldEntry): string =>
  asText((entry as any).pack_type || (entry as any).packing_type).toLowerCase();
const normalizedReasonKey = (entry: RepackingSqcQcHoldEntry): string =>
  defectNamesOf(entry).map((d) => asText(d).toLowerCase()).sort().join('|');
const normalizedCavKey = (entry: RepackingSqcQcHoldEntry): string =>
  asText(entry.mould).toLowerCase();

/** Exact merged-row key requested for the right-hand detail table. */
const mergedRowKey = (
  productionDate: string,
  machineNo: MachineNo,
  bottleName: string,
  shift: number,
  lotNo: string,
  packType: string,
  reasonKey: string,
  cavKey: string
): string =>
  `${productionDate}|${machineNo}|${bottleName.toLowerCase()}|${shift}|` +
  `${lotNo.toLowerCase()}|${packType.toLowerCase()}|${reasonKey}|${cavKey}`;

/**
 * localStorage identity: the exact merged-row key plus a kind prefix so an
 * SQC row and a QC HOLD row with identical visible values never collide.
 * job_id and pcs_per_pack deliberately do NOT split the row.
 */
const sqcBatchSourceKey = (
  originDate: string,
  machineNo: MachineNo,
  bottleName: string,
  shift: number,
  lotNo: string,
  packType: string,
  reasonKey: string,
  cavKey: string
): string =>
  `sqc|${mergedRowKey(originDate, machineNo, bottleName, shift, lotNo, packType, reasonKey, cavKey)}`;

/** Equivalent identity for QC HOLD rows (defects + mould fill Reason + Cav.). */
const qcBatchSourceKey = (
  originDate: string,
  machineNo: MachineNo,
  bottleName: string,
  shift: number,
  lotNo: string,
  packType: string,
  defectsKey: string,
  mouldKey: string
): string =>
  `qc|${mergedRowKey(originDate, machineNo, bottleName, shift, lotNo, packType, defectsKey, mouldKey)}`;

/** Read the stable leading fields of any cached key, including legacy keys. */
const legacyBatchFields = (sourceKey: string) => {
  const parts = sourceKey.split('|');
  const machine = Number(parts[2]);
  return {
    machineNo: (MACHINE_NUMBERS.includes(machine as MachineNo) ? machine : 1) as MachineNo,
    bottleName: parts[3] || '',
    shift: Number(parts[4]) || 1,
    lotNo: parts[5] || '',
  };
};

/**
 * Stale localStorage copies must never double-count a merged detail row. Keep
 * one batch per unique row key; when copies disagree, keep the one with the
 * most saved progress rather than adding their values together.
 */
const dedupeBatches = (batches: ResortingBatch[]): ResortingBatch[] => {
  const byKey = new Map<string, ResortingBatch>();
  for (const batch of batches) {
    const key = `${batch.kind}|${batch.sourceKey}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, batch);
      continue;
    }
    if (batchProgress(batch) > batchProgress(existing)) byKey.set(key, batch);
  }
  return [...byKey.values()];
};

const batchProgress = (batch: ResortingBatch): number =>
  (batch.entries[0]?.okQty ?? 0) + (batch.entries[0]?.rejected ?? 0);

/**
 * The left logs are strictly (kind + production date + bottle name) summaries.
 * Several lots / shifts / job IDs for one bottle on one date become ONE row
 * whose Pending Qty is the sum of every entry's remaining packs.
 */
const groupLogRows = (batches: ResortingBatch[]): ResortingLogRow[] => {
  const grouped = new Map<string, ResortingLogRow>();
  for (const batch of batches) {
    const entry = batch.entries[0];
    if (!entry) continue;
    const okQty = Math.max(0, asNum(entry.okQty));
    const rejected = Math.max(0, asNum(entry.rejected));
    const balance = Math.max(0, asNum(batch.initialHold) - okQty - rejected);
    const date = batch.originDate || entry.date || '';
    const bottleName = batch.bottleName || '';
    const key = `${batch.kind}|${date}|${bottleName.toLowerCase()}`;
    const row = grouped.get(key) ?? {
      id: key,
      kind: batch.kind,
      date,
      bottleName,
      balance: 0,
    };
    row.balance += balance;
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.bottleName.localeCompare(b.bottleName)
  );
};

/** Sorting progress lives on one entry per batch, edited from the QA-F-10 row. */
const setBatchProgress = (
  batch: ResortingBatch,
  hold: number,
  okQty: number,
  rejected: number
): ResortingBatch => {
  const entry = batch.entries[0];
  const cappedOk = Math.min(Math.max(0, okQty), Math.max(0, hold));
  const cappedRejected = Math.min(Math.max(0, rejected), Math.max(0, hold - cappedOk));
  return {
    ...batch,
    initialHold: hold,
    entries: [{
      id: entry?.id ?? logId('entry'),
      date: batch.originDate || entry?.date || '',
      okQty: cappedOk,
      rejected: cappedRejected,
    }],
  };
};

/** Restore locally saved sorting data, tolerating missing/corrupt storage. */
const loadStoredBatches = (): ResortingBatch[] => {
  try {
    const raw = localStorage.getItem(RESORTING_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeBatches(parsed
      .filter((b: any) =>
        !!b &&
        typeof b.id === 'string' &&
        typeof b.sourceKey === 'string' &&
        typeof b.originDate === 'string' &&
        typeof b.bottleName === 'string' &&
        typeof b.initialHold === 'number' &&
        Array.isArray(b.entries)
      )
      .map((b) => {
        const kind: 'sqc' | 'qc' = b.kind === 'qc' ? 'qc' : 'sqc';
        // Batches saved before the split were SQC log entries; prefix their old
        // source keys so revisiting a date does not seed a duplicate batch.
        const sourceKey =
          b.kind === 'sqc' || b.kind === 'qc' ? b.sourceKey : `sqc|${b.sourceKey}`;
        const inferred = legacyBatchFields(sourceKey);
        const hold = Math.max(0, asNum(b.initialHold));
        const entries = b.entries
          .filter((e: any) => e && typeof e.id === 'string')
          .map((e: any) => ({
            id: e.id as string,
            date: typeof e.date === 'string' ? e.date : '',
            okQty: Math.max(0, asNum(e.okQty)),
            rejected: Math.max(0, asNum(e.rejected)),
          }));
        // Older logs could hold several follow-up entries. One detail row now
        // owns all sorting progress, so collapse them into one dated entry and
        // cap the totals at the batch's merged Pack count.
        const okQty = Math.min(hold, entries.reduce((sum: number, e: any) => sum + e.okQty, 0));
        const rejected = Math.min(
          Math.max(0, hold - okQty),
          entries.reduce((sum: number, e: any) => sum + e.rejected, 0)
        );
        return {
          ...b,
          kind,
          sourceKey,
          jobId: typeof b.jobId === 'string' ? b.jobId : '',
          originDate: b.originDate,
          machineNo: (MACHINE_NUMBERS.includes(asNum(b.machineNo) as MachineNo)
            ? asNum(b.machineNo) : inferred.machineNo) as MachineNo,
          bottleName: b.bottleName || inferred.bottleName,
          lotNo: typeof b.lotNo === 'string' ? b.lotNo : inferred.lotNo,
          shift: Number(b.shift) || inferred.shift,
          initialHold: hold,
          entries: [{
            id: entries[0]?.id ?? logId('entry'),
            date: b.originDate || entries[0]?.date || '',
            okQty,
            rejected,
          }],
        } as ResortingBatch;
      }));
  } catch {
    return [];
  }
};

const PRM_STYLES = `
.prm-root {
  padding: 20px 24px 32px;
  max-width: 1920px;
  margin: 0 auto;
  color: #0f172a;
  font-family: "Segoe UI", Arial, Helvetica, sans-serif;
  box-sizing: border-box;
}
.prm-root *, .prm-root *::before, .prm-root *::after { box-sizing: border-box; }

/* ── Tab state (CSS only — the report tabs are purely presentational) ───── */
.prm-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.prm-view { display: none; }
#prm-tab-numbering:checked ~ .prm-view--numbering { display: block; }
#prm-tab-sqc:checked ~ .prm-view--sqc { display: block; }

/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.prm-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 20px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.prm-tab-labels { display: flex; gap: 4px; padding: 3px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 9px; }
.prm-tab-label {
  cursor: pointer; padding: 7px 14px; border-radius: 6px; border: 1px solid transparent;
  font-size: 12.5px; font-weight: 600; line-height: 1.2; color: #475569;
  white-space: nowrap; user-select: none;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}
.prm-tab-label:hover { color: #1d4ed8; background: #e2e8f0; }
#prm-tab-numbering:checked ~ .prm-toolbar .prm-tab-label--numbering,
#prm-tab-sqc:checked ~ .prm-toolbar .prm-tab-label--sqc {
  background: #2563eb; border-color: #2563eb; color: #ffffff;
  box-shadow: 0 1px 3px rgba(37, 99, 235, 0.3);
}
#prm-tab-numbering:checked ~ .prm-toolbar .prm-tab-label--numbering:hover,
#prm-tab-sqc:checked ~ .prm-toolbar .prm-tab-label--sqc:hover { color: #ffffff; }

.prm-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
.prm-control-group { display: flex; align-items: center; gap: 8px; }
.prm-status-filter { margin-left: 4px; }
.prm-status-options { display: flex; gap: 3px; padding: 3px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 9px; }
.prm-status-option {
  height: 27px; padding: 0 12px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: #475569; font: inherit; font-size: 12px; font-weight: 700;
  cursor: pointer; white-space: nowrap;
}
.prm-status-option:hover { background: #e2e8f0; color: #1d4ed8; }
.prm-status-option--active, .prm-status-option--active:hover {
  background: #2563eb; border-color: #2563eb; color: #ffffff;
}
.prm-field-label { font-size: 11.5px; font-weight: 600; color: #475569; white-space: nowrap; }
.prm-input, .prm-select {
  height: 32px; padding: 0 9px; border: 1px solid #cbd5e1; border-radius: 7px;
  background: #ffffff; color: #0f172a; font-size: 12px; font-family: inherit; outline: none;
}
.prm-input:focus, .prm-select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.13); }
.prm-input[type="date"] { min-width: 152px; }
.prm-select { min-width: 138px; cursor: pointer; }
.prm-day-btn {
  height: 32px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 7px;
  background: #ffffff; color: #334155; font-size: 11.5px; font-weight: 600;
  font-family: inherit; white-space: nowrap; cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.prm-day-btn:hover { background: #f1f5f9; border-color: #94a3b8; }
.prm-actions { margin-left: auto; display: flex; gap: 8px; }
.prm-action-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 14px; border-radius: 7px; font-size: 12px; font-weight: 700;
  font-family: inherit; white-space: nowrap; cursor: pointer;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.prm-action-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.prm-action-btn svg { width: 14px; height: 14px; }
.prm-action-btn--primary { background: #2563eb; color: #ffffff; border: 1px solid #2563eb; box-shadow: 0 1px 2px rgba(37, 99, 235, 0.25); }
.prm-action-btn--primary:hover:not(:disabled) { background: #1d4ed8; }
.prm-action-btn--save { background: #2563eb; color: #ffffff; border: 1px solid #2563eb; box-shadow: 0 1px 2px rgba(37, 99, 235, 0.25); }
.prm-action-btn--save:hover:not(:disabled) { background: #1d4ed8; }
.prm-action-btn--outline { background: #ffffff; color: #1d4ed8; border: 1px solid #93c5fd; }
.prm-action-btn--outline:hover:not(:disabled) { background: #eff6ff; }

/* ── Sheet / captions ────────────────────────────────────────────────────── */
.prm-sheet {
  background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 22px 24px 26px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.prm-sheet-caption {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
  gap: 8px 20px; margin-bottom: 9px; font-size: 12px; color: #1e293b;
}
.prm-sheet-caption-date { font-weight: 700; white-space: nowrap; }
.prm-status {
  font-size: 11px; font-weight: 600; color: #64748b;
  margin: 0 0 8px; padding: 5px 9px; border-radius: 6px; background: #f8fafc;
  border: 1px solid #e2e8f0;
}
.prm-status--error { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }

/* ── Classic bordered grid ───────────────────────────────────────────────── */
.prm-grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px; line-height: 1.25; color: #000000; }
.prm-grid th, .prm-grid td {
  border: 1px solid #000000; padding: 5px 4px; text-align: center; vertical-align: middle;
  overflow: hidden; word-break: break-word;
}
.prm-grid th { font-weight: 700; background: #f8fafc; }
.prm-grid-title {
  font-family: Georgia, "Times New Roman", serif; font-size: 16px; font-weight: 700;
  letter-spacing: 0.5px; padding: 9px 4px !important; background: #ffffff !important;
}
.prm-grid-group { font-weight: 700; }
.prm-mc-cell { font-weight: 700; background: #f8fafc; white-space: nowrap; }
.prm-name-cell { text-align: left !important; padding-left: 7px !important; }
.prm-shift-row { background: #f8fafc; }
.prm-shift-name { font-weight: 700; }
.prm-total-row td { font-weight: 700; background: #f8fafc; }
.prm-grid--sqc th { background: #d6e4ff; }
.prm-grid--sqc .prm-grid-title, .prm-grid--sqc .prm-grid-subtitle { background: #d6e4ff !important; }
.prm-grid-subtitle { font-size: 11.5px; font-weight: 600; text-align: left !important; padding-left: 8px !important; }
.prm-grid-code { font-weight: 700; }
.prm-mc-cell--sqc { background: #d6e4ff; }
.prm-muted-cell { color: #000000; }
/* Wide flexible columns: defect badges and remarks wrap instead of clipping. */
.prm-grid--sqc .prm-reason-cell,
.prm-grid--sqc .prm-remarks-cell {
  text-align: left !important;
  white-space: normal !important;
  overflow: visible !important;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* SQC / QC HOLD sheet — text-xs (12px), bold, pure black for every header and
   data cell. Tight padding keeps the narrow numeric columns compact inside the
   expanded 75% detail pane while Reason / Remarks wrap freely. */
.prm-grid--sqc { font-size: 12px; line-height: 1.2; color: #000000; }
.prm-grid--sqc th, .prm-grid--sqc td {
  font-size: 12px;
  font-weight: 700;
  color: #000000;
  border-color: #cbd5e1 !important;
  padding: 6px 6px;
}
/* Compact headers stay on one line inside their narrow <colgroup> slots;
   Bottle Name, Reason and Remarks wrap naturally. */
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(1),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(4),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(5),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(6),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(7),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(8),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(9),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(12),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(13),
.prm-grid--sqc thead tr.prm-grid-group th:nth-child(14) {
  white-space: nowrap;
}
.prm-grid--sqc .prm-mc-cell {
  padding-left: 4px !important;
  padding-right: 4px !important;
  text-align: center !important;
  white-space: nowrap;
}
/* Editable OK Qty / Rejected cells shrink inside their 4.5% columns. */
.prm-grid--sqc .prm-progress-cell { padding: 2px !important; }
.prm-grid-progress-input {
  width: 100%; min-width: 0; padding: 2px; box-sizing: border-box;
  border: 1px solid #94a3b8; border-radius: 3px;
  background: #ffffff; color: #000000;
  font: inherit; font-weight: 700; text-align: center;
}
/* One clean spacer row per machine block (h-3 ≈ 12px): no top/bottom or inner
   cell borders, only the table's left/right edges. */
.prm-grid--sqc .prm-mc-spacer td {
  height: 12px;
  padding: 0 !important;
  border-top: 0 !important;
  border-bottom: 0 !important;
  border-left: 1px solid #cbd5e1;
  border-right: 1px solid #cbd5e1;
  background: #ffffff !important;
}

/* QC HOLD sheet reuses .prm-grid--sqc so both sheets share the exact same
   steel-blue headers, light-grey borders, bold type, spacing and spacer rows. */
.prm-report-left > .prm-grid + .prm-grid { margin-top: 14px; }
/* Note is a bordered row physically attached to the bottom of each sheet. */
.prm-grid--sqc .prm-note-row { border-color: #cbd5e1 !important; }
.prm-note-row td {
  border-top: 0 !important;
  text-align: left !important;
  padding: 8px 12px !important;
  font-size: 10.5px;
  font-weight: 700;
  color: #000000;
}

/* ── Sub-table on the SQC sheet ──────────────────────────────────────────── */
.prm-subtable { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 18px; font-size: 14px; color: #000000; }
.prm-subtable th, .prm-subtable td { border: 1px solid #000000; padding: 6px 8px; text-align: left; vertical-align: middle; font-size: 14px; font-weight: 700; color: #000000; }
.prm-subtable th { background: #dce6f1; font-weight: 700; }
.prm-subtable-note td { font-size: 14px; }
.prm-subtable-notes td { height: 30px; }

/* ── 75 / 25 split: expanded detail sheet left, compact log right ────────── */
.prm-report-split { display: flex; flex-direction: column; gap: 16px; align-items: flex-start; }
.prm-report-left, .prm-report-right { width: 100%; min-width: 0; }
@media (min-width: 1024px) {
  .prm-report-split { flex-direction: row; }
  .prm-report-left { width: 75%; max-width: 75%; flex: 1 1 75%; }
  .prm-report-right { width: 25%; max-width: 25%; flex: 1 1 25%; }
}

/* ── SQC / QC HOLD Resorting Log ─────────────────────────────────────────── */
.prm-log { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; color: #000000; }
.prm-log th, .prm-log td {
  border: 1px solid #cbd5e1; padding: 6px 5px; text-align: center;
  vertical-align: middle; font-weight: 700; color: #000000;
  overflow: hidden; word-break: break-word;
}
.prm-log th { background: #d6e4ff; }
.prm-log-title { padding: 8px 5px !important; font-size: 12px; letter-spacing: 0.3px; }
.prm-log-name { text-align: left !important; padding-left: 7px !important; }
.prm-log-row--selectable {
  cursor: pointer;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.prm-log-row--selectable:hover { background: #eff6ff; }
.prm-log-row--selectable:focus-visible { outline: 2px solid #2563eb; outline-offset: -2px; }
.prm-log-row--selected,
.prm-log-row--selected:hover { background: #e2eaf8; box-shadow: inset 0 0 0 1px #2563eb; }
.prm-log-row--selected .prm-log-name { color: #1d4ed8; }
.prm-detail-empty {
  display: flex; align-items: center; justify-content: center; min-height: 180px;
  border: 1px dashed #94a3b8; border-radius: 8px; background: #f8fafc;
  color: #475569; font-size: 12px; font-weight: 600; text-align: center; padding: 24px;
}
.prm-log-caption { margin-bottom: 8px; font-size: 11px; font-weight: 700; color: #000000; }
.prm-log-stack { display: flex; flex-direction: column; gap: 14px; }
.prm-log-section { min-width: 0; }

/* ── Pagination (screen only; print always includes every filtered row) ──── */
.prm-pager {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end;
  gap: 6px 12px; margin-top: 6px; font-size: 11px; color: #475569;
}
.prm-pager button {
  height: 26px; padding: 0 9px; border: 1px solid #cbd5e1; border-radius: 6px;
  background: #ffffff; color: #1d4ed8; font: inherit; font-weight: 700; cursor: pointer;
}
.prm-pager button:hover:not(:disabled) { background: #eff6ff; }
.prm-pager button:disabled { opacity: 0.45; cursor: not-allowed; }
.prm-pager-count { color: #64748b; font-weight: 600; white-space: nowrap; }

/* ── Print: only the selected detail sheet and its totals ────────────────── */
@media print {
  @page { size: A4 landscape; margin: 8mm; }
  .prm-root { padding: 0 !important; max-width: none !important; margin: 0 !important; }
  .prm-toolbar, .prm-radio, .prm-status, .prm-pager, .prm-sheet-caption,
  .prm-detail-empty, .prm-report-right { display: none !important; }
  .prm-view--numbering { display: none !important; }
  .prm-view--sqc { display: block !important; }
  .prm-sheet { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; padding: 0 !important; }
  .prm-report-split { display: block !important; }
  .prm-report-left { display: block !important; width: 100% !important; max-width: 100% !important; }
  .prm-report-left > .prm-grid { width: 100% !important; max-width: 100% !important; }
  .prm-grid, .prm-subtable { font-size: 12px !important; color: #000000 !important; }
  .prm-grid th, .prm-grid td, .prm-subtable th, .prm-subtable td {
    color: #000000 !important;
    font-weight: 700 !important;
    font-size: 12px !important;
    border-color: #000000 !important;
    padding-top: 2px !important;
    padding-bottom: 2px !important;
  }
  .prm-grid--sqc th, .prm-grid--sqc td { border-color: #cbd5e1 !important; }
  .prm-grid th.prm-grid-title { font-size: 14px !important; }
  .prm-grid tr, .prm-subtable tr { break-inside: avoid; page-break-inside: avoid; }
  .prm-root * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

/** Static placeholder tail of a Numbering data row (15 cells after M/c.). */
const NumberingTailCells: React.FC = () => (
  <>
    <td /><td /><td /><td /><td />
    <td /><td /><td /><td /><td />
    <td /><td /><td /><td /><td />
  </>
);

// ─── Aggregation helpers ────────────────────────────────────────────────────

const bottleNameFor = (
  entry: { bottle_id?: unknown; bottle_name?: unknown },
  lookup: Map<string, string>
): string => asText(entry.bottle_name) || lookup.get(String(entry.bottle_id ?? '')) || '';

/**
 * The right-hand detail rows are aggregated on the exact visible identity:
 * Date + Machine + Bottle + Shift + Lot + Pack Type + Reason + Cav. Two entries
 * merge only when all five editable attributes match; any difference keeps a
 * separate row. `job_id` and `pcs_per_pack` are display-only, never split keys.
 */
const aggregateSqc = (
  entries: RepackingSqcQcHoldEntry[],
  lookup: Map<string, string>
): Map<MachineNo, SqcGroupRow[]> => {
  const byMachine = new Map<MachineNo, SqcGroupRow[]>();
  for (const m of MACHINE_NUMBERS) byMachine.set(m, []);

  for (const entry of entries) {
    if (!isSqcEntry(entry)) continue;
    const machineNo = asNum(entry.machine_no) as MachineNo;
    if (!byMachine.has(machineNo)) continue;

    const productionDate = asText(entry.production_date);
    const jobName = bottleNameFor(entry, lookup);
    const shift = asNum(entry.shift) || 1;
    const lotNo = asText(entry.lot_no);
    const packType = packTypeOf(entry);
    const reasonKey = normalizedReasonKey(entry);
    const cavKey = normalizedCavKey(entry);
    const key = mergedRowKey(
      productionDate, machineNo, jobName, shift, lotNo, packType, reasonKey, cavKey
    );
    const sourceKey = sqcBatchSourceKey(
      productionDate, machineNo, jobName, shift, lotNo, packType, reasonKey, cavKey
    );

    const rows = byMachine.get(machineNo)!;
    let group = rows.find((r) => r.key === key);
    if (!group) {
      group = {
        key,
        sourceKey,
        productionDate,
        machineNo,
        // First source job is kept for reference only; the key never uses it.
        jobId: asText(entry.job_id),
        jobName,
        shift,
        lotNo,
        pcsPerPack: asNum(entry.pcs_per_pack),
        packType,
        packs: 0,
        looseBottles: 0,
        qty: 0,
        reason: dedupe(defectNamesOf(entry)),
        cav: dedupe([asText(entry.mould), asText(entry.section_no)]),
        sec: asText(entry.section_no),
        remarks: asText(entry.remarks),
        isZero: false,
      };
      rows.push(group);
    }
    group.packs += asNum(entry.cartons);
    group.looseBottles += asNum(entry.defective_bottles);
    group.qty += entryQty(entry);
    group.reason = dedupe([...group.reason.split(', '), ...defectNamesOf(entry)]);
    group.cav = dedupe([
      ...group.cav.split(', '), asText(entry.mould), asText(entry.section_no)
    ]);
    group.sec = dedupe([...group.sec.split(', '), asText(entry.section_no)]);
    const remark = asText(entry.remarks);
    if (remark) group.remarks = dedupe([...group.remarks.split(', '), remark]);
  }

  for (const rows of byMachine.values()) {
    for (const row of rows) {
      // A zero-quantity entry is still a real saved line, but the report shows
      // it as an empty job row. Its grouping key remains intact for progress.
      if (row.packs === 0 && row.qty === 0) {
        row.isZero = true;
        row.shift = 0;
        row.lotNo = '';
        row.pcsPerPack = 0;
        row.reason = '';
        row.cav = '';
        row.sec = '';
        row.remarks = '';
      }
    }
  }
  return byMachine;
};

/** Blank for empty/unpopulated cells; a genuine `0` string is preserved. */
const blankOr = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '' : String(value);

/**
 * Displays the same defect text used for aggregation/export, but colours each
 * name with the category from the live defect master. `Other` (and any future
 * category) gets the neutral tag style automatically; unknown names stay plain.
 */
const DefectTags: React.FC<{
  value: string;
  categoryByName: Map<string, string>;
}> = ({ value, categoryByName }) => {
  const names = value.split(',').map((n) => asText(n)).filter(Boolean);
  if (names.length === 0) return null;
  return (
    <>
      {names.map((name, idx) => {
        const category = categoryByName.get(name.toLowerCase());
        const s = styleForDefectCategory(category);
        return (
          <React.Fragment key={`${name}-${idx}`}>
            {idx > 0 ? ', ' : null}
            <span
              title={category || undefined}
              style={{
                display: 'inline-block',
                padding: '0 3px',
                borderRadius: '3px',
                backgroundColor: s.bg,
                color: s.color,
                border: `1px solid ${s.border}`,
              }}
            >
              {name}
            </span>
          </React.Fragment>
        );
      })}
    </>
  );
};

/**
 * Equivalent merged identity for QC HOLD entries. Defects fill Reason and the
 * saved mould/section fills Cav.; checker, QA name and remarks never split a
 * row, and remarks are concatenated from the saved free text only.
 */
const aggregateQcHolds = (
  entries: RepackingSqcQcHoldEntry[],
  lookup: Map<string, string>
): QcHoldGroupRow[] => {
  const rows: QcHoldGroupRow[] = [];
  for (const entry of entries) {
    if (!isQcHoldEntry(entry)) continue;
    const machineNo = asNum(entry.machine_no) as MachineNo;
    if (!MACHINE_NUMBERS.includes(machineNo)) continue;

    const productionDate = asText(entry.production_date);
    const jobName = bottleNameFor(entry, lookup);
    const shift = asNum(entry.shift) || 1;
    const lotNo = asText(entry.lot_no); // Genuine `0` stays visible as text.
    const packType = packTypeOf(entry);
    const defectsKey = normalizedReasonKey(entry);
    const mouldKey = normalizedCavKey(entry);
    const key = mergedRowKey(
      productionDate, machineNo, jobName, shift, lotNo, packType, defectsKey, mouldKey
    );
    const sourceKey = qcBatchSourceKey(
      productionDate, machineNo, jobName, shift, lotNo, packType, defectsKey, mouldKey
    );

    const mould = dedupe([asText(entry.mould), asText(entry.section_no)]);
    const defects = defectNamesOf(entry);
    const remark = asText(entry.remarks);
    let group = rows.find((row) => row.key === key);
    if (!group) {
      group = {
        key,
        sourceKey,
        productionDate,
        machineNo,
        jobId: asText(entry.job_id), // Reference only; never part of the key.
        jobName,
        shift,
        lotNo,
        pcsPerPack: asNum(entry.pcs_per_pack),
        packType,
        packs: 0,
        qty: 0,
        mould,
        defects: dedupe(defects),
        checker: asText(entry.checker_name),
        remarks: remark,
      };
      rows.push(group);
    }
    group.packs += asNum(entry.cartons);
    group.qty += entryQty(entry);
    group.defects = dedupe([...group.defects.split(', '), ...defects]);
    group.mould = dedupe([...group.mould.split(', '), asText(entry.mould), asText(entry.section_no)]);
    if (remark) group.remarks = dedupe([...group.remarks.split(', '), remark]);
  }
  return rows.filter((row) => row.qty > 0 || row.packs > 0 || !!row.defects);
};

/**
 * One merged SQC / QC HOLD database line as a row of the right-hand detail
 * table. `sourceKey` is the exact grouping key, so progress always attaches to
 * the row the user sees and to no other row.
 */
interface ResortingDetailRow {
  key: string;
  kind: 'sqc' | 'qc';
  sourceKey: string;
  machineNo: MachineNo;
  productionDate: string;
  bottleName: string;
  shift: number;
  lotNo: string;
  pcsPerPack: number;
  packType: string;
  packs: number;
  qty: number;
  reason: string;
  cav: string;
  notes: string;
}

const detailRowFromSqcGroup = (group: SqcGroupRow): ResortingDetailRow => ({
  key: group.sourceKey,
  kind: 'sqc',
  sourceKey: group.sourceKey,
  machineNo: group.machineNo,
  productionDate: group.productionDate,
  bottleName: group.jobName,
  shift: group.shift,
  lotNo: group.lotNo,
  pcsPerPack: group.pcsPerPack,
  packType: group.packType,
  packs: group.packs,
  qty: group.qty,
  reason: group.reason,
  cav: group.cav,
  notes: group.remarks,
});

const detailRowFromQcGroup = (group: QcHoldGroupRow): ResortingDetailRow => ({
  key: group.sourceKey,
  kind: 'qc',
  sourceKey: group.sourceKey,
  machineNo: group.machineNo,
  productionDate: group.productionDate,
  bottleName: group.jobName,
  shift: group.shift,
  lotNo: group.lotNo,
  pcsPerPack: group.pcsPerPack,
  packType: group.packType,
  packs: group.packs,
  qty: group.qty,
  reason: group.defects,
  cav: group.mould,
  notes: group.remarks,
});

/** One localStorage batch per merged detail row, clamped to its combined packs. */
const makeDetailBatch = (
  detail: ResortingDetailRow,
  okQty = 0,
  rejected = 0
): ResortingBatch =>
  setBatchProgress({
    id: logId('batch'),
    kind: detail.kind,
    sourceKey: detail.sourceKey,
    jobId: '',
    originDate: detail.productionDate,
    machineNo: detail.machineNo,
    bottleName: detail.bottleName,
    lotNo: detail.lotNo,
    shift: detail.shift,
    initialHold: detail.packs,
    entries: [{
      id: logId('entry'),
      date: detail.productionDate,
      okQty,
      rejected,
    }],
  }, detail.packs, okQty, rejected);

// ─── Component ──────────────────────────────────────────────────────────────

export const ResortingModule: React.FC = () => {
  const { bottles } = useERP();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission(MODULES.QUALITY_CONTROL, 'edit');
  const [dateIso, setDateIso] = useState<string>(() => toIso(new Date()));
  const [machineFilter, setMachineFilter] = useState<MachineFilter>('all');
  /** Numbering tab still uses the CSS-only radio pair; this mirrors it for the
   *  toolbar so date/machine controls can be hidden on the SQC tab only. */
  const [reportMode, setReportMode] = useState<'numbering' | 'sqc'>('sqc');
  /** Sole visibility control for every SQC / QC HOLD table. */
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [pages, setPages] = useState<PageState>(INITIAL_PAGE_STATE);
  /** All saved SQC / QC HOLD entries across every production date. */
  const [entries, setEntries] = useState<RepackingSqcQcHoldEntry[]>([]);
  const [bottleNames, setBottleNames] = useState<BottleNameItem[]>([]);
  const [allDataLoaded, setAllDataLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exporting, setExporting] = useState(false);
  // Resorting log is local UI state, restored from localStorage on mount.
  const [resortingBatches, setResortingBatches] = useState<ResortingBatch[]>(loadStoredBatches);
  /** No detail table is shown until a bottle is picked from a left-hand log. */
  const [selectedLog, setSelectedLog] = useState<ResortingSelection | null>(null);
  /** Defect master is still used to colour the inline Reason badges. */
  const [defectGroups, setDefectGroups] = useState<DefectGroup[]>([]);

  useEffect(() => {
    let active = true;
    qualityRepository.getDefects(true)
      .then((defects) => {
        if (active) setDefectGroups(groupDefectsByType(defects));
      })
      .catch(() => {
        if (active) setDefectGroups([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // The SQC / QC HOLD report is date-independent: one fetch returns every saved
  // entry on every date. The Status Filter is now the only visibility control,
  // so changing the Numbering tab's report date can never hide history here.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setAllDataLoaded(false);

    repackingRepository.getAllRepackingData()
      .then(({ sqc, bottleNames: names }) => {
        if (!active) return;
        setEntries(Array.isArray(sqc) ? sqc : []);
        setBottleNames(Array.isArray(names) ? names : []);
        setAllDataLoaded(true);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load SQC/QC HOLD report data:', err);
        setEntries([]);
        setLoadError('Could not load saved SQC / QC HOLD entries.');
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // Same bottle-name sources the Quality Module uses for the JOB NAME column.
  const bottleLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bottles) {
      const id = asText(b.id);
      if (id) map.set(id, asText(b.name));
    }
    for (const b of bottleNames) {
      map.set(String(b.bottle_id), asText(b.bottle_name));
    }
    return map;
  }, [bottles, bottleNames]);

  /** Merged SQC / QC HOLD group rows — the only rows the detail tables render. */
  const sqcGroupsByMachine = useMemo(
    () => aggregateSqc(entries, bottleLookup),
    [entries, bottleLookup]
  );
  const qcGroups = useMemo(
    () => aggregateQcHolds(entries, bottleLookup),
    [entries, bottleLookup]
  );
  const allDetailRows = useMemo(() => {
    const rows: ResortingDetailRow[] = [];
    for (const groups of sqcGroupsByMachine.values()) {
      for (const group of groups) rows.push(detailRowFromSqcGroup(group));
    }
    for (const group of qcGroups) rows.push(detailRowFromQcGroup(group));
    return rows;
  }, [sqcGroupsByMachine, qcGroups]);

  /** Exact merged-row lookup plus legacy identity indexes for cache migration. */
  const detailBySourceKey = useMemo(
    () => new Map(allDetailRows.map((row) => [row.sourceKey, row])),
    [allDetailRows]
  );
  const legacyDetailIndex = useMemo(() => {
    const strict = new Map<string, ResortingDetailRow[]>();
    const loose = new Map<string, ResortingDetailRow[]>();
    const push = (map: Map<string, ResortingDetailRow[]>, key: string, row: ResortingDetailRow) => {
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    };
    for (const row of allDetailRows) {
      push(strict, `${row.kind}|${row.productionDate}|${row.machineNo}|${row.bottleName.toLowerCase()}|${row.shift}|${row.lotNo.toLowerCase()}`, row);
      push(loose, `${row.kind}|${row.productionDate}|${row.bottleName.toLowerCase()}`, row);
    }
    return { strict, loose };
  }, [allDetailRows]);

  // Category lookup comes from the DB master so inline Reason badges keep their
  // category colours; the separate breakdown legend is intentionally removed.
  const defectCategoryByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of defectGroups) {
      for (const name of group.items) map.set(name.toLowerCase(), group.group);
    }
    return map;
  }, [defectGroups]);

  // One cached batch per merged detail row. Stale per-entry batches are folded
  // into the merged row they now belong to, without ever double-counting.
  useEffect(() => {
    if (loading || loadError || !allDataLoaded) return;
    setResortingBatches((prev) => {
      const bySourceKey = new Map<string, ResortingBatch>();
      const keep = (batch: ResortingBatch) => {
        const key = `${batch.kind}|${batch.sourceKey}`;
        const existing = bySourceKey.get(key);
        if (!existing || batchProgress(batch) > batchProgress(existing)) {
          bySourceKey.set(key, batch);
        }
      };
      const moveProgress = (details: ResortingDetailRow[], okQty: number, rejected: number) => {
        details.forEach((detail, idx) => keep(makeDetailBatch(
          detail,
          idx === 0 ? okQty : 0,
          idx === 0 ? rejected : 0
        )));
      };

      for (const batch of dedupeBatches(prev)) {
        const okQty = batch.entries[0]?.okQty ?? 0;
        const rejected = batch.entries[0]?.rejected ?? 0;
        const detail = detailBySourceKey.get(batch.sourceKey);
        if (detail) {
          keep(makeDetailBatch(detail, okQty, rejected));
          continue;
        }
        // Legacy keys carried job_id / pcs_per_pack / entry ids. Re-attach their
        // progress using the stable visible identity of the new merged row.
        const strictKey = `${batch.kind}|${batch.originDate}|${batch.machineNo}|${batch.bottleName.toLowerCase()}|${batch.shift}|${batch.lotNo.toLowerCase()}`;
        const looseKey = `${batch.kind}|${batch.originDate}|${batch.bottleName.toLowerCase()}`;
        const candidates =
          legacyDetailIndex.strict.get(strictKey) ?? legacyDetailIndex.loose.get(looseKey) ?? [];
        if (candidates.length > 0) {
          moveProgress(candidates, okQty, rejected);
        }
      }
      for (const detail of allDetailRows) keep(makeDetailBatch(detail));
      return [...bySourceKey.values()];
    });
  }, [allDataLoaded, allDetailRows, detailBySourceKey, legacyDetailIndex, loading, loadError]);

  // One row per (kind + exact production date + bottle name); all lots and
  // shifts for that bottle/date contribute to the single Pending Qty.
  const resortingRows = useMemo<ResortingLogRow[]>(
    () => groupLogRows(resortingBatches),
    [resortingBatches]
  );

  const sqcLogRows = useMemo(
    () => resortingRows.filter((row) =>
      row.kind === 'sqc' && matchesStatus(row.balance, statusFilter)
    ),
    [resortingRows, statusFilter]
  );
  const qcLogRows = useMemo(
    () => resortingRows.filter((row) =>
      row.kind === 'qc' && matchesStatus(row.balance, statusFilter)
    ),
    [resortingRows, statusFilter]
  );

  // Machine filter belongs to the Numbering toolbar only; every SQC table now
  // shows all machines and is filtered solely by the Status Filter.
  const allMachines = useMemo(() => [...MACHINE_NUMBERS] as MachineNo[], []);
  const statusCaption = STATUS_FILTER_CAPTION[statusFilter];

  // Inline QA-F-10 inputs and the resorting logs share the same saved batches.
  const reportBatchBySourceKey = useMemo(
    () => new Map(resortingBatches.map((batch) => [batch.sourceKey, batch])),
    [resortingBatches]
  );
  /** All progress values are pack counts, capped against the row's Packs. */
  const reportProgressFor = (sourceKey: string, holdPacks: number) => {
    const entry = reportBatchBySourceKey.get(sourceKey)?.entries[0];
    const okQty = Math.min(Math.max(0, entry?.okQty ?? 0), Math.max(0, holdPacks));
    const rejected = Math.min(
      Math.max(0, entry?.rejected ?? 0),
      Math.max(0, holdPacks - okQty)
    );
    return { okQty, rejected, balance: Math.max(0, holdPacks - okQty - rejected) };
  };

  /** Excel exports the same merged detail rows as the sheet, status-filtered. */
  const sqcReportRows = useMemo(
    () => allDetailRows.filter((row) =>
      row.kind === 'sqc' &&
      matchesStatus(reportProgressFor(row.sourceKey, row.packs).balance, statusFilter)
    ),
    [allDetailRows, reportBatchBySourceKey, statusFilter]
  );
  const qcReportRows = useMemo(
    () => allDetailRows.filter((row) =>
      row.kind === 'qc' &&
      matchesStatus(reportProgressFor(row.sourceKey, row.packs).balance, statusFilter)
    ),
    [allDetailRows, reportBatchBySourceKey, statusFilter]
  );

  // Master / detail: the left row supplies ONLY kind + exact date + bottle.
  // Every merged row for that triple is shown, including different lots,
  // shifts, machines and cavities; unrelated dates/bottles are excluded.
  const selectedDetailRows = useMemo(() => {
    if (!selectedLog) return [] as ResortingDetailRow[];
    const bottle = selectedLog.bottleName.toLowerCase();
    return allDetailRows.filter((row) =>
      row.kind === selectedLog.kind &&
      row.productionDate === selectedLog.date &&
      row.bottleName.toLowerCase() === bottle
    );
  }, [allDetailRows, selectedLog]);

  const sqcDetailRows = selectedDetailRows.filter((row) => row.kind === 'sqc');
  const qcDetailRows = selectedDetailRows.filter((row) => row.kind === 'qc');

  /** Pack-based totals for every merged row behind the selected log row. */
  const detailTotals = useMemo(() => {
    const totals = {
      sqcQty: 0, qcQty: 0,
      sqcOk: 0, sqcRejected: 0, sqcBalance: 0,
      qcOk: 0, qcRejected: 0, qcBalance: 0,
    };
    for (const row of sqcDetailRows) {
      totals.sqcQty += row.qty;
      if (row.packs <= 0) continue;
      const progress = reportProgressFor(row.sourceKey, row.packs);
      totals.sqcOk += progress.okQty;
      totals.sqcRejected += progress.rejected;
      totals.sqcBalance += progress.balance;
    }
    for (const row of qcDetailRows) {
      totals.qcQty += row.qty;
      if (row.packs <= 0) continue;
      const progress = reportProgressFor(row.sourceKey, row.packs);
      totals.qcOk += progress.okQty;
      totals.qcRejected += progress.rejected;
      totals.qcBalance += progress.balance;
    }
    return totals;
  }, [sqcDetailRows, qcDetailRows, reportBatchBySourceKey]);

  const sqcRowCount = sqcReportRows.length;
  const qcRowCount = qcReportRows.length;

  // Screen-only pagination for the left logs; the detail sheet always shows all
  // merged rows for the selected date + bottle, and Excel uses un-paged arrays.
  const pagedSqcLogRows = pageSlice(sqcLogRows, pages.sqcLog);
  const pagedQcLogRows = pageSlice(qcLogRows, pages.qcLog);

  // Keep pages in range when loaded data changes underneath an open view.
  useEffect(() => {
    setPages((prev) => {
      const next: PageState = {
        sqcLog: Math.min(prev.sqcLog, pageTotal(sqcLogRows.length)),
        qcLog: Math.min(prev.qcLog, pageTotal(qcLogRows.length)),
        sqc: Math.min(prev.sqc, pageTotal(sqcRowCount)),
        qc: Math.min(prev.qc, pageTotal(qcRowCount)),
      };
      return (next.sqcLog === prev.sqcLog && next.qcLog === prev.qcLog &&
        next.sqc === prev.sqc && next.qc === prev.qc) ? prev : next;
    });
  }, [sqcLogRows.length, qcLogRows.length, sqcRowCount, qcRowCount]);

  /** Status is the only visibility control; changing it restarts every table. */
  const handleStatusFilterChange = (value: StatusFilter) => {
    setStatusFilter(value);
    setSelectedLog(null);
    setPages(INITIAL_PAGE_STATE);
  };

  /** Print CSS hides the logs and toolbar, leaving only the selected detail grid. */
  const handlePrint = () => window.print();

  const renderPager = (key: PageKey, rowCount: number) => {
    if (rowCount <= PAGE_SIZE) return null;
    const page = pages[key];
    const total = pageTotal(rowCount);
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, rowCount);
    return (
      <div className="prm-pager" aria-label={`${key} pagination`}>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPages((prev) => ({ ...prev, [key]: Math.max(1, prev[key] - 1) }))}
        >
          &lt; Prev
        </button>
        <span>Page {page} of {total}</span>
        <button
          type="button"
          disabled={page >= total}
          onClick={() => setPages((prev) => ({ ...prev, [key]: Math.min(total, prev[key] + 1) }))}
        >
          Next &gt;
        </button>
        <span className="prm-pager-count">Showing {start}–{end} of {rowCount}</span>
      </div>
    );
  };

  const updateReportProgress = (
    kind: 'sqc' | 'qc',
    sourceKey: string,
    originDate: string,
    bottleName: string,
    lotNo: string,
    initialHold: number,
    field: 'okQty' | 'rejected',
    value: string
  ) => {
    if (!canEdit) return;
    const existing = reportBatchBySourceKey.get(sourceKey);
    const current = existing?.entries[0];
    const nextOk = field === 'okQty' ? Math.max(0, asNum(value)) : current?.okQty ?? 0;
    const nextRejected = field === 'rejected' ? Math.max(0, asNum(value)) : current?.rejected ?? 0;
    const hold = initialHold;
    if (nextOk + nextRejected > hold) {
      toast.error(`OK Qty + Rejected cannot exceed the pack count of ${hold}.`, { duration: 1800 });
      return;
    }
    setResortingBatches((prev) => {
      const batch = prev.find((item) => item.sourceKey === sourceKey);
      if (batch) {
        return prev.map((item) =>
          item.id === batch.id ? setBatchProgress(item, hold, nextOk, nextRejected) : item
        );
      }
      const start = originDate || '';
      // The merged source key carries the stable display identity; job_id and
      // entry ids are intentionally absent so progress follows the visible row.
      const inferred = legacyBatchFields(sourceKey);
      return [...prev, {
        id: logId('batch'),
        kind,
        sourceKey,
        jobId: '',
        originDate: start,
        machineNo: inferred.machineNo,
        bottleName,
        lotNo: lotNo || inferred.lotNo,
        shift: inferred.shift,
        initialHold,
        entries: [{
          id: logId('entry'), date: start, okQty: nextOk, rejected: nextRejected,
        }],
      }];
    });
  };

  const handleSave = () => {
    if (!canEdit) return;
    try {
      localStorage.setItem(RESORTING_LOG_STORAGE_KEY, JSON.stringify(resortingBatches));
      const sqcCount = resortingBatches.filter((batch) => batch.kind === 'sqc').length;
      const qcCount = resortingBatches.filter((batch) => batch.kind === 'qc').length;
      toast.success(
        `Resorting logs saved — ${sqcCount} SQC / ${qcCount} QC hold batch${sqcCount + qcCount === 1 ? '' : 'es'}.`,
        { duration: 2500 }
      );
    } catch (err) {
      console.error('Failed to save SQC / QC HOLD resorting log:', err);
      toast.error('Could not save the resorting log. Please try again.');
    }
  };

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const exceljsModule: any = await import('exceljs');
      const ExcelJS = exceljsModule.Workbook ? exceljsModule : exceljsModule.default;
      const workbook = new ExcelJS.Workbook();
      // Bold, pure-black typography with the application's blue header tint.
      const tableFont = { bold: true, size: 11, color: { argb: 'FF000000' } };
      const border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
      const headerFill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4FF' },
      };
      const styleData = (row: any) => row.eachCell((cell: any) => {
        cell.font = { ...tableFont };
        cell.border = border;
      });
      const styleHeader = (row: any) => {
        row.font = { ...tableFont };
        row.eachCell((cell: any) => {
          cell.fill = headerFill;
          cell.border = border;
        });
      };
      const excelText = (value: string | number | null | undefined): string =>
        value === null || value === undefined ? '' : String(value);
      const excelNumber = (value: number): number | '' => (value > 0 ? value : '');

      // Only the active right-hand matrix is exported; no sidebar log blocks.
      const isQc = selectedLog?.kind === 'qc';
      const rows = isQc ? qcDetailRows : sqcDetailRows;
      const totals = isQc
        ? {
          qty: detailTotals.qcQty,
          ok: detailTotals.qcOk,
          rejected: detailTotals.qcRejected,
          balance: detailTotals.qcBalance,
        }
        : {
          qty: detailTotals.sqcQty,
          ok: detailTotals.sqcOk,
          rejected: detailTotals.sqcRejected,
          balance: detailTotals.sqcBalance,
        };
      const sheet = workbook.addWorksheet(isQc ? 'QC HOLD' : 'SQC');
      sheet.mergeCells('A1:O1');
      sheet.getCell('A1').value = isQc
        ? 'REPORT OF QC HOLD MATERIALS (QC HOLD)'
        : 'REPORT OF NON CONFORMING MATERIALS (SQC)';
      sheet.getCell('A1').font = { bold: true, size: 14, name: 'Times New Roman' };
      sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

      sheet.mergeCells('A2:O2');
      sheet.getCell('A2').value = isQc
        ? `Material kept aside for QC Hold. (QC HOLD). ${statusCaption}`
        : `Material kept aside for Resorting. ( SQC). ${statusCaption}`;
      sheet.getCell('A2').font = { ...tableFont };

      styleHeader(sheet.addRow([
        'M/c.', 'Date', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack', 'Pack Type', 'Packs', 'Qty',
        'Reason', 'Cav.', 'OK Qty', 'Rejected', 'Balance', 'Remarks',
      ]));
      for (const machineNo of allMachines) {
        const machineRows = rows.filter((row) => row.machineNo === machineNo);
        if (machineRows.length === 0) continue;
        machineRows.forEach((row, idx) => {
          const isActive = row.packs > 0;
          const progress = isActive
            ? reportProgressFor(row.sourceKey, row.packs)
            : { okQty: 0, rejected: 0, balance: 0 };
          styleData(sheet.addRow([
            idx === 0 ? `M/c. ${machineNo}` : '',
            formatEntryDate(row.productionDate),
            row.bottleName,
            row.shift ? ROMAN_SHIFT[row.shift] || String(row.shift) : '',
            excelText(row.lotNo),
            row.pcsPerPack > 0 ? row.pcsPerPack : '',
            excelText(row.packType),
            row.packs > 0 ? row.packs : '',
            excelNumber(row.qty),
            row.reason,
            row.cav,
            isActive ? excelNumber(progress.okQty) : '',
            isActive ? excelNumber(progress.rejected) : '',
            isActive ? excelNumber(progress.balance) : '',
            row.notes,
          ]));
        });
        const spacer = sheet.addRow([]);
        spacer.height = 9;
        spacer.getCell(1).border = { left: { style: 'thin' }, right: { style: 'thin' } };
        spacer.getCell(15).border = { left: { style: 'thin' }, right: { style: 'thin' } };
      }
      styleData(sheet.addRow([
        '', '', 'Total', '', '', '', '', '', excelNumber(totals.qty),
        '', '',
        excelNumber(totals.ok),
        excelNumber(totals.rejected),
        excelNumber(totals.balance),
        '',
      ]));
      if (isQc) {
        // Note is a bordered row attached directly to the bottom of the table.
        const noteRowNumber = sheet.rowCount + 1;
        sheet.mergeCells(`A${noteRowNumber}:O${noteRowNumber}`);
        const noteCell = sheet.getCell(`A${noteRowNumber}`);
        noteCell.value = 'Note : Amber colour of the bottle is within specification.';
        noteCell.font = { ...tableFont };
        noteCell.border = {
          top: { style: 'none' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' },
        };
      }
      sheet.columns = [
        { width: 8 }, { width: 12 }, { width: 22 }, { width: 8 }, { width: 11 },
        { width: 11 }, { width: 12 }, { width: 9 }, { width: 10 }, { width: 30 },
        { width: 11 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 30 },
      ];
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Resorting_${isQc ? 'QC_HOLD' : 'SQC'}_${(selectedLog?.date || 'all').replace(/-/g, '')}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export SQC / QC HOLD report:', err);
    } finally {
      setExporting(false);
    }
  };

  /** A left row selects only its kind + exact production date + bottle name. */
  const selectLogRow = (row: ResortingLogRow) => {
    setSelectedLog({
      kind: row.kind,
      date: row.date,
      bottleName: row.bottleName,
    });
  };

  const renderResortingLog = (kind: 'sqc' | 'qc', title: string) => {
    const rows = kind === 'sqc' ? pagedSqcLogRows : pagedQcLogRows;
    const rowCount = kind === 'sqc' ? sqcLogRows.length : qcLogRows.length;
    const displayDate = (row: ResortingLogRow): string =>
      isValidIso(row.date) ? toDisplayDate(row.date) : row.date || '—';

    return (
      <section className="prm-log-section" aria-label={title}>
        <table className="prm-log text-xs">
          <colgroup>
            <col style={{ width: '30%' }} />
            <col style={{ width: '42%' }} />
            <col style={{ width: '28%' }} />
          </colgroup>
          <thead>
            <tr><th className="prm-log-title" colSpan={3}>{title}</th></tr>
            <tr><th>Date</th><th>Bottle Name</th><th>Pending Qty</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={3}>No balances for the selected status.</td></tr>
            ) : (
              rows.map((row) => {
                const selected = selectedLog?.kind === row.kind &&
                  selectedLog.date === row.date &&
                  selectedLog.bottleName.toLowerCase() === row.bottleName.toLowerCase();
                return (
                  <tr
                    key={row.id}
                    className={`prm-log-row--selectable${selected ? ' prm-log-row--selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    title={`View details for ${row.bottleName}`}
                    onClick={() => selectLogRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectLogRow(row);
                      }
                    }}
                  >
                    <td>{displayDate(row)}</td>
                    <td className="prm-log-name">{row.bottleName}</td>
                    <td>{row.balance}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {renderPager(kind === 'sqc' ? 'sqcLog' : 'qcLog', rowCount)}
      </section>
    );
  };

  return (
    <div className="prm-root">
      <style>{PRM_STYLES}</style>
      <Toaster position="bottom-right" richColors />

      <input
        className="prm-radio"
        type="radio"
        name="prm-report-view"
        id="prm-tab-numbering"
        checked={reportMode === 'numbering'}
        onChange={() => setReportMode('numbering')}
      />
      <input
        className="prm-radio"
        type="radio"
        name="prm-report-view"
        id="prm-tab-sqc"
        checked={reportMode === 'sqc'}
        onChange={() => setReportMode('sqc')}
      />

      {/* ── Top control & filter bar ─────────────────────────────────────── */}
      <div className="prm-toolbar">
        <div className="prm-tab-labels" role="tablist" aria-label="Report view">
          <label className="prm-tab-label prm-tab-label--numbering" htmlFor="prm-tab-numbering">
            Numbering Report
          </label>
          <label className="prm-tab-label prm-tab-label--sqc" htmlFor="prm-tab-sqc">
            SQC / QC HOLD Report
          </label>
        </div>

        {reportMode === 'sqc' && (
          <div className="prm-control-group prm-status-filter">
            <span className="prm-field-label" id="prm-status-filter-label">Status Filter</span>
            <div className="prm-status-options" role="group" aria-labelledby="prm-status-filter-label">
              {(['pending', 'completed', 'all'] as StatusFilter[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`prm-status-option${statusFilter === value ? ' prm-status-option--active' : ''}`}
                  aria-pressed={statusFilter === value}
                  onClick={() => handleStatusFilterChange(value)}
                >
                  {STATUS_FILTER_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
        )}

        {reportMode === 'numbering' && (
          <div className="prm-controls">
            <div className="prm-control-group">
              <label className="prm-field-label" htmlFor="prm-report-date">Report Date</label>
              <input
                className="prm-input"
                id="prm-report-date"
                type="date"
                value={dateIso}
                onChange={(e) => {
                  if (isValidIso(e.target.value)) setDateIso(e.target.value);
                }}
              />
            </div>
            <div className="prm-control-group">
              <button className="prm-day-btn" type="button" onClick={() => setDateIso((p) => shiftIso(p, -1))}>
                &lt; Previous Day
              </button>
              <button className="prm-day-btn" type="button" onClick={() => setDateIso(toIso(new Date()))}>
                Today
              </button>
              <button className="prm-day-btn" type="button" onClick={() => setDateIso((p) => shiftIso(p, 1))}>
                Next Day &gt;
              </button>
            </div>
            <div className="prm-control-group">
              <label className="prm-field-label" htmlFor="prm-machine">Machine</label>
              <select
                className="prm-select"
                id="prm-machine"
                value={machineFilter}
                onChange={(e) => setMachineFilter(e.target.value as MachineFilter)}
              >
                <option value="all">All Machines</option>
                {MACHINE_NUMBERS.map((m) => (
                  <option key={m} value={m}>Machine {m}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="prm-actions">
          <button
            className="prm-action-btn prm-action-btn--save"
            type="button"
            onClick={handleSave}
            disabled={!canEdit}
          >
            <Save /> Save
          </button>
          <button className="prm-action-btn prm-action-btn--primary" type="button" onClick={handleExport} disabled={exporting}>
            <Download /> {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
          <button className="prm-action-btn prm-action-btn--outline" type="button" onClick={handlePrint}>
            <Printer /> Print PDF
          </button>
        </div>
      </div>

      {/* ── Layout 1 : Numbering Report (static shell) ───────────────────── */}
      <div className="prm-view prm-view--numbering">
        <div className="prm-sheet">
          <div className="prm-sheet-caption">
            <span>Please find below the Daily Report of Bottles kept aside for Pallet Sorting. ( Numbering).</span>
            <span className="prm-sheet-caption-date">Date : DD.MM.YYYY</span>
          </div>

          <table className="prm-grid">
            <colgroup>
              <col style={{ width: '5%' }} /><col style={{ width: '14%' }} /><col style={{ width: '5%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '5%' }} /><col style={{ width: '6%' }} /><col style={{ width: '5%' }} />
              <col style={{ width: '5%' }} /><col style={{ width: '5%' }} /><col style={{ width: '5%' }} />
              <col style={{ width: '4%' }} /><col style={{ width: '5%' }} />
            </colgroup>
            <thead>
              <tr><th className="prm-grid-title" colSpan={17}>NUMBERING REPORT</th></tr>
              <tr className="prm-grid-group">
                <th rowSpan={3}>M/c.</th><th rowSpan={3}>Bottle Name</th><th rowSpan={3}>Pcs</th>
                <th colSpan={6}>Shift wise ( Packets and Qty.)</th>
                <th rowSpan={3}>Total Qty.</th><th rowSpan={3}>Previous Balance Qty.</th>
                <th rowSpan={3}>Today OK Pack</th><th rowSpan={3}>Today OK Qty.</th>
                <th rowSpan={3}>Today Rej. Pack</th><th rowSpan={3}>Today Rej. Qty.</th>
                <th rowSpan={3}>%</th><th rowSpan={3}>Cumm. Balance Qty.</th>
              </tr>
              <tr className="prm-grid-group">
                <th colSpan={2}>I</th><th colSpan={2}>II</th><th colSpan={2}>III</th>
              </tr>
              <tr className="prm-grid-group">
                <th>Pack</th><th>Qty.</th><th>Pack</th><th>Qty.</th><th>Pack</th><th>Qty.</th>
              </tr>
            </thead>
            <tbody>
              {MACHINE_NUMBERS.map((machine) => (
                <React.Fragment key={`numbering-mc-${machine}`}>
                  {NUMBERING_BOTTLE_ROWS.map((row) => (
                    <tr key={`numbering-mc-${machine}-bottle-${row}`}>
                      {row === 0 ? <td className="prm-mc-cell" rowSpan={8}>M/c. {machine}</td> : null}
                      <td className="prm-name-cell">&nbsp;</td>
                      <NumberingTailCells />
                    </tr>
                  ))}
                  {NUMBERING_SHIFT_ROWS.map((shift) => (
                    <tr className="prm-shift-row" key={`numbering-mc-${machine}-${shift}`}>
                      <td className="prm-name-cell prm-shift-name">{shift}</td>
                      <NumberingTailCells />
                    </tr>
                  ))}
                </React.Fragment>
              ))}
              <tr className="prm-total-row">
                <td>&nbsp;</td><td className="prm-name-cell">Total</td><NumberingTailCells />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Layout 2 : SQC + QC HOLD matrices and their resorting logs ────── */}
      <div className="prm-view prm-view--sqc">
        <div className="prm-sheet">
          <div className="prm-sheet-caption">
            <span>{statusCaption}</span>
          </div>

          {loading ? (
            <p className="prm-status">Loading saved SQC / QC HOLD entries…</p>
          ) : loadError ? (
            <p className="prm-status prm-status--error">{loadError}</p>
          ) : sqcRowCount === 0 && qcRowCount === 0 && sqcLogRows.length === 0 && qcLogRows.length === 0 ? (
            <p className="prm-status">No SQC / QC HOLD entries for the selected status.</p>
          ) : null}

          <div className="prm-report-split flex flex-col lg:flex-row gap-4 items-start">
            {/* ── 25% sidebar: two independent, carry-forward resorting logs ─ */}
            <div className="prm-report-right w-full lg:w-1/4 lg:max-w-[25%] min-w-0">
              <div className="prm-log-caption">
                {statusCaption} · balances carry forward across all dates
              </div>
              <div className="prm-log-stack">
                {renderResortingLog('sqc', 'SQC - RESORTING LOG')}
                {renderResortingLog('qc', 'QC HOLD - RESORTING LOG')}
              </div>
            </div>

            {/* ── 75% detail pane: the selected log row's matrix only ──────── */}
            <div className="prm-report-left w-full lg:w-3/4 lg:max-w-[75%] min-w-0">
              {!selectedLog && (
                <div className="prm-detail-empty" role="status">
                  Select a bottle from the Resorting Log on the left to view and update its details
                </div>
              )}
              {selectedLog?.kind === 'sqc' && (
                <>
                  {/* TOP TABLE — SQC: only the selected bottle's batch. */}
                  <table className="prm-grid prm-grid--sqc table-fixed w-full text-xs">
                <colgroup>
                  {DETAIL_TABLE_COL_WIDTHS.map((width, i) => (
                    <col key={`sqc-detail-col-${i}`} style={{ width }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th className="prm-grid-title bg-[#D6E4FF]" colSpan={15}>REPORT OF NON CONFORMING MATERIALS (SQC)</th>
                  </tr>
                  <tr>
                    <th className="prm-grid-subtitle bg-[#D6E4FF]" colSpan={15}>
                      Material kept aside for Resorting. ( SQC). {statusCaption}
                    </th>
                  </tr>
                  <tr className="prm-grid-group">
                    <th className={MC_CELL_CLASS}>M/c.</th><th>Date</th><th>Bottle Name</th><th>Shift</th><th>Lot</th>
                    <th>Pcs / Pack</th><th>Pack Type</th><th>Packs</th><th>Qty</th><th>Reason</th><th>Cav.</th>
                    <th>OK Qty</th><th>Rejected</th><th>Balance</th><th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {sqcDetailRows.length === 0 ? (
                    <tr><td colSpan={15}>No SQC database records found for this date and bottle.</td></tr>
                  ) : allMachines.map((machineNo) => {
                    // Rows are merged by the exact visible identity, so two
                    // entries with matching Shift/Lot/Pack/Reason/Cav are one.
                    const rows = sqcDetailRows.filter((row) => row.machineNo === machineNo);
                    if (rows.length === 0) return null;
                    return (
                      <React.Fragment key={`sqc-mc-${machineNo}`}>
                        {rows.map((row, idx) => {
                          const active = row.packs > 0;
                          const progress = active
                            ? reportProgressFor(row.sourceKey, row.packs)
                            : { okQty: 0, rejected: 0, balance: 0 };
                          return (
                            <tr key={row.key}>
                              {idx === 0 ? (
                                <td className={MC_CELL_CLASS} rowSpan={rows.length}>M/c. {machineNo}</td>
                              ) : null}
                              <td>{formatEntryDate(row.productionDate)}</td>
                              <td className="prm-name-cell">{row.bottleName}</td>
                              <td>{row.shift ? ROMAN_SHIFT[row.shift] || String(row.shift) : ''}</td>
                              <td>{blankOr(row.lotNo)}</td>
                              <td>{row.pcsPerPack > 0 ? row.pcsPerPack : ''}</td>
                              <td>{row.packType || '—'}</td>
                              <td>{row.packs > 0 ? row.packs : ''}</td>
                              <td>{row.qty > 0 ? row.qty : ''}</td>
                              <td className="prm-reason-cell">
                                <DefectTags value={row.reason} categoryByName={defectCategoryByName} />
                              </td>
                              <td>{row.cav}</td>
                              <td className="prm-progress-cell">
                                {active ? (
                                  <input
                                    type="number" min={0} max={row.packs} step={1}
                                    className="prm-grid-progress-input" readOnly={!canEdit}
                                    value={progress.okQty}
                                    aria-label={`SQC OK Packs for ${row.bottleName} on ${row.productionDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'sqc', row.sourceKey, row.productionDate, row.bottleName,
                                      row.lotNo, row.packs, 'okQty', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td className="prm-progress-cell">
                                {active ? (
                                  <input
                                    type="number" min={0} max={row.packs} step={1}
                                    className="prm-grid-progress-input" readOnly={!canEdit}
                                    value={progress.rejected}
                                    aria-label={`SQC Rejected Packs for ${row.bottleName} on ${row.productionDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'sqc', row.sourceKey, row.productionDate, row.bottleName,
                                      row.lotNo, row.packs, 'rejected', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td>{active ? progress.balance : ''}</td>
                              <td className="prm-remarks-cell prm-name-cell">{row.notes}</td>
                            </tr>
                          );
                        })}
                        <tr className="prm-mc-spacer" key={`sqc-mc-${machineNo}-spacer`}>
                          <td colSpan={15}>&nbsp;</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  <tr className="prm-total-row">
                    <td className="prm-name-cell" colSpan={3}>Total</td>
                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                    <td>{detailTotals.sqcQty > 0 ? detailTotals.sqcQty : ''}</td>
                    <td colSpan={2}>&nbsp;</td>
                    <td>{detailTotals.sqcOk > 0 ? detailTotals.sqcOk : ''}</td>
                    <td>{detailTotals.sqcRejected > 0 ? detailTotals.sqcRejected : ''}</td>
                    <td>{detailTotals.sqcBalance > 0 ? detailTotals.sqcBalance : ''}</td>
                    <td />
                  </tr>
                </tbody>
              </table>

                </>
              )}
              {selectedLog?.kind === 'qc' && (
                <>
                  {/* BOTTOM TABLE — QC HOLD: only the selected bottle's batch. */}
                  <table className="prm-grid prm-grid--sqc table-fixed w-full text-xs">
                <colgroup>
                  {DETAIL_TABLE_COL_WIDTHS.map((width, i) => (
                    <col key={`qc-detail-col-${i}`} style={{ width }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th className="prm-grid-title bg-[#D6E4FF] text-black font-bold border-black" colSpan={15}>
                      REPORT OF QC HOLD MATERIALS (QC HOLD)
                    </th>
                  </tr>
                  <tr>
                    <th className="prm-grid-subtitle bg-[#D6E4FF] text-black font-bold border-black" colSpan={15}>
                      Material kept aside for QC Hold. (QC HOLD). {statusCaption}
                    </th>
                  </tr>
                  <tr className="prm-grid-group">
                    {[
                      'M/c.', 'Date', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack',
                      'Pack Type', 'Packs', 'Qty', 'Reason', 'Cav.',
                      'OK Qty', 'Rejected', 'Balance', 'Remarks',
                    ].map((label) => (
                      <th
                        key={label}
                        className={`bg-[#D6E4FF] text-black font-bold border-black${label === 'M/c.' ? ` ${MC_CELL_CLASS}` : ''}`}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {qcDetailRows.length === 0 ? (
                    <tr><td colSpan={15}>No QC HOLD database records found for this date and bottle.</td></tr>
                  ) : allMachines.map((machineNo) => {
                    // Merged QC HOLD rows for the clicked date + bottle.
                    // Defect names fill Reason and mould/section fill Cav.
                    const rows = qcDetailRows.filter((row) => row.machineNo === machineNo);
                    if (rows.length === 0) return null;
                    return (
                      <React.Fragment key={`qc-mc-${machineNo}`}>
                        {rows.map((row, idx) => {
                          const active = row.packs > 0;
                          const progress = active
                            ? reportProgressFor(row.sourceKey, row.packs)
                            : { okQty: 0, rejected: 0, balance: 0 };
                          return (
                            <tr key={row.key}>
                              {idx === 0 ? (
                                <td className={MC_CELL_CLASS} rowSpan={rows.length}>M/c. {machineNo}</td>
                              ) : null}
                              <td>{formatEntryDate(row.productionDate)}</td>
                              <td className="prm-name-cell">{row.bottleName}</td>
                              <td>{row.shift ? ROMAN_SHIFT[row.shift] || String(row.shift) : ''}</td>
                              <td>{blankOr(row.lotNo)}</td>
                              <td>{row.pcsPerPack > 0 ? row.pcsPerPack : ''}</td>
                              <td>{row.packType || '—'}</td>
                              <td>{row.packs > 0 ? row.packs : ''}</td>
                              <td>{row.qty > 0 ? row.qty : ''}</td>
                              <td className="prm-reason-cell">
                                <DefectTags value={row.reason} categoryByName={defectCategoryByName} />
                              </td>
                              <td>{row.cav}</td>
                              <td className="prm-progress-cell">
                                {active ? (
                                  <input
                                    type="number" min={0} max={row.packs} step={1}
                                    className="prm-grid-progress-input" readOnly={!canEdit}
                                    value={progress.okQty}
                                    aria-label={`QC HOLD OK Packs for ${row.bottleName} on ${row.productionDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'qc', row.sourceKey, row.productionDate, row.bottleName,
                                      row.lotNo, row.packs, 'okQty', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td className="prm-progress-cell">
                                {active ? (
                                  <input
                                    type="number" min={0} max={row.packs} step={1}
                                    className="prm-grid-progress-input" readOnly={!canEdit}
                                    value={progress.rejected}
                                    aria-label={`QC HOLD Rejected Packs for ${row.bottleName} on ${row.productionDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'qc', row.sourceKey, row.productionDate, row.bottleName,
                                      row.lotNo, row.packs, 'rejected', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td>{active ? progress.balance : ''}</td>
                              <td className="prm-remarks-cell prm-name-cell">{row.notes}</td>
                            </tr>
                          );
                        })}
                        <tr className="prm-mc-spacer" key={`qc-mc-${machineNo}-spacer`}>
                          <td colSpan={15}>&nbsp;</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  <tr className="prm-total-row">
                    <td className="prm-name-cell" colSpan={3}>Total</td>
                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                    <td>{detailTotals.qcQty > 0 ? detailTotals.qcQty : ''}</td>
                    <td colSpan={2}>&nbsp;</td>
                    <td>{detailTotals.qcOk > 0 ? detailTotals.qcOk : ''}</td>
                    <td>{detailTotals.qcRejected > 0 ? detailTotals.qcRejected : ''}</td>
                    <td>{detailTotals.qcBalance > 0 ? detailTotals.qcBalance : ''}</td>
                    <td />
                  </tr>
                  <tr className="prm-note-row border border-t-0 border-black">
                    <td colSpan={15} className="border border-t-0 border-black px-3 py-2 font-bold text-black">
                      Note : Amber colour of the bottle is within specification.
                    </td>
                  </tr>
                </tbody>
              </table>
                </>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
};
