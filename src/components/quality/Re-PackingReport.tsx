/**
 * Re-PackingReport.tsx — Re-Packing Report with NUMBERING and SQC/QC HOLD layouts.
 *
 * Two-layout Re-Packing Report rendered as a compact ERP dashboard: light
 * page background, white machine cards with subtle borders / rounded corners
 * / minimal shadows, and blue (#2563EB) as the primary accent.
 *   • NUMBERING (default): 4 machine tables with columns
 *     Job Name | Pack Type | Shift | Time | Pcs/Pack | Cartons | Defective Bottles | Lot No. | Defects | Mould | Section No. | Checker Name | Remarks
 *   • SQC/QC HOLD: 4 machine tables with columns
 *     Job Name | Shift | Time | Pack Type | Lot No. | Pcs/Pack | Cartons | Defective Bottles | Defects | Mould | Section | Checker Name | Remarks
 *
 * Every column of every data row is an editable ERP-styled input (text,
 * number, dropdown or 12-hour AM/PM time picker where applicable), and each row
 * keeps its own independent values in component state. The Time columns use a
 * custom dropdown 12-hour time picker (Hour, Minute, AM/PM) whose available
 * hours are restricted to the cell's selected shift; times are never
 * auto-populated from job schedules. Switching between NUMBERING and SQC/QC
 * HOLD keeps the
 * entered values for the current component session; a date change re-derives
 * the entries from that date's production records.
 *
 * Each JOB NAME cell carries a small (+) button (styled like the Hourly
 * Production Monitor's row-add pill) that inserts a new row IMMEDIATELY BELOW
 * the row it was clicked on — the same bottle's production row (or another
 * added row of that bottle), never after the next bottle or at the bottom of
 * the machine table — with the same bottle/job name prefilled. Added rows have
 * fully independent editable fields, any number of rows may be added per
 * bottle (they stay grouped under it), and the NUMBERING / SQC row-add sets
 * are kept in separate per-layout stores so the two tabs never affect each
 * other. Every manually added row also carries a matching (-) button that
 * removes the row (and its typed values); rows added from a removed row are
 * re-anchored to the same bottle group, and production rows loaded from the
 * Hourly Production Monitor data are never removable.
 *
 * Job names and entries come from the SAME Hourly Production Monitor data the
 * Quality Module uses, loaded through the existing qualityRepository
 * (GET /api/production/quality/daily/?date=) — the same read-only repository
 * call the Machine Wise Production and Efficiency report and the Daily M/C
 * Speed and Weight report already make for the selected date (concurrent loads
 * of one date share a single in-flight request). Each machine's day is split
 * into continuous same-bottle runs with the same run detection as
 * AllMachineReport / DailyMcSpeedWeightReport: a job that runs all day yields
 * ONE entry, a mid-day job change yields one entry per run, and distinct jobs
 * are never merged.
 *
 * No new API endpoint, no save/persistence, no backend or schema change, and
 * no change to any production calculation or the Hourly Production Monitor —
 * this is a UI-only, editable representation of existing data reusing the
 * existing Vitrum Glass ERP blue-and-white theme.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, Check, Loader2, CheckCircle2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useERP } from '../../context/ERPContext';
import { planningRepository } from '../../services/planningRepository';
import {
  repackingRepository,
  RepackingNumberingEntry,
  RepackingSqcQcHoldEntry,
  EmployeeItem,
} from '../../services/repackingRepository';
import {
  qualityRepository,
  QualityDayHourly,
  QualityHourlyEntry,
  QualityShiftMap,
  DefectMasterItem,
  hasMeaningfulData,
} from '../../services/qualityRepository';

const C = {
  border: '#e2e8f0',
  // Light grey/blue-grey table-cell borders shared by both tables — clearly
  // visible grid without being too dark.
  tableBorder: '#cbd5e1',
  // Column-header highlight: light blue row with navy text (both tables).
  headerBg: '#dbeafe',
  headerText: '#1e3a8a',
  textMain: '#0f172a',
  textMuted: '#64748b',
  white: '#ffffff',
  blueActive: '#2563eb',
  blueHover: '#1e40af',
  lightGray: '#f1f5f9',
};

const MACHINE_NOS = [1, 2, 3, 4];

/** Subtle per-machine indicator colors for the numbered card badges. */
const MACHINE_INDICATOR_COLORS = ['#2563EB', '#2563EB', '#2563EB', '#2563EB'];

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

const NUMBERING_COLUMNS = [
  'Job Name', 'Pack Type', 'Shift', 'Time', 'Pcs/Pack', 'Cartons', 'Bottle',
  'Defects', 'Mould', 'SECTION', 'Checker Name',
  'Remarks',
];

/** Numbering table: column min-widths for the header cells. */
const NUMBERING_COL_WIDTHS: Record<string, string> = {
  'Job Name': '160px',
  'Pack Type': '70px',
  'Shift': '60px',
  'Time': '70px',
  'Pcs/Pack': '60px',
  'Cartons': '60px',
  'Bottle': '75px',
  'Defects': '200px',
  'Mould': '70px',
  'SECTION': '70px',
  'Checker Name': '110px',
  'Remarks': '160px',
};

/** Numbering table: percentage widths so the table fills all available
 *  horizontal space (sums to 100.0%). */
const NUMBERING_COL_PERCENTS: Record<string, string> = {
  'Job Name': '13.0%',
  'Pack Type': '6.0%',
  'Shift': '5.0%',
  'Time': '8%',
  'Pcs/Pack': '5.0%',
  'Cartons': '5.0%',
  'Defective Bottles': '7.5%',
  'Defects': '18.0%',
  'Mould': '5.5%',
  'SECTION': '5.5%',
  'Checker Name': '8.5%',
  'Remarks': '13%',
};

/** Numbering table: 0-based column indices that end a visual section
 *  (Production Details after 'Defective Bottles' (6), Defect Details after 'SECTION' (9)). */
const NUMBERING_SECTION_ENDS = new Set([6, 9]);
const NUMBERING_SECTION_DIVIDER = '2px solid #cbd5e1';

const SQC_COLUMNS = [
  'Job Name', 'Shift', 'Time', 'Pack Type', 'Lot No.', 'Pcs/Pack', 'Cartons',
  'Bottle', 'Defects', 'Mould', 'Section', 'Checker Name',
  'Remarks',
];

/** SQC/QC HOLD table: percentage widths so the table fills all available
 *  horizontal space (sums to 100.0%). */
const SQC_COL_PERCENTS: Record<string, string> = {
  'Shift': '5.0%',
  'Time': '8%',
  'Job Name': '13.0%',
  'Pack Type': '5.5%',
  'Lot No.': '5.5%',
  'Pcs/Pack': '5.0%',
  'Cartons': '5.0%',
  'Defective Bottles': '7.0%',
  'Defects': '16.0%',
  'Mould': '5.5%',
  'Section': '5.5%',
  'Checker Name': '7.5%',
  'Remarks': '11.5%',
};

/** SQC/QC HOLD table: pixel minimums for the header cells. */
const SQC_COL_WIDTHS: Record<string, string> = {
  'Shift': '60px',
  'Time': '70px',
  'Job Name': '160px',
  'Pack Type': '70px',
  'Lot No.': '70px',
  'Pcs/Pack': '60px',
  'Cartons': '60px',
  'Bottle': '75px',
  'Defects': '190px',
  'Mould': '70px',
  'Section': '70px',
  'Checker Name': '110px',
  'Remarks': '160px',
};

/** SQC/QC HOLD: 0-based column indices that end a visual section (after 'Bottle' (7) and 'Section' (10)). */
const SQC_SECTION_ENDS = new Set([7, 10]);

/** Minimum rendered table width — below it the card body scrolls horizontally. */
const TABLE_MIN_WIDTH_NUMBERING = '1170px';
const TABLE_MIN_WIDTH_SQC = '1240px';
const TABLE_MIN_WIDTH = '1220px';

// ─── Shift-based 12-hour time windows for the TIME column picker ────────────
/** Valid (hour, AM/PM) pairs per shift. Within a shift each hour pairs with
 *  exactly one period, so the picker can never assemble an out-of-shift time:
 *  Shift 1: 7:00 AM - 3:00 PM · Shift 2: 4:00 PM - 11:00 PM · Shift 3:
 *  12:00 AM - 6:00 AM. */
const SHIFT_TIME_RANGES: Record<string, { hour: number; period: 'AM' | 'PM' }[]> = {
  '1': [
    { hour: 7, period: 'AM' }, { hour: 8, period: 'AM' }, { hour: 9, period: 'AM' },
    { hour: 10, period: 'AM' }, { hour: 11, period: 'AM' }, { hour: 12, period: 'PM' },
    { hour: 1, period: 'PM' }, { hour: 2, period: 'PM' }, { hour: 3, period: 'PM' },
  ],
  '2': [
    { hour: 4, period: 'PM' }, { hour: 5, period: 'PM' }, { hour: 6, period: 'PM' },
    { hour: 7, period: 'PM' }, { hour: 8, period: 'PM' }, { hour: 9, period: 'PM' },
    { hour: 10, period: 'PM' }, { hour: 11, period: 'PM' },
  ],
  '3': [
    { hour: 12, period: 'AM' }, { hour: 1, period: 'AM' }, { hour: 2, period: 'AM' },
    { hour: 3, period: 'AM' }, { hour: 4, period: 'AM' }, { hour: 5, period: 'AM' },
    { hour: 6, period: 'AM' },
  ],
};

/** All minutes 00-59 for the minute selector. */
const ALL_MINUTES = Array.from({ length: 60 }, (_, i) => i);

const EMPTY_DAY: QualityDayHourly = {};

/** Numbering table inputs: no rounded inner borders, transparent fill so the
 *  table's continuous grid borders read as the cell boundaries. */
const NUMBERING_INPUT_STYLE: React.CSSProperties = {
  borderRadius: 0,
  border: '1px solid transparent',
  backgroundColor: 'transparent',
};

// SQC/QC HOLD uses the same continuous-grid treatment as Numbering: inputs
// remain fully functional, while the table itself provides the visual borders.
const SQC_INPUT_STYLE = NUMBERING_INPUT_STYLE;

// ─── Production-day timeline (same canonical labels as the HRP) ─────────────
/** Canonical production-day order (9 AM → 8 AM) — used for run detection only. */
const PRODUCTION_TIMES: { time: string; shift_id: number }[] = [
  { time: '9:00 AM', shift_id: 1 }, { time: '10:00 AM', shift_id: 1 },
  { time: '11:00 AM', shift_id: 1 }, { time: '12:00 PM', shift_id: 1 },
  { time: '1:00 PM', shift_id: 1 }, { time: '2:00 PM', shift_id: 1 },
  { time: '3:00 PM', shift_id: 1 }, { time: '4:00 PM', shift_id: 1 },
  { time: '5:00 PM', shift_id: 2 }, { time: '6:00 PM', shift_id: 2 },
  { time: '7:00 PM', shift_id: 2 }, { time: '8:00 PM', shift_id: 2 },
  { time: '9:00 PM', shift_id: 2 }, { time: '10:00 PM', shift_id: 2 },
  { time: '11:00 PM', shift_id: 2 }, { time: '12:00 AM', shift_id: 2 },
  { time: '1:00 AM', shift_id: 3 }, { time: '2:00 AM', shift_id: 3 },
  { time: '3:00 AM', shift_id: 3 }, { time: '4:00 AM', shift_id: 3 },
  { time: '5:00 AM', shift_id: 3 }, { time: '6:00 AM', shift_id: 3 },
  { time: '7:00 AM', shift_id: 3 }, { time: '8:00 AM', shift_id: 3 },
];

const parseReportLabelToMinutes = (label: string): number | null => {
  // Primary: 24-hour format "HH:mm" (e.g. "15:30").
  const m24 = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(label);
  if (m24) {
    let h = parseInt(m24[1], 10);
    const mins = parseInt(m24[2], 10);
    if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
    return h * 60 + mins;
  }
  // Backward compatibility: 12-hour format "h:mm AM/PM" (e.g. "3:30 PM")
  // for existing data keys stored in the legacy convention.
  const m12 = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(label);
  if (!m12) return null;
  let h = parseInt(m12[1], 10);
  const mins = parseInt(m12[2], 10);
  const ap = m12[3].toUpperCase();
  if (h < 1 || h > 12 || mins < 0 || mins > 59) return null;
  if (ap === 'AM') {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }
  return h * 60 + mins;
};

