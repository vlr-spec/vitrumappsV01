/**
 * Re-PackingReport.tsx — Re-Packing Report with NUMBERING and SQC/QC HOLD layouts.
 *
 * Two-layout Re-Packing Report rendered as a compact ERP dashboard: light
 * page background, white machine cards with subtle borders / rounded corners
 * / minimal shadows, and blue (#2563EB) as the primary accent.
 *   • NUMBERING (default): 4 machine tables with columns
 *     Job Name | Shift | Time | Pcs/Pack | Cartons | No. of Bottles | Defects | Lot No. | Mould | Section No. | Checker Name | QA-Shift Ex.
 *   • SQC/QC HOLD: 4 machine tables with columns
 *     Job Name | Time | Shift | Lot No. | Mould | Section | Defects | Pcs/Pack | Cartons | No. of Bottles | Checker Name | QA-Shift Ex.
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
import { ChevronDown } from 'lucide-react';
import { useERP } from '../../context/ERPContext';
import {
  qualityRepository,
  QualityDayHourly,
  QualityHourlyEntry,
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
  'Job Name', 'Shift', 'Time', 'Pcs/Pack', 'Cartons', 'No. of Bottles',
  'Defects', 'Lot No.', 'Mould', 'Section No.', 'Checker Name', 'QA-Shift Ex.',
];

const SQC_COLUMNS = [
  'Job Name', 'Time', 'Shift', 'Lot No.', 'Mould', 'Section', 'Defects',
  'Pcs/Pack', 'Cartons', 'No. of Bottles', 'Checker Name', 'QA-Shift Ex.',
];

/** Minimum rendered table width — below it the card body scrolls horizontally. */
// 12 columns (one 80px default-width column more than the original 11) at the
// same per-column minimums, so every column keeps its existing width and the
// card body just starts scrolling horizontally a little earlier.
const TABLE_MIN_WIDTH = '1140px';

const EMPTY_DAY: QualityDayHourly = {};

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
  padding: '3px 8px',
  fontSize: '12px',
  lineHeight: 1.3,
  backgroundColor: C.white,
  border: `1px solid ${C.border}`,
  borderRadius: '6px',
  outline: 'none',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

const focusCellBorder = (
  e: React.FocusEvent<HTMLElement>,
  focused: boolean
) => {
  e.currentTarget.style.borderColor = focused ? C.blueActive : C.border;
  // Soft blue focus ring, matching the modern ERP card inputs.
  e.currentTarget.style.boxShadow = focused ? '0 0 0 2px rgba(37, 99, 235, 0.12)' : 'none';
};

/** Editable text cell — left-aligned for names, centered otherwise. */
const CellTextInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  align?: 'left' | 'center';
  placeholder?: string;
}> = ({ value, onChange, align = 'center', placeholder }) => (
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
    }}
  />
);

/** Editable numeric cell — same typing-only behaviour as the HRP NumInput. */
const CellNumInput: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
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
        } as React.CSSProperties
      }
    />
  );
};

/** Editable shift dropdown — prefilled from the run's production shift. */
const CellShiftSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
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
    }}
  >
    <option value="1">Shift 1</option>
    <option value="2">Shift 2</option>
    <option value="3">Shift 3</option>
  </select>
);

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

