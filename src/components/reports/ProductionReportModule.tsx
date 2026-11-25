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
import {
  groupDefectsByType,
  styleForDefectCategory,
  type DefectGroup,
} from '../../utils/defectCategories';

/**
 * Production Report Module — classic, print-friendly report sheets.
 *
 *   • Numbering Report   — static 17-column pallet-sorting register shell
 *   • SQC / QC HOLD (QA-F-10) — LIVE report built from the same saved entries
 *     the Quality Module's SQC/QC HOLD tab uses, via repackingRepository.
 *
 * No file outside this module is modified; the Quality Module keeps its own
 * behaviour and storage untouched.
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
 * Both QA-F-10 matrices share one 14-column grid definition. M/c. is a fixed
 * 54px and Date is a fixed 78px; every other width is a fraction of the
 * remaining space so every vertical border lines up. The two detail columns (Reason/Cav. # against
 * Mould/Defects) and the three progress columns (OK Qty / Rejected / Balance)
 * occupy the same slots in both sheets, with Remarks last.
 */
const MC_COL_WIDTH = 54;
/** Date is always visible now because rows span multiple report dates. */
const DATE_COL_WIDTH = 78;
const colWidth = (fraction: number): string =>
  `calc((100% - ${MC_COL_WIDTH + DATE_COL_WIDTH}px) * ${fraction})`;
const SHARED_COL_WIDTHS = [
  colWidth(0.14), // Bottle Name
  colWidth(0.05), // Shift
  colWidth(0.05), // Lot
  colWidth(0.07), // Pcs / Pack
  colWidth(0.05), // Packs
  colWidth(0.05), // Qty
];
const DETAIL_COL_WIDTHS = [colWidth(0.11), colWidth(0.09)]; // Reason/Cav. # or Mould/Defects
const PROGRESS_COL_WIDTHS = [colWidth(0.08), colWidth(0.08), colWidth(0.08)];
const REMARKS_COL_WIDTH = colWidth(0.15);
/** Tailwind classes on the M/c. <th>/<td> in both sheets. */
const MC_CELL_CLASS =
  'prm-mc-cell prm-mc-cell--sqc w-[54px] min-w-[54px] max-w-[54px] px-1 text-center whitespace-nowrap';

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
  /** The report date the source entry was saved on (the batch's origin date). */
  productionDate: string;
  machineNo: MachineNo;
  /** Actual production Job ID; keeps mid-shift job changes separate. */
  jobId: string;
  jobName: string;
  shift: number;
  lotNo: string;
  pcsPerPack: number;
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
  /** The report date the source entry was saved on (the batch's origin date). */
  productionDate: string;
  machineNo: MachineNo;
  /** Actual production Job ID; keeps mid-shift job changes separate. */
  jobId: string;
  jobName: string;
  shift: number;
  /** String so a genuine lot `0` is preserved. */
  lotNo: string;
  pcsPerPack: number;
  packs: number;
  /** Per-entry (Cartons × Pack Size) + Loose Bottles, summed for the lot. */
  qty: number;
  mould: string;
  defects: string;
  checker: string;
  remarks: string;
}

/**
 * One bottle line shared by BOTH QA-F-10 matrices. The SQC sheet always draws
 * its rows from `sqcGroup`; the QC sheet draws the identical rows and fills the
 * cells only where a matching QC HOLD line exists.
 */
interface ReportBottleRow {
  key: string;
  jobName: string;
  sqcGroup: SqcGroupRow;
  qcGroup: QcHoldGroupRow | undefined;
}

/**
 * Page the combined machine rows as one list, not 20 rows per machine. The
 * machine maps are rebuilt from the slice so rowSpans and spacers stay correct.
 */
const pageRowsByMachine = (
  byMachine: Map<MachineNo, ReportBottleRow[]>,
  page: number
): Map<MachineNo, ReportBottleRow[]> => {
  const allRows = MACHINE_NUMBERS.flatMap((m) => byMachine.get(m) ?? []);
  const slice = pageSlice(allRows, page);
  const out = new Map<MachineNo, ReportBottleRow[]>();
  for (const m of MACHINE_NUMBERS) {
    out.set(m, slice.filter((row) => row.sqcGroup.machineNo === m));
  }
  return out;
};

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
  /** kind + date + machine + job + shift + lot: revisiting a date must not re-seed. */
  sourceKey: string;
  /** Report date on which this hold first appeared. */
  originDate: string;
  bottleName: string;
  lotNo: string;
  /** Initial hold, taken from the report's Qty column on the origin date. */
  initialHold: number;
  /** One entry per batch; its progress is edited on the QA-F-10 report row. */
  entries: ResortingEntry[];
}

/** One unresolved batch in the left-side pending queue. */
interface ResortingLogRow extends ResortingEntry {
  kind: 'sqc' | 'qc';
  /** Origin report date, used to jump back to the source QA-F-10 sheet. */
  bottleName: string;
  balance: number;
}

