/**
 * Re-PackingReport.tsx — Re-Packing Report with NUMBERING and SQC/QC HOLD layouts.
 *
 * Two-layout Re-Packing Report rendered as a compact ERP dashboard: light
 * page background, white machine cards with subtle borders / rounded corners
 * / minimal shadows, and blue (#2563EB) as the primary accent.
 *   • NUMBERING (default): 4 machine tables with columns
 *     Job Name | Pack Type | Shift | Time | Pcs/Pack | Cartons | Defective Bottles | Lot No. | Defects | Mould | Section No. | Checker Name | QA-Shift Ex. (Numbering)
 *   • SQC/QC HOLD: 4 machine tables with columns
 *     Shift | Time | Job Name | Pack Type | Lot No. | Pcs/Pack | Cartons | Defective Bottles | Defects | Mould | Section | Checker Name | QA-Shift Ex.
 *
 * Every column of every data row is an editable ERP-styled input (text,
 * number, dropdown or 12-hour AM/PM time picker where applicable), and each row
 * keeps its own independent values in component state. The Time columns are a
 * MANUAL time picker (hours + minutes + AM/PM) that is never auto-populated
 * from job schedules. Switching between NUMBERING and SQC/QC HOLD keeps the
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
import { ChevronDown, Save, Check, Loader2 } from 'lucide-react';
import { useERP } from '../../context/ERPContext';
import { useAuth } from '../../context/AuthContext';
import {
  qualityRepository,
  QualityDayHourly,
  QualityHourlyEntry,
  QualityShiftMap,
  hasMeaningfulData,
} from '../../services/qualityRepository';

const C = {
  border: '#e2e8f0',
  // Column-header highlight: light blue row with navy text (both tables).
  headerBg: '#dbeafe',
  headerText: '#1e3a8a',
  textMain: '#1e293b',
  textMuted: '#64748b',
  white: '#ffffff',
  blueActive: '#2563eb',
  blueHover: '#1e40af',
  lightGray: '#f1f5f9',
};

const MACHINE_NOS = [1, 2, 3, 4];

/** Subtle per-machine indicator colors for the numbered card badges. */
const MACHINE_INDICATOR_COLORS = ['#2563EB', '#0EA5E9', '#6366F1', '#8B5CF6'];

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

const NUMBERING_COLUMNS = [
  'Job Name', 'Pack Type', 'Shift', 'Time', 'Pcs/Pack', 'Cartons', 'Bottle',
  'Defects', 'Mould', 'Section No.', 'Checker Name',
  'QA-Shift Ex.',
];

/** Numbering table: column min-widths for the header cells. */
const NUMBERING_COL_WIDTHS: Record<string, string> = {
  'Job Name': '160px',
  'Pack Type': '80px',
  'Shift': '70px',
  'Time': '95px',
  'Pcs/Pack': '70px',
  'Cartons': '70px',
  'Bottle': '85px',
  'Defects': '200px',
  'Mould': '70px',
  'Section No.': '70px',
  'Checker Name': '110px',
  'QA-Shift Ex.': '90px',
};

/** Numbering table: percentage widths so the table fills all available
 *  horizontal space (sums to 100.0%). */
const NUMBERING_COL_PERCENTS: Record<string, string> = {
  'Job Name': '13.0%',
  'Pack Type': '7.0%',
  'Shift': '6.0%',
  'Time': '8.0%',
  'Pcs/Pack': '6.0%',
  'Cartons': '6.0%',
  'Defective Bottles': '7.5%',
  'Defects': '20.5%',
  'Mould': '5.5%',
  'Section No.': '5.5%',
  'Checker Name': '8.5%',
  'QA-Shift Ex.': '6.5%',
};

/** Numbering table: 0-based column indices that end a visual section
 *  (Production Details after 'Defective Bottles' (6), Defect Details after 'Section No.' (9)). */
const NUMBERING_SECTION_ENDS = new Set([6, 9]);
const NUMBERING_SECTION_DIVIDER = '2px solid #cbd5e1';

const SQC_COLUMNS = [
  'Shift', 'Time', 'Job Name', 'Pack Type', 'Lot No.', 'Pcs/Pack', 'Cartons',
  'Bottle', 'Defects', 'Mould', 'Section', 'Checker Name',
  'QA-Shift Ex.',
];

/** SQC/QC HOLD table: percentage widths so the table fills all available
 *  horizontal space (sums to 100.0%). */