const CellTimePicker: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
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
  const machineNos = MACHINE_NOS;

  // ── Hourly Production Monitor data for the selected date ─────────────────
  // Loaded through the SAME existing repository call the Machine Wise report
  // and the Daily M/C Speed and Weight report use for the selected date —
  // no new endpoint, no change to any existing fetch.
  const [hourly, setHourly] = useState<QualityDayHourly>({});
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
      const { hourly: day, ok, error } = await qualityRepository.load(targetKey);
      if (token !== requestRef.current) return;
      setLoading(false);
      if (ok === false) {
        setLoadError(error || 'Could not load saved data.');
        setLoadedKey(targetKey);
        setHourly({});
        return;
      }
      setLoadError('');
      setLoadedKey(targetKey);
      setHourly(day ?? {});
    } catch (err) {
      if (token !== requestRef.current) return;
      setLoading(false);
      setLoadError(err instanceof Error && err.message ? err.message : 'Could not load saved data.');
      setLoadedKey(targetKey);
      setHourly({});
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

  // The hourly records of the SELECTED date's 24-hour window only. Entries are
  // never built from the store while it still holds another date, so the
  // report can only ever show the currently selected production day.
  const dayHourly: QualityDayHourly = loadedKey === dateKey ? hourly : EMPTY_DAY;

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
    <div style={{ padding: '16px 20px', backgroundColor: '#f8fafc', minHeight: '100%' }}>
      {/* The NUMBERING / SQC/QC HOLD switch lives in the main navigation bar
          of the parent module (QualityControlModule) — the `layout` prop
          selects which report is rendered below. */}

      {/* Date filter and navigation preserved from parent - via useERP context */}
      {/* The parent component provides dateKey, dateLabel, shift navigation etc. */}

      {layout === 'numbering' && (
        <div>
          <div style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '4px', height: '15px', borderRadius: '2px', backgroundColor: '#2563EB', display: 'inline-block' }} />
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#1e293b' }}>
              Re-Packing Report — Numbering
            </h3>
          </div>
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
              <div key={machineNo} style={{ marginBottom: '12px', backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: '10px', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px', borderBottom: `1px solid ${C.border}`, backgroundColor: C.white }}>
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
                    }}
                  >
                    {machineNo}
                  </span>
                  <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#1e293b' }}>
                    Machine {machineNo}
                  </h4>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      minWidth: TABLE_MIN_WIDTH,
                    }}
                  >
                    <thead>
                      <tr style={{ backgroundColor: C.headerBg }}>
                        {NUMBERING_COLUMNS.map((col, idx) => (
                          <th
                            key={col}
                            style={{
                              ...thStyle(idx === NUMBERING_COLUMNS.length - 1, col === 'Job Name' ? '140px' : col === 'Checker Name' ? '110px' : '80px'),
                              textAlign: col === 'Job Name' || col === 'Checker Name' ? 'left' : 'center',
                            }}
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
                          <tr key={key} style={{ backgroundColor: row.visualIdx % 2 === 0 ? C.white : '#f8fafc' }}>
                            <td style={cellTd('left')}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <CellTextInput
                                    value={cellValue(numberingValues, key, 'jobName', jobNameFallback)}
                                    onChange={(v) => setNumberingCell(key, 'jobName', v)}
                                    align="left"
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
                            <td style={cellTd()}>
                              <CellShiftSelect
                                value={cellValue(numberingValues, key, 'shift', shiftFallback)}
                                onChange={(v) => setNumberingCell(key, 'shift', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellTimePicker
                                value={cellValue(numberingValues, key, 'time', '')}
                                onChange={(v) => setNumberingCell(key, 'time', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'pcsPack', '')}
                                onChange={(v) => setNumberingCell(key, 'pcsPack', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'cartons', '')}
                                onChange={(v) => setNumberingCell(key, 'cartons', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'noOfBottle', '')}
                                onChange={(v) => setNumberingCell(key, 'noOfBottle', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'defects', '')}
                                onChange={(v) => setNumberingCell(key, 'defects', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'lotNo', '')}
                                onChange={(v) => setNumberingCell(key, 'lotNo', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'mould', '')}
                                onChange={(v) => setNumberingCell(key, 'mould', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(numberingValues, key, 'sectionNo', '')}
                                onChange={(v) => setNumberingCell(key, 'sectionNo', v)}
                              />
                            </td>
                            <td style={cellTd('left')}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'checkerName', '')}
                                onChange={(v) => setNumberingCell(key, 'checkerName', v)}
                                align="left"
                              />
                            </td>
                            <td style={cellTd('center', true)}>
                              <CellTextInput
                                value={cellValue(numberingValues, key, 'qaShiftEx', '')}
                                onChange={(v) => setNumberingCell(key, 'qaShiftEx', v)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {/* Empty / status state — only when there are NO rows at all */}
                      {orderedRows.length === 0 && (
                        <tr>
                          <td colSpan={12} style={emptyStateTd(12)}>
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
        </div>
      )}

      {layout === 'sqc' && (
        <div>
          <div style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '4px', height: '15px', borderRadius: '2px', backgroundColor: '#2563EB', display: 'inline-block' }} />
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#1e293b' }}>
              Re-Packing Report — SQC/QC HOLD
            </h3>
          </div>
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
              <div key={machineNo} style={{ marginBottom: '12px', backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: '10px', boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px', borderBottom: `1px solid ${C.border}`, backgroundColor: C.white }}>
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
                    }}
                  >
                    {machineNo}
                  </span>
                  <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: '#1e293b' }}>
                    Machine {machineNo}
                  </h4>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      minWidth: TABLE_MIN_WIDTH,
                    }}
                  >
                    <thead>
                      <tr style={{ backgroundColor: C.headerBg }}>
                        {SQC_COLUMNS.map((col, idx) => (
                          <th
                            key={col}
                            style={{
                              ...thStyle(idx === SQC_COLUMNS.length - 1, col === 'Job Name' ? '140px' : col === 'Checker Name' ? '110px' : col === 'Time' ? '130px' : '80px'),
                              textAlign: col === 'Job Name' || col === 'Checker Name' ? 'left' : 'center',
                            }}
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
                          <tr key={key} style={{ backgroundColor: row.visualIdx % 2 === 0 ? C.white : '#f8fafc' }}>
                            <td style={cellTd('left')}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <CellTextInput
                                    value={cellValue(sqcValues, key, 'jobName', jobNameFallback)}
                                    onChange={(v) => setSqcCell(key, 'jobName', v)}
                                    align="left"
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
                            <td style={cellTd()}>
                              <CellTimePicker
                                value={cellValue(sqcValues, key, 'time', '')}
                                onChange={(v) => setSqcCell(key, 'time', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellShiftSelect
                                value={cellValue(sqcValues, key, 'shift', shiftFallback)}
                                onChange={(v) => setSqcCell(key, 'shift', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'lotNo', '')}
                                onChange={(v) => setSqcCell(key, 'lotNo', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'mould', '')}
                                onChange={(v) => setSqcCell(key, 'mould', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'section', '')}
                                onChange={(v) => setSqcCell(key, 'section', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'defects', '')}
                                onChange={(v) => setSqcCell(key, 'defects', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'pcsPack', '')}
                                onChange={(v) => setSqcCell(key, 'pcsPack', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'cartons', '')}
                                onChange={(v) => setSqcCell(key, 'cartons', v)}
                              />
                            </td>
                            <td style={cellTd()}>
                              <CellNumInput
                                value={cellValue(sqcValues, key, 'noOfBottle', '')}
                                onChange={(v) => setSqcCell(key, 'noOfBottle', v)}
                              />
                            </td>
                            <td style={cellTd('left')}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'checkerName', '')}
                                onChange={(v) => setSqcCell(key, 'checkerName', v)}
                                align="left"
                              />
                            </td>
                            <td style={cellTd('center', true)}>
                              <CellTextInput
                                value={cellValue(sqcValues, key, 'qaShiftEx', '')}
                                onChange={(v) => setSqcCell(key, 'qaShiftEx', v)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {/* Empty / status state — only when there are NO rows at all */}
                      {orderedRows.length === 0 && (
                        <tr>
                          <td colSpan={12} style={emptyStateTd(12)}>
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
        </div>
      )}
    </div>
  );
};

export default RePackingReport;