let logSeq = 0;
const logId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(logSeq += 1).toString(36)}`;
/** Stable identities shared by log seeding and the inline QA-F-10 inputs. */
const sqcBatchSourceKey = (
  originDate: string,
  machineNo: MachineNo,
  jobName: string,
  shift: number,
  lotNo: string,
  jobId = ''
): string =>
  `sqc|${originDate}|${machineNo}|${jobName}|${shift}|${lotNo}${jobId ? `|${jobId}` : ''}`;
const qcBatchSourceKey = (
  originDate: string,
  machineNo: MachineNo,
  jobName: string,
  shift: number,
  lotNo: string,
  mould: string,
  defects: string,
  jobId = ''
): string =>
  `qc|${originDate}|${machineNo}|${jobName}|${shift}|${lotNo}|${mould}|${defects}${jobId ? `|${jobId}` : ''}`;

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
    return parsed
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
        const hold = Math.max(0, asNum(b.initialHold));
        const entries = b.entries
          .filter((e: any) => e && typeof e.id === 'string')
          .map((e: any) => ({
            id: e.id as string,
            date: typeof e.date === 'string' ? e.date : '',
            okQty: Math.max(0, asNum(e.okQty)),
            rejected: Math.max(0, asNum(e.rejected)),
          }));
        // Older logs could hold several follow-up entries. QA-F-10 rows now
        // own all sorting progress, so collapse them into one dated entry and
        // cap the totals at the batch's hold.
        const okQty = Math.min(hold, entries.reduce((sum: number, e: any) => sum + e.okQty, 0));
        const rejected = Math.min(
          Math.max(0, hold - okQty),
          entries.reduce((sum: number, e: any) => sum + e.rejected, 0)
        );
        return {
          ...b,
          // Batches saved before the split were SQC log entries; prefix their old
          // source keys so revisiting a date does not seed a duplicate batch.
          kind: b.kind === 'qc' ? 'qc' : 'sqc',
          sourceKey:
            b.kind === 'sqc' || b.kind === 'qc'
              ? b.sourceKey
              : `sqc|${b.sourceKey}`,
          lotNo: typeof b.lotNo === 'string' ? b.lotNo : '',
          initialHold: hold,
          entries: [{
            id: entries[0]?.id ?? logId('entry'),
            date: b.originDate || entries[0]?.date || '',
            okQty,
            rejected,
          }],
        };
      });
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
.prm-action-btn--save { background: #16a34a; color: #ffffff; border: 1px solid #16a34a; box-shadow: 0 1px 2px rgba(22, 163, 74, 0.25); }
.prm-action-btn--save:hover:not(:disabled) { background: #15803d; }
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
.prm-grid--sqc th { background: #dce6f1; }
.prm-grid--sqc .prm-grid-title, .prm-grid--sqc .prm-grid-subtitle { background: #dce6f1 !important; }
.prm-grid-subtitle { font-size: 11.5px; font-weight: 600; text-align: left !important; padding-left: 8px !important; }
.prm-grid-code { font-weight: 700; }
.prm-mc-cell--sqc { background: #dce6f1; }
.prm-muted-cell { color: #000000; }

/* SQC / QC HOLD sheet — text-xs (12px), bold, pure black for every header and
   data cell. Tight px-1.5 / py-1.5 padding keeps all 14 columns inside the 60%
   left pane without horizontal overflow. */
.prm-grid--sqc { font-size: 12px; line-height: 1.2; color: #000000; }
.prm-grid--sqc th, .prm-grid--sqc td {
  font-size: 12px;
  font-weight: 700;
  color: #000000;
  padding: 6px 6px;
}
/* Narrow M/c. column — CSS fallback for the w-[54px] / px-1 Tailwind classes. */
.prm-grid--sqc .prm-mc-cell {
  width: 54px;
  min-width: 54px;
  max-width: 54px;
  padding-left: 4px !important;
  padding-right: 4px !important;
  text-align: center !important;
  white-space: nowrap;
}
/* Editable OK Qty / Rejected cells on active report rows. */
.prm-grid--sqc .prm-progress-cell { padding: 2px !important; }
.prm-grid-progress-input {
  width: 100%; min-width: 0; padding: 2px 1px; border: 1px solid #94a3b8;
  border-radius: 3px; background: #ffffff; color: #000000;
  font: inherit; font-weight: 700; text-align: center;
}
/* One clean spacer row per machine block (h-3 ≈ 12px): no top/bottom or inner
   cell borders, only the table's left/right edges. */
.prm-grid--sqc .prm-mc-spacer td {
  height: 12px;
  padding: 0 !important;
  border-top: 0 !important;
  border-bottom: 0 !important;
  border-left: 1px solid #000000;
  border-right: 1px solid #000000;
  background: #ffffff !important;
}

/* QC HOLD sheet reuses .prm-grid--sqc so both sheets share the exact same
   steel-blue headers, black borders, bold type, spacing and spacer rows. */
.prm-report-left > .prm-grid + .prm-grid { margin-top: 14px; }
/* Note is a bordered row physically attached to the bottom of each sheet. */
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

/* ── 60 / 40 split: vertical report left, carry-forward log right ────────── */
.prm-report-split { display: flex; flex-direction: column; gap: 16px; align-items: flex-start; }
.prm-report-left, .prm-report-right { width: 100%; min-width: 0; }
@media (min-width: 1024px) {
  .prm-report-split { flex-direction: row; }
  .prm-report-left { width: 60%; }
  .prm-report-right { width: 40%; }
}

/* ── SQC / QC HOLD Resorting Log ─────────────────────────────────────────── */
.prm-log { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; color: #000000; }
.prm-log th, .prm-log td {
  border: 1px solid #000000; padding: 6px 5px; text-align: center;
  vertical-align: middle; font-weight: 700; color: #000000;
  overflow: hidden; word-break: break-word;
}
.prm-log th { background: #dce6f1; }
.prm-log-title { padding: 8px 5px !important; font-size: 12px; letter-spacing: 0.3px; }
.prm-log-name { text-align: left !important; padding-left: 7px !important; }
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

/* ── Signatures / distribution ───────────────────────────────────────────── */
.prm-signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 30px; }
.prm-signature { width: 180px; border-top: 1px solid #000000; padding-top: 6px; text-align: center; font-size: 11.5px; font-weight: 700; color: #000000; }
.prm-cc { margin-top: 22px; font-size: 10.5px; color: #000000; }

/* ── Print: only the QA-F-10 sheet, regardless of the selected tab ───────── */
@media print {
  @page { size: A4 landscape; margin: 8mm; }
  .prm-root { padding: 0 !important; max-width: none !important; margin: 0 !important; }
  .prm-toolbar, .prm-radio, .prm-status, .prm-defect-legend, .prm-pager { display: none !important; }
  .prm-view--numbering { display: none !important; }
  .prm-view--sqc { display: block !important; }
  .prm-sheet { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; padding: 0 !important; }
  .prm-sheet-caption { font-size: 10px !important; }
  /* Both panes go full width on paper so the 13-column sheet stays readable. */
  .prm-report-split { display: block !important; }
  .prm-report-left, .prm-report-right { width: 100% !important; }
  .prm-grid, .prm-subtable, .prm-log { font-size: 12px !important; color: #000000 !important; }
  .prm-grid th, .prm-grid td, .prm-subtable th, .prm-subtable td,
  .prm-log th, .prm-log td {
    color: #000000 !important;
    font-weight: 700 !important;
    font-size: 12px !important;
    border-color: #000000 !important;
    padding-top: 2px !important;
    padding-bottom: 2px !important;
  }
  .prm-grid th.prm-grid-title { font-size: 14px !important; }
  .prm-signatures { margin-top: 16px !important; }
  .prm-cc { margin-top: 12px !important; }
  .prm-grid tr, .prm-subtable tr, .prm-log tr { break-inside: avoid; page-break-inside: avoid; }
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

/** Group saved SQC entries (Lot No. > 0 only) by machine + job + shift + lot + pack. */
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
    const jobName = bottleNameFor(entry, lookup);
    const productionDate = asText(entry.production_date);
    const shift = asNum(entry.shift) || 1;
    const lotNo = asText(entry.lot_no);
    const pcsPerPack = asNum(entry.pcs_per_pack);
    // Date is part of the key: the 30-day lookback must keep each day's hold
    // separate instead of collapsing repeats of the same bottle into one.
    const jobId = asText(entry.job_id);
    const key = `${productionDate}|${machineNo}|${jobId.toLowerCase()}|${jobName.toLowerCase()}|${shift}|${lotNo.toLowerCase()}|${pcsPerPack}`;

    const rows = byMachine.get(machineNo)!;
    let group = rows.find((r) => r.key === key);
    if (!group) {
      group = {
        key,
        productionDate,
        machineNo,
        jobId,
        jobName,
        shift,
        lotNo,
        pcsPerPack,
        packs: 0,
        looseBottles: 0,
        qty: 0,
        reason: '',
        cav: '',
        sec: '',
        remarks: '',
        isZero: false,
      };
      rows.push(group);
    }
    group.packs += asNum(entry.cartons);
    group.looseBottles += asNum(entry.defective_bottles);
    group.qty += entryQty(entry);
    group.reason = dedupe(
      group.reason ? [...group.reason.split(', '), ...defectNamesOf(entry)] : defectNamesOf(entry)
    );
    group.cav = dedupe(group.cav ? [...group.cav.split(', '), asText(entry.mould)] : [asText(entry.mould)]);
    group.sec = dedupe(
      group.sec ? [...group.sec.split(', '), asText(entry.section_no)] : [asText(entry.section_no)]
    );
    const remark = asText(entry.remarks) || asText(entry.qa_shift_ex_name);
    if (remark) group.remarks = group.remarks ? `${group.remarks} ${remark}` : remark;
  }

  for (const rows of byMachine.values()) {
    for (const row of rows) {
      // A saved entry with no cartons and no bottles is still a real row in the
      // Quality Module's SQC/QC HOLD list. Keep it, but display it as an
      // all-zero job row (no shift / lot / pack size / defect details).
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
 * Group QC HOLD entries (Lot No. 0 with tracking details only). SQC rows with
 * a positive lot can never enter this dataset, so no entry is double-routed.
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
    const jobName = bottleNameFor(entry, lookup);
    const productionDate = asText(entry.production_date);
    const shift = asNum(entry.shift) || 1;
    const lotNo = '0'; // Kept as text so the genuine zero is visible in the report.
    const pcsPerPack = asNum(entry.pcs_per_pack);
    const mould = asText(entry.mould);
    const defects = dedupe(defectNamesOf(entry));
    const checker = asText(entry.checker_name) || asText(entry.qa_shift_ex_name);
    const remarks = asText(entry.remarks);
    const jobId = asText(entry.job_id);
    const key = `${productionDate}|${machineNo}|${jobId.toLowerCase()}|${jobName.toLowerCase()}|${shift}|${pcsPerPack}|${mould}|${defects.toLowerCase()}|${checker.toLowerCase()}|${remarks.toLowerCase()}`;
    let group = rows.find((row) => row.key === key);
    if (!group) {
      group = {
        key,
        productionDate,
        machineNo,
        jobId,
        jobName,
        shift,
        lotNo,
        pcsPerPack,
        packs: 0,
        qty: 0,
        mould,
        defects,
        checker,
        remarks,
      };
      rows.push(group);
    }
    group.packs += asNum(entry.cartons);
    group.qty += entryQty(entry);
  }
  return rows.filter((row) => row.qty > 0 || row.packs > 0 || !!row.defects);
};

// ─── Component ──────────────────────────────────────────────────────────────

export const ProductionReportModule: React.FC = () => {
  const { bottles } = useERP();
  const [dateIso, setDateIso] = useState<string>(() => toIso(new Date()));
  const [machineFilter, setMachineFilter] = useState<MachineFilter>('all');
  /** Numbering tab still uses the CSS-only radio pair; this mirrors it for the
   *  toolbar so date/machine controls can be hidden on the SQC tab only. */
  const [reportMode, setReportMode] = useState<'numbering' | 'sqc'>('sqc');
  /** Sole visibility control for every SQC / QC HOLD table. */
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [pages, setPages] = useState<PageState>(INITIAL_PAGE_STATE);
  const [printAll, setPrintAll] = useState(false);
  /** All saved SQC / QC HOLD entries across every production date. */
  const [entries, setEntries] = useState<RepackingSqcQcHoldEntry[]>([]);
  const [bottleNames, setBottleNames] = useState<BottleNameItem[]>([]);
  const [allDataLoaded, setAllDataLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exporting, setExporting] = useState(false);
  // Resorting log is local UI state, restored from localStorage on mount.
  const [resortingBatches, setResortingBatches] = useState<ResortingBatch[]>(loadStoredBatches);
  /** Active defect master, grouped by database category for report breakdowns. */
  const [defectGroups, setDefectGroups] = useState<DefectGroup[]>([]);

  useEffect(() => {
    let active = true;
    qualityRepository.getDefects(true)
      .then((defects) => {
        if (active) setDefectGroups(groupDefectsByType(defects));
      })
      .catch(() => {
        // A master-list failure must not hide already-saved defect names.
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

  // Date-independent saved entries only. Previously this added zero-quantity
  // rows from the selected date's hourly production log; those are date-bound
  // and would make the visible rows change with the report date.
  const groupedByMachine = useMemo(
    () => aggregateSqc(entries, bottleLookup),
    [entries, bottleLookup]
  );

  const qcHoldRows = useMemo(
    () => aggregateQcHolds(entries, bottleLookup),
    [entries, bottleLookup]
  );

  // Category lookup and counts come from the DB master, not from a fixed list:
  // categories with no logged defects still appear with a zero count.
  const defectCategoryByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of defectGroups) {
      for (const name of group.items) map.set(name.toLowerCase(), group.group);
    }
    return map;
  }, [defectGroups]);

  const defectBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of defectGroups) counts.set(group.group, 0);
    for (const entry of entries) {
      for (const name of defectNamesOf(entry)) {
        const category = defectCategoryByName.get(name.toLowerCase());
        if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([group, count]) => ({ group, count }));
  }, [entries, defectGroups, defectCategoryByName]);

  // ── Every-date data for the two resorting logs ────────────────────────────
  // Same classification rules as the right-side sheets: Lot # > 0 → SQC,
  // Lot # "0" with tracking details → QC HOLD. Grouping includes the source
  // date and Job ID, so repeated holds on different days/jobs stay separate.
  const logSqcRowsByMachine = groupedByMachine;
  const logQcHoldRows = qcHoldRows;

  /**
   * Row-for-row definition shared by the two right-hand matrices. Every machine
   * gets exactly the SQC table's bottle rows; the QC sheet reuses them and only
   * fills cells where a matching QC HOLD line exists. A QC-only bottle is added
   * to BOTH sheets as an empty line so the grids can never drift apart.
   */
  const reportRowsByMachine = useMemo(() => {
    const byMachine = new Map<MachineNo, ReportBottleRow[]>();
    for (const machineNo of MACHINE_NUMBERS) {
      const sqcGroups = groupedByMachine.get(machineNo) ?? [];
      const holds = qcHoldRows.filter((row) => row.machineNo === machineNo);
      const rows: ReportBottleRow[] = sqcGroups.map((sqcGroup) => {
        const name = sqcGroup.jobName.toLowerCase();
        const qcGroup =
          holds.find((row) =>
            row.productionDate === sqcGroup.productionDate &&
            row.jobId === sqcGroup.jobId &&
            row.jobName.toLowerCase() === name &&
            row.shift === sqcGroup.shift
          ) ??
          holds.find((row) =>
            row.productionDate === sqcGroup.productionDate &&
            row.jobId === sqcGroup.jobId &&
            row.jobName.toLowerCase() === name
          );
        return { key: sqcGroup.key, jobName: sqcGroup.jobName, sqcGroup, qcGroup };
      });
      for (const hold of holds) {
        const name = hold.jobName.toLowerCase();
        if (rows.some((row) =>
          row.sqcGroup.productionDate === hold.productionDate &&
          row.sqcGroup.jobId === hold.jobId &&
          row.jobName.toLowerCase() === name
        )) continue;
        const key = `qc-only|${machineNo}|${hold.productionDate}|${hold.jobId}|${name}`;
        rows.push({
          key,
          jobName: hold.jobName,
          sqcGroup: {
            key,
            productionDate: hold.productionDate,
            machineNo,
            jobId: hold.jobId,
            jobName: hold.jobName,
            shift: hold.shift,
            lotNo: '',
            pcsPerPack: 0,
            packs: 0,
            looseBottles: 0,
            qty: 0,
            reason: '',
            cav: '',
            sec: '',
            remarks: '',
            isZero: true,
          },
          qcGroup: hold,
        });
      }
      byMachine.set(machineNo, rows);
    }
    return byMachine;
  }, [groupedByMachine, qcHoldRows]);

  // Seed one batch per hold across all dates. sourceKey carries the origin
  // date and Job ID, so repeated jobs on different dates never overwrite each
  // other and saved OK/Rejected progress is reused via `known`.
  useEffect(() => {
    if (loading || loadError || !allDataLoaded) return;
    setResortingBatches((prev) => {
      const known = new Set(prev.map((batch) => batch.sourceKey));
      const additions: ResortingBatch[] = [];
      for (const [machineNo, groups] of logSqcRowsByMachine) {
        for (const group of groups) {
          if (group.isZero || group.qty <= 0) continue;
          const originDate = group.productionDate || '';
          const sourceKey = sqcBatchSourceKey(
            originDate, machineNo, group.jobName, group.shift, group.lotNo, group.jobId
          );
          if (known.has(sourceKey)) continue;
          known.add(sourceKey);
          additions.push({
            id: logId('batch'),
            kind: 'sqc',
            sourceKey,
            originDate,
            bottleName: group.jobName,
            lotNo: group.lotNo,
            initialHold: group.qty,
            entries: [{ id: logId('entry'), date: originDate, okQty: 0, rejected: 0 }],
          });
        }
      }
      for (const group of logQcHoldRows) {
        // Both logs use the calculated Qty: (Cartons × Pack Size) + Loose Bottles.
        const holdQty = group.qty;
        if (holdQty <= 0) continue;
        const originDate = group.productionDate || '';
        const sourceKey = qcBatchSourceKey(
          originDate, group.machineNo, group.jobName, group.shift,
          group.lotNo, group.mould, group.defects, group.jobId
        );
        if (known.has(sourceKey)) continue;
        known.add(sourceKey);
        additions.push({
          id: logId('batch'),
          kind: 'qc',
          sourceKey,
          originDate,
          bottleName: group.jobName,
          lotNo: group.lotNo,
          initialHold: holdQty,
          entries: [{ id: logId('entry'), date: originDate, okQty: 0, rejected: 0 }],
        });
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
  }, [allDataLoaded, logSqcRowsByMachine, logQcHoldRows, loading, loadError]);

  // Every hold across all dates; the Status Filter is applied below. Completed
  // batches stay visible instead of being dropped from the resorting logs.
  const resortingRows = useMemo<ResortingLogRow[]>(() => {
    const rows: ResortingLogRow[] = [];
    for (const batch of resortingBatches) {
      const entry = batch.entries[0];
      if (!entry) continue;
      const okQty = Math.max(0, asNum(entry.okQty));
      const rejected = Math.max(0, asNum(entry.rejected));
      const balance = Math.max(0, batch.initialHold - okQty - rejected);
      const displayDate = isValidIso(batch.originDate)
        ? batch.originDate
        : isValidIso(entry.date) ? entry.date : '';
      rows.push({
        ...entry,
        date: displayDate,
        okQty,
        rejected,
        kind: batch.kind,
        bottleName: batch.bottleName,
        balance,
      });
    }
    return rows.sort((a, b) =>
      a.date.localeCompare(b.date) || a.bottleName.localeCompare(b.bottleName)
    );
  }, [resortingBatches]);

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
  const statusLabel = STATUS_FILTER_LABEL[statusFilter];
  const statusCaption = STATUS_FILTER_CAPTION[statusFilter];

  // Inline QA-F-10 inputs and the resorting logs share the same saved batches.
  const reportBatchBySourceKey = useMemo(
    () => new Map(resortingBatches.map((batch) => [batch.sourceKey, batch])),
    [resortingBatches]
  );
  const reportProgressFor = (sourceKey: string, qty: number) => {
    const entry = reportBatchBySourceKey.get(sourceKey)?.entries[0];
    const okQty = entry?.okQty ?? 0;
    const rejected = entry?.rejected ?? 0;
    return { okQty, rejected, balance: Math.max(0, qty - okQty - rejected) };
  };

  /** Balance of one SQC row, using the same batch key as the inline inputs. */
  const sqcRowBalance = (sqc: SqcGroupRow): number => {
    if (sqc.isZero || sqc.qty <= 0) return 0;
    return reportProgressFor(
      sqcBatchSourceKey(
        sqc.productionDate || '', sqc.machineNo, sqc.jobName,
        sqc.shift, sqc.lotNo, sqc.jobId
      ),
      sqc.qty
    ).balance;
  };
  /** Balance of one QC HOLD row, using the same batch key as the inline inputs. */
  const qcRowBalance = (hold: QcHoldGroupRow): number => {
    if (hold.qty <= 0) return 0;
    return reportProgressFor(
      qcBatchSourceKey(
        hold.productionDate || '', hold.machineNo, hold.jobName, hold.shift,
        hold.lotNo, hold.mould, hold.defects, hold.jobId
      ),
      hold.qty
    ).balance;
  };

  const sqcReportRowsByMachine = useMemo(() => {
    const out = new Map<MachineNo, ReportBottleRow[]>();
    for (const machineNo of MACHINE_NUMBERS) {
      out.set(machineNo, (reportRowsByMachine.get(machineNo) ?? []).filter((row) =>
        matchesStatus(sqcRowBalance(row.sqcGroup), statusFilter)
      ));
    }
    return out;
    // sqcRowBalance reads reportBatchBySourceKey, which is in the deps.
  }, [reportRowsByMachine, reportBatchBySourceKey, statusFilter]);

  const qcReportRowsByMachine = useMemo(() => {
    const out = new Map<MachineNo, ReportBottleRow[]>();
    for (const machineNo of MACHINE_NUMBERS) {
      out.set(machineNo, (reportRowsByMachine.get(machineNo) ?? []).filter((row) =>
        !!row.qcGroup && matchesStatus(qcRowBalance(row.qcGroup), statusFilter)
      ));
    }
    return out;
  }, [reportRowsByMachine, reportBatchBySourceKey, statusFilter]);

  const sqcRowCount = useMemo(
    () => [...sqcReportRowsByMachine.values()].reduce((sum, rows) => sum + rows.length, 0),
    [sqcReportRowsByMachine]
  );
  const qcRowCount = useMemo(
    () => [...qcReportRowsByMachine.values()].reduce((sum, rows) => sum + rows.length, 0),
    [qcReportRowsByMachine]
  );

  const grandTotalQty = useMemo(
    () => allMachines.reduce((sum, m) =>
      sum + (sqcReportRowsByMachine.get(m) ?? []).reduce((s, row) => s + row.sqcGroup.qty, 0), 0),
    [allMachines, sqcReportRowsByMachine]
  );
  const qcTotalQty = useMemo(
    () => allMachines.reduce((sum, m) =>
      sum + (qcReportRowsByMachine.get(m) ?? []).reduce((s, row) => s + (row.qcGroup?.qty ?? 0), 0), 0),
    [allMachines, qcReportRowsByMachine]
  );
  const reportTotals = useMemo(() => {
    const totals = {
      sqcOk: 0, sqcRejected: 0, sqcBalance: 0,
      qcOk: 0, qcRejected: 0, qcBalance: 0,
    };
    for (const machineNo of allMachines) {
      for (const row of sqcReportRowsByMachine.get(machineNo) ?? []) {
        const sqc = row.sqcGroup;
        if (sqc.isZero || sqc.qty <= 0) continue;
        const progress = reportProgressFor(
          sqcBatchSourceKey(
            sqc.productionDate || '', sqc.machineNo, sqc.jobName,
            sqc.shift, sqc.lotNo, sqc.jobId
          ),
          sqc.qty
        );
        totals.sqcOk += progress.okQty;
        totals.sqcRejected += progress.rejected;
        totals.sqcBalance += progress.balance;
      }
      for (const row of qcReportRowsByMachine.get(machineNo) ?? []) {
        const hold = row.qcGroup;
        if (!hold || hold.qty <= 0) continue;
        const progress = reportProgressFor(
          qcBatchSourceKey(
            hold.productionDate || '', hold.machineNo, hold.jobName, hold.shift,
            hold.lotNo, hold.mould, hold.defects, hold.jobId
          ),
          hold.qty
        );
        totals.qcOk += progress.okQty;
        totals.qcRejected += progress.rejected;
        totals.qcBalance += progress.balance;
      }
    }
    return totals;
  }, [allMachines, sqcReportRowsByMachine, qcReportRowsByMachine, reportBatchBySourceKey]);

  // Screen pagination. `printAll` expands every table so Print PDF includes all
  // filtered rows; Excel always uses the un-paged arrays directly.
  const pagedSqcLogRows = printAll ? sqcLogRows : pageSlice(sqcLogRows, pages.sqcLog);
  const pagedQcLogRows = printAll ? qcLogRows : pageSlice(qcLogRows, pages.qcLog);
  const pagedSqcReportRowsByMachine = useMemo(
    () => (printAll ? sqcReportRowsByMachine : pageRowsByMachine(sqcReportRowsByMachine, pages.sqc)),
    [sqcReportRowsByMachine, pages.sqc, printAll]
  );
  const pagedQcReportRowsByMachine = useMemo(
    () => (printAll ? qcReportRowsByMachine : pageRowsByMachine(qcReportRowsByMachine, pages.qc)),
    [qcReportRowsByMachine, pages.qc, printAll]
  );

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
    setPages(INITIAL_PAGE_STATE);
  };

  /** Expand all four tables before printing so Print PDF ignores pagination. */
  const handlePrint = () => {
    if (printAll) {
      window.print();
      return;
    }
    setPrintAll(true);
    requestAnimationFrame(() => {
      window.print();
      setPrintAll(false);
    });
  };

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
    const existing = reportBatchBySourceKey.get(sourceKey);
    const current = existing?.entries[0];
    const nextOk = field === 'okQty' ? Math.max(0, asNum(value)) : current?.okQty ?? 0;
    const nextRejected = field === 'rejected' ? Math.max(0, asNum(value)) : current?.rejected ?? 0;
    const hold = initialHold;
    if (nextOk + nextRejected > hold) {
      toast.error(`OK Qty + Rejected cannot exceed the hold of ${hold}.`, { duration: 1800 });
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
      return [...prev, {
        id: logId('batch'),
        kind,
        sourceKey,
        originDate: start,
        bottleName,
        lotNo,
        initialHold,
        entries: [{
          id: logId('entry'), date: start, okQty: nextOk, rejected: nextRejected,
        }],
      }];
    });
  };

  const handleSave = () => {
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
      // Bold, pure-black typography matches the on-screen matrices.
      const tableFont = { bold: true, size: 11, color: { argb: 'FF000000' } };
      const border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
      const headerFill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' },
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

      // Logs are exported in full — never the current page only.
      const addLogTable = (sheet: any, title: string, rows: ResortingLogRow[]) => {
        sheet.addRow([]);
        const caption = sheet.addRow([title]);
        caption.font = { bold: true, size: 12, name: 'Times New Roman', color: { argb: 'FF000000' } };
        styleHeader(sheet.addRow(['Date', 'Bottle Name', 'Pending Qty']));
        if (rows.length === 0) {
          sheet.addRow(['', 'No balances for the selected status.']);
          return;
        }
        for (const row of rows) {
          styleData(sheet.addRow([row.date, row.bottleName, row.balance]));
        }
      };

      // ── Sheet 1: SQC report + SQC resorting log ──────────────────────────
      const sqcSheet = workbook.addWorksheet('SQC');
      sqcSheet.mergeCells('A1:M1');
      sqcSheet.getCell('A1').value = 'REPORT OF NON CONFORMING MATERIALS (SQC)';
      sqcSheet.getCell('A1').font = { bold: true, size: 14, name: 'Times New Roman' };
      sqcSheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      sqcSheet.getCell('N1').value = 'QA-F-10';
      sqcSheet.getCell('N1').font = { ...tableFont };

      sqcSheet.mergeCells('A2:M2');
      sqcSheet.getCell('A2').value = `Material kept aside for Resorting. ( SQC). ${statusCaption}`;
      sqcSheet.getCell('N2').value = statusLabel;
      sqcSheet.getCell('N2').font = { ...tableFont };

      styleHeader(sqcSheet.addRow([
        'M/c.', 'Date', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack', 'Packs', 'Qty',
        'Reason', 'Cav.', 'OK Qty', 'Rejected', 'Balance', 'Remarks',
      ]));
      for (const machineNo of allMachines) {
        const rows = sqcReportRowsByMachine.get(machineNo) ?? [];
        if (rows.length === 0) continue;
        rows.forEach(({ sqcGroup: row }, idx) => {
          const hasData = !row.isZero && (row.packs > 0 || row.qty > 0);
          const isActive = hasData && row.qty > 0;
          const progress = isActive
            ? reportProgressFor(
                sqcBatchSourceKey(
                  row.productionDate || '', row.machineNo, row.jobName,
                  row.shift, row.lotNo, row.jobId
                ),
                row.qty
              )
            : { okQty: 0, rejected: 0, balance: 0 };
          styleData(sqcSheet.addRow([
            idx === 0 ? `M/c. ${machineNo}` : '',
            formatEntryDate(row.productionDate),
            row.jobName,
            hasData && row.shift ? ROMAN_SHIFT[row.shift] || String(row.shift) : '',
            hasData ? excelText(row.lotNo) : '',
            hasData && row.pcsPerPack > 0 ? row.pcsPerPack : '',
            hasData && row.packs > 0 ? row.packs : '',
            excelNumber(row.qty),
            hasData ? row.reason : '',
            hasData ? row.cav : '',
            isActive ? excelNumber(progress.okQty) : '',
            isActive ? excelNumber(progress.rejected) : '',
            isActive ? excelNumber(progress.balance) : '',
            isActive ? row.remarks : '',
          ]));
        });
        const spacer = sqcSheet.addRow([]);
        spacer.height = 9;
        spacer.getCell(1).border = { left: { style: 'thin' }, right: { style: 'thin' } };
        spacer.getCell(14).border = { left: { style: 'thin' }, right: { style: 'thin' } };
      }
      styleData(sqcSheet.addRow([
        '', '', 'Total', '', '', '', '', excelNumber(grandTotalQty),
        '', '',
        excelNumber(reportTotals.sqcOk),
        excelNumber(reportTotals.sqcRejected),
        excelNumber(reportTotals.sqcBalance),
        '',
      ]));
      addLogTable(sqcSheet, 'SQC - RESORTING LOG', sqcLogRows);
      sqcSheet.columns = [
        { width: 8 }, { width: 12 }, { width: 22 }, { width: 8 }, { width: 11 },
        { width: 11 }, { width: 9 }, { width: 10 }, { width: 24 }, { width: 11 },
        { width: 10 }, { width: 10 }, { width: 10 }, { width: 22 },
      ];

      // ── Sheet 2: QC HOLD report + QC resorting log ───────────────────────
      const qcSheet = workbook.addWorksheet('QC HOLD');
      qcSheet.mergeCells('A1:M1');
      qcSheet.getCell('A1').value = 'REPORT OF QC HOLD MATERIALS (QC HOLD)';
      qcSheet.getCell('A1').font = { bold: true, size: 14, name: 'Times New Roman' };
      qcSheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      qcSheet.getCell('N1').value = 'QA-F-10';
      qcSheet.getCell('N1').font = { ...tableFont };

      qcSheet.mergeCells('A2:M2');
      qcSheet.getCell('A2').value = `Material kept aside for QC Hold. (QC HOLD). ${statusCaption}`;
      qcSheet.getCell('A2').font = { ...tableFont };
      qcSheet.getCell('N2').value = statusLabel;
      qcSheet.getCell('N2').font = { ...tableFont };

      styleHeader(qcSheet.addRow([
        'M/c.', 'Date', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack', 'Packs', 'Qty',
        'Mould', 'Defects', 'OK Qty', 'Rejected', 'Balance', 'Remarks',
      ]));
      for (const machineNo of allMachines) {
        const rows = qcReportRowsByMachine.get(machineNo) ?? [];
        if (rows.length === 0) continue;
        rows.forEach(({ qcGroup: hold }, idx) => {
          if (!hold) return;
          const isActive = hold.qty > 0;
          const progress = isActive
            ? reportProgressFor(
                qcBatchSourceKey(
                  hold.productionDate || '', hold.machineNo, hold.jobName, hold.shift,
                  hold.lotNo, hold.mould, hold.defects, hold.jobId
                ),
                hold.qty
              )
            : { okQty: 0, rejected: 0, balance: 0 };
          styleData(qcSheet.addRow([
            idx === 0 ? `M/c. ${machineNo}` : '',
            formatEntryDate(hold.productionDate),
            hold.jobName,
            hold.shift ? ROMAN_SHIFT[hold.shift] || String(hold.shift) : '',
            excelText(hold.lotNo),
            hold.pcsPerPack > 0 ? hold.pcsPerPack : '',
            hold.packs > 0 ? hold.packs : '',
            excelNumber(hold.qty),
            excelText(hold.mould),
            excelText(hold.defects),
            isActive ? excelNumber(progress.okQty) : '',
            isActive ? excelNumber(progress.rejected) : '',
            isActive ? excelNumber(progress.balance) : '',
            isActive ? excelText(hold.remarks) : '',
          ]));
        });
        const spacer = qcSheet.addRow([]);
        spacer.height = 9;
        spacer.getCell(1).border = { left: { style: 'thin' }, right: { style: 'thin' } };
        spacer.getCell(14).border = { left: { style: 'thin' }, right: { style: 'thin' } };
      }
      styleData(qcSheet.addRow([
        '', '', 'Total', '', '', '', '', excelNumber(qcTotalQty),
        '', '',
        excelNumber(reportTotals.qcOk),
        excelNumber(reportTotals.qcRejected),
        excelNumber(reportTotals.qcBalance),
        '',
      ]));
      // Note is a bordered row attached directly to the bottom of the table.
      const qcNoteRowNumber = qcSheet.rowCount + 1;
      qcSheet.mergeCells(`A${qcNoteRowNumber}:N${qcNoteRowNumber}`);
      const qcNoteCell = qcSheet.getCell(`A${qcNoteRowNumber}`);
      qcNoteCell.value = 'Note : Amber colour of the bottle is within specification.';
      qcNoteCell.font = { ...tableFont };
      qcNoteCell.border = {
        top: { style: 'none' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
      addLogTable(qcSheet, 'QC HOLD - RESORTING LOG', qcLogRows);
      qcSheet.columns = [
        { width: 8 }, { width: 12 }, { width: 22 }, { width: 8 }, { width: 11 },
        { width: 11 }, { width: 9 }, { width: 10 }, { width: 10 }, { width: 22 },
        { width: 10 }, { width: 10 }, { width: 10 }, { width: 22 },
      ];
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SQC_QC_Hold_Report_${statusFilter}.xlsx`;
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
              rows.map((row) => (
                <tr key={row.id}>
                  <td>{displayDate(row)}</td>
                  <td className="prm-log-name">{row.bottleName}</td>
                  <td>{row.balance}</td>
                </tr>
              ))
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
            className="prm-action-btn prm-action-btn--save bg-green-600 hover:bg-green-700 text-white font-bold px-4 py-2 rounded flex items-center gap-2"
            type="button"
            onClick={handleSave}
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

          <div className="prm-signatures">
            <div className="prm-signature">Q.A. Executive</div>
            <div className="prm-signature">HOD QA</div>
          </div>
          <div className="prm-cc">cc : Director / Design &amp; Dev. / Mould Workshop / Costing / Warehouse / Glass.</div>
        </div>
      </div>

      {/* ── Layout 2 : SQC + QC HOLD matrices and their resorting logs ────── */}
      <div className="prm-view prm-view--sqc">
        <div className="prm-sheet">
          <div className="prm-sheet-caption">
            <span>{statusCaption}</span>
            <span className="prm-sheet-caption-date">Status : {statusLabel}</span>
          </div>

          {loading ? (
            <p className="prm-status">Loading saved SQC / QC HOLD entries…</p>
          ) : loadError ? (
            <p className="prm-status prm-status--error">{loadError}</p>
          ) : sqcRowCount === 0 && qcRowCount === 0 && sqcLogRows.length === 0 && qcLogRows.length === 0 ? (
            <p className="prm-status">No SQC / QC HOLD entries for the selected status.</p>
          ) : null}

          <div className="prm-report-split flex flex-col lg:flex-row gap-4 items-start">
            {/* ── Left 40% : two independent, carry-forward resorting logs ── */}
            <div className="prm-report-right w-full lg:w-[40%] min-w-0">
              <div className="prm-log-caption">
                {statusCaption} · balances carry forward across all dates
              </div>
              <div className="prm-log-stack">
                {renderResortingLog('sqc', 'SQC - RESORTING LOG')}
                {renderResortingLog('qc', 'QC HOLD - RESORTING LOG')}
              </div>
            </div>

            {/* ── Right 60% : SQC sheet above QC HOLD sheet ────────────────── */}
            <div className="prm-report-left w-full lg:w-[60%] min-w-0">
              {/* TOP TABLE — SQC: material kept aside for resorting. */}
              <table className="prm-grid prm-grid--sqc table-fixed w-full text-xs">
                <colgroup>
                  <col style={{ width: MC_COL_WIDTH, minWidth: MC_COL_WIDTH, maxWidth: MC_COL_WIDTH }} />
                  <col style={{ width: DATE_COL_WIDTH, minWidth: DATE_COL_WIDTH, maxWidth: DATE_COL_WIDTH }} />
                  {SHARED_COL_WIDTHS.map((width, i) => (
                    <col key={`sqc-shared-${i}`} style={{ width }} />
                  ))}
                  {DETAIL_COL_WIDTHS.map((width, i) => (
                    <col key={`sqc-detail-${i}`} style={{ width }} />
                  ))}
                  {PROGRESS_COL_WIDTHS.map((width, i) => (
                    <col key={`sqc-progress-${i}`} style={{ width }} />
                  ))}
                  <col style={{ width: REMARKS_COL_WIDTH }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="prm-grid-title" colSpan={14}>REPORT OF NON CONFORMING MATERIALS (SQC)</th>
                    <th className="prm-grid-code">QA-F-10</th>
                  </tr>
                  <tr>
                    <th className="prm-grid-subtitle" colSpan={14}>
                      Material kept aside for Resorting. ( SQC). {statusCaption}
                    </th>
                    <th>{statusLabel}</th>
                  </tr>
                  <tr className="prm-grid-group">
                    <th className={MC_CELL_CLASS}>M/c.</th><th>Date</th><th>Bottle Name</th><th>Shift</th><th>Lot</th>
                    <th>Pcs / Pack</th><th>Packs</th><th>Qty</th><th>Reason</th><th>Cav.</th>
                    <th>OK Qty</th><th>Rejected</th><th>Balance</th><th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {allMachines.map((machineNo) => {
                    const rows = pagedSqcReportRowsByMachine.get(machineNo) ?? [];
                    if (rows.length === 0) return null;
                    return (
                      <React.Fragment key={`sqc-mc-${machineNo}`}>
                        {rows.map((row, idx) => {
                          const group = row.sqcGroup;
                          const hasData = !group.isZero && (group.packs > 0 || group.qty > 0);
                          const active = hasData && group.qty > 0;
                          const originDate = group.productionDate || '';
                          const sourceKey = active
                            ? sqcBatchSourceKey(
                                originDate, group.machineNo, group.jobName,
                                group.shift, group.lotNo, group.jobId
                              )
                            : '';
                          const progress = active
                            ? reportProgressFor(sourceKey, group.qty)
                            : { okQty: 0, rejected: 0, balance: 0 };
                          return (
                            <tr key={`sqc-mc-${machineNo}-row-${idx}`}>
                              {idx === 0 ? (
                                <td className={MC_CELL_CLASS} rowSpan={rows.length}>M/c. {machineNo}</td>
                              ) : null}
                              <td>{formatEntryDate(group.productionDate)}</td>
                              <td className="prm-name-cell">{group.jobName || ''}</td>
                              <td>{hasData && group.shift ? ROMAN_SHIFT[group.shift] || String(group.shift) : ''}</td>
                              <td>{hasData ? blankOr(group.lotNo) : ''}</td>
                              <td>{hasData && group.pcsPerPack > 0 ? group.pcsPerPack : ''}</td>
                              <td>{hasData && group.packs > 0 ? group.packs : ''}</td>
                              <td>{hasData && group.qty > 0 ? group.qty : ''}</td>
                              <td>
                                {hasData
                                  ? <DefectTags value={group.reason} categoryByName={defectCategoryByName} />
                                  : ''}
                              </td>
                              <td>{hasData ? group.cav || '' : ''}</td>
                              <td className="prm-progress-cell">
                                {active ? (
                                  <input
                                    type="number" min={0} step={1}
                                    className="prm-grid-progress-input"
                                    value={progress.okQty}
                                    aria-label={`SQC OK Qty for ${group.jobName} on ${originDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'sqc', sourceKey, originDate, group.jobName,
                                      group.lotNo, group.qty, 'okQty', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td className="prm-progress-cell">
                                {active ? (
                                  <input
                                    type="number" min={0} step={1}
                                    className="prm-grid-progress-input"
                                    value={progress.rejected}
                                    aria-label={`SQC Rejected for ${group.jobName} on ${originDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'sqc', sourceKey, originDate, group.jobName,
                                      group.lotNo, group.qty, 'rejected', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td>{active ? progress.balance : ''}</td>
                              <td className="prm-name-cell">{active ? group.remarks || '' : ''}</td>
                            </tr>
                          );
                        })}
                        <tr className="prm-mc-spacer" key={`sqc-mc-${machineNo}-spacer`}>
                          <td colSpan={14}>&nbsp;</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  <tr className="prm-total-row">
                    <td className="prm-name-cell" colSpan={3}>Total</td>
                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                    <td>{grandTotalQty > 0 ? grandTotalQty : ''}</td>
                    <td colSpan={2}>&nbsp;</td>
                    <td>{reportTotals.sqcOk > 0 ? reportTotals.sqcOk : ''}</td>
                    <td>{reportTotals.sqcRejected > 0 ? reportTotals.sqcRejected : ''}</td>
                    <td>{reportTotals.sqcBalance > 0 ? reportTotals.sqcBalance : ''}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
              {renderPager('sqc', sqcRowCount)}

              {/* Live category breakdown: driven entirely by active master rows,
                  so `Other` and future categories appear automatically. */}
              {defectBreakdown.length > 0 && (
                <div
                  className="prm-defect-legend"
                  style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', margin: '0 0 6px' }}
                >
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#334155' }}>
                    Defect categories logged:
                  </span>
                  {defectBreakdown.map(({ group, count }) => {
                    const s = styleForDefectCategory(group);
                    return (
                      <span
                        key={group}
                        style={{
                          fontSize: '10px',
                          fontWeight: 600,
                          padding: '1px 5px',
                          borderRadius: '3px',
                          backgroundColor: s.bg,
                          color: s.color,
                          border: `1px solid ${s.border}`,
                        }}
                      >
                        {group} · {count}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* BOTTOM TABLE — QC HOLD inspection lines. Same grid treatment
                  as the SQC sheet above (steel-blue headers, black borders). */}
              <table className="prm-grid prm-grid--sqc table-fixed w-full text-xs">
                <colgroup>
                  <col style={{ width: MC_COL_WIDTH, minWidth: MC_COL_WIDTH, maxWidth: MC_COL_WIDTH }} />
                  <col style={{ width: DATE_COL_WIDTH, minWidth: DATE_COL_WIDTH, maxWidth: DATE_COL_WIDTH }} />
                  {SHARED_COL_WIDTHS.map((width, i) => (
                    <col key={`qc-shared-${i}`} style={{ width }} />
                  ))}
                  {DETAIL_COL_WIDTHS.map((width, i) => (
                    <col key={`qc-detail-${i}`} style={{ width }} />
                  ))}
                  {PROGRESS_COL_WIDTHS.map((width, i) => (
                    <col key={`qc-progress-${i}`} style={{ width }} />
                  ))}
                  <col style={{ width: REMARKS_COL_WIDTH }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="prm-grid-title bg-[#dce6f1] text-black font-bold border-black" colSpan={14}>
                      REPORT OF QC HOLD MATERIALS (QC HOLD)
                    </th>
                    <th className="prm-grid-code bg-[#dce6f1] text-black font-bold border-black">QA-F-10</th>
                  </tr>
                  <tr>
                    <th className="prm-grid-subtitle bg-[#dce6f1] text-black font-bold border-black" colSpan={14}>
                      Material kept aside for QC Hold. (QC HOLD). {statusCaption}
                    </th>
                    <th className="bg-[#dce6f1] text-black font-bold border-black">{statusLabel}</th>
                  </tr>
                  <tr className="prm-grid-group">
                    {[
                      'M/c.', 'Date', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack',
                      'Packs', 'Qty', 'Mould', 'Defects',
                      'OK Qty', 'Rejected', 'Balance', 'Remarks',
                    ].map((label) => (
                      <th
                        key={label}
                        className={`bg-[#dce6f1] text-black font-bold border-black${label === 'M/c.' ? ` ${MC_CELL_CLASS}` : ''}`}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allMachines.map((machineNo) => {
                    // Same machine-to-bottle rows, same rowSpan, same spacers as
                    // the SQC sheet above — only the detail cells differ.
                    const rows = pagedQcReportRowsByMachine.get(machineNo) ?? [];
                    if (rows.length === 0) return null;
                    return (
                      <React.Fragment key={`qc-mc-${machineNo}`}>
                        {rows.map(({ jobName, qcGroup: hold }, idx) => {
                          const active = !!hold && hold.qty > 0;
                          const originDate = hold?.productionDate || '';
                          const sourceKey = active && hold
                            ? qcBatchSourceKey(
                                originDate, hold.machineNo, hold.jobName, hold.shift,
                                hold.lotNo, hold.mould, hold.defects, hold.jobId
                              )
                            : '';
                          const progress = active && hold
                            ? reportProgressFor(sourceKey, hold.qty)
                            : { okQty: 0, rejected: 0, balance: 0 };
                          return (
                            <tr key={`qc-mc-${machineNo}-row-${idx}`}>
                              {idx === 0 ? (
                                <td className={MC_CELL_CLASS} rowSpan={rows.length}>M/c. {machineNo}</td>
                              ) : null}
                              <td>{formatEntryDate(hold?.productionDate ?? '')}</td>
                              <td className="prm-name-cell">{jobName}</td>
                              <td>{hold?.shift ? ROMAN_SHIFT[hold.shift] || String(hold.shift) : ''}</td>
                              <td>{hold ? blankOr(hold.lotNo) : ''}</td>
                              <td>{hold && hold.pcsPerPack > 0 ? hold.pcsPerPack : ''}</td>
                              <td>{hold && hold.packs > 0 ? hold.packs : ''}</td>
                              <td>{hold && hold.qty > 0 ? hold.qty : ''}</td>
                              <td>{hold ? blankOr(hold.mould) : ''}</td>
                              <td>
                                {hold
                                  ? <DefectTags value={blankOr(hold.defects)} categoryByName={defectCategoryByName} />
                                  : ''}
                              </td>
                              <td className="prm-progress-cell">
                                {active && hold ? (
                                  <input
                                    type="number" min={0} step={1}
                                    className="prm-grid-progress-input"
                                    value={progress.okQty}
                                    aria-label={`QC HOLD OK Qty for ${jobName} on ${originDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'qc', sourceKey, originDate, hold.jobName,
                                      hold.lotNo, hold.qty, 'okQty', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td className="prm-progress-cell">
                                {active && hold ? (
                                  <input
                                    type="number" min={0} step={1}
                                    className="prm-grid-progress-input"
                                    value={progress.rejected}
                                    aria-label={`QC HOLD Rejected for ${jobName} on ${originDate}`}
                                    onChange={(e) => updateReportProgress(
                                      'qc', sourceKey, originDate, hold.jobName,
                                      hold.lotNo, hold.qty, 'rejected', e.target.value
                                    )}
                                  />
                                ) : ''}
                              </td>
                              <td>{active ? progress.balance : ''}</td>
                              <td className="prm-name-cell">{active ? blankOr(hold.remarks) : ''}</td>
                            </tr>
                          );
                        })}
                        <tr className="prm-mc-spacer" key={`qc-mc-${machineNo}-spacer`}>
                          <td colSpan={14}>&nbsp;</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  <tr className="prm-total-row">
                    <td className="prm-name-cell" colSpan={3}>Total</td>
                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                    <td>{qcTotalQty > 0 ? qcTotalQty : ''}</td>
                    <td colSpan={2}>&nbsp;</td>
                    <td>{reportTotals.qcOk > 0 ? reportTotals.qcOk : ''}</td>
                    <td>{reportTotals.qcRejected > 0 ? reportTotals.qcRejected : ''}</td>
                    <td>{reportTotals.qcBalance > 0 ? reportTotals.qcBalance : ''}</td>
                    <td />
                  </tr>
                  <tr className="prm-note-row border border-t-0 border-black">
                    <td colSpan={14} className="border border-t-0 border-black px-3 py-2 font-bold text-black">
                      Note : Amber colour of the bottle is within specification.
                    </td>
                  </tr>
                </tbody>
              </table>
              {renderPager('qc', qcRowCount)}
              <div className="prm-signatures">
                <div className="prm-signature">Q.A. Executive</div>
                <div className="prm-signature">HOD QA</div>
              </div>
              <div className="prm-cc">cc : Director / Design &amp; Dev. / Mould Workshop / Costing / Warehouse / Glass.</div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
};