/** Minutes since the 9 AM production-day start (9 AM = 0 … 8:59 AM next day). */
const toReportTimelineMinutes = (label: string): number | null => {
  const mins = parseReportLabelToMinutes(label);
  if (mins === null) return null;
  const nineAM = 9 * 60;
  return mins < nineAM ? mins + 24 * 60 - nineAM : mins - nineAM;
};

/** All keys in production-timeline order: the 24 hourly labels plus any split labels present. */
const getReportOrderedKeys = (byTime: Record<string, QualityHourlyEntry | undefined>): string[] => {
  const keys = new Set<string>(PRODUCTION_TIMES.map((pt) => pt.time));
  for (const k of Object.keys(byTime ?? {})) keys.add(k);
  const list = [...keys];
  list.sort((a, b) => {
    const ta = toReportTimelineMinutes(a);
    const tb = toReportTimelineMinutes(b);
    if (ta === null && tb === null) return a.localeCompare(b);
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
  return list;
};

/** Shift of one key: hourly slots keep their own; splits inherit their parent hour's shift. */
const shiftIdForReportKey = (key: string): number => {
  const direct = PRODUCTION_TIMES.find((pt) => pt.time === key);
  if (direct) return direct.shift_id;
  const tOwn = toReportTimelineMinutes(key);
  let shiftId = 1;
  for (const pt of PRODUCTION_TIMES) {
    const tPt = toReportTimelineMinutes(pt.time);
    if (tPt !== null && tOwn !== null && tPt <= tOwn) shiftId = pt.shift_id;
    else break;
  }
  return shiftId;
};

// ─── Machine + bottle/job runs (identical to AllMachineReport / DailyMcSpeedWeightReport) ──
const entryBottle = (e: QualityHourlyEntry | undefined): string => String(e?.bottle_id ?? '').trim();
const entryJob = (e: QualityHourlyEntry | undefined): string => String(e?.job_id ?? '').trim();

const bottleNameFor = (bottleId: string, bottles: { id: string; name: string }[]): string => {
  const id = String(bottleId ?? '').trim();
  if (!id) return '';
  const hit = bottles.find((b) => String(b.id ?? '').trim() === id);
  return hit?.name?.trim() || id;
};

interface HourPoint {
  slot: { time: string; shift_id: number };
  entry: QualityHourlyEntry;
}

interface JobRun {
  machineNo: number;
  runIndex: number;
  bottleId: string;
  jobId: string;
  runKey: string;
  points: HourPoint[];
}

/**
 * Bottle identity of every point, with the long-standing gap-closing passes so
 * a record with production but no bottle joins the run it physically sits in
 * (previous run, or the next one when it comes first) instead of splitting an
 * otherwise continuous run.
 */
const runKeysFor = (points: HourPoint[]): string[] => {
  const keys = points.map((p) => {
    const bottle = entryBottle(p.entry);
    return bottle ? `b:${bottle}` : '';
  });
  let inherited = '';
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]) inherited = keys[i];
    else keys[i] = inherited;
  }
  inherited = '';
  for (let i = keys.length - 1; i >= 0; i--) {
    if (keys[i]) inherited = keys[i];
    else keys[i] = inherited;
  }
  return keys;
};

/**
 * One entry per continuous same-bottle run — same split as the Machine Wise
 * Production and Efficiency report's date-wise job selection: a job that runs
 * all day yields a single run, a mid-day job change starts a new run, and
 * distinct jobs are never merged. Empty hours never break a run because they
 * are not part of the sequence.
 */
const splitMachineRuns = (
  machineNo: number,
  byTime: Record<string, QualityHourlyEntry>
): JobRun[] => {
  const ordered = getReportOrderedKeys(byTime);
  const points: HourPoint[] = [];
  for (const key of ordered) {
    const entry = byTime[key];
    if (!hasMeaningfulData(entry)) continue;
    points.push({
      slot: { time: key, shift_id: shiftIdForReportKey(key) },
      entry: entry as QualityHourlyEntry,
    });
  }
  // No records at all for this machine: a single empty run keeps the machine
  // on the report (rendered as its empty-state row).
  if (points.length === 0) {
    return [{ machineNo, runIndex: 0, bottleId: '', jobId: '', runKey: '', points: [] }];
  }
  const keys = runKeysFor(points);
  const runs: JobRun[] = [];
  let currentKey: string | null = null;
  for (let i = 0; i < points.length; i++) {
    if (runs.length === 0 || keys[i] !== currentKey) {
      currentKey = keys[i];
      // The run's extent, needed before looking up its bottle: the first record
      // of a run may itself be the unlabelled one that only inherited this run's
      // key, and the search for the bottle must never cross into the next run.
      let end = i;
      while (end < points.length && keys[end] === currentKey) end++;
      let bottleId = '';
      let jobId = '';
      for (let j = i; j < end && !bottleId; j++) {
        bottleId = entryBottle(points[j].entry);
        if (bottleId) jobId = entryJob(points[j].entry);
      }
      runs.push({
        machineNo,
        runIndex: runs.length,
        bottleId,
        jobId,
        runKey: keys[i],
        points: points.slice(i, end),
      });
      i = end - 1;
    }
  }
  return runs;
};

/**
 * "07:40 - 16:00" — the run's ACTUAL production interval, read from the
 * first row's saved period start and the last row's period end (falling back
 * to the plain hourly labels when a row carries no period).
 */
const runIntervalLabel = (run: JobRun): string => {
  const first = run.points[0];
  const last = run.points[run.points.length - 1];
  if (!first || !last) return '';
  const start = String(first.entry.period_start ?? '').trim() || first.slot.time;
  const end = String(last.entry.period_end ?? '').trim() || last.slot.time;
  if (start && end && start !== end) return `${start} - ${end}`;
  return end || start;
};

// ─── ERP grid cell inputs (compact card styling, uniform heights) ───────────
const CELL_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  height: '26px',
  boxSizing: 'border-box',
  padding: '2px 4px',
  fontSize: '12px',
  fontWeight: 600,
  lineHeight: 1.3,
  backgroundColor: 'transparent',
  border: '1px solid transparent',
  borderRadius: '0px',
  outline: 'none',
  transition: 'background-color 0.15s ease, box-shadow 0.15s ease',
};

const focusCellBorder = (
  e: React.FocusEvent<HTMLElement>,
  focused: boolean
) => {
  e.currentTarget.style.backgroundColor = focused ? '#eff6ff' : 'transparent';
  e.currentTarget.style.boxShadow = focused ? 'inset 0 0 0 1.5px #2563eb' : 'none';
};

/** Editable text cell — left-aligned for names, centered otherwise. */
const CellTextInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  align?: 'left' | 'center';
  placeholder?: string;
  style?: React.CSSProperties;
}> = ({ value, onChange, align = 'center', placeholder, style }) => (
  <input
    type="text"
    value={value}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
    onFocus={(e) => focusCellBorder(e, true)}
    onBlur={(e) => focusCellBorder(e, false)}
    style={{
      ...CELL_INPUT_STYLE,
      color: value ? C.textMain : '#94a3b8',
      textAlign: align,
      cursor: 'text',
      ...(style ?? {}),
    }}
  />
);

/** Editable numeric cell — same typing-only behaviour as the HRP NumInput. */
const CellNumInput: React.FC<{ value: string; onChange: (v: string) => void; style?: React.CSSProperties }> = ({ value, onChange, style }) => {
  // ArrowUp / ArrowDown are the native step keys of <input type="number">: the
  // browser silently changes the value (and fires onChange) with no typing at
  // all. A production cell must only ever change by typing, so both keys are
  // swallowed here and the value is left exactly as entered.
  const blockArrowStep = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
  };
  return (
    <input
      type="number"
      min="0"
      value={value}
      onKeyDown={blockArrowStep}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => focusCellBorder(e, true)}
      onBlur={(e) => focusCellBorder(e, false)}
      style={
        {
          ...CELL_INPUT_STYLE,
          color: value ? C.textMain : '#94a3b8',
          textAlign: 'center',
          cursor: 'text',
          MozAppearance: 'textfield',
          ...(style ?? {}),
        } as React.CSSProperties
      }
    />
  );
};

/** Editable shift dropdown — prefilled from the run's production shift. */
const CellShiftSelect: React.FC<{ value: string; onChange: (v: string) => void; style?: React.CSSProperties }> = ({ value, onChange, style }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    onFocus={(e) => focusCellBorder(e, true)}
    onBlur={(e) => focusCellBorder(e, false)}
    style={{
      ...CELL_INPUT_STYLE,
      padding: '2px 4px',
      color: value ? C.textMain : '#94a3b8',
      textAlign: 'center',
      textAlignLast: 'center',
      cursor: 'pointer',
      appearance: 'auto',
      ...(style ?? {}),
    }}
  >
    <option value="1">Shift 1</option>
    <option value="2">Shift 2</option>
    <option value="3">Shift 3</option>
  </select>
);

const PackTypeCell: React.FC<{
  value: string;
  onChange: (v: string) => void;
  machineNo: number;
  packingTypes: string[];
  style?: React.CSSProperties;
}> = ({ value, onChange, machineNo, packingTypes, style }) => {
  const options = useMemo(() => {
    const set = new Set(packingTypes);
    if (value && value.trim()) set.add(value.trim());
    return Array.from(set).sort();
  }, [packingTypes, value]);

  if (options.length === 0) {
    return <CellTextInput value={value} onChange={onChange} style={style} />;
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => focusCellBorder(e, true)}
      onBlur={(e) => focusCellBorder(e, false)}
      style={{
        ...CELL_INPUT_STYLE,
        padding: '2px 4px',
        color: value ? C.textMain : '#94a3b8',
        textAlign: 'center',
        textAlignLast: 'center',
        cursor: 'pointer',
        appearance: 'auto',
        fontSize: '11.5px',
        ...(style ?? {}),
      }}
    >
      <option value="">Select</option>
      {options.map((cat) => (
        <option key={cat} value={cat}>{cat}</option>
      ))}
    </select>
  );
};