const SQC_COL_PERCENTS: Record<string, string> = {
  'Shift': '5.5%',
  'Time': '7.5%',
  'Job Name': '13.0%',
  'Pack Type': '6.5%',
  'Lot No.': '6.5%',
  'Pcs/Pack': '5.5%',
  'Cartons': '5.5%',
  'Defective Bottles': '7.0%',
  'Defects': '19.0%',
  'Mould': '5.5%',
  'Section': '5.5%',
  'Checker Name': '7.5%',
  'QA-Shift Ex.': '5.5%',
};

/** SQC/QC HOLD table: pixel minimums for the header cells. */
const SQC_COL_WIDTHS: Record<string, string> = {
  'Shift': '70px',
  'Time': '95px',
  'Job Name': '160px',
  'Pack Type': '80px',
  'Lot No.': '80px',
  'Pcs/Pack': '70px',
  'Cartons': '70px',
  'Bottle': '85px',
  'Defects': '190px',
  'Mould': '70px',
  'Section': '70px',
  'Checker Name': '110px',
  'QA-Shift Ex.': '90px',
};

/** SQC/QC HOLD: 0-based column indices that end a visual section (after 'Defective Bottles' (7) and 'Section' (10)). */
const SQC_SECTION_ENDS = new Set([7, 10]);

