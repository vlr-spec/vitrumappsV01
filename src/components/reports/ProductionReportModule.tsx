import React, { useEffect, useMemo, useState } from 'react';
import { Download, Printer, Save } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import {
  repackingRepository,
  RepackingSqcQcHoldEntry,
  BottleNameItem,
} from '../../services/repackingRepository';
import {
  qualityRepository,
  hasMeaningfulData,
  QualityDayHourly,
} from '../../services/qualityRepository';
import { useERP } from '../../context/ERPContext';

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

/**
 * Both QA-F-10 matrices share one 13-column grid definition. M/c. is a fixed
 * 54px; every other width is a fraction of the remaining space so every
 * vertical border lines up. The two detail columns (Reason/Cav. # against
 * Mould/Defects) and the three progress columns (OK Qty / Rejected / Balance)
 * occupy the same slots in both sheets, with Remarks last.
 */
const MC_COL_WIDTH = 54;
const colWidth = (fraction: number): string =>
  `calc((100% - ${MC_COL_WIDTH}px) * ${fraction})`;
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
/** Whole-day date arithmetic in UTC, so the 30-day lookback never drifts with
 *  daylight-saving changes or the browser's local timezone. */
const addDaysUtc = (iso: string, days: number): string => {
  if (!isValidIso(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
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
  lotNo: string
): string =>
  `sqc|${originDate}|${machineNo}|${jobName}|${shift}|${lotNo}`;
const qcBatchSourceKey = (
  originDate: string,
  machineNo: MachineNo,
  jobName: string,
  shift: number,
  lotNo: string,
  mould: string,
  defects: string
): string =>
  `qc|${originDate}|${machineNo}|${jobName}|${shift}|${lotNo}|${mould}|${defects}`;

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
   data cell. Tight px-1.5 / py-1.5 padding keeps all 11 columns inside the 60%
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
/* Bottle name is a link back to the source report date. CSS fallbacks keep it
   looking like plain text while letting the hover state win over .prm-log td. */
.prm-log-name-button {
  background: transparent; border: 0; padding: 0; font: inherit;
  font-weight: 700; color: #000000; cursor: pointer; text-align: left;
}
.prm-log-name-button:hover { color: #1d4ed8; text-decoration: underline; }
.prm-log-caption { margin-bottom: 8px; font-size: 11px; font-weight: 700; color: #000000; }
.prm-log-stack { display: flex; flex-direction: column; gap: 14px; }
.prm-log-section { min-width: 0; }

/* ── Signatures / distribution ───────────────────────────────────────────── */
.prm-signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 30px; }
.prm-signature { width: 180px; border-top: 1px solid #000000; padding-top: 6px; text-align: center; font-size: 11.5px; font-weight: 700; color: #000000; }
.prm-cc { margin-top: 22px; font-size: 10.5px; color: #000000; }

/* ── Print: only the QA-F-10 sheet, regardless of the selected tab ───────── */
@media print {
  @page { size: A4 landscape; margin: 8mm; }
  .prm-root { padding: 0 !important; max-width: none !important; margin: 0 !important; }
  .prm-toolbar, .prm-radio, .prm-status { display: none !important; }
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
    const key = `${productionDate}|${machineNo}|${jobName.toLowerCase()}|${shift}|${lotNo.toLowerCase()}|${pcsPerPack}`;

    const rows = byMachine.get(machineNo)!;
    let group = rows.find((r) => r.key === key);
    if (!group) {
      group = {
        key,
        productionDate,
        machineNo,
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
    const key = `${productionDate}|${machineNo}|${jobName.toLowerCase()}|${shift}|${pcsPerPack}|${mould}|${defects.toLowerCase()}|${checker.toLowerCase()}|${remarks.toLowerCase()}`;
    let group = rows.find((row) => row.key === key);
    if (!group) {
      group = {
        key,
        productionDate,
        machineNo,
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

/**
 * JOB NAMES present in the Quality Module's SQC/QC HOLD list for one date.
 * The tab derives its rows from the Hourly Production Report for that date:
 * any row carrying a bottle_id / job_id (including jobs planned but not yet
 * produced, i.e. 0 cartons and 0 bottles) counts as content — the same
 * `hasMeaningfulData` rule the Quality Module uses.
 */
const productionJobNamesByMachine = (
  dayHourly: QualityDayHourly,
  lookup: Map<string, string>
): Map<MachineNo, string[]> => {
  const result = new Map<MachineNo, string[]>();
  for (const m of MACHINE_NUMBERS) {
    const names: string[] = [];
    const byTime = dayHourly[String(m)] ?? {};
    for (const entry of Object.values(byTime)) {
      if (!hasMeaningfulData(entry)) continue;
      const name = bottleNameFor(entry, lookup);
      if (name) names.push(name);
    }
    result.set(m, names.filter((name, i) => names.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i));
  }
  return result;
};

// ─── Component ──────────────────────────────────────────────────────────────

export const ProductionReportModule: React.FC = () => {
  const { bottles } = useERP();
  const [dateIso, setDateIso] = useState<string>(() => toIso(new Date()));
  const [machineFilter, setMachineFilter] = useState<MachineFilter>('all');
  /** Strictly the selected report date — drives both left QA-F-10 tables. */
  const [entries, setEntries] = useState<RepackingSqcQcHoldEntry[]>([]);
  /** selected report date − 30 days … selected report date — drives the logs. */
  const [logEntries, setLogEntries] = useState<RepackingSqcQcHoldEntry[]>([]);
  const [logBottleNames, setLogBottleNames] = useState<BottleNameItem[]>([]);
  const [loadedLogDateIso, setLoadedLogDateIso] = useState('');
  const [bottleNames, setBottleNames] = useState<BottleNameItem[]>([]);
  const [dayHourly, setDayHourly] = useState<QualityDayHourly>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exporting, setExporting] = useState(false);
  // Resorting log is local UI state, restored from localStorage on mount.
  const [resortingBatches, setResortingBatches] = useState<ResortingBatch[]>(loadStoredBatches);

  // Same API sources the Quality Module's SQC/QC HOLD tab reads from:
  // saved repacking entries + the hourly production rows that supply the
  // per-machine JOB NAME list (including jobs with nothing entered yet).
  // The left sheets stay on the selected date; the right logs use a separate
  // 30-day lookback through the SAME existing per-date fetcher (no backend or
  // schema changes — the repository already caches each date it fetches).
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setLoadedLogDateIso('');

    // One request for the selected date, shared by the left sheets and the
    // log window so the same day is never fetched twice.
    const selectedData = repackingRepository.getRepackingData(dateIso);
    const selected = Promise.all([selectedData, qualityRepository.load(dateIso)]);
    const lookbackDates: string[] = [];
    for (let offset = 30; offset >= 0; offset -= 1) {
      const day = addDaysUtc(dateIso, -offset);
      if (day !== dateIso) lookbackDates.push(day);
    }
    // A slow/failed day must not hide the other 30 days or the left sheets.
    const lookback = Promise.allSettled([
      selectedData,
      ...lookbackDates.map((day) => repackingRepository.getRepackingData(day)),
    ]);

    selected
      .then(([{ sqc, bottleNames: names }, { hourly }]) => {
        if (!active) return;
        setEntries(Array.isArray(sqc) ? sqc : []);
        setBottleNames(Array.isArray(names) ? names : []);
        setDayHourly(hourly ?? {});
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load SQC/QC HOLD report data:', err);
        setEntries([]);
        setDayHourly({});
        setLoadError('Could not load saved SQC/QC HOLD entries for this date.');
        setLoading(false);
      });

    lookback.then((results) => {
      if (!active) return;
      const allEntries: RepackingSqcQcHoldEntry[] = [];
      const allNames: BottleNameItem[] = [];
      const seenEntries = new Set<string>();
      const seenNames = new Set<string>();
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const row of result.value.sqc ?? []) {
          const key = row.entry_id ||
            `${row.production_date}|${row.machine_no}|${row.job_id}|${row.lot_no}|${row.shift}|${row.entry_time}`;
          if (seenEntries.has(key)) continue;
          seenEntries.add(key);
          allEntries.push(row);
        }
        for (const name of result.value.bottleNames ?? []) {
          const key = String(name.bottle_id);
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          allNames.push(name);
        }
      }
      setLogEntries(allEntries);
      setLogBottleNames(allNames);
      setLoadedLogDateIso(dateIso);
    });

    return () => {
      active = false;
    };
  }, [dateIso]);

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

  const groupedByMachine = useMemo(() => {
    const byMachine = aggregateSqc(entries, bottleLookup);
    const jobsByMachine = productionJobNamesByMachine(dayHourly, bottleLookup);
    for (const machineNo of MACHINE_NUMBERS) {
      const rows = byMachine.get(machineNo)!;
      const existing = new Set(rows.map((r) => r.jobName.toLowerCase()));
      for (const jobName of jobsByMachine.get(machineNo) ?? []) {
        const key = jobName.toLowerCase();
        if (existing.has(key)) continue;
        existing.add(key);
        rows.push({
          key: `zero|${machineNo}|${key}`,
          productionDate: dateIso,
          machineNo,
          jobName,
          shift: 0,
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
        });
      }
    }
    return byMachine;
  }, [entries, bottleLookup, dayHourly]);

  const qcHoldRows = useMemo(
    () => aggregateQcHolds(entries, bottleLookup),
    [entries, bottleLookup]
  );
  const visibleQcHoldRows = useMemo(
    () => qcHoldRows.filter((row) =>
      machineFilter === 'all' || row.machineNo === machineFilter
    ),
    [qcHoldRows, machineFilter]
  );

  // ── 30-day lookback data for the two right-side resorting logs only ─────────
  // Bottle names from every fetched date, so older holds keep their job names.
  const logBottleLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bottles) {
      const id = asText(b.id);
      if (id) map.set(id, asText(b.name));
    }
    for (const b of logBottleNames) {
      map.set(String(b.bottle_id), asText(b.bottle_name));
    }
    return map;
  }, [bottles, logBottleNames]);

  // Same classification rules as the left sheets: Lot # > 0 → SQC,
  // Lot # "0" with tracking details → QC HOLD. Grouping includes the source
  // date, so a bottle held on several days yields one batch per day.
  const logSqcRowsByMachine = useMemo(
    () => aggregateSqc(logEntries, logBottleLookup),
    [logEntries, logBottleLookup]
  );
  const logQcHoldRows = useMemo(
    () => aggregateQcHolds(logEntries, logBottleLookup),
    [logEntries, logBottleLookup]
  );
  const lookbackStartIso = useMemo(() => addDaysUtc(dateIso, -30), [dateIso]);

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
          holds.find((row) => row.jobName.toLowerCase() === name && row.shift === sqcGroup.shift) ??
          holds.find((row) => row.jobName.toLowerCase() === name);
        return { key: sqcGroup.key, jobName: sqcGroup.jobName, sqcGroup, qcGroup };
      });
      for (const hold of holds) {
        const name = hold.jobName.toLowerCase();
        if (rows.some((row) => row.jobName.toLowerCase() === name)) continue;
        rows.push({
          key: `qc-only|${machineNo}|${name}`,
          jobName: hold.jobName,
          sqcGroup: {
            key: `qc-only|${machineNo}|${name}`,
            productionDate: hold.productionDate,
            machineNo,
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

  // Seed one batch per hold in the 30-day window. sourceKey includes the
  // SOURCE production date, so revisiting any date never duplicates a batch,
  // and saved OK/Rejected progress is reused via `known`.
  useEffect(() => {
    if (loading || loadError || loadedLogDateIso !== dateIso) return;
    setResortingBatches((prev) => {
      const known = new Set(prev.map((batch) => batch.sourceKey));
      const additions: ResortingBatch[] = [];
      for (const [machineNo, groups] of logSqcRowsByMachine) {
        for (const group of groups) {
          if (group.isZero || group.qty <= 0) continue;
          const originDate = group.productionDate || dateIso;
          if (originDate < lookbackStartIso || originDate > dateIso) continue;
          const sourceKey = sqcBatchSourceKey(
            originDate, machineNo, group.jobName, group.shift, group.lotNo
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
        const originDate = group.productionDate || dateIso;
        if (originDate < lookbackStartIso || originDate > dateIso) continue;
        const sourceKey = qcBatchSourceKey(
          originDate, group.machineNo, group.jobName, group.shift,
          group.lotNo, group.mould, group.defects
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
  }, [dateIso, loadedLogDateIso, lookbackStartIso, logSqcRowsByMachine, logQcHoldRows, loading, loadError]);

  // Left-side pending queue: one row per unresolved batch in the 30-day window.
  // QA-F-10 rows own all sorting progress, so Pending Qty here is simply the
  // batch hold minus everything already sorted against it.
  const resortingRows = useMemo<ResortingLogRow[]>(() => {
    const rows: ResortingLogRow[] = [];
    for (const batch of resortingBatches) {
      // Only the last 30 days are in scope; later dates are still pending
      // work and may resurface when that date becomes the report date.
      if (batch.originDate < lookbackStartIso || batch.originDate > dateIso) continue;
      const entry = batch.entries[0];
      if (!entry) continue;
      const okQty = Math.max(0, asNum(entry.okQty));
      const rejected = Math.max(0, asNum(entry.rejected));
      const balance = Math.max(0, batch.initialHold - okQty - rejected);
      if (balance <= 0) continue;
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
  }, [resortingBatches, dateIso, lookbackStartIso]);

  const sqcLogRows = useMemo(
    () => resortingRows.filter((row) => row.kind === 'sqc'),
    [resortingRows]
  );
  const qcLogRows = useMemo(
    () => resortingRows.filter((row) => row.kind === 'qc'),
    [resortingRows]
  );

  const visibleMachines = useMemo(
    () => (machineFilter === 'all' ? [...MACHINE_NUMBERS] : [machineFilter]),
    [machineFilter]
  );
  const visibleGroups = useMemo(
    () => visibleMachines.flatMap((m) => groupedByMachine.get(m) ?? []),
    [visibleMachines, groupedByMachine]
  );
  const grandTotalQty = useMemo(
    () => visibleGroups.reduce((sum, row) => sum + row.qty, 0),
    [visibleGroups]
  );
  const qcTotalQty = useMemo(
    () => visibleQcHoldRows.reduce((sum, row) => sum + row.qty, 0),
    [visibleQcHoldRows]
  );
  const dateLabel = isValidIso(dateIso) ? toDisplayDate(dateIso) : 'DD.MM.YYYY';

  // Inline QA-F-10 inputs and the left pending queue share the same saved batch
  // entries. Each batch has one progress entry, edited only from its report row.
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
  const reportTotals = (() => {
    const totals = {
      sqcOk: 0, sqcRejected: 0, sqcBalance: 0,
      qcOk: 0, qcRejected: 0, qcBalance: 0,
    };
    for (const machineNo of visibleMachines) {
      for (const row of reportRowsByMachine.get(machineNo) ?? []) {
        const sqc = row.sqcGroup;
        if (!sqc.isZero && sqc.qty > 0) {
          const progress = reportProgressFor(
            sqcBatchSourceKey(
              sqc.productionDate || dateIso,
              sqc.machineNo,
              sqc.jobName,
              sqc.shift,
              sqc.lotNo
            ),
            sqc.qty
          );
          totals.sqcOk += progress.okQty;
          totals.sqcRejected += progress.rejected;
          totals.sqcBalance += progress.balance;
        }
        const hold = row.qcGroup;
        if (hold && hold.qty > 0) {
          const progress = reportProgressFor(
            qcBatchSourceKey(
              hold.productionDate || dateIso,
              hold.machineNo,
              hold.jobName,
              hold.shift,
              hold.lotNo,
              hold.mould,
              hold.defects
            ),
            hold.qty
          );
          totals.qcOk += progress.okQty;
          totals.qcRejected += progress.rejected;
          totals.qcBalance += progress.balance;
        }
      }
    }
    return totals;
  })();

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
      const start = originDate || dateIso;
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

      const addLogTable = (sheet: any, title: string, rows: ResortingLogRow[]) => {
        sheet.addRow([]);
        const caption = sheet.addRow([title]);
        caption.font = { bold: true, size: 12, name: 'Times New Roman', color: { argb: 'FF000000' } };
        styleHeader(sheet.addRow(['Date', 'Bottle Name', 'Pending Qty']));
        if (rows.length === 0) {
          sheet.addRow(['', 'No pending balances to resort.']);
          return;
        }
        for (const row of rows) {
          styleData(sheet.addRow([row.date, row.bottleName, row.balance]));
        }
      };

      const excelNumber = (value: number): number | '' => (value > 0 ? value : '');

      // ── Sheet 1: SQC report + SQC resorting log ──────────────────────────
      const sqcSheet = workbook.addWorksheet('SQC');
      sqcSheet.mergeCells('A1:L1');
      sqcSheet.getCell('A1').value = 'REPORT OF NON CONFORMING MATERIALS (SQC)';
      sqcSheet.getCell('A1').font = { bold: true, size: 14, name: 'Times New Roman' };
      sqcSheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      sqcSheet.getCell('M1').value = 'QA-F-10';
      sqcSheet.getCell('M1').font = { ...tableFont };

      sqcSheet.mergeCells('A2:L2');
      sqcSheet.getCell('A2').value = 'Material kept aside for Resorting. ( SQC).';
      sqcSheet.getCell('M2').value = dateLabel;
      sqcSheet.getCell('M2').font = { ...tableFont };

      styleHeader(sqcSheet.addRow([
        'M/c.', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack', 'Packs', 'Qty',
        'Reason', 'Cav.', 'OK Qty', 'Rejected', 'Balance', 'Remarks',
      ]));
      for (const machineNo of visibleMachines) {
        const rows = reportRowsByMachine.get(machineNo) ?? [];
        if (rows.length === 0) continue;
        rows.forEach(({ sqcGroup: row }, idx) => {
          const hasData = !row.isZero && (row.packs > 0 || row.qty > 0);
          const isActive = hasData && row.qty > 0;
          const progress = isActive
            ? reportProgressFor(
                sqcBatchSourceKey(
                  row.productionDate || dateIso,
                  row.machineNo,
                  row.jobName,
                  row.shift,
                  row.lotNo
                ),
                row.qty
              )
            : { okQty: 0, rejected: 0, balance: 0 };
          styleData(sqcSheet.addRow([
            idx === 0 ? `M/c. ${machineNo}` : '',
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
        spacer.getCell(13).border = { left: { style: 'thin' }, right: { style: 'thin' } };
      }
      styleData(sqcSheet.addRow([
        '', 'Total', '', '', '', '', excelNumber(grandTotalQty),
        '', '',
        excelNumber(reportTotals.sqcOk),
        excelNumber(reportTotals.sqcRejected),
        excelNumber(reportTotals.sqcBalance),
        '',
      ]));
      addLogTable(sqcSheet, 'SQC - RESORTING LOG', sqcLogRows);
      sqcSheet.columns = [
        { width: 8 }, { width: 22 }, { width: 8 }, { width: 11 }, { width: 11 },
        { width: 9 }, { width: 10 }, { width: 24 }, { width: 11 },
        { width: 10 }, { width: 10 }, { width: 10 }, { width: 22 },
      ];

      // ── Sheet 2: QC HOLD report + QC resorting log ───────────────────────
      const qcSheet = workbook.addWorksheet('QC HOLD');
      // Same title / code and subtitle / date metadata layout as the on-screen sheet.
      qcSheet.mergeCells('A1:L1');
      qcSheet.getCell('A1').value = 'REPORT OF QC HOLD MATERIALS (QC HOLD)';
      qcSheet.getCell('A1').font = { bold: true, size: 14, name: 'Times New Roman' };
      qcSheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      qcSheet.getCell('M1').value = 'QA-F-10';
      qcSheet.getCell('M1').font = { ...tableFont };

      qcSheet.mergeCells('A2:L2');
      qcSheet.getCell('A2').value = 'Material kept aside for QC Hold. (QC HOLD).';
      qcSheet.getCell('A2').font = { ...tableFont };
      qcSheet.getCell('M2').value = dateLabel;
      qcSheet.getCell('M2').font = { ...tableFont };

      styleHeader(qcSheet.addRow([
        'M/c.', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack', 'Packs', 'Qty',
        'Mould', 'Defects', 'OK Qty', 'Rejected', 'Balance', 'Remarks',
      ]));
      for (const machineNo of visibleMachines) {
        // Identical machine-to-bottle rows as the SQC sheet above.
        const rows = reportRowsByMachine.get(machineNo) ?? [];
        if (rows.length === 0) continue;
        rows.forEach(({ jobName, qcGroup: hold }, idx) => {
          const isActive = !!hold && hold.qty > 0;
          const progress = isActive && hold
            ? reportProgressFor(
                qcBatchSourceKey(
                  hold.productionDate || dateIso,
                  hold.machineNo,
                  hold.jobName,
                  hold.shift,
                  hold.lotNo,
                  hold.mould,
                  hold.defects
                ),
                hold.qty
              )
            : { okQty: 0, rejected: 0, balance: 0 };
          styleData(qcSheet.addRow([
            idx === 0 ? `M/c. ${machineNo}` : '',
            jobName,
            hold?.shift ? ROMAN_SHIFT[hold.shift] || String(hold.shift) : '',
            hold ? excelText(hold.lotNo) : '',
            hold && hold.pcsPerPack > 0 ? hold.pcsPerPack : '',
            hold && hold.packs > 0 ? hold.packs : '',
            hold ? excelNumber(hold.qty) : '',
            hold ? excelText(hold.mould) : '',
            hold ? excelText(hold.defects) : '',
            isActive ? excelNumber(progress.okQty) : '',
            isActive ? excelNumber(progress.rejected) : '',
            isActive ? excelNumber(progress.balance) : '',
            isActive ? excelText(hold.remarks) : '',
          ]));
        });
        const spacer = qcSheet.addRow([]);
        spacer.height = 9;
        spacer.getCell(1).border = { left: { style: 'thin' }, right: { style: 'thin' } };
        spacer.getCell(13).border = { left: { style: 'thin' }, right: { style: 'thin' } };
      }
      styleData(qcSheet.addRow([
        '', 'Total', '', '', '', '', excelNumber(qcTotalQty),
        '', '',
        excelNumber(reportTotals.qcOk),
        excelNumber(reportTotals.qcRejected),
        excelNumber(reportTotals.qcBalance),
        '',
      ]));
      // Note is a bordered row attached directly to the bottom of the table.
      const qcNoteRowNumber = qcSheet.rowCount + 1;
      qcSheet.mergeCells(`A${qcNoteRowNumber}:M${qcNoteRowNumber}`);
      const qcNoteCell = qcSheet.getCell(`A${qcNoteRowNumber}`);
      qcNoteCell.value = 'Note : Amber colour of the bottle is within specification.';
      qcNoteCell.font = { ...tableFont };
      qcNoteCell.border = {
        top: { style: 'none' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
      addLogTable(qcSheet, 'QC HOLD - RESORTING LOG', qcLogRows);
      qcSheet.columns = [
        { width: 8 }, { width: 22 }, { width: 8 }, { width: 11 }, { width: 11 },
        { width: 9 }, { width: 10 }, { width: 10 }, { width: 22 },
        { width: 10 }, { width: 10 }, { width: 10 }, { width: 22 },
      ];
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SQC_QC_Hold_Report_${dateLabel}.xlsx`;
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

  const renderResortingLog = (kind: 'sqc' | 'qc', title: string, emptyText: string) => {
    const rows = kind === 'sqc' ? sqcLogRows : qcLogRows;
    const displayDate = (row: ResortingLogRow): string =>
      isValidIso(row.date) ? toDisplayDate(row.date) : row.date || 'its source date';
    const openReportDate = (row: ResortingLogRow) => {
      if (isValidIso(row.date)) setDateIso(row.date);
    };

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
              <tr><td colSpan={3}>{emptyText}</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>{displayDate(row)}</td>
                  <td className="prm-log-name">
                    <button
                      type="button"
                      className="prm-log-name-button cursor-pointer font-bold text-black hover:text-blue-700 hover:underline"
                      title={`Click to view report details on ${displayDate(row)}`}
                      aria-label={`View ${row.bottleName} report details on ${displayDate(row)}`}
                      onClick={() => openReportDate(row)}
                    >
                      {row.bottleName}
                    </button>
                  </td>
                  <td>{row.balance}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    );
  };

  return (
    <div className="prm-root">
      <style>{PRM_STYLES}</style>
      <Toaster position="bottom-right" richColors />

      <input className="prm-radio" type="radio" name="prm-report-view" id="prm-tab-numbering" />
      <input className="prm-radio" type="radio" name="prm-report-view" id="prm-tab-sqc" defaultChecked />

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
          <button className="prm-action-btn prm-action-btn--outline" type="button" onClick={() => window.print()}>
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
          {loading ? (
            <p className="prm-status">Loading saved SQC / QC HOLD entries…</p>
          ) : loadError ? (
            <p className="prm-status prm-status--error">{loadError}</p>
          ) : visibleGroups.length === 0 && visibleQcHoldRows.length === 0 ? (
            <p className="prm-status">No SQC / QC HOLD jobs for {dateLabel}.</p>
          ) : null}

          <div className="prm-report-split flex flex-col lg:flex-row gap-4 items-start">
            {/* ── Left 40% : two independent, carry-forward resorting logs ── */}
            <div className="prm-report-right w-full lg:w-[40%] min-w-0">
              <div className="prm-log-caption">
                Sorted against the report as on {dateLabel} · only pending balances carry forward
              </div>
              <div className="prm-log-stack">
                {renderResortingLog(
                  'sqc',
                  'SQC - RESORTING LOG',
                  'No pending SQC balances to resort for this date.'
                )}
                {renderResortingLog(
                  'qc',
                  'QC HOLD - RESORTING LOG',
                  'No pending QC HOLD balances to resort for this date.'
                )}
              </div>
            </div>

            {/* ── Right 60% : SQC sheet above QC HOLD sheet ────────────────── */}
            <div className="prm-report-left w-full lg:w-[60%] min-w-0">
              {/* TOP TABLE — SQC: material kept aside for resorting. */}
              <table className="prm-grid prm-grid--sqc table-fixed w-full text-xs">
                <colgroup>
                  <col style={{ width: MC_COL_WIDTH, minWidth: MC_COL_WIDTH, maxWidth: MC_COL_WIDTH }} />
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
                    <th className="prm-grid-title" colSpan={12}>REPORT OF NON CONFORMING MATERIALS (SQC)</th>
                    <th className="prm-grid-code">QA-F-10</th>
                  </tr>
                  <tr>
                    <th className="prm-grid-subtitle" colSpan={12}>Material kept aside for Resorting. ( SQC).</th>
                    <th>{dateLabel}</th>
                  </tr>
                  <tr className="prm-grid-group">
                    <th className={MC_CELL_CLASS}>M/c.</th><th>Bottle Name</th><th>Shift</th><th>Lot</th>
                    <th>Pcs / Pack</th><th>Packs</th><th>Qty</th><th>Reason</th><th>Cav.</th>
                    <th>OK Qty</th><th>Rejected</th><th>Balance</th><th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMachines.map((machineNo) => {
                    const rows = reportRowsByMachine.get(machineNo) ?? [];
                    if (rows.length === 0) return null;
                    return (
                      <React.Fragment key={`sqc-mc-${machineNo}`}>
                        {rows.map((row, idx) => {
                          const group = row.sqcGroup;
                          const hasData = !group.isZero && (group.packs > 0 || group.qty > 0);
                          const active = hasData && group.qty > 0;
                          const originDate = group.productionDate || dateIso;
                          const sourceKey = active
                            ? sqcBatchSourceKey(
                                originDate, group.machineNo, group.jobName,
                                group.shift, group.lotNo
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
                              <td className="prm-name-cell">{group.jobName || ''}</td>
                              <td>{hasData && group.shift ? ROMAN_SHIFT[group.shift] || String(group.shift) : ''}</td>
                              <td>{hasData ? blankOr(group.lotNo) : ''}</td>
                              <td>{hasData && group.pcsPerPack > 0 ? group.pcsPerPack : ''}</td>
                              <td>{hasData && group.packs > 0 ? group.packs : ''}</td>
                              <td>{hasData && group.qty > 0 ? group.qty : ''}</td>
                              <td>{hasData ? group.reason || '' : ''}</td>
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
                          <td colSpan={13}>&nbsp;</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  <tr className="prm-total-row">
                    <td className="prm-name-cell" colSpan={2}>Total</td>
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

              {/* BOTTOM TABLE — QC HOLD inspection lines. Same grid treatment
                  as the SQC sheet above (steel-blue headers, black borders). */}
              <table className="prm-grid prm-grid--sqc table-fixed w-full text-xs">
                <colgroup>
                  <col style={{ width: MC_COL_WIDTH, minWidth: MC_COL_WIDTH, maxWidth: MC_COL_WIDTH }} />
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
                    <th className="prm-grid-title bg-[#dce6f1] text-black font-bold border-black" colSpan={12}>
                      REPORT OF QC HOLD MATERIALS (QC HOLD)
                    </th>
                    <th className="prm-grid-code bg-[#dce6f1] text-black font-bold border-black">QA-F-10</th>
                  </tr>
                  <tr>
                    <th className="prm-grid-subtitle bg-[#dce6f1] text-black font-bold border-black" colSpan={12}>
                      Material kept aside for QC Hold. (QC HOLD).
                    </th>
                    <th className="bg-[#dce6f1] text-black font-bold border-black">{dateLabel}</th>
                  </tr>
                  <tr className="prm-grid-group">
                    {[
                      'M/c.', 'Bottle Name', 'Shift', 'Lot', 'Pcs / Pack',
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
                  {visibleMachines.map((machineNo) => {
                    // Same machine-to-bottle rows, same rowSpan, same spacers as
                    // the SQC sheet above — only the detail cells differ.
                    const rows = reportRowsByMachine.get(machineNo) ?? [];
                    if (rows.length === 0) return null;
                    return (
                      <React.Fragment key={`qc-mc-${machineNo}`}>
                        {rows.map(({ jobName, qcGroup: hold }, idx) => {
                          const active = !!hold && hold.qty > 0;
                          const originDate = hold?.productionDate || dateIso;
                          const sourceKey = active && hold
                            ? qcBatchSourceKey(
                                originDate, hold.machineNo, hold.jobName, hold.shift,
                                hold.lotNo, hold.mould, hold.defects
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
                              <td className="prm-name-cell">{jobName}</td>
                              <td>{hold?.shift ? ROMAN_SHIFT[hold.shift] || String(hold.shift) : ''}</td>
                              <td>{hold ? blankOr(hold.lotNo) : ''}</td>
                              <td>{hold && hold.pcsPerPack > 0 ? hold.pcsPerPack : ''}</td>
                              <td>{hold && hold.packs > 0 ? hold.packs : ''}</td>
                              <td>{hold && hold.qty > 0 ? hold.qty : ''}</td>
                              <td>{hold ? blankOr(hold.mould) : ''}</td>
                              <td>{hold ? blankOr(hold.defects) : ''}</td>
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
                          <td colSpan={13}>&nbsp;</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  <tr className="prm-total-row">
                    <td className="prm-name-cell" colSpan={2}>Total</td>
                    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                    <td>{qcTotalQty > 0 ? qcTotalQty : ''}</td>
                    <td colSpan={2}>&nbsp;</td>
                    <td>{reportTotals.qcOk > 0 ? reportTotals.qcOk : ''}</td>
                    <td>{reportTotals.qcRejected > 0 ? reportTotals.qcRejected : ''}</td>
                    <td>{reportTotals.qcBalance > 0 ? reportTotals.qcBalance : ''}</td>
                    <td />
                  </tr>
                  <tr className="prm-note-row border border-t-0 border-black">
                    <td colSpan={13} className="border border-t-0 border-black px-3 py-2 font-bold text-black">
                      Note : Amber colour of the bottle is within specification.
                    </td>
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
        </div>
      </div>
    </div>
  );
};