// ─── Defect Styles & Dropdown (mirrors Quality Module) ──────────────────────
const GROUP_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  Critical: { color: '#be123c', bg: '#fff1f2', border: '#fecdd3' },
  Major: { color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  Minor: { color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
};

/**
 * Defects dropdown popover: rendered through a portal to document.body.
 * Overlays the page without affecting row height, column widths, or machine cards.
 * Flips upward when close to the bottom of the viewport and closes on outside click or Escape.
 */
const DefectDropdown: React.FC<{
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  selected: string[];
  onChange: (v: string[]) => void;
  defectGroups: { group: 'Critical' | 'Major' | 'Minor'; items: string[] }[];
  isLoading?: boolean;
  disabled?: boolean;
}> = ({ isOpen, onToggle, selected, onChange, defectGroups, isLoading = false, disabled = false }) => {
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
    flip: boolean;
  }>({ left: 0, width: 280, maxHeight: 320, flip: false });

  // Update floating popover coordinates anchored to the trigger cell
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      onToggle(false);
      return;
    }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flip = spaceBelow < 330 && spaceAbove > spaceBelow;
    const popoverWidth = 280;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8));
    const maxHeight = Math.min(320, Math.max(160, flip ? spaceAbove - 16 : spaceBelow - 16));

    setCoords({
      top: flip ? undefined : rect.bottom + 4,
      bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
      left,
      width: popoverWidth,
      maxHeight,
      flip,
    });
  }, [onToggle]);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      return;
    }
    updatePosition();
    const handleScroll = (e: Event) => {
      // Ignore scroll events from within the popover's internal defect list
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) {
        return;
      }
      updatePosition();
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, updatePosition]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(target)) return;
      if (popoverRef.current && popoverRef.current.contains(target)) return;
      onToggle(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onToggle]);

  const toggleItem = (item: string) => {
    if (disabled) return;
    onChange(selected.includes(item) ? selected.filter((x) => x !== item) : [...selected, item]);
  };

  const q = search.toLowerCase();
  const filtered = defectGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((d) => d.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);

  const MAX_TAGS = 2;
  const visible = selected.slice(0, MAX_TAGS);
  const extra = selected.length - MAX_TAGS;

  return (
    <div style={{ position: 'relative', width: '100%', minWidth: '150px' }}>
      {/* Trigger: Fixed height and nowrap so opening/closing never shifts row height or column widths */}
      <div
        ref={triggerRef}
        onClick={() => {
          if (!disabled) onToggle(!isOpen);
        }}
        title={selected.length > 0 ? selected.join(', ') : (isLoading ? 'Loading defects...' : 'Click to select defects')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          height: '24px',
          minHeight: '24px',
          maxHeight: '24px',
          padding: '1px 5px',
          border: `1px solid ${isOpen ? '#2563eb' : '#cbd5e1'}`,
          borderRadius: '4px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          backgroundColor: '#ffffff',
          boxShadow: isOpen ? '0 0 0 2px #dbeafe' : 'none',
          transition: 'border-color 0.15s',
          boxSizing: 'border-box',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {selected.length === 0 ? (
          <span style={{ fontSize: '11px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isLoading ? 'Loading defects...' : 'Select defects'}
          </span>
        ) : (
          <>
            {visible.map((d) => {
              const grp = defectGroups.find((g) => g.items.includes(d))?.group ?? 'Minor';
              const s = GROUP_STYLE[grp] ?? GROUP_STYLE.Minor;
              return (
                <span
                  key={d}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '2px',
                    backgroundColor: s.bg,
                    color: s.color,
                    border: `1px solid ${s.border}`,
                    borderRadius: '3px',
                    padding: '0 4px',
                    fontSize: '10px',
                    fontWeight: 500,
                    lineHeight: '18px',
                    height: '18px',
                    maxWidth: '75px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                  title={d}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d}</span>
                  <span
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      toggleItem(d);
                    }}
                    style={{ cursor: 'pointer', lineHeight: 1, opacity: 0.7, fontSize: '11px', marginLeft: '1px' }}
                  >
                    ×
                  </span>
                </span>
              );
            })}
            {extra > 0 && (
              <span
                style={{
                  fontSize: '9.5px',
                  color: '#2563eb',
                  fontWeight: 600,
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: '3px',
                  padding: '0 4px',
                  lineHeight: '18px',
                  height: '18px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                +{extra} more
              </span>
            )}
          </>
        )}
        <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: '10px', paddingLeft: '4px', flexShrink: 0 }}>▾</span>
      </div>

      {/* Floating Popover rendered through Portal to document.body */}
      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              top: coords.top !== undefined ? `${coords.top}px` : 'auto',
              bottom: coords.bottom !== undefined ? `${coords.bottom}px` : 'auto',
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              maxHeight: `${coords.maxHeight}px`,
              zIndex: 99999,
              backgroundColor: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: '7px',
              boxShadow: '0 12px 32px rgba(15, 23, 42, 0.2), 0 2px 6px rgba(0, 0, 0, 0.08)',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search defects..."
                style={{
                  width: '100%',
                  padding: '5px 8px',
                  fontSize: '12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: '5px',
                  outline: 'none',
                  color: '#1e293b',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {filtered.length === 0 && (
                <div style={{ padding: '14px', textAlign: 'center', fontSize: '12px', color: '#94a3b8' }}>
                  {isLoading ? 'Loading defects...' : 'No defects found'}
                </div>
              )}
              {filtered.map((g) => {
                const s = GROUP_STYLE[g.group];
                return (
                  <div key={g.group}>
                    <div
                      style={{
                        padding: '5px 10px 3px',
                        fontSize: '10px',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: s.color,
                        backgroundColor: s.bg,
                        borderTop: `1px solid ${s.border}`,
                        position: 'sticky',
                        top: 0,
                        zIndex: 1,
                      }}
                    >
                      {g.group} · {g.items.length}
                    </div>
                    {g.items.map((item) => {
                      const checked = selected.includes(item);
                      return (
                        <label
                          key={item}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '5px 12px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            color: '#1e293b',
                            backgroundColor: checked ? '#f8faff' : 'transparent',
                            transition: 'background-color 0.1s',
                          }}
                          onMouseEnter={(e) => {
                            if (!checked) e.currentTarget.style.backgroundColor = '#f8fafc';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = checked ? '#f8faff' : 'transparent';
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleItem(item)}
                            style={{ accentColor: '#2563eb', width: '13px', height: '13px', flexShrink: 0 }}
                          />
                          {item}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div
              style={{
                padding: '6px 10px',
                borderTop: '1px solid #f1f5f9',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexShrink: 0,
                backgroundColor: '#ffffff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '11px', color: '#64748b' }}>
                  {selected.length} {selected.length === 1 ? 'defect' : 'defects'} selected
                </span>
                {selected.length > 0 && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange([]);
                    }}
                    style={{
                      fontSize: '11px',
                      color: '#dc2626',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '0',
                      fontWeight: 500,
                    }}
                  >
                    Clear all
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => onToggle(false)}
                style={{
                  fontSize: '11px',
                  color: '#ffffff',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '3px 10px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Done
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

/** Cell wrapper for the multi-select DefectDropdown popover. */
const CellDefectsDropdown: React.FC<{
  cellKey: string;
  activeOpenKey: string | null;
  onToggleOpen: (k: string | null) => void;
  value: string;
  onChange: (v: string) => void;
  defectGroups: { group: 'Critical' | 'Major' | 'Minor'; items: string[] }[];
  isLoading?: boolean;
}> = ({ cellKey, activeOpenKey, onToggleOpen, value, onChange, defectGroups, isLoading }) => {
  const isOpen = activeOpenKey === cellKey;
  const selected = useMemo(() => {
    return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  }, [value]);

  const handleChange = (items: string[]) => {
    onChange(items.join(', '));
  };

  const handleToggle = (open: boolean) => {
    onToggleOpen(open ? cellKey : null);
  };

  return (
    <DefectDropdown
      isOpen={isOpen}
      onToggle={handleToggle}
      selected={selected}
      onChange={handleChange}
      defectGroups={defectGroups}
      isLoading={isLoading}
    />
  );
};

// ─── Employee Data Source ───────────────────────────────────────────────────
/**
 * Single source of truth for the employee list used in the Checker Name
 * dropdowns across all Re-Packing Report tables (Remarks is a free-text input).
 *
 * The backend returns employees that are ACTIVE in ``hpr.employee_master``
 * **and** ACTIVE in ``sqc.sqc_role`` together with their ``roles``. Only
 * employees holding the ``CHECKER`` role are offered here, because the chosen
 * name is resolved to ``employee_id`` and stored as
 * ``sqc.repacking_* .checker_id`` (FK -> hpr.employee_master.employee_id).
 */
export const useEmployeeList = (dbEmployees?: EmployeeItem[]): string[] => {
  return useMemo(() => {
    const set = new Set<string>();
    (dbEmployees ?? []).forEach((e) => {
      if (!(e.roles ?? []).includes('CHECKER')) return;
      const name = e.employee_name?.trim();
      if (name) set.add(name);
    });
    return Array.from(set).sort();
  }, [dbEmployees]);
};

/**
 * Dropdown for employee selection (Checker Name and QA-Shift Ex.).
 * Shows only the placeholder plus employee names from the list.
 */
const CellEmployeeSelect: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  align?: 'left' | 'center';
  style?: React.CSSProperties;
}> = ({ value, onChange, options, placeholder = 'Select', align = 'center', style }) => {
  const allOptions = useMemo(() => {
    const set = new Set<string>();
    options.forEach((opt) => {
      const t = opt?.trim();
      if (t) set.add(t);
    });
    if (value && value.trim()) set.add(value.trim());
    return Array.from(set).sort();
  }, [options, value]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => focusCellBorder(e, true)}
      onBlur={(e) => focusCellBorder(e, false)}
      style={{
        ...CELL_INPUT_STYLE,
        padding: '2px 4px',
        color: value ? C.textMain : '#94a3b8',
        textAlign: align,
        textAlignLast: align,
        cursor: 'pointer',
        appearance: 'auto',
        fontSize: '11.5px',
        ...(style ?? {}),
      }}
    >
      <option value="">{placeholder}</option>
      {allOptions.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
};


/**
 * Custom 12-hour time picker for the TIME column.
 * Opens as a dropdown popover (portal to document.body) anchored to the trigger
 * cell, so opening/closing never shifts row height or column widths.
 * Three separate selectors: Hour, Minute, AM/PM. Hours are restricted to the
 * cell's selected shift (Shift 1: 7 AM-3 PM · Shift 2: 4 PM-11 PM · Shift 3:
 * 12 AM-6 AM), so an out-of-shift time can never be assembled. Confirm writes
 * the time back to the cell's editable value; no time is hardcoded as a default.
 */
const CellTimePicker: React.FC<{
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  value: string;
  shift: string;
  onConfirm: (time: string) => void;
}> = ({ isOpen, onToggle, value, shift, onConfirm }) => {
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
    flip: boolean;
  }>({ left: 0, width: 210, maxHeight: 220, flip: false });

  const allowed = SHIFT_TIME_RANGES[shift ?? '1'] ?? SHIFT_TIME_RANGES['1'];
  const distinctHours = useMemo(() => {
    const seen = new Set<number>();
    return allowed.filter((a) => !seen.has(a.hour) && !!seen.add(a.hour)).map((a) => a.hour);
  }, [allowed]);

  const periodsFor = (h: number): ('AM' | 'PM')[] =>
    allowed.filter((a) => a.hour === h).map((a) => a.period);

  const parseCellTime = (v: string): { hour: number; minute: number; period: 'AM' | 'PM' } | null => {
    // 12-hour format "h:mm AM/PM" (e.g. "7:00 AM").
    const m12 = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(v);
    if (m12) {
      const h = parseInt(m12[1], 10);
      const mins = parseInt(m12[2], 10);
      if (h < 1 || h > 12 || mins < 0 || mins > 59) return null;
      return { hour: h, minute: mins, period: m12[3].toUpperCase() as 'AM' | 'PM' };
    }
    // Legacy 24-hour "HH:mm" (e.g. "15:00").
    const m24 = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
    if (m24) {
      const h = parseInt(m24[1], 10);
      const mins = parseInt(m24[2], 10);
      if (h < 0 || h > 23 || mins < 0 || mins > 59) return null;
      return { hour: h % 12 || 12, minute: mins, period: h < 12 ? 'AM' : 'PM' };
    }
    return null;
  };

  const buildSelection = (): { hour: number; minute: number; period: 'AM' | 'PM' } | null => {
    const p = parseCellTime(value);
    return p && allowed.some((a) => a.hour === p.hour && a.period === p.period) ? p : null;
  };

  const init = buildSelection();
  const defaultHour = distinctHours[0] ?? null;
  const [hour, setHour] = useState<number | null>(init?.hour ?? defaultHour);
  const [minute, setMinute] = useState<number | null>(init?.minute ?? 0);
  const [period, setPeriod] = useState<'AM' | 'PM' | null>(
    init?.period ?? (defaultHour != null ? periodsFor(defaultHour)[0] ?? null : null)
  );

  const isReady = hour != null && minute != null && period != null;

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      onToggle(false);
      return;
    }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const flip = spaceBelow < 300 && spaceAbove > spaceBelow;
    const width = 210;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setCoords({
      top: flip ? undefined : rect.bottom + 4,
      bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
      left,
      width,
      maxHeight: Math.min(260, Math.max(140, flip ? spaceAbove - 16 : spaceBelow - 16)),
      flip,
    });
  }, [onToggle]);

  // (Re)initialize the picker's working selection from the cell's saved time
  // whenever the picker opens or the shift/time changes. Nothing is pre-filled
  // when the cell has no valid saved time.
  useEffect(() => {
    if (!isOpen) return;
    const sel = buildSelection();
    // Only override the working selection when the cell's saved time is valid
    // for the current shift. Otherwise keep the in-shift defaults (first
    // allowed hour, :00, first valid period) so the dropdowns are never blank.
    if (sel) {
      setHour(sel.hour);
      setMinute(sel.minute);
      setPeriod(sel.period);
    }
    updatePosition();
    const handleScroll = () => updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, value, allowed, updatePosition, onToggle]);

  // Keep AM/PM consistent with the chosen hour within the shift.
  useEffect(() => {
    if (hour === null || period === null) return;
    if (!allowed.some((a) => a.hour === hour && a.period === period)) {
      const valid = periodsFor(hour);
      if (valid.length) setPeriod(valid[0]);
    }
  }, [hour, period, allowed]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(target)) return;
      if (popoverRef.current && popoverRef.current.contains(target)) return;
      onToggle(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onToggle(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onToggle]);

  const handleConfirm = () => {
    if (!isReady) return;
    onConfirm(`${hour}:${pad(minute)} ${period}`);
    onToggle(false);
  };

  const rangeLabel = `${allowed[0].hour}:00 ${allowed[0].period} - ${allowed[allowed.length - 1].hour}:00 ${allowed[allowed.length - 1].period}`;

  const pickerSelectStyle: React.CSSProperties = {
    width: 52,
    height: 26,
    fontSize: 12,
    fontWeight: 600,
    backgroundColor: '#ffffff',
    border: '1px solid #cbd5e1',
    borderRadius: '4px',
    color: '#1e293b',
    padding: '0 4px',
    cursor: 'pointer',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        ref={triggerRef}
        onClick={() => onToggle(!isOpen)}
        title={value || 'Click to select time'}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '26px',
          minHeight: '26px',
          padding: '0 24px 0 8px',
          border: `1px solid ${isOpen ? '#2563eb' : '#cbd5e1'}`,
          borderRadius: '4px',
          cursor: 'pointer',
          backgroundColor: '#ffffff',
          boxShadow: isOpen ? '0 0 0 2px #dbeafe' : 'none',
          boxSizing: 'border-box',
          fontSize: '12px',
          color: value ? C.textMain : '#94a3b8',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value || <span style={{ color: '#94a3b8' }}>—</span>}
        </span>
        <span
          style={{
            position: 'absolute',
            right: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#94a3b8',
            fontSize: '11px',
            pointerEvents: 'none',
            flexShrink: 0,
          }}
        >
          ▼
        </span>
      </div>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              top: coords.top !== undefined ? `${coords.top}px` : 'auto',
              bottom: coords.bottom !== undefined ? `${coords.bottom}px` : 'auto',
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              maxHeight: `${coords.maxHeight}px`,
              zIndex: 99999,
              backgroundColor: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: '7px',
              boxShadow: '0 12px 32px rgba(15, 23, 42, 0.2), 0 2px 6px rgba(0, 0, 0, 0.08)',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#64748b',
                  marginBottom: '6px',
                }}
              >
                Shift {shift} · {rangeLabel}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <select
                  value={hour ?? ''}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setHour(Number.isNaN(v) ? null : v);
                  }}
                  style={pickerSelectStyle}
                >
                  {distinctHours.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <select
                  value={minute ?? ''}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setMinute(Number.isNaN(v) ? null : v);
                  }}
                  style={pickerSelectStyle}
                >
                  {ALL_MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {pad(m)}
                    </option>
                  ))}
                </select>
                <select
                  value={period ?? ''}
                  onChange={(e) => setPeriod(e.target.value as 'AM' | 'PM')}
                  style={pickerSelectStyle}
                >
                  {hour === null ? null : periodsFor(hour).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div
              style={{
                padding: '8px 10px',
                borderTop: '1px solid #f1f5f9',
                display: 'flex',
                justifyContent: 'flex-end',
                flexShrink: 0,
                backgroundColor: '#ffffff',
              }}
            >
              <button
                type="button"
                onClick={handleConfirm}
                disabled={!isReady}
                style={{
                  fontSize: '11.5px',
                  fontWeight: 600,
                  color: '#ffffff',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '3px 10px',
                  cursor: isReady ? 'pointer' : 'not-allowed',
                  opacity: isReady ? 1 : 0.5,
                }}
              >
                Confirm
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};


/**
 * Small (+) row-add button placed right after the Job Name input, matching the
 * Hourly Production Monitor's blue add/split pill (blue text, #eff6ff fill,
 * #bfdbfe border, 4px radius, #dbeafe hover).
 */
const AddRowButton: React.FC<{ onClick: () => void; title: string }> = ({ onClick, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      flexShrink: 0,
      width: '22px',
      height: '26px',
      padding: 0,
      color: '#2563eb',
      backgroundColor: '#eff6ff',
      border: '1px solid #bfdbfe',
      borderRadius: '4px',
      fontSize: '15px',
      fontWeight: 700,
      lineHeight: 1,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background-color 0.15s ease',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#dbeafe'; }}
    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#eff6ff'; }}
  >
    +
  </button>
);

/**
 * Small (-) button next to (+) on MANUALLY ADDED rows — same size, shape and
 * transition as the add pill, in the conventional soft-red remove tint. It
 * removes only the added row; production rows loaded from the Hourly
 * Production Monitor data never show it and can never be removed.
 */
const RemoveRowButton: React.FC<{ onClick: () => void; title: string }> = ({ onClick, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      flexShrink: 0,
      width: '22px',
      height: '26px',
      padding: 0,
      color: '#dc2626',
      backgroundColor: '#fef2f2',
      border: '1px solid #fecaca',
      borderRadius: '4px',
      fontSize: '15px',
      fontWeight: 700,
      lineHeight: 1,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background-color 0.15s ease',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fee2e2'; }}
    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#fef2f2'; }}
  >
    −
  </button>
);

/** Compact table-header cell style — bold navy uppercase labels on a light blue strip. */
const thStyle = (minWidth?: string): React.CSSProperties => ({
  padding: '6px 8px',
  color: C.headerText,
  fontWeight: 700,
  fontSize: '10.5px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  border: `1px solid ${C.tableBorder}`,
  lineHeight: 1.3,
  verticalAlign: 'middle',
  backgroundColor: C.headerBg,
  whiteSpace: 'nowrap',
  minWidth: minWidth ?? '80px',
});

/** Data-cell <td> style — compact padding with a clean dark grid border. */
const cellTd = (align: 'left' | 'center' = 'center'): React.CSSProperties => ({
  padding: '3px 6px',
  border: `1px solid ${C.tableBorder}`,
  fontSize: '12.5px',
  color: C.textMain,
  textAlign: align,
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
});

const emptyStateTd = (colSpan: number): React.CSSProperties => ({
  padding: '12px',
  textAlign: 'center',
  color: C.textMuted,
  fontSize: '13px',
  border: `1px solid ${C.tableBorder}`,
});

/** Numbering table header cell — dark grid borders, bold labels on the blue header strip. */
const numThStyle = (colIndex: number, total: number, minWidth?: string, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  return {
    padding: '7px 6px',
    color: C.headerText,
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    border: `1px solid ${C.tableBorder}`,
    lineHeight: 1.3,
    verticalAlign: 'middle',
    backgroundColor: C.headerBg,
    whiteSpace: 'nowrap',
    minWidth: minWidth ?? '70px',
    textAlign: align,
    boxSizing: 'border-box',
  };
};

/** Numbering table data cell — dark grid borders, dark semibold values. */
const numCellTd = (colIndex: number, total: number, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  return {
    padding: '3px 4px',
    border: `1px solid ${C.tableBorder}`,
    fontSize: '12px',
    color: C.textMain,
    textAlign: align,
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    height: '32px',
  };
};

/** SQC/QC HOLD header cell — dark grid borders, bold labels on the blue header strip. */
const sqcThStyle = (colIndex: number, total: number, minWidth?: string, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  return {
    padding: '7px 6px',
    color: C.headerText,
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    border: `1px solid ${C.tableBorder}`,
    lineHeight: 1.3,
    verticalAlign: 'middle',
    backgroundColor: C.headerBg,
    whiteSpace: 'nowrap',
    minWidth: minWidth ?? '70px',
    textAlign: align,
    boxSizing: 'border-box',
  };
};

/** SQC/QC HOLD data cell — dark grid borders, dark semibold values. */
const sqcCellTd = (colIndex: number, total: number, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  return {
    padding: '3px 4px',
    border: `1px solid ${C.tableBorder}`,
    fontSize: '12px',
    color: C.textMain,
    textAlign: align,
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    height: '32px',
  };
};

/** Editable cell values of one layout, keyed per date + machine + production run. */
type CellValues = Record<string, string>;
type ValuesStore = Record<string, CellValues>;

/**
 * One manually added row (via the JOB NAME (+) button). `jobName` (and the
 * pre-selected `shift`) are prefilled from the row the user clicked; every
 * other field starts empty and is edited independently like any production row.
 * `anchor` identifies the row this one was created from — `run:<productionRowIdx>`
 * or `x:<addedRowId>` — so it renders IMMEDIATELY BELOW that row, keeping
 * added rows grouped directly under their bottle name.
 */
interface ExtraRow {
  id: number;
  jobName: string;
  shift: string;
  packType: string;
  pcsPack: string;
  time: string;
  anchor: string;
}

/** Manually added rows per layout, keyed `${dateKey}|${machineNo}`. */
type ExtraRowsStore = Record<string, ExtraRow[]>;

/** One rendered table row: a saved database entry, a production run or a manually added row. */
type OrderedRow =
  | { kind: 'db'; dbEntry: RepackingNumberingEntry | RepackingSqcQcHoldEntry; visualIdx: number; rowKey: string }
  | { kind: 'run'; run: JobRun; rowIdx: number; visualIdx: number; rowKey: string }
  | { kind: 'extra'; extra: ExtraRow; visualIdx: number; rowKey: string };

/**
 * Interleaves base rows with manually added rows: every added row renders
 * directly beneath the row its (+) button was clicked on. If saved database
 * records exist, they form the base rows; otherwise detected production runs
 * form the base rows.
 */
const buildOrderedRows = (
  dbEntries: (RepackingNumberingEntry | RepackingSqcQcHoldEntry)[],
  rowRuns: JobRun[],
  extras: ExtraRow[],
  machineNo: number,
  dateKey: string
): OrderedRow[] => {
  const out: OrderedRow[] = [];
  const childrenOf = (anchor: string): ExtraRow[] => extras.filter((e) => e.anchor === anchor);
  const visited = new Set<number>();
  const pushExtraWithChildren = (extra: ExtraRow): void => {
    if (visited.has(extra.id)) return;
    visited.add(extra.id);
    out.push({
      kind: 'extra',
      extra,
      visualIdx: out.length,
      rowKey: `${dateKey}|${machineNo}|x|${extra.id}`,
    });
    for (const child of childrenOf(`x:${extra.id}`)) pushExtraWithChildren(child);
  };

  if (dbEntries && dbEntries.length > 0) {
    dbEntries.forEach((dbEntry) => {
      const anchor = `db:${dbEntry.entry_id}`;
      out.push({
        kind: 'db',
        dbEntry,
        visualIdx: out.length,
        rowKey: anchor,
      });
      for (const extra of childrenOf(anchor)) pushExtraWithChildren(extra);
    });
  } else {
    rowRuns.forEach((run, rowIdx) => {
      const anchor = `run:${rowIdx}`;
      out.push({
        kind: 'run',
        run,
        rowIdx,
        visualIdx: out.length,
        rowKey: `${dateKey}|${machineNo}|${rowIdx}|${run.bottleId || 'job'}|${run.runKey}`,
      });
      for (const extra of childrenOf(anchor)) pushExtraWithChildren(extra);
    });
  }

  for (const extra of extras) {
    if (visited.has(extra.id)) continue;
    visited.add(extra.id);
    out.push({
      kind: 'extra',
      extra,
      visualIdx: out.length,
      rowKey: `${dateKey}|${machineNo}|x|${extra.id}`,
    });
  }
  return out;
};

const RePackingReport: React.FC<{ date: Date; layout?: 'numbering' | 'sqc' }> = ({ date, layout = 'numbering' }) => {
  const { bottles } = useERP();
  const machineNos = MACHINE_NOS;

  const [hourly, setHourly] = useState<QualityDayHourly>({});
  const [shiftAssignments, setShiftAssignments] = useState<QualityShiftMap>({});
  const [defectGroups, setDefectGroups] = useState<{ group: 'Critical' | 'Major' | 'Minor'; items: string[] }[]>([]);
  const [defectList, setDefectList] = useState<DefectMasterItem[]>([]);
  const [loadingDefects, setLoadingDefects] = useState(true);
  const [dbEmployees, setDbEmployees] = useState<EmployeeItem[]>([]);
  const [packagingMasterCodes, setPackagingMasterCodes] = useState<string[]>([]);
  const [savedNumbering, setSavedNumbering] = useState<Record<number, RepackingNumberingEntry[]>>({});
  const [savedSqc, setSavedSqc] = useState<Record<number, RepackingSqcQcHoldEntry[]>>({});
  const [baselineNumbering, setBaselineNumbering] = useState<ValuesStore>({});
  const [baselineSqc, setBaselineSqc] = useState<ValuesStore>({});
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimeoutRef = useRef<number | null>(null);

  // Success Popup Message state
  const [showSuccessPopup, setShowSuccessPopup] = useState(false);
  const [successPopupMsg, setSuccessPopupMsg] = useState('');

  // Single open dropdown tracker: ensures only one Defects popover is open at a time
  const [openDefectCellKey, setOpenDefectCellKey] = useState<string | null>(null);

  // Single open time-picker cell tracker (works alongside the defects tracker
  // above so only one cell dropdown is open at a time).
  const [openTimeCellKey, setOpenTimeCellKey] = useState<string | null>(null);

  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const requestRef = useRef(0);

  // ── Editable per-row values ───
  const [numberingValues, setNumberingValues] = useState<ValuesStore>({});
  const [sqcValues, setSqcValues] = useState<ValuesStore>({});

  // ── Manually added rows ((+) button in the JOB NAME column) ──────────────
  const [numberingExtras, setNumberingExtras] = useState<ExtraRowsStore>({});
  const [sqcExtras, setSqcExtras] = useState<ExtraRowsStore>({});
  const extraIdRef = useRef(0);

  const dateKey = toIso(date);
  const dateLabel = toDisplay(date);

  // Load database employees and packaging masters on mount
  useEffect(() => {
    let active = true;
    repackingRepository
      .getEmployees()
      .then((emps) => {
        if (active && Array.isArray(emps)) setDbEmployees(emps);
      })
      .catch((err) => console.error('Failed to load employees:', err));

    planningRepository
      .getPackagingMasters()
      .then((res) => {
        if (active && res.ok && Array.isArray(res.rows)) {
          const codes = res.rows.map((r) => r.packaging_code).filter(Boolean);
          setPackagingMasterCodes(codes);
        }
      })
      .catch((err) => console.error('Failed to load packaging masters:', err));

    return () => {
      active = false;
    };
  }, []);

  const loadSavedData = useCallback(async (targetKey: string) => {
    try {
      const { numbering, sqc } = await repackingRepository.getRepackingData(targetKey);

      const numMap: Record<number, RepackingNumberingEntry[]> = {};
      const numInitVals: ValuesStore = {};
      const numBase: ValuesStore = {};

      numbering.forEach((entry) => {
        const m = entry.machine_no;
        if (!numMap[m]) numMap[m] = [];
        numMap[m].push(entry);

        const key = `db:${entry.entry_id}`;
        const vals: CellValues = {
          jobName: entry.bottle_name || entry.job_id || '',
          packType: entry.pack_type || '',
          shift: String(entry.shift || 1),
          time: entry.entry_time || '',
          pcsPack: entry.pcs_per_pack != null ? String(entry.pcs_per_pack) : '',
          cartons: entry.cartons != null ? String(entry.cartons) : '',
          noOfBottle: entry.defective_bottles != null ? String(entry.defective_bottles) : '',
          defects: entry.defect_name || '',
          mould: entry.mould || '',
          sectionNo: entry.section_no || '',
          checkerName: entry.checker_name || '',
          // The last column is the free-text Remarks cell (legacy field name
          // ``qaShiftEx``) — it is persisted in sqc.repacking_* .remarks.
          qaShiftEx: entry.remarks || entry.qa_shift_ex_name || '',
        };
        numInitVals[key] = vals;
        numBase[key] = { ...vals };
      });

      setSavedNumbering(numMap);
      setNumberingValues((prev) => ({ ...prev, ...numInitVals }));
      setBaselineNumbering((prev) => ({ ...prev, ...numBase }));

      const sqcMap: Record<number, RepackingSqcQcHoldEntry[]> = {};
      const sqcInitVals: ValuesStore = {};
      const sqcBase: ValuesStore = {};

      sqc.forEach((entry) => {
        const m = entry.machine_no;
        if (!sqcMap[m]) sqcMap[m] = [];
        sqcMap[m].push(entry);

        const key = `db:${entry.entry_id}`;
        const vals: CellValues = {
          jobName: entry.bottle_name || entry.job_id || '',
          packType: entry.pack_type || '',
          lotNo: entry.lot_no || '',
          shift: String(entry.shift || 1),
          time: entry.entry_time || '',
          pcsPack: entry.pcs_per_pack != null ? String(entry.pcs_per_pack) : '',
          cartons: entry.cartons != null ? String(entry.cartons) : '',
          noOfBottle: entry.defective_bottles != null ? String(entry.defective_bottles) : '',
          defects: entry.defect_name || '',
          mould: entry.mould || '',
          section: entry.section_no || '',
          sectionNo: entry.section_no || '',
          checkerName: entry.checker_name || '',
          // Free-text Remarks cell (legacy field name ``qaShiftEx``).
          qaShiftEx: entry.remarks || entry.qa_shift_ex_name || '',
        };
        sqcInitVals[key] = vals;
        sqcBase[key] = { ...vals };
      });

      setSavedSqc(sqcMap);
      setSqcValues((prev) => ({ ...prev, ...sqcInitVals }));
      setBaselineSqc((prev) => ({ ...prev, ...sqcBase }));
    } catch (err) {
      console.error('Failed to load saved repacking data:', err);
    }
  }, []);

  const loadDay = useCallback(async (targetKey: string) => {
    const token = (requestRef.current += 1);
    setLoading(true);
    try {
      const { hourly: day, shifts: dayShifts, ok, error } = await qualityRepository.load(targetKey);
      if (token !== requestRef.current) return;
      setLoading(false);
      if (ok === false) {
        setLoadError(error || 'Could not load saved data.');
        setLoadedKey(targetKey);
        setHourly({});
        setShiftAssignments({});
        return;
      }
      setLoadError('');
      setLoadedKey(targetKey);
      setHourly(day ?? {});
      setShiftAssignments(dayShifts ?? {});
    } catch (err) {
      if (token !== requestRef.current) return;
      setLoading(false);
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load saved data.');
      setLoadedKey(targetKey);
      setHourly({});
      setShiftAssignments({});
    }
  }, []);

  useEffect(() => {
    void loadDay(dateKey);
    void loadSavedData(dateKey);
    return () => {
      requestRef.current += 1;
    };
  }, [dateKey, loadDay, loadSavedData]);

  useEffect(() => {
    let active = true;
    qualityRepository
      .getDefects(true)
      .then((defects) => {
        if (!active) return;
        setDefectList(defects);
        const groups: { group: 'Critical' | 'Major' | 'Minor'; items: string[] }[] = (
          ['Critical', 'Major', 'Minor'] as const
        ).map((grp) => ({
          group: grp,
          items: defects
            .filter((d) => d.defect_type === grp)
            .sort((a, b) => a.defect_sr - b.defect_sr)
            .map((d) => d.defect_name),
        }));
        setDefectGroups(groups);
        setLoadingDefects(false);
      })
      .catch(() => {
        if (!active) return;
        setLoadingDefects(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const employeeList = useEmployeeList(dbEmployees);

  const dayHourly: QualityDayHourly = loadedKey === dateKey ? hourly : EMPTY_DAY;

  const packingTypesPerMachine = useMemo(() => {
    const out: Record<number, string[]> = {};
    for (const machineNo of MACHINE_NOS) {
      const entries = dayHourly[String(machineNo)] ?? {};
      const types = new Set<string>();
      for (const entry of Object.values(entries)) {
        if (entry.packing_category && entry.packing_category.length > 0) {
          entry.packing_category.forEach((cat: string) => types.add(cat));
        }
      }
      out[machineNo] = [...types].sort();
    }
    return out;
  }, [dayHourly]);

  /**
   * All unique Pack Types (packing_category) reported in the Hourly Production
   * Report for each machine + Job ID on the selected date. The Pack Type
   * dropdown shows only these job-specific options — never the full master
   * list or unrelated packing types.
   */
  const machineJobPackTypes = useMemo<Record<number, Record<string, string[]>>>(
    () => {
      const out: Record<number, Record<string, string[]>> = {};
      for (const machineNo of MACHINE_NOS) {
        const byTime = dayHourly[String(machineNo)] ?? {};
        const map: Record<string, string[]> = {};
        for (const entry of Object.values(byTime)) {
          const jobId = String(entry.job_id ?? '').trim();
          if (!jobId) continue;
          if (!map[jobId]) map[jobId] = [];
          if (Array.isArray(entry.packing_category)) {
            entry.packing_category.forEach((cat) => {
              if (cat && !map[jobId].includes(cat)) map[jobId].push(cat);
            });
          }
        }
        for (const jobId of Object.keys(map)) {
          map[jobId].sort();
        }
        out[machineNo] = map;
      }
      return out;
    },
    [dayHourly]
  );

  const machineRuns = useMemo<Record<number, JobRun[]>>(() => {
    const out: Record<number, JobRun[]> = {};
    for (const machineNo of MACHINE_NOS) {
      out[machineNo] = splitMachineRuns(machineNo, dayHourly[String(machineNo)] ?? {});
    }
    return out;
  }, [dayHourly]);

  /**
   * Pack Type (packing_category) and Pack Size / Pcs-Per-Pack (packing_size)
   * read from the loaded production report (hourly_production), keyed per
   * machine and Job ID. Maps each job to all of its available pack types and
   * the corresponding pcs/pack value for each type.
   *
   * Structure: machineNo → jobId → packType → pcsPack
   */
  const machineJobPackDetails = useMemo<Record<number, Record<string, Record<string, string>>>>(
    () => {
      const out: Record<number, Record<string, Record<string, string>>> = {};
      for (const machineNo of MACHINE_NOS) {
        const byTime = dayHourly[String(machineNo)] ?? {};
        const map: Record<string, Record<string, string>> = {};
        for (const entry of Object.values(byTime)) {
          const jobId = String(entry.job_id ?? '').trim();
          if (!jobId) continue;
          if (!map[jobId]) map[jobId] = {};
          const pcsPack = entry.packing_size != null ? String(entry.packing_size) : '';
          if (Array.isArray(entry.packing_category)) {
            entry.packing_category.forEach((cat) => {
              if (cat && map[jobId][cat] === undefined) {
                map[jobId][cat] = pcsPack;
              }
            });
          } else if (entry.packing_category) {
            const cat = String(entry.packing_category);
            if (map[jobId][cat] === undefined) {
              map[jobId][cat] = pcsPack;
            }
          }
        }
        out[machineNo] = map;
      }
      return out;
    },
    [dayHourly]
  );

  const runJobName = useCallback(
    (run: JobRun): string => bottleNameFor(run.bottleId, bottles),
    [bottles]
  );
  const runShift = (run: JobRun): string => String(run.points[0]?.slot.shift_id ?? 1);
  const runTime = (run: JobRun): string => runIntervalLabel(run);

  const rowKeyFor = (machineNo: number, run: JobRun, rowIndex: number): string =>
    `${dateKey}|${machineNo}|${rowIndex}|${run.bottleId || 'job'}|${run.runKey}`;

  const cellValue = (store: ValuesStore, key: string, field: string, fallback: string): string =>
    store[key]?.[field] ?? fallback;

  /** Production Job ID of a rendered row, used to match its production record. */
  const productionJobIdFor = (row: OrderedRow): string => {
    if (row.kind === 'db') return String((row.dbEntry as { job_id: string }).job_id ?? '');
    if (row.kind === 'run') return row.run.jobId;
    return row.extra.jobName;
  };

  const setNumberingCell = useCallback((key: string, field: string, value: string) => {
    setNumberingValues((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [field]: value } }));
  }, []);
  const setSqcCell = useCallback((key: string, field: string, value: string) => {
    setSqcValues((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [field]: value } }));
  }, []);

  const extraRowsKey = (machineNo: number): string => `${dateKey}|${machineNo}`;
  const extraRowKey = (machineNo: number, extraId: number): string =>
    `${dateKey}|${machineNo}|x|${extraId}`;

  const addExtraRow = (
    target: 'numbering' | 'sqc',
    machineNo: number,
    anchor: string,
    jobName: string,
    shift: string,
    packType: string,
    pcsPack: string,
    time: string
  ) => {
    const row: ExtraRow = {
      id: (extraIdRef.current += 1),
      jobName,
      shift,
      packType,
      pcsPack,
      time,
      anchor,
    };
    const setter = target === 'numbering' ? setNumberingExtras : setSqcExtras;
    const storeKey = extraRowsKey(machineNo);
    setter((prev) => ({ ...prev, [storeKey]: [...(prev[storeKey] ?? []), row] }));

    // Also initialize the new row's values in the values state so the UI
    // correctly displays the inherited packType and pcsPack for the new entry.
    const valuesKey = `${dateKey}|${machineNo}|x|${row.id}`;
    const valuesSetter = target === 'numbering' ? setNumberingValues : setSqcValues;
    valuesSetter((prev) => ({
      ...prev,
      [valuesKey]: {
        jobName,
        shift,
        packType,
        pcsPack,
        time: time,
        // Other fields will fall back to their defaults/baselines when rendered.
      },
    }));
  };

  const removeExtraRow = (target: 'numbering' | 'sqc', machineNo: number, extraId: number) => {
    const storeKey = extraRowsKey(machineNo);
    const rowKey = extraRowKey(machineNo, extraId);
    const rowsSetter = target === 'numbering' ? setNumberingExtras : setSqcExtras;
    rowsSetter((prev) => {
      const list = prev[storeKey] ?? [];
      const removed = list.find((r) => r.id === extraId);
      if (!removed) return prev;
      const removedAnchor = `x:${extraId}`;
      return {
        ...prev,
        [storeKey]: list
          .filter((r) => r.id !== extraId)
          .map((r) => (r.anchor === removedAnchor ? { ...r, anchor: removed.anchor } : r)),
      };
    });
    const valuesSetter = target === 'numbering' ? setNumberingValues : setSqcValues;
    valuesSetter((prev) => {
      if (!(rowKey in prev)) return prev;
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  };

  const handleDeleteDbRow = async (
    target: 'numbering' | 'sqc',
    machineNo: number,
    entryId: string
  ) => {
    if (!window.confirm('Are you sure you want to delete this saved entry?')) return;
    try {
      const ok =
        target === 'numbering'
          ? await repackingRepository.deleteNumbering(entryId)
          : await repackingRepository.deleteSqcQcHold(entryId);

      if (!ok) {
        alert('Could not delete the entry. Please try again.');
        return;
      }

      const key = `db:${entryId}`;
      if (target === 'numbering') {
        setSavedNumbering((prev) => ({
          ...prev,
          [machineNo]: (prev[machineNo] ?? []).filter((e) => String(e.entry_id) !== entryId),
        }));
        setNumberingValues((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setBaselineNumbering((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } else {
        setSavedSqc((prev) => ({
          ...prev,
          [machineNo]: (prev[machineNo] ?? []).filter((e) => String(e.entry_id) !== entryId),
        }));
        setSqcValues((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setBaselineSqc((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    } catch (err: any) {
      console.error('Delete failed:', err);
      alert(err?.message || 'Failed to delete the entry.');
    }
  };

  const handleSaveClick = async () => {
    if (saveState === 'saving') return;

    try {
      const isNum = layout === 'numbering';
      const valuesStore = isNum ? numberingValues : sqcValues;
      const baselineStore = isNum ? baselineNumbering : baselineSqc;
      const savedEntriesByMachine = isNum ? savedNumbering : savedSqc;

      const inserts: any[] = [];
      const updates: any[] = [];

      for (const machineNo of MACHINE_NOS) {
        const dbEntries = savedEntriesByMachine[machineNo] ?? [];
        const rowRuns = (machineRuns[machineNo] ?? []).filter((r) => r.points.length > 0);
        const extras = (isNum ? numberingExtras : sqcExtras)[extraRowsKey(machineNo)] ?? [];

        const orderedRows = buildOrderedRows(dbEntries, rowRuns, extras, machineNo, dateKey);

        for (const row of orderedRows) {
          const key = row.rowKey;
          const currentVals = valuesStore[key] ?? {};
          const baseline = baselineStore[key];

          let jobNameFallback = '';
          let shiftFallback = '1';
          let defaultBottleId: number | null = null;
          let defaultJobId = '';
          let entryId: string | null = null;

          if (row.kind === 'db') {
            entryId = String(row.dbEntry.entry_id);
            jobNameFallback = row.dbEntry.bottle_name || row.dbEntry.job_id || '';
            shiftFallback = String(row.dbEntry.shift || 1);
            defaultBottleId = row.dbEntry.bottle_id ?? null;
            defaultJobId = row.dbEntry.job_id || '';
          } else if (row.kind === 'run') {
            jobNameFallback = runJobName(row.run);
            shiftFallback = runShift(row.run);
            defaultBottleId = row.run.bottleId ? parseInt(row.run.bottleId, 10) || null : null;
            defaultJobId = row.run.jobId || '';
          } else {
            jobNameFallback = row.extra.jobName;
            shiftFallback = row.extra.shift;
          }

          const effectiveJobName = (currentVals.jobName ?? jobNameFallback).trim();
          const effectiveShift = parseInt(currentVals.shift ?? shiftFallback, 10) || 1;
          const effectiveTime = (currentVals.time ?? '').trim();
          const effectivePackType = (currentVals.packType ?? '').trim() || null;
          const effectivePcsPackRaw = currentVals.pcsPack != null && currentVals.pcsPack !== '' ? parseInt(currentVals.pcsPack, 10) : null;
          const effectivePcsPack = Number.isNaN(effectivePcsPackRaw) ? null : effectivePcsPackRaw;
          const effectiveCartons = currentVals.cartons ? parseInt(currentVals.cartons, 10) || null : null;
          const effectiveDefectiveBottles = currentVals.noOfBottle ? parseInt(currentVals.noOfBottle, 10) || null : null;
          const effectiveMould = (currentVals.mould ?? '').trim() || null;
          const effectiveSection = (isNum ? currentVals.sectionNo : (currentVals.section ?? currentVals.sectionNo))?.trim() || null;
          const effectiveCheckerName = (currentVals.checkerName ?? '').trim();
          // The last column of the table is a free-text Remarks cell (the
          // state key keeps its legacy name ``qaShiftEx``); it is persisted in
          // sqc.repacking_* .remarks — the live tables have no QA-executive
          // column to write to.
          const effectiveRemarks = (currentVals.qaShiftEx ?? '').trim();
          const effectiveDefects = (currentVals.defects ?? '').trim();
          const effectiveLotNo = !isNum ? (currentVals.lotNo ?? '').trim() || null : undefined;

          // ── Checker ─────────────────────────────────────────────────────
          // The dropdown only offers employees that hold the ACTIVE CHECKER
          // role, and what gets stored is ``employee_id`` (string, leading
          // zeros preserved) — never the display name. An unrecognised value
          // would violate the checker_id -> hpr.employee_master FK, so the
          // save is blocked with a clear message instead of sending it.
          let checkerId: string | null = null;
          if (effectiveCheckerName) {
            const unchangedDbValue =
              row.kind === 'db' &&
              !!row.dbEntry.checker_id &&
              (row.dbEntry.checker_name || '').trim().toLowerCase() === effectiveCheckerName.toLowerCase();
            const checkerEmp = dbEmployees.find(
              (e) =>
                e.employee_name?.trim().toLowerCase() === effectiveCheckerName.toLowerCase() ||
                e.employee_id === effectiveCheckerName
            );
            if (unchangedDbValue) {
              // Value came from the database and was not edited — keep the
              // stored FK as-is (covers checkers that are no longer listed).
              checkerId = row.kind === 'db' ? row.dbEntry.checker_id : null;
            } else if (checkerEmp) {
              checkerId = checkerEmp.employee_id;
            } else {
              alert(
                `"${effectiveCheckerName}" is not an active employee. Please select a Checker from the dropdown.`
              );
              return;
            }
          }

          let defectId: string | null = null;
          const defectIds: string[] = [];
          if (effectiveDefects) {
            const names = effectiveDefects.split(',').map((s) => s.trim()).filter(Boolean);
            for (const dName of names) {
              const dHit = defectList.find((d) => d.defect_name.toLowerCase() === dName.toLowerCase());
              if (dHit) {
                defectIds.push(String(dHit.defect_id));
              }
            }
            defectId = defectIds.length > 0 ? defectIds[0] : null;
          }

          let bottleId: number | null = defaultBottleId;
          if (effectiveJobName) {
            const bHit = bottles.find(
              (b) => b.name.toLowerCase() === effectiveJobName.toLowerCase() || String(b.id) === effectiveJobName
            );
            if (bHit) {
              bottleId = parseInt(bHit.id, 10) || null;
            }
          }
          const jobId = defaultJobId || effectiveJobName || 'JOB';

          if (entryId) {
            const hasChanged =
              !baseline ||
              currentVals.jobName !== baseline.jobName ||
              currentVals.shift !== baseline.shift ||
              currentVals.time !== baseline.time ||
              currentVals.packType !== baseline.packType ||
              currentVals.pcsPack !== baseline.pcsPack ||
              currentVals.cartons !== baseline.cartons ||
              currentVals.noOfBottle !== baseline.noOfBottle ||
              currentVals.defects !== baseline.defects ||
              currentVals.mould !== baseline.mould ||
              (isNum ? currentVals.sectionNo !== baseline.sectionNo : currentVals.section !== baseline.section) ||
              currentVals.checkerName !== baseline.checkerName ||
              currentVals.qaShiftEx !== baseline.qaShiftEx ||
              (!isNum && currentVals.lotNo !== baseline.lotNo);

            if (hasChanged) {
              if (!effectiveTime) {
                alert(`Please select a Time for ${effectiveJobName || 'entry'} on Machine ${machineNo} before saving.`);
                return;
              }
              const updateObj: any = {
                entry_id: entryId,
                entry_ids: row.kind === 'db' ? (row.dbEntry.entry_ids || [entryId]) : [entryId],
                production_date: dateKey,
                machine_no: machineNo,
                job_id: jobId,
                bottle_id: bottleId,
                pack_type: effectivePackType,
                shift: effectiveShift,
                entry_time: effectiveTime,
                pcs_per_pack: effectivePcsPack,
                cartons: effectiveCartons,
                defective_bottles: effectiveDefectiveBottles,
                defect_id: defectId,
                defect_ids: defectIds,
                mould: effectiveMould,
                section_no: effectiveSection,
                checker_id: checkerId,
                remarks: effectiveRemarks,
              };
              if (!isNum) updateObj.lot_no = effectiveLotNo;
              updates.push(updateObj);
            }
          } else {
            const hasUserEnteredData =
              row.kind === 'extra' ||
              Boolean(effectiveTime) ||
              Boolean(effectivePackType) ||
              effectivePcsPack !== null ||
              effectiveCartons !== null ||
              effectiveDefectiveBottles !== null ||
              Boolean(effectiveDefects) ||
              Boolean(effectiveMould) ||
              Boolean(effectiveSection) ||
              Boolean(effectiveCheckerName) ||
              Boolean(effectiveRemarks) ||
              (!isNum && Boolean(effectiveLotNo));

            if (hasUserEnteredData) {
              if (!effectiveTime) {
                alert(`Please select a Time for ${effectiveJobName || 'new entry'} on Machine ${machineNo} before saving.`);
                return;
              }
              const insertObj: any = {
                production_date: dateKey,
                machine_no: machineNo,
                job_id: jobId,
                bottle_id: bottleId,
                pack_type: effectivePackType,
                shift: effectiveShift,
                entry_time: effectiveTime,
                pcs_per_pack: effectivePcsPack,
                cartons: effectiveCartons,
                defective_bottles: effectiveDefectiveBottles,
                defect_id: defectId,
                defect_ids: defectIds,
                mould: effectiveMould,
                section_no: effectiveSection,
                checker_id: checkerId,
                remarks: effectiveRemarks,
              };
              if (!isNum) insertObj.lot_no = effectiveLotNo;
              inserts.push(insertObj);
            }
          }
        }
      }

      if (inserts.length === 0 && updates.length === 0) {
        setSaveState('saved');
        toast.info('No changes to save.');
        if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = window.setTimeout(() => setSaveState('idle'), 1500);
        return;
      }

      setSaveState('saving');

      if (isNum) {
        await repackingRepository.saveNumberingBatch(inserts, updates);
        setNumberingExtras({});
      } else {
        await repackingRepository.saveSqcQcHoldBatch(inserts, updates);
        setSqcExtras({});
      }

      // Invalidate the repacking cache for this date so the reload below
      // fetches fresh post-save data instead of stale cached data.
      repackingRepository.invalidateRepackingCache(dateKey);

      await loadSavedData(dateKey);

      setSaveState('saved');
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = window.setTimeout(() => setSaveState('idle'), 2500);

      const label = isNum ? 'Numbering' : 'SQC/QC HOLD';
      const countParts: string[] = [];
      if (inserts.length > 0) countParts.push(`${inserts.length} new ${inserts.length === 1 ? 'row' : 'rows'}`);
      if (updates.length > 0) countParts.push(`${updates.length} updated ${updates.length === 1 ? 'row' : 'rows'}`);
      const countText = countParts.join(', ');
      const msg = `${label} entries for ${dateLabel} have been saved to the database successfully${countText ? ` (${countText})` : ''}.`;

      toast.success(msg);
      setSuccessPopupMsg(msg);
      setShowSuccessPopup(true);
    } catch (err: any) {
      console.error('Batch save failed:', err);
      const errMsg = err?.message || 'Failed to save repacking entries. Please check inputs and try again.';
      toast.error(errMsg);
      alert(errMsg);
      setSaveState('idle');
    }
  };

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const statusMessage = (emptyText: string): string => {
    if (loading) return `Loading production data for ${dateLabel}…`;
    if (loadError) return `Could not load production data — ${loadError}`;
    return emptyText;
  };

  return (
    <div
      style={{
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '32px',
        paddingBottom: '8px',
      }}
    >
      {/* Save Button — Fixed/sticky at top-right so it stays visible while scrolling */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          width: '100%',
          padding: '0 2px 8px 2px',
          boxSizing: 'border-box',
          position: 'sticky',
          top: 0,
          zIndex: 50,
          backgroundColor: '#ffffff',
        }}
      >
        <button
          type="button"
          onClick={handleSaveClick}
          disabled={saveState === 'saving'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 16px',
            fontSize: '12.5px',
            fontWeight: 500,
            color: '#ffffff',
            backgroundColor: saveState === 'saved' ? '#16a34a' : '#2563eb',
            border: 'none',
            borderRadius: '6px',
            cursor: saveState === 'saving' ? 'wait' : 'pointer',
            transition: 'all 0.15s ease',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
          }}
          onMouseEnter={(e) => {
            if (saveState === 'idle') e.currentTarget.style.backgroundColor = '#1d4ed8';
          }}
          onMouseLeave={(e) => {
            if (saveState === 'idle') e.currentTarget.style.backgroundColor = '#2563eb';
          }}
        >
          {saveState === 'saving' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            </>
          ) : saveState === 'saved' ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>Saved</span>
            </>
          ) : (
            <>
              <Save className="w-3.5 h-3.5" />
              <span>Save</span>
            </>
          )}
        </button>
      </div>

      {layout === 'numbering' && (
        <>
          {machineNos.map((machineNo, machineIdx) => {
            const runs = machineRuns[machineNo] ?? [];
            const rowRuns = runs.filter((run) => run.points.length > 0);
            const extras = numberingExtras[extraRowsKey(machineNo)] ?? [];
            const dbEntries = savedNumbering[machineNo] ?? [];
            const orderedRows = buildOrderedRows(dbEntries, rowRuns, extras, machineNo, dateKey);
            return (
              <div
                key={machineNo}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  backgroundColor: C.white,
                  border: `1px solid ${C.border}`,
                  borderRadius: '10px',
                  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    borderBottom: `1px solid ${C.border}`,
                    backgroundColor: C.white,
                  }}
                >
                  <span
                    style={{
                      width: '22px',
                      height: '22px',
                      flexShrink: 0,
                      borderRadius: '6px',
                      backgroundColor: MACHINE_INDICATOR_COLORS[machineIdx] ?? '#2563EB',
                      color: '#ffffff',
                      fontSize: '11.5px',
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                    }}
                  >
                    {machineNo}
                  </span>
                  <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#1e293b', lineHeight: 1.2 }}>
                    Machine {machineNo}
                  </h4>
                </div>
                <div style={{ width: '100%', overflowX: 'auto', boxSizing: 'border-box' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      tableLayout: 'fixed',
                      minWidth: TABLE_MIN_WIDTH_NUMBERING,
                    }}
                  >
                    <colgroup>
                      {NUMBERING_COLUMNS.map((col) => (
                        <col key={col} style={{ width: NUMBERING_COL_PERCENTS[col] ?? '8%' }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr style={{ backgroundColor: C.headerBg, height: '34px' }}>
                        {NUMBERING_COLUMNS.map((col, idx) => (
                          <th
                            key={col}
                            style={numThStyle(
                              idx,
                              NUMBERING_COLUMNS.length,
                              NUMBERING_COL_WIDTHS[col],
                              col === 'Job Name' || col === 'Checker Name' ? 'left' : 'center'
                            )}
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {orderedRows.map((row) => {
                        const key = row.rowKey;
                        const isDbRow = row.kind === 'db';
                        const dbEntryId = isDbRow ? String(row.dbEntry.entry_id) : null;
                        const jobNameFallback =
                          row.kind === 'extra'
                            ? row.extra.jobName
                            : isDbRow
                            ? (row.dbEntry.bottle_name || row.dbEntry.job_id || '')
                            : runJobName(row.run);
                        const shiftFallback =
                          row.kind === 'extra'
                            ? row.extra.shift
                            : isDbRow
                            ? String(row.dbEntry.shift || 1)
                            : runShift(row.run);
                        // Pack Type and Pcs/Pack are prefilled from the matching
                        // production report record (machine + Job ID).
                        const prodJobId = productionJobIdFor(row);
                        const packDetailsForJob = machineJobPackDetails[machineNo]?.[prodJobId] ?? {};
                        const availablePackTypes = Object.keys(packDetailsForJob);
                        const basePackType = availablePackTypes[0] ?? '';
                        const basePcsPack = basePackType ? packDetailsForJob[basePackType] : '';
                        // Pack Type dropdown options are limited to the packing
                        // types reported for this job on this machine/date.
                        const jobPackTypes = machineJobPackTypes[machineNo]?.[prodJobId] ?? [];
                        const anchor =
                          row.kind === 'extra'
                            ? `x:${row.extra.id}`
                            : isDbRow
                            ? `db:${row.dbEntry.entry_id}`
                            : `run:${row.rowIdx}`;
                        const extraId = row.kind === 'extra' ? row.extra.id : -1;

                        return (
                          <tr key={key} style={{ backgroundColor: row.visualIdx % 2 === 0 ? C.white : '#f8fafc', height: '32px' }}>
                            <td style={numCellTd(0, NUMBERING_COLUMNS.length, 'left')}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', width: '100%' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <CellTextInput
                                    value={cellValue(numberingValues, key, 'jobName', jobNameFallback)}
                                    onChange={(v) => setNumberingCell(key, 'jobName', v)}
                                    align="left"
                                    placeholder="Job / Bottle Name"
                                    style={NUMBERING_INPUT_STYLE}
                                  />
                                </div>
                                <AddRowButton
                                  title="Add another row for this job"
                                  onClick={() =>
                                    addExtraRow(
                                      'numbering',
                                      machineNo,
                                      anchor,
                                      cellValue(numberingValues, key, 'jobName', jobNameFallback),
                                      cellValue(numberingValues, key, 'shift', shiftFallback),
                                      cellValue(numberingValues, key, 'packType', isDbRow ? (row.dbEntry.pack_type || '') : basePackType),
                                      cellValue(numberingValues, key, 'pcsPack', isDbRow && row.dbEntry.pcs_per_pack != null ? String(row.dbEntry.pcs_per_pack) : basePcsPack),
                                      ''
                                    )
                                  }
                                />
                                {extraId >= 0 && (
                                  <RemoveRowButton
                                    title="Remove this row"
                                    onClick={() => removeExtraRow('numbering', machineNo, extraId)}
                                  />
                                )}
                                {isDbRow && dbEntryId && (
                                  <RemoveRowButton
                                    title="Delete this saved entry"
                                    onClick={() => handleDeleteDbRow('numbering', machineNo, dbEntryId)}
                                  />
                                )}
                              </div>
                            </td>
                            <td style={numCellTd(1, NUMBERING_COLUMNS.length)}>
                              <PackTypeCell
                                value={cellValue(numberingValues, key, 'packType', row.kind === 'extra' ? row.extra.packType : basePackType)}
                                onChange={(v) => {
                                  setNumberingCell(key, 'packType', v);
                                  const pcsPack = packDetailsForJob[v];
                                  // Only auto-populate PCS/Pack when the selected
                                  // pack type exists in the Production Report, so
                                  // existing values are not accidentally cleared.
                                  if (pcsPack !== undefined) {
                                    setNumberingCell(key, 'pcsPack', pcsPack);
                                  }
                                }}
                                machineNo={machineNo}
                                packingTypes={jobPackTypes}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(2, NUMBERING_COLUMNS.length)}>
                              <CellShiftSelect
                                value={cellValue(numberingValues, key, 'shift', shiftFallback)}
                                onChange={(v) => setNumberingCell(key, 'shift', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(3, NUMBERING_COLUMNS.length)}>
                              <CellTimePicker
                                isOpen={openTimeCellKey === `time|num|${key}`}
                                onToggle={(open) => setOpenTimeCellKey(open ? `time|num|${key}` : null)}
                                value={cellValue(numberingValues, key, 'time', '')}
                                shift={cellValue(numberingValues, key, 'shift', shiftFallback)}
                                onConfirm={(t) => setNumberingCell(key, 'time', t)}
                              />
                            </td>
                            <td style={numCellTd(4, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'pcsPack', row.kind === 'extra' ? row.extra.pcsPack : basePcsPack)}
                                onChange={(v) => setNumberingCell(key, 'pcsPack', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(5, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'cartons', isDbRow && row.dbEntry.cartons != null ? String(row.dbEntry.cartons) : '')}
                                onChange={(v) => setNumberingCell(key, 'cartons', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(6, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'noOfBottle', isDbRow && row.dbEntry.defective_bottles != null ? String(row.dbEntry.defective_bottles) : '')}
                                onChange={(v) => setNumberingCell(key, 'noOfBottle', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(7, NUMBERING_COLUMNS.length)}>
                              <CellDefectsDropdown
                                cellKey={`num|${key}`}
                                activeOpenKey={openDefectCellKey}
                                onToggleOpen={setOpenDefectCellKey}
                                value={cellValue(numberingValues, key, 'defects', isDbRow ? (row.dbEntry.defect_name || '') : '')}
                                onChange={(v) => setNumberingCell(key, 'defects', v)}
                                defectGroups={defectGroups}
                                isLoading={loadingDefects}
                              />
                            </td>
                            <td style={numCellTd(8, NUMBERING_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'mould', isDbRow ? (row.dbEntry.mould || '') : '')}
                                onChange={(v) => setNumberingCell(key, 'mould', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(9, NUMBERING_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'sectionNo', isDbRow ? (row.dbEntry.section_no || '') : '')}
                                onChange={(v) => setNumberingCell(key, 'sectionNo', v)}
                                placeholder="F12"
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(10, NUMBERING_COLUMNS.length, 'left')}>
                              <CellEmployeeSelect
                                value={cellValue(numberingValues, key, 'checkerName', isDbRow ? (row.dbEntry.checker_name || '') : '')}
                                onChange={(v) => setNumberingCell(key, 'checkerName', v)}
                                options={employeeList}
                                placeholder="Select Checker"
                                align="left"
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(11, NUMBERING_COLUMNS.length, 'center')}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'qaShiftEx', isDbRow ? (row.dbEntry.remarks || row.dbEntry.qa_shift_ex_name || '') : '')}
                                onChange={(v) => setNumberingCell(key, 'qaShiftEx', v)}
                                placeholder="Remarks"
                                align="center"
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {orderedRows.length === 0 && (
                        <tr>
                          <td colSpan={NUMBERING_COLUMNS.length} style={emptyStateTd(NUMBERING_COLUMNS.length)}>
                            {statusMessage('No numbering data available for the selected date.')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </>
      )}

      {layout === 'sqc' && (
        <>
          {machineNos.map((machineNo, machineIdx) => {
            const runs = machineRuns[machineNo] ?? [];
            const rowRuns = runs.filter((run) => run.points.length > 0);
            const extras = sqcExtras[extraRowsKey(machineNo)] ?? [];
            const dbEntries = savedSqc[machineNo] ?? [];
            const orderedRows = buildOrderedRows(dbEntries, rowRuns, extras, machineNo, dateKey);
            return (
              <div
                key={machineNo}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  backgroundColor: C.white,
                  border: `1px solid ${C.border}`,
                  borderRadius: '10px',
                  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    borderBottom: `1px solid ${C.border}`,
                    backgroundColor: C.white,
                  }}
                >
                  <span
                    style={{
                      width: '22px',
                      height: '22px',
                      flexShrink: 0,
                      borderRadius: '6px',
                      backgroundColor: MACHINE_INDICATOR_COLORS[machineIdx] ?? '#2563EB',
                      color: '#ffffff',
                      fontSize: '11.5px',
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                    }}
                  >
                    {machineNo}
                  </span>
                  <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#1e293b', lineHeight: 1.2 }}>
                    Machine {machineNo}
                  </h4>
                </div>
                <div style={{ width: '100%', overflowX: 'auto', boxSizing: 'border-box' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      tableLayout: 'fixed',
                      minWidth: TABLE_MIN_WIDTH_SQC,
                    }}
                  >
                    <colgroup>
                      {SQC_COLUMNS.map((col) => (
                        <col key={col} style={{ width: SQC_COL_PERCENTS[col] ?? '8%' }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr style={{ backgroundColor: C.headerBg, height: '34px' }}>
                        {SQC_COLUMNS.map((col, idx) => (
                          <th
                            key={col}
                            style={sqcThStyle(
                              idx,
                              SQC_COLUMNS.length,
                              SQC_COL_WIDTHS[col],
                              col === 'Job Name' || col === 'Checker Name' ? 'left' : 'center'
                            )}
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {orderedRows.map((row) => {
                        const key = row.rowKey;
                        const isDbRow = row.kind === 'db';
                        const dbEntryId = isDbRow ? String(row.dbEntry.entry_id) : null;
                        const jobNameFallback =
                          row.kind === 'extra'
                            ? row.extra.jobName
                            : isDbRow
                            ? (row.dbEntry.bottle_name || row.dbEntry.job_id || '')
                            : runJobName(row.run);
                        const shiftFallback =
                          row.kind === 'extra'
                            ? row.extra.shift
                            : isDbRow
                            ? String(row.dbEntry.shift || 1)
                            : runShift(row.run);
                        // Pack Type and Pcs/Pack are prefilled from the matching
                        // production report record (machine + Job ID).
                        const prodJobId = productionJobIdFor(row);
                        const packDetailsForJob = machineJobPackDetails[machineNo]?.[prodJobId] ?? {};
                        const availablePackTypes = Object.keys(packDetailsForJob);
                        const basePackType = availablePackTypes[0] ?? '';
                        const basePcsPack = basePackType ? packDetailsForJob[basePackType] : '';
                        // Pack Type dropdown options are limited to the packing
                        // types reported for this job on this machine/date.
                        const jobPackTypes = machineJobPackTypes[machineNo]?.[prodJobId] ?? [];
                        const anchor =
                          row.kind === 'extra'
                            ? `x:${row.extra.id}`
                            : isDbRow
                            ? `db:${row.dbEntry.entry_id}`
                            : `run:${row.rowIdx}`;
                        const extraId = row.kind === 'extra' ? row.extra.id : -1;

                        return (
                          <tr key={key} style={{ backgroundColor: row.visualIdx % 2 === 0 ? C.white : '#f8fafc', height: '32px' }}>
                            <td style={sqcCellTd(0, SQC_COLUMNS.length, 'left')}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', width: '100%' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <CellTextInput
                                    value={cellValue(sqcValues, key, 'jobName', jobNameFallback)}
                                    onChange={(v) => setSqcCell(key, 'jobName', v)}
                                    align="left"
                                    placeholder="Job / Bottle Name"
                                    style={SQC_INPUT_STYLE}
                                  />
                                </div>
                                <AddRowButton
                                  title="Add another row for this job"
                                  onClick={() =>
                                    addExtraRow(
                                      'sqc',
                                      machineNo,
                                      anchor,
                                      cellValue(sqcValues, key, 'jobName', jobNameFallback),
                                      cellValue(sqcValues, key, 'shift', shiftFallback),
                                      cellValue(sqcValues, key, 'packType', isDbRow ? (row.dbEntry.pack_type || '') : basePackType),
                                      cellValue(sqcValues, key, 'pcsPack', isDbRow && row.dbEntry.pcs_per_pack != null ? String(row.dbEntry.pcs_per_pack) : basePcsPack),
                                      ''
                                    )
                                  }
                                />
                                {extraId >= 0 && (
                                  <RemoveRowButton
                                    title="Remove this row"
                                    onClick={() => removeExtraRow('sqc', machineNo, extraId)}
                                  />
                                )}
                                {isDbRow && dbEntryId && (
                                  <RemoveRowButton
                                    title="Delete this saved entry"
                                    onClick={() => handleDeleteDbRow('sqc', machineNo, dbEntryId)}
                                  />
                                )}
                              </div>
                            </td>
                            <td style={sqcCellTd(1, SQC_COLUMNS.length)}>
                              <CellShiftSelect
                                value={cellValue(sqcValues, key, 'shift', shiftFallback)}
                                onChange={(v) => setSqcCell(key, 'shift', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(2, SQC_COLUMNS.length)}>
                              <CellTimePicker
                                isOpen={openTimeCellKey === `time|sqc|${key}`}
                                onToggle={(open) => setOpenTimeCellKey(open ? `time|sqc|${key}` : null)}
                                value={cellValue(sqcValues, key, 'time', '')}
                                shift={cellValue(sqcValues, key, 'shift', shiftFallback)}
                                onConfirm={(t) => setSqcCell(key, 'time', t)}
                              />
                            </td>
                            <td style={sqcCellTd(3, SQC_COLUMNS.length)}>
                              <PackTypeCell
                                value={cellValue(sqcValues, key, 'packType', row.kind === 'extra' ? row.extra.packType : basePackType)}
                                onChange={(v) => {
                                  setSqcCell(key, 'packType', v);
                                  const pcsPack = packDetailsForJob[v];
                                  // Only auto-populate PCS/Pack when the selected
                                  // pack type exists in the Production Report, so
                                  // existing values are not accidentally cleared.
                                  if (pcsPack !== undefined) {
                                    setSqcCell(key, 'pcsPack', pcsPack);
                                  }
                                }}
                                machineNo={machineNo}
                                packingTypes={jobPackTypes}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(4, SQC_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'lotNo', isDbRow && 'lot_no' in row.dbEntry ? (row.dbEntry.lot_no || '') : '')}
                                onChange={(v) => setSqcCell(key, 'lotNo', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(5, SQC_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'pcsPack', row.kind === 'extra' ? row.extra.pcsPack : basePcsPack)}
                                onChange={(v) => setSqcCell(key, 'pcsPack', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(6, SQC_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'cartons', isDbRow && row.dbEntry.cartons != null ? String(row.dbEntry.cartons) : '')}
                                onChange={(v) => setSqcCell(key, 'cartons', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(7, SQC_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'noOfBottle', isDbRow && row.dbEntry.defective_bottles != null ? String(row.dbEntry.defective_bottles) : '')}
                                onChange={(v) => setSqcCell(key, 'noOfBottle', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(8, SQC_COLUMNS.length)}>
                              <CellDefectsDropdown
                                cellKey={`sqc|${key}`}
                                activeOpenKey={openDefectCellKey}
                                onToggleOpen={setOpenDefectCellKey}
                                value={cellValue(sqcValues, key, 'defects', isDbRow ? (row.dbEntry.defect_name || '') : '')}
                                onChange={(v) => setSqcCell(key, 'defects', v)}
                                defectGroups={defectGroups}
                                isLoading={loadingDefects}
                              />
                            </td>
                            <td style={sqcCellTd(9, SQC_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'mould', isDbRow ? (row.dbEntry.mould || '') : '')}
                                onChange={(v) => setSqcCell(key, 'mould', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(10, SQC_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'section', isDbRow ? (row.dbEntry.section_no || '') : '')}
                                onChange={(v) => setSqcCell(key, 'section', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(11, SQC_COLUMNS.length, 'left')}>
                              <CellEmployeeSelect
                                value={cellValue(sqcValues, key, 'checkerName', isDbRow ? (row.dbEntry.checker_name || '') : '')}
                                onChange={(v) => setSqcCell(key, 'checkerName', v)}
                                options={employeeList}
                                placeholder="Select Checker"
                                align="left"
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(12, SQC_COLUMNS.length, 'center')}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'qaShiftEx', isDbRow ? (row.dbEntry.remarks || row.dbEntry.qa_shift_ex_name || '') : '')}
                                onChange={(v) => setSqcCell(key, 'qaShiftEx', v)}
                                placeholder="Remarks"
                                align="center"
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {orderedRows.length === 0 && (
                        <tr>
                          <td colSpan={SQC_COLUMNS.length} style={emptyStateTd(SQC_COLUMNS.length)}>
                            {statusMessage('No SQC/QC HOLD data available for the selected date.')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Success Popup Message Modal rendered through Portal to document.body */}
      {showSuccessPopup &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99999,
              backgroundColor: 'rgba(15, 23, 42, 0.45)',
              backdropFilter: 'blur(3px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '16px',
              boxSizing: 'border-box',
            }}
            onClick={() => setShowSuccessPopup(false)}
          >
            <div
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                maxWidth: '430px',
                width: '100%',
                padding: '24px',
                boxShadow: '0 20px 35px -5px rgba(15, 23, 42, 0.25), 0 8px 16px -4px rgba(15, 23, 42, 0.1)',
                border: '1px solid #e2e8f0',
                position: 'relative',
                boxSizing: 'border-box',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setShowSuccessPopup(false)}
                style={{
                  position: 'absolute',
                  top: '14px',
                  right: '14px',
                  color: '#94a3b8',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = '#475569')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
              >
                <X size={18} />
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px' }}>
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '50%',
                    backgroundColor: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    color: '#059669',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <CheckCircle2 size={24} />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#0f172a' }}>
                    Data Saved Successfully
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#64748b' }}>
                    Database update completed
                  </p>
                </div>
              </div>

              <p style={{ margin: '0 0 20px 0', fontSize: '13.5px', color: '#334155', lineHeight: 1.5 }}>
                {successPopupMsg || `${layout === 'numbering' ? 'Numbering' : 'SQC/QC HOLD'} entries have been successfully saved to the database.`}
              </p>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowSuccessPopup(false)}
                  style={{
                    padding: '7px 22px',
                    fontSize: '13px',
                    fontWeight: 500,
                    color: '#ffffff',
                    backgroundColor: '#2563eb',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#1d4ed8')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#2563eb')}
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default RePackingReport;