/** Minimum rendered table width — below it the card body scrolls horizontally. */
const TABLE_MIN_WIDTH_NUMBERING = '1170px';
const TABLE_MIN_WIDTH_SQC = '1240px';
const TABLE_MIN_WIDTH = '1220px';

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
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(label);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
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
 * "7:40 AM - 4:00 PM" — the run's ACTUAL production interval, read from the
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
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  if (packingTypes.length === 0) {
    return <CellTextInput value={value} onChange={onChange} style={style} />;
  }

  if (packingTypes.length === 1) {
    // Only one packing type used during this day — display as plain text
    return <CellTextInput value={packingTypes[0]} onChange={() => {}} style={style} />;
  }

  // Multiple packing types — show dropdown for selection
  return (
    <select
      value={value}
      onChange={handleChange}
      onFocus={(e) => focusCellBorder(e, true)}
      onBlur={(e) => focusCellBorder(e, false)}
      style={{
        ...CELL_INPUT_STYLE,
        padding: '2px 4px',
        color: value ? C.textMain : '#94a3b8',
        textAlign: 'center',
        cursor: 'pointer',
        appearance: 'auto',
        ...(style ?? {}),
      }}
    >
      {packingTypes.map((cat) => (
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

  const MAX_TAGS = 1;
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
                    maxWidth: '105px',
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
            {selected.length > 0 && (
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
                <span style={{ fontSize: '11.5px', color: '#64748b' }}>{selected.length} selected</span>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange([]);
                  }}
                  style={{
                    fontSize: '11.5px',
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
              </div>
            )}
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
// TODO: replace with employees fetched from DB
/**
 * Single source of truth for the employee list used in Checker Name and
 * QA-Shift Ex. dropdowns across all Re-Packing Report tables.
 * TODO: replace with employees fetched from DB
 */
export const DEFAULT_EMPLOYEE_LIST: string[] = [
  'Ashish',
  'Mangesh Kadam',
  'Rajesh Shingote',
  'Rama Zanjure',
  'Ramesh Domala',
  'Ravindra Shanbhag',
  'Sanjeev Sinha',
  'Shivanand Nayak',
  'Sudhir Pai',
  'Sumit Gupta',
  'Vithob Shet',
];

/**
 * Hook to retrieve the active employee roster.
 * Combines the base employee list with the current logged-in user and any
 * supervisors/executives assigned to the day's shifts.
 * TODO: replace with employees fetched from DB
 */
export const useEmployeeList = (shiftAssignments?: QualityShiftMap): string[] => {
  const { user: authUser } = useAuth();
  return useMemo(() => {
    // TODO: replace with employees fetched from DB
    const set = new Set<string>(DEFAULT_EMPLOYEE_LIST);
    if (authUser?.employee_name?.trim()) {
      set.add(authUser.employee_name.trim());
    }
    if (shiftAssignments) {
      Object.values(shiftAssignments).forEach((sa) => {
        if (sa.supervisor?.trim()) set.add(sa.supervisor.trim());
        if (sa.executive?.trim()) set.add(sa.executive.trim());
      });
    }
    return Array.from(set).sort();
  }, [authUser, shiftAssignments]);
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

// ─── CellTimePicker ─────────────────────────────────────────────────────────
/**
 * Manual 12-hour (AM/PM) time picker for the Time columns. The trigger is
 * styled exactly like the other cell inputs; clicking it opens a compact
 * floating panel (same pattern as the HRP's bottle picker) with Hour /
 * Minute / AM-PM selects. The chosen time is committed through the SAME
 * controlled onChange path as every other cell, stored as "3:30 PM" — the
 * app's existing time-label convention. Times are NEVER auto-populated from
 * job schedules: an empty field stays empty until the operator picks a time.
 * The panel is position:fixed so the machine card's rounded-corner clipping
 * and the table's horizontal scroll can never cut it off, and it closes on
 * outside click, Escape or any scroll.
 */
const TIME_PANEL_WIDTH = 216;

/** Stored time shape: "h:mm AM/PM" (unpadded hour, padded minutes). */
const TIME_VALUE_RE = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/;

interface TimeDraft {
  h: string;
  m: string;
  ap: 'AM' | 'PM';
}

/** Parses a stored cell time back into picker parts; null when unparseable/empty. */
const parseTimeDraft = (value: string): TimeDraft | null => {
  const match = TIME_VALUE_RE.exec(value);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  if (h < 1 || h > 12 || mm < 0 || mm > 59) return null;
  return { h: String(h), m: pad(mm), ap: match[3].toUpperCase() === 'PM' ? 'PM' : 'AM' };
};

const TIME_HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const TIME_MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

const PANEL_SELECT_STYLE: React.CSSProperties = {
  ...CELL_INPUT_STYLE,
  flex: 1,
  minWidth: 0,
  height: '24px',
  padding: '2px 4px',
  textAlign: 'center',
  textAlignLast: 'center',
  cursor: 'pointer',
  appearance: 'auto',
};

const CellTimePicker: React.FC<{ value: string; onChange: (v: string) => void; style?: React.CSSProperties }> = ({ value, onChange, style }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TimeDraft>({ h: '12', m: '00', ap: 'AM' });
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — same behaviour as the HRP bottle picker.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // A fixed panel would float over stale coordinates once anything scrolls —
  // dismiss it on any scroll (capture phase also catches the table's own
  // horizontal scroller, keeping the panel always anchored to its trigger).
  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [open]);

  const openPanel = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const panelH = 46;
      // Flip above the trigger when there is no room below (bottom rows).
      const flip = rect.bottom + panelH + 8 > window.innerHeight && rect.top > panelH + 8;
      const top = flip ? rect.top - panelH - 2 : rect.bottom + 2;
      // Keep the panel inside the viewport on small screens.
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - TIME_PANEL_WIDTH - 8));
      setPanelPos({ top, left });
    }
    setDraft(parseTimeDraft(value) ?? { h: '12', m: '00', ap: 'AM' });
    setOpen(true);
  };

  const commitDraft = (next: TimeDraft) => {
    setDraft(next);
    // Same controlled onChange every other cell uses — the value goes straight
    // into the existing per-row state store under this row's 'time' field.
    onChange(`${parseInt(next.h, 10)}:${next.m} ${next.ap}`);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        title={value || 'Select time'}
        onFocus={(e) => focusCellBorder(e, true)}
        onBlur={(e) => focusCellBorder(e, false)}
        style={{
          ...CELL_INPUT_STYLE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '4px',
          cursor: 'pointer',
          textAlign: 'left',
          color: value ? C.textMain : '#94a3b8',
          ...(style ?? {}),
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value || '— Select time'}
        </span>
        <ChevronDown size={12} style={{ flexShrink: 0, color: '#94a3b8' }} />
      </button>
      {open && (
        <div
          style={{
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            zIndex: 1000,
            width: TIME_PANEL_WIDTH,
            maxWidth: 'calc(100vw - 16px)',
            padding: '8px',
            backgroundColor: C.white,
            border: `1px solid ${C.border}`,
            borderRadius: '6px',
            boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <select
            aria-label="Hour"
            value={draft.h}
            onChange={(e) => commitDraft({ ...draft, h: e.target.value })}
            style={PANEL_SELECT_STYLE}
          >
            {TIME_HOURS.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <select
            aria-label="Minute"
            value={draft.m}
            onChange={(e) => commitDraft({ ...draft, m: e.target.value })}
            style={PANEL_SELECT_STYLE}
          >
            {TIME_MINUTES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select
            aria-label="AM/PM"
            value={draft.ap}
            onChange={(e) => commitDraft({ ...draft, ap: e.target.value === 'PM' ? 'PM' : 'AM' })}
            style={PANEL_SELECT_STYLE}
          >
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
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
const thStyle = (isLast: boolean, minWidth?: string): React.CSSProperties => ({
  padding: '6px 8px',
  color: C.headerText,
  fontWeight: 700,
  fontSize: '10.5px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  borderBottom: `1px solid ${C.border}`,
  borderRight: isLast ? 'none' : `1px solid ${C.border}`,
  lineHeight: 1.3,
  verticalAlign: 'middle',
  backgroundColor: C.headerBg,
  whiteSpace: 'nowrap',
  minWidth: minWidth ?? '80px',
});

/** Data-cell <td> style — compact padding with the same borders as before. */
const cellTd = (align: 'left' | 'center' = 'center', isLast = false): React.CSSProperties => ({
  padding: '3px 6px',
  borderBottom: `1px solid ${C.border}`,
  borderRight: isLast ? 'none' : `1px solid ${C.border}`,
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
  borderBottom: `1px solid ${C.border}`,
});

/** Numbering table header cell — with section divider borders. */
const numThStyle = (colIndex: number, total: number, minWidth?: string, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  const isLast = colIndex === total - 1;
  const isSectionEnd = NUMBERING_SECTION_ENDS.has(colIndex);
  return {
    padding: '7px 6px',
    color: C.headerText,
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    borderBottom: `1px solid ${C.border}`,
    borderRight: isLast
      ? 'none'
      : isSectionEnd
        ? NUMBERING_SECTION_DIVIDER
        : `1px solid ${C.border}`,
    lineHeight: 1.3,
    verticalAlign: 'middle',
    backgroundColor: C.headerBg,
    whiteSpace: 'nowrap',
    minWidth: minWidth ?? '70px',
    textAlign: align,
    boxSizing: 'border-box',
  };
};

/** Numbering table data cell — with section divider borders. */
const numCellTd = (colIndex: number, total: number, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  const isLast = colIndex === total - 1;
  const isSectionEnd = NUMBERING_SECTION_ENDS.has(colIndex);
  return {
    padding: '3px 4px',
    borderBottom: `1px solid ${C.border}`,
    borderRight: isLast
      ? 'none'
      : isSectionEnd
        ? NUMBERING_SECTION_DIVIDER
        : `1px solid ${C.border}`,
    fontSize: '12px',
    color: C.textMain,
    textAlign: align,
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    height: '32px',
  };
};

/** SQC/QC HOLD header cell — mirrors Numbering's grouped-section dividers. */
const sqcThStyle = (colIndex: number, total: number, minWidth?: string, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  const isLast = colIndex === total - 1;
  const isSectionEnd = SQC_SECTION_ENDS.has(colIndex);
  return {
    padding: '7px 6px',
    color: C.headerText,
    fontWeight: 700,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    borderBottom: `1px solid ${C.border}`,
    borderRight: isLast ? 'none' : isSectionEnd ? NUMBERING_SECTION_DIVIDER : `1px solid ${C.border}`,
    lineHeight: 1.3,
    verticalAlign: 'middle',
    backgroundColor: C.headerBg,
    whiteSpace: 'nowrap',
    minWidth: minWidth ?? '70px',
    textAlign: align,
    boxSizing: 'border-box',
  };
};

/** SQC/QC HOLD data cell — mirrors Numbering's grouped-section dividers. */
const sqcCellTd = (colIndex: number, total: number, align: 'left' | 'center' = 'center'): React.CSSProperties => {
  const isLast = colIndex === total - 1;
  const isSectionEnd = SQC_SECTION_ENDS.has(colIndex);
  return {
    padding: '3px 4px',
    borderBottom: `1px solid ${C.border}`,
    borderRight: isLast ? 'none' : isSectionEnd ? NUMBERING_SECTION_DIVIDER : `1px solid ${C.border}`,
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
  anchor: string;
}

/** Manually added rows per layout, keyed `${dateKey}|${machineNo}`. */
type ExtraRowsStore = Record<string, ExtraRow[]>;

/** One rendered table row: a production run or a manually added row. */
type OrderedRow =
  | { kind: 'run'; run: JobRun; rowIdx: number; visualIdx: number }
  | { kind: 'extra'; extra: ExtraRow; visualIdx: number };

/**
 * Production runs interleaved with the machine's manually added rows: every
 * added row renders directly beneath the row its (+) button was clicked on —
 * its bottle's production row, or another added row — so added rows stay
 * grouped under their bottle name (Medley, Medley-added, Himalaya,
 * Himalaya-added) instead of collecting at the bottom of the machine table.
 * Rows added FROM an added row render immediately beneath it; added rows whose
 * anchor no longer exists fall back to the end of the table (in creation
 * order) so they can never become invisible.
 */
const buildOrderedRows = (rowRuns: JobRun[], extras: ExtraRow[]): OrderedRow[] => {
  const out: OrderedRow[] = [];
  const childrenOf = (anchor: string): ExtraRow[] => extras.filter((e) => e.anchor === anchor);
  const visited = new Set<number>();
  const pushExtraWithChildren = (extra: ExtraRow): void => {
    // Guard against a self-referencing anchor ever looping.
    if (visited.has(extra.id)) return;
    visited.add(extra.id);
    out.push({ kind: 'extra', extra, visualIdx: out.length });
    // Rows added FROM this added row render immediately beneath it.
    for (const child of childrenOf(`x:${extra.id}`)) pushExtraWithChildren(child);
  };
  rowRuns.forEach((run, rowIdx) => {
    out.push({ kind: 'run', run, rowIdx, visualIdx: out.length });
    for (const extra of childrenOf(`run:${rowIdx}`)) pushExtraWithChildren(extra);
  });
  // Orphans (stale anchor after a data change): a child always has a later
  // creation order than its parent, so this pass keeps parent-before-child.
  for (const extra of extras) {
    if (visited.has(extra.id)) continue;
    visited.add(extra.id);
    out.push({ kind: 'extra', extra, visualIdx: out.length });
  }
  return out;
};

const RePackingReport: React.FC<{ date: Date; layout?: 'numbering' | 'sqc' }> = ({ date, layout = 'numbering' }) => {
  const { bottles } = useERP();
  const { user: authUser } = useAuth();
  const machineNos = MACHINE_NOS;

  // ── Hourly Production Monitor data for the selected date ─────────────────
  // Loaded through the SAME existing repository call the Machine Wise report
  // and the Daily M/C Speed and Weight report use for the selected date —
  // no new endpoint, no change to any existing fetch.
  const [hourly, setHourly] = useState<QualityDayHourly>({});
  const [shiftAssignments, setShiftAssignments] = useState<QualityShiftMap>({});
  const [defectGroups, setDefectGroups] = useState<{ group: 'Critical' | 'Major' | 'Minor'; items: string[] }[]>([]);
  const [loadingDefects, setLoadingDefects] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimeoutRef = useRef<number | null>(null);

  // The date the stored `hourly` was loaded for. Rows are only ever built from
  // it while it matches the selected date, so a date change can never show
  // another day's jobs under the new date while the fetch is in flight.
  // Single open dropdown tracker: ensures only one Defects popover is open at a time
  const [openDefectCellKey, setOpenDefectCellKey] = useState<string | null>(null);

  // The date the stored `hourly` was loaded for. Rows are only ever built from
  // it while it matches the selected date, so a date change can never show
  // another day's jobs under the new date while the fetch is in flight.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const requestRef = useRef(0);

  // ── Editable per-row values (component session only — never persisted) ───
  // Kept per layout so switching NUMBERING ↔ SQC/QC HOLD preserves whatever
  // was entered, and keyed per date + machine + run so entries of one date
  // never leak into another date's rows.
  const [numberingValues, setNumberingValues] = useState<ValuesStore>({});
  const [sqcValues, setSqcValues] = useState<ValuesStore>({});

  // ── Manually added rows ((+) button in the JOB NAME column) ──────────────
  // Kept in ONE store per layout so the NUMBERING and SQC/QC HOLD row-add
  // sets are completely independent — adding rows in one tab never affects
  // the other — and keyed per date + machine so rows of one date never leak
  // into another date's tables. Values of added rows live in the same
  // per-layout cell-value stores as production rows, under their own keys.
  const [numberingExtras, setNumberingExtras] = useState<ExtraRowsStore>({});
  const [sqcExtras, setSqcExtras] = useState<ExtraRowsStore>({});
  // Monotonic id source — unique across every added row of both layouts.
  const extraIdRef = useRef(0);

  const dateKey = toIso(date);
  const dateLabel = toDisplay(date);

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

  // Load the existing HPR/Quality records for the selected date.
  useEffect(() => {
    void loadDay(dateKey);
    return () => {
      // Abandon the in-flight response when the selected date changes or the
      // report unmounts, so a late answer can never be written into state.
      requestRef.current += 1;
    };
  }, [dateKey, loadDay]);

  // Load defects master data grouped into Critical, Major, Minor (same as Quality Module)
  useEffect(() => {
    let active = true;
    qualityRepository
      .getDefects(true)
      .then((defects) => {
        if (!active) return;
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

  // Save button UI state handler
  const handleSaveClick = () => {
    if (saveState === 'saving') return;
    setSaveState('saving');
    if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = window.setTimeout(() => {
      setSaveState('saved');
      saveTimeoutRef.current = window.setTimeout(() => {
        setSaveState('idle');
      }, 2500);
    }, 600);
  };

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Employee roster for Checker Name and QA-Shift Ex. dropdowns
  // TODO: replace with employees fetched from DB
  const employeeList = useEmployeeList(shiftAssignments);

  // The hourly records of the SELECTED date's 24-hour window only. Entries are
  // never built from the store while it still holds another date, so the
  // report can only ever show the currently selected production day.
  const dayHourly: QualityDayHourly = loadedKey === dateKey ? hourly : EMPTY_DAY;

  // Available packing types per machine for the selected date,
  // computed from the Hourly Production Monitor records.
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

  // One entry per continuous same-bottle run per machine — the date-wise job
  // selection of the Machine Wise Production and Efficiency report: a single
  // job all day yields one entry, a mid-day job change yields one entry per
  // job, and multiple job changes stay distinct instead of being merged.
  const machineRuns = useMemo<Record<number, JobRun[]>>(() => {
    const out: Record<number, JobRun[]> = {};
    for (const machineNo of MACHINE_NOS) {
      out[machineNo] = splitMachineRuns(machineNo, dayHourly[String(machineNo)] ?? {});
    }
    return out;
  }, [dayHourly]);

  /** Job Name of one run — the bottle name from the production records. */
  const runJobName = useCallback(
    (run: JobRun): string => bottleNameFor(run.bottleId, bottles),
    [bottles]
  );
  /** Shift of one run — the shift its first production hour belongs to. */
  const runShift = (run: JobRun): string => String(run.points[0]?.slot.shift_id ?? 1);
  /**
   * Time of one run — its actual production interval. Retained unchanged for
   * compatibility; the Time column is now a MANUAL time picker and is no
   * longer pre-filled from the job schedule.
   */
  const runTime = (run: JobRun): string => runIntervalLabel(run);

  /**
   * Stable per-row key: one editable row per date + machine + production run.
   * The bottle and interval are part of the key so a later data change (new
   * job split) addresses the correct run instead of inheriting another row's
   * typed values.
   */
  const rowKeyFor = (machineNo: number, run: JobRun, rowIndex: number): string =>
    `${dateKey}|${machineNo}|${rowIndex}|${run.bottleId || 'job'}|${run.runKey}`;

  const cellValue = (store: ValuesStore, key: string, field: string, fallback: string): string =>
    store[key]?.[field] ?? fallback;

  const setNumberingCell = useCallback((key: string, field: string, value: string) => {
    setNumberingValues((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [field]: value } }));
  }, []);
  const setSqcCell = useCallback((key: string, field: string, value: string) => {
    setSqcValues((prev) => ({ ...prev, [key]: { ...(prev[key] ?? {}), [field]: value } }));
  }, []);

  /** Per-layout, per-date key of a machine's manually added rows. */
  const extraRowsKey = (machineNo: number): string => `${dateKey}|${machineNo}`;

  /** Stable per-row key of one manually added row — distinct from every
   * production row key, so its fields resolve independently. */
  const extraRowKey = (machineNo: number, extraId: number): string =>
    `${dateKey}|${machineNo}|x|${extraId}`;

  /**
   * (+) row-add: creates a new row anchored to the row whose button was
   * clicked — `run:<productionRowIdx>` for a bottle's production row or
   * `x:<addedRowId>` for another added row — so it is inserted IMMEDIATELY
   * BELOW that row (inside the same bottle's group), never after the next
   * bottle or at the bottom of the machine table. The bottle/job name and
   * shift are prefilled. Writes only to the chosen layout's store, so
   * NUMBERING and SQC/QC HOLD row-add stay fully independent. Any number of
   * rows may be added for the same bottle.
   */
  const addExtraRow = (
    target: 'numbering' | 'sqc',
    machineNo: number,
    anchor: string,
    jobName: string,
    shift: string
  ) => {
    const row: ExtraRow = { id: (extraIdRef.current += 1), jobName, shift, anchor };
    const setter = target === 'numbering' ? setNumberingExtras : setSqcExtras;
    const storeKey = extraRowsKey(machineNo);
    setter((prev) => ({ ...prev, [storeKey]: [...(prev[storeKey] ?? []), row] }));
  };

  /**
   * (-) row-remove: deletes ONE manually added row from the chosen layout's
   * store and clears the values typed into it. Rows added FROM the removed
   * row are re-anchored to the removed row's own anchor, so they stay grouped
   * under the same bottle instead of vanishing or jumping elsewhere. Writes
   * only to that layout, so NUMBERING and SQC/QC HOLD row removal stays fully
   * independent, and production rows are never touched.
   */
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
    // Drop the removed row's typed values so nothing lingers for a future row.
    const valuesSetter = target === 'numbering' ? setNumberingValues : setSqcValues;
    valuesSetter((prev) => {
      if (!(rowKey in prev)) return prev;
      const next = { ...prev };
      delete next[rowKey];
      return next;
    });
  };

  /** Loading / error / empty status shown in a machine's body when it has no entries. */
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
        gap: '12px',
        paddingBottom: '8px',
      }}
    >
      {/* Save Button (UI Only) — Upper-right corner above the table */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          width: '100%',
          padding: '0 2px',
          boxSizing: 'border-box',
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

      {/* The NUMBERING / SQC/QC HOLD switch lives in the main navigation bar
          of the parent module (QualityControlModule) — the `layout` prop
          selects which report is rendered below. */}

      {layout === 'numbering' && (
        <>
          {machineNos.map((machineNo, machineIdx) => {
            const runs = machineRuns[machineNo] ?? [];
            const rowRuns = runs.filter((run) => run.points.length > 0);
            // Manually added rows for THIS machine (NUMBERING store only —
            // independent from the SQC/QC HOLD set), interleaved with the
            // production rows so each added row sits directly below the row
            // its (+) button was clicked on.
            const extras = numberingExtras[extraRowsKey(machineNo)] ?? [];
            const orderedRows = buildOrderedRows(rowRuns, extras);
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
                        // Production and added rows share the exact same 12
                        // cells — only the prefill fallbacks, the row key and
                        // the buttons differ.
                        const key =
                          row.kind === 'extra'
                            ? extraRowKey(machineNo, row.extra.id)
                            : rowKeyFor(machineNo, row.run, row.rowIdx);
                        const jobNameFallback =
                          row.kind === 'extra' ? row.extra.jobName : runJobName(row.run);
                        const shiftFallback =
                          row.kind === 'extra' ? row.extra.shift : runShift(row.run);
                        // Anchor of a row added FROM this row: its bottle's
                        // production row, or this added row itself — so the new
                        // row is inserted immediately below this one.
                        const anchor =
                          row.kind === 'extra' ? `x:${row.extra.id}` : `run:${row.rowIdx}`;
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
                                      cellValue(numberingValues, key, 'shift', shiftFallback)
                                    )
                                  }
                                />
                                {extraId >= 0 && (
                                  <RemoveRowButton
                                    title="Remove this row"
                                    onClick={() => removeExtraRow('numbering', machineNo, extraId)}
                                  />
                                )}
                              </div>
                            </td>
                            <td style={numCellTd(1, NUMBERING_COLUMNS.length)}>
                              <PackTypeCell
                                value={cellValue(numberingValues, key, 'packType', '')}
                                onChange={(v) => setNumberingCell(key, 'packType', v)}
                                machineNo={machineNo}
                                packingTypes={packingTypesPerMachine[machineNo] ?? []}
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
                                value={cellValue(numberingValues, key, 'time', '')}
                                onChange={(v) => setNumberingCell(key, 'time', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(4, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'pcsPack', '')}
                                onChange={(v) => setNumberingCell(key, 'pcsPack', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(5, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'cartons', '')}
                                onChange={(v) => setNumberingCell(key, 'cartons', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(6, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'noOfBottle', '')}
                                onChange={(v) => setNumberingCell(key, 'noOfBottle', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(7, NUMBERING_COLUMNS.length)}>
                              <CellDefectsDropdown
                                cellKey={`num|${key}`}
                                activeOpenKey={openDefectCellKey}
                                onToggleOpen={setOpenDefectCellKey}
                                value={cellValue(numberingValues, key, 'defects', '')}
                                onChange={(v) => setNumberingCell(key, 'defects', v)}
                                defectGroups={defectGroups}
                                isLoading={loadingDefects}
                              />
                            </td>
                            <td style={numCellTd(8, NUMBERING_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'mould', '')}
                                onChange={(v) => setNumberingCell(key, 'mould', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(9, NUMBERING_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'sectionNo', '')}
                                onChange={(v) => setNumberingCell(key, 'sectionNo', v)}
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(10, NUMBERING_COLUMNS.length, 'left')}>
                              <CellEmployeeSelect
                                value={cellValue(numberingValues, key, 'checkerName', '')}
                                onChange={(v) => setNumberingCell(key, 'checkerName', v)}
                                options={employeeList}
                                placeholder="Select Checker"
                                align="left"
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                            <td style={numCellTd(11, NUMBERING_COLUMNS.length, 'center')}>
                              <CellEmployeeSelect
                                value={cellValue(numberingValues, key, 'qaShiftEx', '')}
                                onChange={(v) => setNumberingCell(key, 'qaShiftEx', v)}
                                options={employeeList}
                                placeholder="Select QA Ex."
                                align="center"
                                style={NUMBERING_INPUT_STYLE}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {/* Empty / status state — only when there are NO rows at all */}
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
            // Manually added rows for THIS machine (SQC store only —
            // independent from the NUMBERING set), interleaved with the
            // production rows so each added row sits directly below the row
            // its (+) button was clicked on.
            const extras = sqcExtras[extraRowsKey(machineNo)] ?? [];
            const orderedRows = buildOrderedRows(rowRuns, extras);
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
                        // Production and added rows share the exact same 13
                        // cells — only the prefill fallbacks, the row key and
                        // the buttons differ.
                        const key =
                          row.kind === 'extra'
                            ? extraRowKey(machineNo, row.extra.id)
                            : rowKeyFor(machineNo, row.run, row.rowIdx);
                        const jobNameFallback =
                          row.kind === 'extra' ? row.extra.jobName : runJobName(row.run);
                        const shiftFallback =
                          row.kind === 'extra' ? row.extra.shift : runShift(row.run);
                        // Anchor of a row added FROM this row: its bottle's
                        // production row, or this added row itself — so the new
                        // row is inserted immediately below this one.
                        const anchor =
                          row.kind === 'extra' ? `x:${row.extra.id}` : `run:${row.rowIdx}`;
                        const extraId = row.kind === 'extra' ? row.extra.id : -1;
                        return (
                          <tr key={key} style={{ backgroundColor: row.visualIdx % 2 === 0 ? C.white : '#f8fafc', height: '32px' }}>
                            <td style={sqcCellTd(0, SQC_COLUMNS.length)}>
                              <CellShiftSelect
                                value={cellValue(sqcValues, key, 'shift', shiftFallback)}
                                onChange={(v) => setSqcCell(key, 'shift', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(1, SQC_COLUMNS.length)}>
                              <CellTimePicker
                                value={cellValue(sqcValues, key, 'time', '')}
                                onChange={(v) => setSqcCell(key, 'time', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(2, SQC_COLUMNS.length, 'left')}>
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
                                      cellValue(sqcValues, key, 'shift', shiftFallback)
                                    )
                                  }
                                />
                                {extraId >= 0 && (
                                  <RemoveRowButton
                                    title="Remove this row"
                                    onClick={() => removeExtraRow('sqc', machineNo, extraId)}
                                  />
                                )}
                              </div>
                            </td>
                            <td style={sqcCellTd(3, SQC_COLUMNS.length)}>
                              <PackTypeCell
                                value={cellValue(sqcValues, key, 'packType', '')}
                                onChange={(v) => setSqcCell(key, 'packType', v)}
                                machineNo={machineNo}
                                packingTypes={packingTypesPerMachine[machineNo] ?? []}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(4, SQC_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'lotNo', '')}
                                onChange={(v) => setSqcCell(key, 'lotNo', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(5, SQC_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'pcsPack', '')}
                                onChange={(v) => setSqcCell(key, 'pcsPack', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(6, SQC_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'cartons', '')}
                                onChange={(v) => setSqcCell(key, 'cartons', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(7, SQC_COLUMNS.length)}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'noOfBottle', '')}
                                onChange={(v) => setSqcCell(key, 'noOfBottle', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(8, SQC_COLUMNS.length)}>
                              <CellDefectsDropdown
                                cellKey={`sqc|${key}`}
                                activeOpenKey={openDefectCellKey}
                                onToggleOpen={setOpenDefectCellKey}
                                value={cellValue(sqcValues, key, 'defects', '')}
                                onChange={(v) => setSqcCell(key, 'defects', v)}
                                defectGroups={defectGroups}
                                isLoading={loadingDefects}
                              />
                            </td>
                            <td style={sqcCellTd(9, SQC_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'mould', '')}
                                onChange={(v) => setSqcCell(key, 'mould', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(10, SQC_COLUMNS.length)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'section', '')}
                                onChange={(v) => setSqcCell(key, 'section', v)}
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(11, SQC_COLUMNS.length, 'left')}>
                              <CellEmployeeSelect
                                value={cellValue(sqcValues, key, 'checkerName', '')}
                                onChange={(v) => setSqcCell(key, 'checkerName', v)}
                                options={employeeList}
                                placeholder="Select Checker"
                                align="left"
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                            <td style={sqcCellTd(12, SQC_COLUMNS.length, 'center')}>
                              <CellEmployeeSelect
                                value={cellValue(sqcValues, key, 'qaShiftEx', '')}
                                onChange={(v) => setSqcCell(key, 'qaShiftEx', v)}
                                options={employeeList}
                                placeholder="Select QA Ex."
                                align="center"
                                style={SQC_INPUT_STYLE}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {/* Empty / status state — only when there are NO rows at all */}
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
    </div>
  );
};

export default RePackingReport;
