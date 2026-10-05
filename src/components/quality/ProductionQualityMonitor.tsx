import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Printer, Download, CalendarDays } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { useERP } from '../../context/ERPContext';
import { useAuth, MODULES } from '../../context/AuthContext';
import { BottleMaster } from '../../types';
import { qualityRepository, QualityHourlyEntry, QualityShiftMap, QualityDayLoad, QualityDayHourly, hasMeaningfulData } from '../../services/qualityRepository';
import { COMPANY_NAME, getReportHeaderLines } from '../../utils/reportHeader';
import { calculateTheoreticalBottles } from '../../utils/calculations';
import QualityReport from './QualityReport';
import AllMachineReport from './AllMachineReport';

// ═══════════════════════════════════════════════════════════════════════════
// Shift master — mirrors the production.shift_master table
// ═══════════════════════════════════════════════════════════════════════════
const DB_SHIFT_MASTER = [
  { shift_id: 1, shift_name: 'Shift 1', start_time: '09:00', end_time: '17:00', display_time: '9:00 AM – 5:00 PM' },
  { shift_id: 2, shift_name: 'Shift 2', start_time: '17:00', end_time: '01:00', display_time: '5:00 PM – 1:00 AM' },
  { shift_id: 3, shift_name: 'Shift 3', start_time: '01:00', end_time: '09:00', display_time: '1:00 AM – 9:00 AM' },
];

// ═══════════════════════════════════════════════════════════════════════════
// Machine master — gob_type determines F/M/R vs F/R weight columns
// (ERPContext machines provide live gob counts; these are the defaults)
// ═══════════════════════════════════════════════════════════════════════════
const DB_MACHINE_MASTER = [
  { machine_no: 1, gob_type: '3-gob' },
  { machine_no: 2, gob_type: '2-gob' },
  { machine_no: 3, gob_type: '2-gob' },
  { machine_no: 4, gob_type: '3-gob' },
];



const GROUP_STYLE: Record<string, { color: string; bg: string; border: string }> = {
  Critical: { color: '#be123c', bg: '#fff1f2', border: '#fecdd3' },
  Major: { color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  Minor: { color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
};

// ═══════════════════════════════════════════════════════════════════════════
// Packing options + 24 hourly slots keyed to shift_id
// ═══════════════════════════════════════════════════════════════════════════
const PACKING_OPTIONS = [
  'ST',
  'SN',
  'SB',
  'BT',
  'PP',
];

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

const SHIFT_LABELS = ['Shift 1', 'Shift 2', 'Shift 3'];
const SHIFT_ROW_BG = ['#f4f8ff', '#f3fdf6', '#fffdf2'];
const SHIFT_CELL_BG = ['#eaf2ff', '#e8faf0', '#fffce8'];
const SHIFT_CELL_COLOR = ['#3b72cc', '#2d8a58', '#b07c1a'];
const SHIFT_BORDERS = ['#c7daff', '#b6efd1', '#f0dfa0'];

const C = {
  border: '#e2e8f0',
  headerBg: '#f8fafc',
  headerText: '#1e293b',
  textMain: '#1e293b',
  textMuted: '#64748b',
  white: '#ffffff',
};

// ═══════════════════════════════════════════════════════════════════════════
// Auto-save — every edit is persisted to the database without pressing Save
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Quiet period after the last keystroke / click before the changed rows are
 * written. Long enough to collapse a burst of typing in one cell into a single
 * request, short enough that the database is current within a second or two of
 * the operator stopping.
 */
const AUTO_SAVE_DEBOUNCE_MS = 1200;

/** How long a "Saved" / "Save failed" chip stays on screen before resetting. */
const AUTO_SAVE_STATUS_RESET_MS = 4000;

/** Backoff schedule (ms) for retrying a failed auto-save. Idempotent: the
 *  backend upserts by (report_id, machine_no, time), so a retry can never
 *  create a duplicate row. */
const AUTO_SAVE_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];

/** Lifecycle of the auto-save indicator shown in the save bar. */
type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * The only fields a save response is allowed to change on an existing row.
 * Used to detect "nothing actually changed" so an unchanged row keeps its
 * object identity and the memoized row component does not re-render.
 */
const MERGED_ROW_FIELDS = ['entry_id', 'report_id', 'job_id', 'bottle_id'] as const;

const AUTO_SAVE_STATUS_VIEW: Record<AutoSaveStatus, { label: string; color: string }> = {
  idle: { label: '', color: '#94a3b8' },
  pending: { label: 'Unsaved changes', color: '#b45309' },
  saving: { label: 'Saving...', color: '#2563eb' },
  saved: { label: 'Saved', color: '#15803d' },
  error: { label: 'Save failed', color: '#b91c1c' },
};

// ─── NumInput ──────────────────────────────────────────────────────────────
const NumInput: React.FC<{ value: string; onChange: (v: string) => void; disabled?: boolean }> = ({ value, onChange, disabled = false }) => {
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
      disabled={disabled}
      onKeyDown={blockArrowStep}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        padding: '3px 4px',
        fontSize: '12px',
        color: value ? C.textMain : '#94a3b8',
        backgroundColor: 'transparent',
        border: '1px solid transparent',
        borderRadius: '4px',
        outline: 'none',
        textAlign: 'center',
        transition: 'border-color 0.15s',
        MozAppearance: 'textfield',
        cursor: disabled ? 'not-allowed' : undefined,
        opacity: disabled ? 0.6 : 1,
      } as React.CSSProperties}
      onFocus={(e) => { e.currentTarget.style.borderColor = '#2563eb'; }}
      onBlur={(e) => { e.currentTarget.style.borderColor = 'transparent'; }}
    />
  );
};

// ─── EffBadge ──────────────────────────────────────────────────────────────
const EffBadge: React.FC<{ val: string }> = ({ val }) => {
  if (!val) return null;
  const n = parseFloat(val);
  const color = n >= 90 ? '#15803d' : n >= 80 ? '#b45309' : '#dc2626';
  const bg = n >= 90 ? '#f0fdf4' : n >= 80 ? '#fffbeb' : '#fff1f2';
  const border = n >= 90 ? '#bbf7d0' : n >= 80 ? '#fde68a' : '#fecaca';
  return (
    <span
      style={{
        display: 'inline-block',
        backgroundColor: bg,
        color,
        border: `1px solid ${border}`,
        borderRadius: '4px',
        padding: '1px 6px',
        fontSize: '11.5px',
        fontWeight: 600,
      }}
    >
      {val}%
    </span>
  );
};

// ─── DefectDropdown ────────────────────────────────────────────────────────
const DefectDropdown: React.FC<{
  selected: string[];
  onChange: (v: string[]) => void;
  defectGroups: { group: 'Critical' | 'Major' | 'Minor'; items: string[] }[];
  isLoading?: boolean;
  disabled?: boolean;
}> = ({ selected, onChange, defectGroups, isLoading = false, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (item: string) => {
    if (disabled) return;
    onChange(selected.includes(item) ? selected.filter((x) => x !== item) : [...selected, item]);
  };

  const q = search.toLowerCase();
  const filtered = defectGroups.map((g) => ({
    ...g,
    items: g.items.filter((d) => d.toLowerCase().includes(q)),
  })).filter((g) => g.items.length > 0);

  const MAX_TAGS = 2;
  const visible = selected.slice(0, MAX_TAGS);
  const extra = selected.length - MAX_TAGS;

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: '180px' }}>
      <div
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '3px',
          minHeight: '30px',
          padding: '3px 6px',
          border: `1px solid ${open ? '#2563eb' : '#e2e8f0'}`,
          borderRadius: '5px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          backgroundColor: '#ffffff',
          boxShadow: open ? '0 0 0 2px #dbeafe' : 'none',
          transition: 'border-color 0.15s',
        }}
      >
        {selected.length === 0 ? (
          <span style={{ fontSize: '11.5px', color: '#94a3b8' }}>
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
                    gap: '3px',
                    backgroundColor: s.bg,
                    color: s.color,
                    border: `1px solid ${s.border}`,
                    borderRadius: '3px',
                    padding: '1px 5px',
                    fontSize: '10.5px',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {d}
                  <span
                    onMouseDown={(e) => { e.stopPropagation(); toggle(d); }}
                    style={{ cursor: 'pointer', lineHeight: 1, opacity: 0.7, fontSize: '11px' }}
                  >
                    ×
                  </span>
                </span>
              );
            })}
            {extra > 0 && (
              <span
                style={{
                  fontSize: '10.5px',
                  color: '#2563eb',
                  fontWeight: 600,
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: '3px',
                  padding: '1px 6px',
                  whiteSpace: 'nowrap',
                }}
              >
                +{extra} more
              </span>
            )}
          </>
        )}
        <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: '10px', paddingLeft: '4px' }}>▾</span>
      </div>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 999,
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '7px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            width: '300px',
            maxHeight: '360px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
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
                        onMouseEnter={(e) => { if (!checked) e.currentTarget.style.backgroundColor = '#f8fafc'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = checked ? '#f8faff' : 'transparent'; }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(item)}
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
              }}
            >
              <span style={{ fontSize: '11.5px', color: '#64748b' }}>{selected.length} selected</span>
              <button
                onMouseDown={(e) => { e.preventDefault(); onChange([]); }}
                style={{ fontSize: '11.5px', color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: '0' }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── PackingMultiSelect ────────────────────────────────────────────────────
const PackingMultiSelect: React.FC<{ selected: string[]; onChange: (v: string[]) => void; disabled?: boolean }> = ({ selected: rawSelected, onChange, disabled = false }) => {
  const selected = Array.isArray(rawSelected) ? rawSelected : [];
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const toggle = (item: string) => {
    if (disabled) return;
    onChange(selected.includes(item) ? selected.filter((x) => x !== item) : [...selected, item]);
  };

  const label = selected.length === 0 ? '—' : selected.length === 1 ? selected[0] : `${selected[0]} +${selected.length - 1}`;
  const hasVal = selected.length > 0;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div
        onClick={() => { if (!disabled) setOpen((o) => !o); }}
        style={{
          padding: '3px 5px',
          fontSize: '11px',
          fontWeight: hasVal ? 600 : 400,
          color: hasVal ? '#2563eb' : '#94a3b8',
          backgroundColor: hasVal ? '#dbeafe' : 'transparent',
          border: `1px solid ${open ? '#2563eb' : hasVal ? '#bfdbfe' : '#e2e8f0'}`,
          borderRadius: '4px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: '80px',
          userSelect: 'none',
        }}
      >
        {label}
      </div>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 3px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 999,
            backgroundColor: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: '6px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.1)',
            minWidth: '90px',
            overflow: 'hidden',
          }}
        >
          {PACKING_OPTIONS.map((opt) => {
            const checked = selected.includes(opt);
            return (
              <label
                key={opt}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '6px 10px',
                  fontSize: '12px',
                  color: '#1e293b',
                  cursor: 'pointer',
                  backgroundColor: checked ? '#f0f5ff' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(opt)}
                  style={{ accentColor: '#2563eb', width: '13px', height: '13px', flexShrink: 0 }}
                />
                {opt}
              </label>
            );
          })}
          {selected.length > 0 && (
            <div style={{ borderTop: '1px solid #f1f5f9', padding: '5px 10px', textAlign: 'right' }}>
              <button
                onMouseDown={(e) => { e.preventDefault(); onChange([]); }}
                style={{ fontSize: '11px', color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Helpers ───────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
/** Parses a native date-input value (YYYY-MM-DD) as a local calendar day. */
const fromIso = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
};

type DefectGroup = { group: 'Critical' | 'Major' | 'Minor'; items: string[] };

const calcBottlesInNos = (e?: QualityHourlyEntry): string => {
  const ps = parseInt(e?.packing_size ?? '');
  const ct = parseInt(e?.cartons ?? '');
  return ps > 0 && ct > 0 ? String(ps * ct) : '';
};

/**
 * Efficiency % of an hourly row = actual bottles (packing size × cartons)
 * ÷ that row's theoretical "As Per Speed" bottles × 100, where the theoretical
 * quantity uses the machine's own Gob count (see calculateTheoreticalBottles).
 */
const calcEffForEntry = (e?: QualityHourlyEntry, gobCount = 0): string => {
  if (!e?.bottle_id || !e.packing_size || !e.cartons) return '';
  const bottlesN = parseInt(e.packing_size) * parseInt(e.cartons);
  const speed = parseFloat(e.speed_per_min);
  const theoretical = calculateTheoreticalBottles(speed, gobCount);
  if (!bottlesN || theoretical <= 0) return '';
  return ((bottlesN / theoretical) * 100).toFixed(1);
};

const calcRowAverage = (e: QualityHourlyEntry | undefined, gobCount: number): string => {
  if (!e) return '';
  const f = parseFloat(e.weight_front);
  const r = parseFloat(e.weight_rear);
  if (gobCount === 3) {
    const m = parseFloat(e.weight_middle);
    const vals = [f, m, r].filter((v) => !isNaN(v));
    if (!vals.length) return '';
    return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
  }
  const vals = [f, r].filter((v) => !isNaN(v));
  if (!vals.length) return '';
  return (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1);
};

/**
 * The ONE hourly slot of this machine and day that is still current — the
 * entry the "+" / "−" buttons belong to. Empty string when no bottle has been
 * picked yet (every row is still a new-job row).
 *
 * A machine runs one job at a time and a job runs across consecutive hours, so
 * exactly one entry is current and the bottle/action area has two states:
 *
 *  - an entry with no bottle yet starts a job: it keeps the bottle dropdown so
 *    a bottle can be picked,
 *  - once a bottle is picked the entry shows the bottle as plain text and the
 *    "+" / "−" buttons instead,
 *  - "+" copies that entry into the next hour with the same Job ID, so the
 *    entry it was copied from becomes historical: plain bottle text, no
 *    dropdown, no "+", no "−",
 *  - when a later entry starts another job the earlier Job ID is closed for
 *    good, so even its newest entry loses the buttons and can no longer be
 *    extended.
 *
 * The current entry is therefore the newest entry that carries a bottle: it is
 * the newest entry of the newest job, and every older filled entry belongs to
 * a job that has already been extended or closed. It is resolved from the real
 * entries and the chronological entry time (PRODUCTION_TIMES is in
 * production-shift order, which is the chronological order of the day) and
 * never from "the last row of the grid" or from an array index, so gaps in the
 * grid cannot promote the wrong row and there can never be two "+" buttons for
 * one job. Because it is derived from the loaded/saved rows on every render,
 * the rule holds after "+", Save, autosave, refresh, date navigation and loads
 * from the backend without any extra bookkeeping.
 */
const activeJobEntryTime = (rows: Record<string, QualityHourlyEntry | undefined>): string => {
  let activeTime = '';
  PRODUCTION_TIMES.forEach((slot) => {
    if (rows[slot.time]?.bottle_id) activeTime = slot.time;
  });
  return activeTime;
};

// Memoized per-hourly-row <tr>. Props are referentially stable across parent
// renders (handlers are useCallback'd, availableSections/allDefectNames are
// cached), so typing in one row only re-renders that row instead of all 24.
const QualityTimeRow = React.memo<{
  time: string;
  shiftIdx: number;
  isFirstInShift: boolean;
  entry?: QualityHourlyEntry;
  gobCount: number;
  hasM: boolean;
  bottles: BottleMaster[];
  allDefectNames: string[];
  defectGroups: DefectGroup[];
  loadingDefects: boolean;
  selectBottle: (time: string, bottleId: string) => void;
  patchEntry: (time: string, patch: Partial<QualityHourlyEntry>) => void;
  copyRowDown: (time: string) => void;
  removeBottle: (time: string) => void;
  canEdit: boolean;
  /** True only for the current entry of the running job (see activeJobEntryTime). */
  isActiveEntry: boolean;
  /** Bottle name of this entry, shown as plain text once a bottle is picked. */
  bottleName: string;
}>(({
  time,
  shiftIdx,
  isFirstInShift,
  entry,
  gobCount,
  hasM,
  bottles,
  allDefectNames,
  defectGroups,
  loadingDefects,
  selectBottle,
  patchEntry,
  copyRowDown,
  removeBottle,
  canEdit,
  isActiveEntry,
  bottleName,
}) => {
  const hasHold = Number(entry?.qc_hold ?? 0) > 0;
  const rowBg = hasHold ? '#fff5f5' : SHIFT_ROW_BG[shiftIdx];
  const rowAvg = calcRowAverage(entry, gobCount);

  // Bottle/action area, two states only (see activeJobEntryTime): a row without
  // a bottle is a new-job row and offers the bottle dropdown, a row with a
  // bottle shows it as plain text and only the current entry of the running
  // job carries the "+" / "−" buttons.
  const hasBottle = !!entry?.bottle_id;
  const isCurrentEntry = hasBottle && isActiveEntry;

  const selectedDefectNames = defectGroups.length > 0

    ? allDefectNames.filter((d) => (entry?.defect_ids ?? []).includes(d))
    : (entry?.defect_ids ?? []);

  const td: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: `1px solid ${C.border}`,
    borderRight: `1px solid ${C.border}`,
    fontSize: '12.5px',
    color: C.textMain,
    verticalAlign: 'middle',
  };
  const tdLast: React.CSSProperties = { ...td, borderRight: 'none' };
  const tdCenter: React.CSSProperties = { ...td, textAlign: 'center' };
  // Greyed "−" of a row that carries no bottle (nothing to remove) or no edit
  // permission — same look in both cases.
  const mutedActionButton: React.CSSProperties = {
    width: '24px', height: '24px', borderRadius: '5px',
    border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', color: '#cbd5e1',
    fontSize: '16px', fontWeight: 700, lineHeight: 1, cursor: 'not-allowed',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, flexShrink: 0,
  };
  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '3px 4px',
    fontSize: '12px',
    fontWeight: 400,
    color: C.textMain,
    backgroundColor: 'transparent',
    border: '1px solid transparent',
    borderRadius: '4px',
    cursor: canEdit ? 'pointer' : 'not-allowed',
    outline: 'none',
    textAlign: 'center',
  };
  const selectFocus = (e: React.FocusEvent<HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = '#2563eb';
  };
  const selectBlur = (e: React.FocusEvent<HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = 'transparent';
  };

  return (
    <tr
      key={time}
      style={{ backgroundColor: rowBg }}
      onMouseEnter={(e) => { if (!hasHold) e.currentTarget.style.backgroundColor = '#ecf1ff'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = rowBg; }}
    >
      {isFirstInShift && (
        <td rowSpan={8} style={{ textAlign: 'center', verticalAlign: 'middle', borderRight: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, width: '38px', backgroundColor: SHIFT_CELL_BG[shiftIdx], padding: '0' }}>
          <div style={{ writingMode: 'vertical-rl', textOrientation: 'mixed', transform: 'rotate(180deg)', fontSize: '10.5px', fontWeight: 700, color: SHIFT_CELL_COLOR[shiftIdx], letterSpacing: '0.08em', textTransform: 'uppercase', userSelect: 'none' }}>
            {SHIFT_LABELS[shiftIdx]}
          </div>
        </td>
      )}

      <td style={{ ...tdCenter, fontWeight: 500, fontSize: '12px', color: C.textMuted, whiteSpace: 'nowrap' }}>
        {entry?.entry_id && (
          <span style={{ color: '#2563eb', fontWeight: 600, marginRight: '6px', fontSize: '11px' }}>
            {/* E{String(entry.entry_id).padStart(3, '0')} */}
          </span>
        )}
        {time}
      </td>

      <td style={{ ...td, padding: '4px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            {hasBottle ? (
              // Bottle already picked: plain text, never a dropdown. Its Job ID
              // is fixed, so this row is only extended with "+" (same Job ID) or
              // removed with "−" on the current entry.
              <span
                title={bottleName}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '3px 5px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: C.textMain,
                  textAlign: 'left',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  opacity: canEdit ? 1 : 0.6,
                }}
              >
                {bottleName}
              </span>
            ) : (
              // New-job row: the dropdown is how the job's bottle is picked.
              <select
                value={entry?.bottle_id ?? ''}
                disabled={!canEdit}
                onChange={(e) => {
                  selectBottle(time, e.target.value);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '3px 5px',
                  fontSize: '12px',
                  fontWeight: 400,
                  color: '#94a3b8',
                  backgroundColor: 'transparent',
                  border: '1px solid transparent',
                  borderRadius: '4px',
                  cursor: canEdit ? 'pointer' : 'not-allowed',
                  outline: 'none',
                  textAlign: 'left',
                  opacity: canEdit ? 1 : 0.6,
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#2563eb'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'transparent'; }}
              >
                <option value="">— Select bottle</option>
                {bottles.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}

            {entry?.job_id && (
              <span
                style={{
                  fontSize: '9px',
                  color: '#64748b',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                ({entry.job_id})
              </span>
            )}
          </div>
          {/* "+" extends the running job into the next hour and "−" removes the
              bottle, so both belong to the current entry alone. A historical or
              closed job entry has plain text and no buttons at all. */}
          {isCurrentEntry && canEdit && (
            <button
              onClick={() => copyRowDown(time)}
              title="Copy this row to the next empty slot"
              style={{
                width: '24px', height: '24px', borderRadius: '5px',
                border: '1px solid #bfdbfe', backgroundColor: '#eff6ff', color: '#2563eb',
                fontSize: '16px', fontWeight: 700, lineHeight: 1, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, flexShrink: 0, transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#dbeafe'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#eff6ff'; }}
            >
              +
            </button>
          )}
          {isCurrentEntry ? (
            canEdit ? (
              <button
                onClick={() => removeBottle(time)}
                title="Remove one bottle from this row"
                style={{
                  width: '24px', height: '24px', borderRadius: '5px',
                  border: '1px solid #fecdd3', backgroundColor: '#fff1f2', color: '#be123c',
                  fontSize: '16px', fontWeight: 700, lineHeight: 1, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 0, flexShrink: 0, transition: 'background-color 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#ffe4e6'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#fff1f2'; }}
              >
                −
              </button>
            ) : (
              <button
                disabled
                title="No edit permission for Quality Control"
                style={mutedActionButton}
              >
                −
              </button>
            )
          ) : !hasBottle ? (
            <button
              disabled
              title="No bottle to remove"
              style={mutedActionButton}
            >
              −
            </button>
          ) : null}
        </div>
      </td>

      <td style={{ ...tdCenter, padding: '4px 2px', width: '50px' }}>
        <NumInput value={entry?.weight_front ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { weight_front: v })} />
      </td>
      {hasM && (
        <td style={{ ...tdCenter, padding: '4px 2px', width: '50px' }}>
          <NumInput value={entry?.weight_middle ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { weight_middle: v })} />
        </td>
      )}
      <td style={{ ...tdCenter, padding: '4px 2px', width: '50px' }}>
        <NumInput value={entry?.weight_rear ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { weight_rear: v })} />
      </td>

      <td style={{ ...tdCenter, fontSize: '12px', fontWeight: rowAvg ? 600 : 400, color: rowAvg ? '#1e293b' : '#94a3b8' }}>
        {rowAvg || ''}
      </td>

      <td style={{ ...tdCenter, padding: '4px 4px' }}>
        <NumInput value={entry?.speed_per_min ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { speed_per_min: v })} />
      </td>

      <td style={{ ...tdCenter, padding: '4px 6px' }}>
        <PackingMultiSelect
          selected={entry?.packing_category ?? []}
          disabled={!canEdit}
          onChange={(v) => patchEntry(time, { packing_category: v })}
        />
      </td>

      <td style={{ ...tdCenter, padding: '4px 4px' }}>
        <NumInput value={entry?.packing_size ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { packing_size: v })} />
      </td>

      <td style={{ ...tdCenter, padding: '4px 4px' }}>
        <NumInput value={entry?.cartons ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { cartons: v })} />
      </td>

      <td style={{ ...tdCenter, fontWeight: 500 }}>
        {calcBottlesInNos(entry)}
      </td>

      <td style={tdCenter}>
        <EffBadge val={calcEffForEntry(entry, gobCount)} />
      </td>

      <td style={{ ...tdCenter, padding: '4px 4px' }}>
        <NumInput value={entry?.sqc ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { sqc: v })} />
      </td>

      <td style={{ ...tdCenter, padding: '4px 4px' }}>
        <NumInput value={entry?.qc_hold != null ? String(entry.qc_hold) : '0'} disabled={!canEdit} onChange={(v) => patchEntry(time, { qc_hold: v === '' ? 0 : Number(v) })} />
      </td>

      <td style={{ ...tdCenter, padding: '4px 4px' }}>
        <NumInput value={entry?.num ?? ''} disabled={!canEdit} onChange={(v) => patchEntry(time, { num: v })} />
      </td>

      <td style={{ ...td, minWidth: '200px', padding: '4px 8px' }}>
        <DefectDropdown
          selected={selectedDefectNames}
          disabled={!canEdit}
          onChange={(names) => patchEntry(time, { defect_ids: names })}
          defectGroups={defectGroups}
          isLoading={loadingDefects}
        />
      </td>

      <td style={{ ...tdLast, padding: '4px 8px', minWidth: '120px', width: '120px' }}>
        <input
          type="text"
          value={entry?.remarks ?? ''}
          disabled={!canEdit}
          onChange={(e) => patchEntry(time, { remarks: e.target.value })}
          placeholder={canEdit ? 'Remarks' : ''}
          style={{
            width: '100%', border: '1px solid transparent', borderRadius: '4px',
            padding: '4px 6px', fontSize: '12px', color: '#475569',
            backgroundColor: 'transparent', outline: 'none',
            transition: 'border-color 0.15s, background-color 0.15s',
            cursor: canEdit ? 'text' : 'not-allowed',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = '#2563eb';
            e.currentTarget.style.backgroundColor = '#ffffff';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        />
      </td>
    </tr>
  );
});

// ─── Module ────────────────────────────────────────────────────────────────
export const QualityControlModule: React.FC = () => {
  const { machines, bottles, getBottlesForMachine, bottleMasterRecords } = useERP();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission(MODULES.QUALITY_CONTROL, 'edit');

  const [activeMachine, setActiveMachine] = useState(1);
  const [navDate, setNavDate] = useState<Date>(() => new Date());

  const isToday = toIso(navDate) === toIso(new Date());
  const dateKey = toIso(navDate);
  const dateLabel = toDisplay(navDate);

  // Two-line report header (company + report title) shown on every printed and
  // exported report. The month/year follows the reporting date in view.
  const reportHeader = useMemo(() => getReportHeaderLines(dateKey), [dateKey]);

  // Gob type drives the Weight F/M/R columns (3-gob ⇒ middle column).
  const gobCount =
    machines.find((m) => m.code === `MAC-${String(activeMachine).padStart(2, '0')}`)?.gobCount ??
    (DB_MACHINE_MASTER.find((m) => m.machine_no === activeMachine)?.gob_type === '3-gob' ? 3 : 2);
  const hasM = gobCount === 3;

  // ── Store: unsaved edits are kept per date + machine in memory ───────────
  const [productionStore, setProductionStore] = useState<Record<string, Record<string, Record<string, QualityHourlyEntry>>>>({});
  const [shiftStore, setShiftStore] = useState<Record<string, QualityShiftMap>>({});
  const [savedFlags, setSavedFlags] = useState<Record<string, boolean>>({});
  const [loadedDates, setLoadedDates] = useState<Record<string, boolean>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, boolean>>({});
  // Exact reason a date failed to load (expired session, permission, server
  // error, ...). Shown in the existing error banner so a failed refresh is
  // never mistaken for "the database is empty".
  const [loadErrorDetails, setLoadErrorDetails] = useState<Record<string, string>>({});
  const [defectGroups, setDefectGroups] = useState<DefectGroup[]>([]);
  const [loadingDefects, setLoadingDefects] = useState<boolean>(true);

  // Dates that received a cross-midnight continuation row via "+". The row
  // lives under its OWN date key, so these dates are persisted together with
  // the current date's save (otherwise the continuation never reaches storage).
  const continuationDates = useRef<Record<string, boolean>>({});

  // Rows edited (or created) in this session, per date + machine + time. Only
  // these rows — plus rows that carry meaningful data — are sent on Save, so a
  // save never sends the whole pre-loaded 96-slot grid and never drops a row.
  // Each mark is stamped with a monotonically increasing sequence number: a
  // save can then clear exactly the marks it persisted and leave marks that
  // were written again while the request was in flight, so an edit made
  // mid-request can never be dropped from the next auto-save.
  const touchedTimes = useRef<Record<string, Record<string, Record<string, number>>>>({});
  const touchSeq = useRef(0);

  const productionStoreRef = useRef(productionStore);
  useEffect(() => {
    productionStoreRef.current = productionStore;
  }, [productionStore]);

  const shiftStoreRef = useRef(shiftStore);
  useEffect(() => {
    shiftStoreRef.current = shiftStore;
  }, [shiftStore]);

  // ── Auto-save bookkeeping ────────────────────────────────────────────────
  // Dates with rows (or shift assignments) that still have to reach the
  // database. Membership is ref-only so queueing never re-renders the grid.
  const dirtyDatesRef = useRef<Set<string>>(new Set());
  const dirtyShiftsRef = useRef<Set<string>>(new Set());
  const autoSaveTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const statusResetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [autoSaveError, setAutoSaveError] = useState('');

  const setAutoSaveStatusSafe = useCallback((next: AutoSaveStatus) => {
    if (mountedRef.current) setAutoSaveStatus(next);
  }, []);

  // Guards Save against concurrent/duplicate submissions.
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  // In-flight promises used to deduplicate concurrent loads for the same date
  // (StrictMode double-effects, rapid date navigation share one request).
  const inFlightRef = useRef<Record<string, Promise<QualityDayLoad> | undefined>>({});

  useEffect(() => {
    let active = true;
    qualityRepository.getDefects(true).then((defects) => {
      if (!active) return;
      const groups: { group: 'Critical' | 'Major' | 'Minor'; items: string[] }[] = (['Critical', 'Major', 'Minor'] as const).map((grp) => ({
        group: grp,
        items: defects
          .filter((d) => d.defect_type === grp)
          .sort((a, b) => a.defect_sr - b.defect_sr)
          .map((d) => d.defect_name),
      }));
      setDefectGroups(groups);
      setLoadingDefects(false);
    }).catch((err) => {
      if (active) {
        setLoadingDefects(false);
        // Never swallow it: without the defect list the dropdown is empty and
        // defect selection silently stops working, so say exactly why.
        toast.error(
          err instanceof Error && err.message
            ? `Could not load the defect list — ${err.message}`
            : 'Could not load the defect list. Defects cannot be selected right now.'
        );
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Load the latest database state whenever the selected date changes (and on
  // mount). Every date change issues a fresh fetch — never reuse previously
  // loaded rows for a date, since records may have changed or been deleted in
  // the database. The store for the date is REPLACED with the API result (never
  // merged with previously loaded rows), so a day with no DB records shows an
  // empty grid instead of resurrecting stale rows. Two exceptions keep data
  // from disappearing: rows still marked touched (edited but unsaved) keep the
  // operator's values, and a failed request leaves the store untouched instead
  // of blanking it. In-flight requests are shared between concurrent effect
  // runs to avoid duplicate API calls.
  useEffect(() => {
    let cancelled = false;
    const existing = inFlightRef.current[dateKey];
    const pending = existing ?? qualityRepository.load(dateKey);
    inFlightRef.current[dateKey] = pending;
    pending.then(({ hourly, shifts, ok, error }) => {
      inFlightRef.current[dateKey] = undefined;
      if (cancelled) return;
      setLoadedDates((prev) => ({ ...prev, [dateKey]: true }));
      setLoadErrors((prev) => ({ ...prev, [dateKey]: ok === false }));
      setLoadErrorDetails((prev) => ({ ...prev, [dateKey]: ok === false ? (error ?? '') : '' }));
      if (ok === false) {
        // The request failed — there is no authoritative data to apply, so
        // keep whatever is already in memory (including unsaved edits such as
        // a freshly selected bottle) instead of blanking the grid. The banner
        // tells the user the refresh could not be performed.
        return;
      }
      setShiftStore((prev) => ({
        ...prev,
        [dateKey]: shifts ?? {},
      }));
      setProductionStore((prev) => {
        const prevDate = prev[dateKey] ?? {};
        const touched = touchedTimes.current[dateKey];
        const serverDate = hourly ?? {};
        const mergedDate: Record<string, Record<string, QualityHourlyEntry>> = {};
        const machineKeys = new Set<string>([
          ...Object.keys(serverDate),
          ...Object.keys(prevDate),
        ]);
        for (const mKey of machineKeys) {
          const serverMachine = serverDate[mKey] ?? {};
          const localMachine = prevDate[mKey] ?? {};
          const byTime: Record<string, QualityHourlyEntry> = {};
          for (const tKey of new Set<string>([
            ...Object.keys(serverMachine),
            ...Object.keys(localMachine),
          ])) {
            const serverEntry = serverMachine[tKey];
            const localEntry = localMachine[tKey];
            if (localEntry && touched?.[mKey]?.[tKey]) {
              // An in-flight refresh must never drop a row the operator edited
              // but has not saved yet (a just-selected bottle, for example).
              // Ids still come from the authoritative response.
              byTime[tKey] = {
                ...localEntry,
                entry_id: localEntry.entry_id || serverEntry?.entry_id || '',
                report_id: localEntry.report_id || serverEntry?.report_id || '',
                job_id: localEntry.job_id || serverEntry?.job_id || '',
              };
            } else if (serverEntry) {
              byTime[tKey] = serverEntry;
            } else if (localEntry && hasMeaningfulData(localEntry)) {
              byTime[tKey] = localEntry;
            }
          }
          mergedDate[mKey] = byTime;
        }
        return { ...prev, [dateKey]: mergedDate };
      });
    }).catch((err) => {
      inFlightRef.current[dateKey] = undefined;
      if (!cancelled) {
        setLoadedDates((prev) => ({ ...prev, [dateKey]: true }));
        setLoadErrors((prev) => ({ ...prev, [dateKey]: true }));
        setLoadErrorDetails((prev) => ({
          ...prev,
          [dateKey]: err instanceof Error && err.message ? err.message : '',
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dateKey]);

  const blankEntry = (time: string, shiftId: number): QualityHourlyEntry => ({
    entry_id: '',
    report_id: dateKey,
    machine_no: activeMachine,
    shift_id: shiftId,
    production_time: time,
    bottle_id: '',
    weight_front: '',
    weight_middle: '',
    weight_rear: '',
    weight_avg: '',
    speed_per_min: '',
    packing_category: [],
    packing_size: '',
    cartons: '',
    bottles_in_nos: '',
    efficiency_percentage: '',
    weight_efficiency: '',
    sqc: '',
    qc_hold: 0,
    num: '',
    remarks: '',
    defect_ids: [],
    job_id: '',
  });

  // ── Auto-save plumbing ───────────────────────────────────────────────────

  /** Latest `runSave`, so timers always invoke the current closure. */
  const runSaveRef = useRef<
    (
      dates: string[],
      options: { touchedOnly: boolean; silent: boolean; reason: 'auto' | 'manual' | 'retry' | 'unload' }
    ) => Promise<void>
  >(async () => {});

  /**
   * Marks one cell dirty and stamps it with a fresh sequence number. Only
   * ref mutation happens here, so it is safe to call from inside a
   * setProductionStore updater (React may run updaters more than once).
   */
  const markTouched = useCallback((date: string, machineKey: string, time: string) => {
    const byDate = touchedTimes.current[date] ?? (touchedTimes.current[date] = {});
    const byMachine = byDate[machineKey] ?? (byDate[machineKey] = {});
    byMachine[time] = ++touchSeq.current;
  }, []);

  /** Number of cells currently marked dirty for a date. */
  const pendingCellCount = useCallback((date: string): number => {
    const byMachine = touchedTimes.current[date];
    if (!byMachine) return 0;
    let count = 0;
    for (const byTime of Object.values(byMachine)) count += Object.keys(byTime).length;
    return count;
  }, []);

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const clearStatusResetTimer = useCallback(() => {
    if (statusResetTimerRef.current !== null) {
      window.clearTimeout(statusResetTimerRef.current);
      statusResetTimerRef.current = null;
    }
  }, []);

  /**
   * Requests a debounced auto-save for one date. Every mutation funnels through
   * here, so a burst of keystrokes collapses into exactly one request and the
   * grid itself never re-renders because of save bookkeeping (refs only).
   */
  const queueAutoSave = useCallback((date: string, isShiftChange = false) => {
    dirtyDatesRef.current.add(date);
    if (isShiftChange) dirtyShiftsRef.current.add(date);
    setAutoSaveStatusSafe('pending');
    // A fresh edit supersedes any armed backoff: the payload is about to
    // change, so the retry budget starts again from the next failure.
    retryAttemptRef.current = 0;
    clearRetryTimer();
    clearStatusResetTimer();
    clearAutoSaveTimer();
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      void runSaveRef.current([date], { touchedOnly: true, silent: true, reason: 'auto' });
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [clearAutoSaveTimer, clearRetryTimer, clearStatusResetTimer, setAutoSaveStatusSafe]);

  // Every dirty date — including the continuation dates a "+" row can spill
  // into — is flushed together, so an auto-save never persists a day while its
  // cross-midnight neighbour is still only in memory.
  const drainDirtyDates = useCallback((): string[] => {
    const dates = new Set<string>(dirtyDatesRef.current);
    for (const auxKey of Object.keys(continuationDates.current)) dates.add(auxKey);
    return [...dates].filter((d) => pendingCellCount(d) > 0 || dirtyShiftsRef.current.has(d));
  }, [pendingCellCount]);

  /**
   * Retries the dirty set with a growing backoff. The save endpoint upserts by
   * (report_id, machine_no, time) and returns the committed rows, so replaying
   * the identical payload updates the same records — a retry can never create a
   * duplicate entry. After the last delay the indicator stays on "Save failed"
   * and the Save button remains available as the manual escape hatch.
   */
  const scheduleRetry = useCallback(() => {
    const attempt = retryAttemptRef.current;
    if (attempt >= AUTO_SAVE_RETRY_DELAYS_MS.length) {
      setAutoSaveStatusSafe('error');
      return;
    }
    const delay = AUTO_SAVE_RETRY_DELAYS_MS[attempt];
    retryAttemptRef.current = attempt + 1;
    setAutoSaveStatusSafe('error');
    clearRetryTimer();
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      const remaining = drainDirtyDates();
      if (remaining.length === 0) {
        retryAttemptRef.current = 0;
        return;
      }
      void runSaveRef.current(remaining, { touchedOnly: true, silent: true, reason: 'retry' });
    }, delay);
  }, [clearRetryTimer, drainDirtyDates, setAutoSaveStatusSafe]);

  // Best-effort safety net for a closing/backgrounded tab: flush immediately
  // instead of waiting out the debounce window. The request is sent with
  // `keepalive` so the browser lets it finish even while the page goes away.
  useEffect(() => {
    const flushNow = () => {
      const remaining = drainDirtyDates();
      if (remaining.length === 0) return;
      clearAutoSaveTimer();
      void runSaveRef.current(remaining, { touchedOnly: true, silent: true, reason: 'unload' });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushNow);
    };
  }, [drainDirtyDates, clearAutoSaveTimer]);

  // Unmount must not leave a pending debounce behind: flush whatever is dirty
  // one last time (the request may not complete, but nothing is silently lost).
  useEffect(
    () => () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
        const dates = [...dirtyDatesRef.current];
        if (dates.length > 0) {
          void runSaveRef.current(dates, { touchedOnly: true, silent: true, reason: 'unload' });
        }
      }
    },
    []
  );

  // Memoized view of the active machine's hourly rows for the selected date.
  // The table body and summary read from this stable map, so editing one row
  // changes only that row's entry reference and the memoized summaries below.
  const activeRows = useMemo(
    () => productionStore[dateKey]?.[String(activeMachine)] ?? {},
    [productionStore, dateKey, activeMachine]
  );

  const reportId = useMemo(() => {
    for (const pt of PRODUCTION_TIMES) {
      const rid = activeRows[pt.time]?.report_id;
      if (rid) return rid;
    }
    return '';
  }, [activeRows]);

  const patchEntry = useCallback((time: string, patch: Partial<QualityHourlyEntry>) => {
    if (!canEdit) return;
    const slot = PRODUCTION_TIMES.find((pt) => pt.time === time);
    const mStr = String(activeMachine);
    markTouched(dateKey, mStr, time);
    queueAutoSave(dateKey);
    setProductionStore((prev) => {
      const existing = prev[dateKey]?.[mStr]?.[time] ?? blankEntry(time, slot?.shift_id ?? 1);
      return {
        ...prev,
        [dateKey]: {
          ...(prev[dateKey] ?? {}),
          [mStr]: {
            ...(prev[dateKey]?.[mStr] ?? {}),
            [time]: { ...existing, ...patch },
          },
        },
      };
    });
  }, [dateKey, activeMachine, canEdit, markTouched, queueAutoSave]);

  // ── Shift assignments ────────────────────────────────────────────────────
  const getShiftAssignment = (shiftId: number) =>
    shiftStore[dateKey]?.[shiftId] ?? { supervisor: '', executive: '' };

  const patchShiftAssignment = (shiftId: number, patch: { supervisor?: string; executive?: string }) => {
    if (!canEdit) return;
    queueAutoSave(dateKey, true);
    setShiftStore((prev) => ({
      ...prev,
      [dateKey]: {
        ...(prev[dateKey] ?? {}),
        [shiftId]: { ...getShiftAssignment(shiftId), ...patch },
      },
    }));
  };

  // ── Master-data lookups ──────────────────────────────────────────────────
  const sectionKey = `${String(activeMachine).padStart(2, '0')}`;

  // Bottle dropdown list: only the bottles that HAVE a bottle_configuration row
  // on the machine currently selected (getBottlesForMachine filters the Bottle
  // Master list on that machine's own machine_no/bottle_id rows). A bottle
  // configured on several sections of the same machine appears once, because
  // the lookup is keyed by bottle. Machines without any configuration simply
  // get an empty list rather than another machine's bottles.
  const machineBottles = useMemo(
    () => getBottlesForMachine(`MAC-${sectionKey}`),
    [getBottlesForMachine, sectionKey]
  );

  // Available sections are derived from bottleMasterRecords/machines, which
  // only change when master data reloads, so the per-key result can be cached
  // and shared across rows renders (previously filtered the full record list
  // for every one of the 24 rows on every keypress).
  const sectionsCache = useRef(new Map<string, string[]>());
  useEffect(() => {
    sectionsCache.current.clear();
  }, [bottleMasterRecords, machines]);

  const getAvailableSections = useCallback((bottleId: string, machineNo?: number): string[] => {
    const key = `${machineNo ?? activeMachine}|${bottleId || ''}`;
    const cached = sectionsCache.current.get(key);
    if (cached) return cached;

    const num = machineNo ?? activeMachine;
    const mch = `MAC-${String(num).padStart(2, '0')}`;
    const sections = bottleMasterRecords
      .filter((r) => r.mch === mch && (!bottleId || r.drawingNumber === bottleId))
      .map((r) => String(r.section));
    const unique = [...new Set(sections)];

    let result: string[];
    if (unique.length > 0) {
      result = unique.sort((a, b) => parseInt(a) - parseInt(b));
    } else {
      const machine = machines.find((m) => m.code === mch);
      if (machine && machine.availableSections.length > 0) {
        result = machine.availableSections.map(String);
      } else {
        result = ['5', '6', '7', '8'];
      }
    }
    sectionsCache.current.set(key, result);
    return result;
  }, [activeMachine, bottleMasterRecords, machines]);

  const allDefectNames = useMemo(() => defectGroups.flatMap((g) => g.items), [defectGroups]);

  // The single current entry of this machine and day: only it carries the
  // "+" / "−" buttons, every other filled entry is a finished/closed job entry.
  // Derived from the rows themselves, so it is correct for a freshly extended
  // job, for autosaved Job IDs, for data reloaded from the backend and for
  // every date.
  const activeEntryTime = useMemo(() => activeJobEntryTime(activeRows), [activeRows]);

  // Bottle name shown as plain text next to a picked bottle. Resolved from the
  // full Bottle Master list (a bottle id is machine independent), so an entry
  // whose bottle is no longer configured on this machine still shows its name.
  const bottleNameById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const b of bottles) byId.set(b.id, b.name);
    return byId;
  }, [bottles]);

  // Same rule for the handlers, evaluated against the live store so it is right
  // even when a handler runs before the next render. A job that a later entry
  // has extended — or that a later job has replaced — is closed: its bottle,
  // bottle name and Job ID stay exactly as they are and it cannot be extended.
  const isActiveEntryTime = useCallback((time: string): boolean => {
    const machineKey = String(activeMachine);
    const rows = productionStoreRef.current?.[dateKey]?.[machineKey] ?? {};
    return time === activeJobEntryTime(rows);
  }, [dateKey, activeMachine]);

  // Pick the bottle of a blank row, which starts the job. The bottle of a row
  // that already carries one is fixed: that entry is only extended with "+"
  // (same Job ID) or removed with "−" (a brand-new job is started instead).
  const selectBottle = useCallback((time: string, bottleId: string) => {
    if (!canEdit) return;
    const machineKey = String(activeMachine);
    const existingEntry = productionStoreRef.current?.[dateKey]?.[machineKey]?.[time];
    // A job entry never changes its bottle: it is either current (buttons only)
    // or a historical/closed entry (read-only). Both are handled elsewhere.
    if (existingEntry?.bottle_id) return;
    if (!bottleId) {
      patchEntry(time, {
        bottle_id: '',
        weight_front: '',
        weight_middle: '',
        weight_rear: '',
        speed_per_min: '',
        job_id: '',
      });
      return;
    }
    const slot = PRODUCTION_TIMES.find((pt) => pt.time === time);

    markTouched(dateKey, machineKey, time);
    queueAutoSave(dateKey);

    setProductionStore((prev) => {
      const base = prev[dateKey]?.[machineKey]?.[time] ?? blankEntry(time, slot?.shift_id ?? 1);
      return {
        ...prev,
        [dateKey]: {
          ...(prev[dateKey] ?? {}),
          [machineKey]: {
            ...(prev[dateKey]?.[machineKey] ?? {}),
            [time]: {
              ...base,
              // A new job: no Job ID yet, the backend issues one on save.
              job_id: '',
              bottle_id: bottleId,
            },
          },
        },
      };
    });
  }, [dateKey, activeMachine, patchEntry, canEdit, markTouched, queueAutoSave]);

  // Copy a filled row down to the next empty slot. Only the current entry of the

  // running job may do this, so a job that a later entry has already extended —
  // or that a later job has replaced — can never be extended again. The row's
  // job_id is preserved (a copied row CONTINUES the same job) and the entry it
  // was copied from immediately becomes a read-only previous entry. If all 24
  // slots of the day are full, the final 8 AM row extends the same job into the
  // next day's first row — crossing the day boundary never starts a new job.
  const copyRowDown = useCallback((time: string) => {
    if (!canEdit) return;
    if (!isActiveEntryTime(time)) return;
    const idx = PRODUCTION_TIMES.findIndex((pt) => pt.time === time);
    // Queue the current date up front: the copy target (same day, or the next
    // day for the 8 AM row) is only known inside the updater below, and the
    // next day's row is always flushed together with this date anyway.
    queueAutoSave(dateKey);
    setProductionStore((prev) => {
      const machineKey = String(activeMachine);
      const source = prev[dateKey]?.[machineKey]?.[time];
      if (!source?.bottle_id) return prev;
      const markRow = (date: string, mKey: string, tKey: string) => {
        markTouched(date, mKey, tKey);
        dirtyDatesRef.current.add(date);
      };
      for (let i = idx + 1; i < PRODUCTION_TIMES.length; i++) {
        const nextTime = PRODUCTION_TIMES[i].time;
        if (!prev[dateKey]?.[machineKey]?.[nextTime]?.bottle_id) {
          markRow(dateKey, machineKey, nextTime);
          return {
            ...prev,
            [dateKey]: {
              ...(prev[dateKey] ?? {}),
              [machineKey]: {
                ...(prev[dateKey]?.[machineKey] ?? {}),
                [nextTime]: {
                  ...source,
                  production_time: nextTime,
                  entry_id: '',
                  shift_id: PRODUCTION_TIMES[i].shift_id,
                },
              },
            },
          };
        }
      }
      if (idx === PRODUCTION_TIMES.length - 1) {
        const nextDate = new Date(`${dateKey}T00:00:00`);
        nextDate.setDate(nextDate.getDate() + 1);
        const nextDateKey = toIso(nextDate);
        const firstTime = PRODUCTION_TIMES[0].time;
        const firstShiftId = PRODUCTION_TIMES[0].shift_id;
        // Never overwrite an existing job in the next day's first slot.
        if (prev[nextDateKey]?.[machineKey]?.[firstTime]?.bottle_id) return prev;
        continuationDates.current[nextDateKey] = true;
        markRow(nextDateKey, machineKey, firstTime);
        return {
          ...prev,
          [nextDateKey]: {
            ...(prev[nextDateKey] ?? {}),
            [machineKey]: {
              ...(prev[nextDateKey]?.[machineKey] ?? {}),
              [firstTime]: {
                ...source,
                production_time: firstTime,
                report_id: nextDateKey,
                entry_id: '',
                shift_id: firstShiftId,
              },
            },
          },
        };
      }
      return prev;
    });
  }, [dateKey, activeMachine, canEdit, markTouched, queueAutoSave, isActiveEntryTime]);

  // Remove the bottle of the current entry, which empties the row so it can
  // start a new job. A historical or closed job entry is read-only: its bottle
  // and Job ID can never be removed.
  const removeBottle = useCallback((time: string) => {
    if (!isActiveEntryTime(time)) return;
    patchEntry(time, {
      bottle_id: '',
      weight_front: '',
      weight_middle: '',
      weight_rear: '',
      weight_avg: '',
      speed_per_min: '',
      packing_category: [],
      packing_size: '',
      cartons: '',
      bottles_in_nos: '',
      efficiency_percentage: '',
      weight_efficiency: '',
      sqc: '',
      qc_hold: 0,
      num: '',
      defect_ids: [],
      remarks: '',
      job_id: '',
    });
  }, [patchEntry, isActiveEntryTime]);

  // ── Derived calculation helpers (shared by display, export, and save payload) ─
  const gobCountFor = useCallback((machineNo: number): number =>
    machines.find((m) => m.code === `MAC-${String(machineNo).padStart(2, '0')}`)?.gobCount ??
    (DB_MACHINE_MASTER.find((m) => m.machine_no === machineNo)?.gob_type === '3-gob' ? 3 : 2),
    [machines]);

  const calcBottlesInNosFor = useCallback((e?: QualityHourlyEntry): string => calcBottlesInNos(e), []);

  const calcEffFor = useCallback(
    (e?: QualityHourlyEntry, machineNo?: number): string =>
      calcEffForEntry(e, machineNo === undefined ? 0 : gobCountFor(machineNo)),
    [gobCountFor]
  );

  const calcRowAvgFor = useCallback((e: QualityHourlyEntry | undefined, machineNo: number): string =>
    calcRowAverage(e, gobCountFor(machineNo)),
    [gobCountFor]);

  // Memoized day summary stats. Recompute only when the active machine's rows
  // actually change, instead of re-scanning all 24 slots on every render and
  // each keypress.
  const dayAvgs = useMemo(() => {
    const collect = (field: 'weight_front' | 'weight_middle' | 'weight_rear'): string => {
      const vals: number[] = [];
      for (const pt of PRODUCTION_TIMES) {
        const v = parseFloat(activeRows[pt.time]?.[field] ?? '');
        if (!isNaN(v)) vals.push(v);
      }
      return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : '';
    };
    const avgVals: number[] = [];
    for (const pt of PRODUCTION_TIMES) {
      const v = parseFloat(calcRowAvgFor(activeRows[pt.time], activeMachine));
      if (!isNaN(v)) avgVals.push(v);
    }
    return {
      front: collect('weight_front'),
      middle: collect('weight_middle'),
      rear: collect('weight_rear'),
      avg: avgVals.length ? (avgVals.reduce((s, v) => s + v, 0) / avgVals.length).toFixed(1) : '',
    };
  }, [activeRows, activeMachine, calcRowAvgFor]);

  const stats = useMemo(() => {
    let totalCartons = 0;
    let totalBottles = 0;
    const effVals: number[] = [];
    for (const pt of PRODUCTION_TIMES) {
      const e = activeRows[pt.time];
      const ct = parseInt(e?.cartons ?? '');
      if (!isNaN(ct)) totalCartons += ct;
      const ps = parseInt(e?.packing_size ?? '');
      if (!isNaN(ct) && ps > 0) totalBottles += ps * ct;
      const eff = parseFloat(calcEffFor(e, activeMachine));
      if (!isNaN(eff)) effVals.push(eff);
    }
    return {
      totalCartons,
      totalBottles,
      avgEff: effVals.length ? (effVals.reduce((s, v) => s + v, 0) / effVals.length).toFixed(1) : '—',
    };
  }, [activeRows, activeMachine, calcEffFor]);

  // ── Save / Export / Print ────────────────────────────────────────────────
  /**
   * Slots the POST response does not prove were stored. The save endpoint
   * re-queries the day it just committed and returns it, so a row we sent with a
   * bottle that is missing (or comes back with a different bottle) means that
   * row never reached the database — the save must be reported as a failure
   * instead of showing a success message for data that will vanish on refresh.
   */
  const unconfirmedBottleRows = (
    sent: Record<string, Record<string, QualityHourlyEntry>>,
    saved: QualityDayHourly | undefined
  ): string[] => {
    const missing: string[] = [];
    if (!saved) return missing;
    for (const [mStr, timeMap] of Object.entries(sent)) {
      for (const [time, entry] of Object.entries(timeMap)) {
        if (!entry?.bottle_id) continue;
        const stored = saved[mStr]?.[time];
        if (!stored || String(stored.bottle_id) !== String(entry.bottle_id)) {
          missing.push(`Machine ${mStr} · ${time}`);
        }
      }
    }
    return missing;
  };

  // Builds the smallest correct payload: only rows edited in this session and
  // rows that carry real data are included — never the pre-loaded empty 24-slot
  // grid. Touched-but-cleared rows are still sent so the backend clears values
  // that were previously saved.
  //
  // `touchedOnly` is used by the auto-save path: it narrows the payload to the
  // cells the operator actually changed, so a background save never rewrites
  // the rest of the day (and never touches another machine's rows).
  const buildSavePayload = (
    date: string,
    store: Record<string, Record<string, Record<string, QualityHourlyEntry>>>,
    touched: Record<string, Record<string, number>> | undefined,
    touchedOnly = false
  ): Record<string, Record<string, QualityHourlyEntry>> => {
    const out: Record<string, Record<string, QualityHourlyEntry>> = {};
    const byMachine = store[date] ?? {};
    for (const [mStr, timeMap] of Object.entries(byMachine)) {
      const mNum = parseInt(mStr, 10) || activeMachine;
      for (const [time, entry] of Object.entries(timeMap)) {
        if (!entry) continue;
        const isTouched = !!touched?.[mStr]?.[time];
        if (touchedOnly && !isTouched) continue;
        const meaningful = hasMeaningfulData(entry);
        if (!isTouched && !meaningful) continue;
        // A blank row the component invented (no entry_id from the database)
        // carries nothing to write: sending it would be a pointless no-op at
        // best and could blank out a stored row for the same slot at worst.
        // Deliberately cleared rows always carry their entry_id and are kept.
        if (!meaningful && !entry.entry_id) continue;
        (out[mStr] ??= {})[time] = {
          ...entry,
          report_id: date,
          weight_avg: calcRowAvgFor(entry, mNum),
          bottles_in_nos: calcBottlesInNosFor(entry),
          efficiency_percentage: calcEffFor(entry, mNum),
        };
      }
    }
    return out;
  };

  /**
   * Single write path for the whole module. The Save button, the debounced
   * auto-save and the retry loop all go through it, so a background write is
   * byte-for-byte the same operation as a manual one.
   */
  const runSave = async (
    dates: string[],
    options: { touchedOnly: boolean; silent: boolean; reason: 'auto' | 'manual' | 'retry' | 'unload' }
  ): Promise<void> => {
    if (!canEdit) {
      if (options.reason === 'manual') toast.error('You do not have permission to edit quality data.');
      return;
    }
    // A save is already running. Whatever is still dirty is picked up when that
    // run finishes (it re-checks the dirty set in its `finally`), so this call
    // simply joins the in-flight write instead of issuing a duplicate request.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    if (options.reason !== 'manual') {
      clearStatusResetTimer();
      setAutoSaveStatusSafe('saving');
    }
    // Declared out here so the post-save scheduling below can see whether this
    // run persisted everything it tried to.
    let failed = 0;

    try {
      // The selected date plus every date that received a continuation row via
      // "+". Continuations live under their OWN date keys and are saved with
      // those dates, so saving today never drops tomorrow's 9 AM row.
      const datesToSave = new Set<string>(dates);
      for (const auxKey of Object.keys(continuationDates.current)) datesToSave.add(auxKey);

      let attempted = false;
      let savedAny = false;
      let lastError = '';
      for (const date of datesToSave) {
        // Re-read the refs on every iteration: a save response merges the
        // database ids back into the store, and a later date in this loop must
        // build its payload from that merged state.
        const store = productionStoreRef.current;
        const shiftedDirty = dirtyShiftsRef.current.has(date);
        const payload = buildSavePayload(date, store, touchedTimes.current[date], options.touchedOnly);
        // Only ship the shift rows when this run is meant to persist them:
        // an hourly-only auto-save must not rewrite the assignments.
        const shifts = options.touchedOnly && !shiftedDirty ? {} : (shiftStoreRef.current[date] ?? {});
        if (Object.keys(store[date] ?? {}).length === 0 && Object.keys(shifts).length === 0) continue;
        if (Object.keys(payload).length === 0 && Object.keys(shifts).length === 0) continue;
        // Remember which sequence numbers this request is about to persist so
        // only those marks can be cleared when it comes back.
        const sentSeqs: Record<string, Record<string, number>> = {};
        const touchedNow = touchedTimes.current[date];
        for (const [mStr, timeMap] of Object.entries(payload)) {
          for (const time of Object.keys(timeMap)) {
            const seq = touchedNow?.[mStr]?.[time];
            if (seq) (sentSeqs[mStr] ??= {})[time] = seq;
          }
        }
        const result = await qualityRepository.save(date, payload, shifts, {
          keepalive: options.reason === 'unload',
        });
        attempted = true;
        if (!result.ok) {
          // Never swallow the reason: the rows for this date were NOT saved.
          failed += 1;
          if (result.error) lastError = result.error;
          continue;
        }
        // The response is the committed database state for this day. Only call
        // the day "saved" once every bottle row we sent is provably in it —
        // otherwise the data would silently disappear on the next refresh.
        const unconfirmed = unconfirmedBottleRows(payload, result.hourly);
        if (unconfirmed.length > 0) {
          failed += 1;
          lastError =
            `the server did not store ${unconfirmed.length} row(s): ` +
            unconfirmed.slice(0, 5).join(', ');
          continue;
        }
        savedAny = true;

        if (result.continuation && result.continuationDate && Object.keys(result.continuation).length > 0) {
          const nextDateKey = result.continuationDate;
          const contData = result.continuation;
          setProductionStore((prev) => {
            const prevDate = prev[nextDateKey] ?? {};
            const machineKeys = new Set<string>([...Object.keys(contData), ...Object.keys(prevDate)]);
            const mergedDate: Record<string, Record<string, QualityHourlyEntry>> = {};
            for (const mKey of machineKeys) {
              const contMachine = contData[mKey] ?? {};
              const prevMachine = prevDate[mKey] ?? {};
              const byTime: Record<string, QualityHourlyEntry> = {};
              for (const tKey of new Set<string>([...Object.keys(contMachine), ...Object.keys(prevMachine)])) {
                const contEntry = contMachine[tKey];
                const prevEntry = prevMachine[tKey];
                if (!contEntry) {
                  byTime[tKey] = prevEntry;
                } else if (!prevEntry) {
                  byTime[tKey] = contEntry;
                } else {
                  const merged: QualityHourlyEntry = {
                    ...prevEntry,
                    entry_id: contEntry.entry_id || prevEntry.entry_id || '',
                    report_id: contEntry.report_id || prevEntry.report_id || '',
                    job_id: contEntry.job_id || prevEntry.job_id || '',
                    bottle_id: prevEntry.bottle_id || contEntry.bottle_id || '',
                  };
                  byTime[tKey] = MERGED_ROW_FIELDS.every((f) => merged[f] === prevEntry[f])
                    ? prevEntry
                    : merged;
                }
              }
              mergedDate[mKey] = byTime;
            }
            return { ...prev, [nextDateKey]: mergedDate };
          });
          continuationDates.current[nextDateKey] = true;
        }

        // The database owns entry_id and job_id: write the DB-generated ids
        // returned by the save back into the live store so display and
        // subsequent saves reuse the same ids instead of creating new ones.
        if (result.hourly && Object.keys(result.hourly).length > 0) {
          const saved = result.hourly;
          setProductionStore((prev) => {
            const prevDate = prev[date] ?? {};
            const machineKeys = new Set<string>([...Object.keys(saved), ...Object.keys(prevDate)]);
            const mergedDate: Record<string, Record<string, QualityHourlyEntry>> = {};
            for (const mKey of machineKeys) {
              const savedMachine = saved[mKey] ?? {};
              const prevMachine = prevDate[mKey] ?? {};
              const byTime: Record<string, QualityHourlyEntry> = {};
              for (const tKey of new Set<string>([...Object.keys(savedMachine), ...Object.keys(prevMachine)])) {
                const savedEntry = savedMachine[tKey];
                const prevEntry = prevMachine[tKey];
                if (!savedEntry) {
                  byTime[tKey] = prevEntry;
                } else if (!prevEntry) {
                  byTime[tKey] = savedEntry;
                } else {
                  // Keep the operator's current values; the id fields
                  // (entry_id, report_id, job_id) come from the authoritative
                  // database response. bottle_id is only ever
                  // *adopted* from the response when the local row is empty, so
                  // a saved selection can never be blanked by a stale or empty
                  // response while an empty row can still pick up what the
                  // database actually stored.
                  const merged: QualityHourlyEntry = {
                    ...prevEntry,
                    entry_id: savedEntry.entry_id || prevEntry.entry_id || '',
                    report_id: savedEntry.report_id || prevEntry.report_id || '',
                    job_id: savedEntry.job_id || prevEntry.job_id || '',
                    bottle_id: prevEntry.bottle_id || savedEntry.bottle_id || '',
                  };
                  // The response carries the whole 4 x 24 grid, but only the
                  // rows the operator actually changed can differ. Reusing the
                  // previous object when none of the five merged fields moved
                  // keeps every untouched row referentially stable, so the
                  // memoized <QualityTimeRow> components skip re-rendering.
                  byTime[tKey] = MERGED_ROW_FIELDS.every((f) => merged[f] === prevEntry[f])
                    ? prevEntry
                    : merged;
                }
              }
              mergedDate[mKey] = byTime;
            }
            return { ...prev, [date]: mergedDate };
          });
        }
        // These rows are now persisted. Clear ONLY the marks this request
        // carried: a cell edited again while the request was in flight has a
        // newer sequence number, so it stays dirty and is written by the very
        // next auto-save. Clearing the whole date instead would silently drop
        // that edit when the page is refreshed.
        const byDateTouched = touchedTimes.current[date];
        if (byDateTouched) {
          for (const [mStr, byTime] of Object.entries(sentSeqs)) {
            const live = byDateTouched[mStr];
            if (!live) continue;
            for (const [tKey, seq] of Object.entries(byTime)) {
              if (live[tKey] === seq) delete live[tKey];
            }
          }
        }
        // A shift-only edit leaves no touched cells, so this flag is cleared
        // unconditionally: reaching here means the day was persisted.
        dirtyShiftsRef.current.delete(date);
        if (pendingCellCount(date) === 0) dirtyDatesRef.current.delete(date);
        setSavedFlags((prev) => ({ ...prev, [date]: true }));
      }

      if (failed > 0) {
        const message = lastError
          ? `Save failed — ${lastError}`
          : 'Save failed — changes were not persisted. Check your connection and try again.';
        setAutoSaveError(message);
        if (options.silent) toast.error(`${message} Retrying automatically.`);
        else toast.error(message);
        scheduleRetry();
      } else if (savedAny) {
        retryAttemptRef.current = 0;
        setAutoSaveError('');
        setAutoSaveStatusSafe('saved');
        if (!options.silent) toast.success(`Saved production quality data for ${dateLabel}`);
      } else if (attempted) {
        setAutoSaveStatusSafe('error');
        toast.error('Save failed — changes were not persisted. Check your connection and try again.');
      } else {
        // Nothing was left to write — the operator cleared a cell back to empty
        // inside the debounce window, so there is no pending change to report.
        setAutoSaveError('');
        setAutoSaveStatusSafe('idle');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }

    // Anything that became dirty while the request was in flight is flushed now
    // so a burst of edits never needs a second manual save. A failed run never
    // reschedules here: the backoff loop below owns the retries, and adding a
    // second schedule on top of it would hammer an unreachable server.
    if (failed === 0 && options.reason !== 'unload' && retryTimerRef.current === null && dirtyDatesRef.current.size > 0) {
      const remaining = drainDirtyDates();
      if (remaining.length > 0) {
        clearAutoSaveTimer();
        autoSaveTimerRef.current = window.setTimeout(() => {
          autoSaveTimerRef.current = null;
          void runSaveRef.current(remaining, { touchedOnly: true, silent: true, reason: 'auto' });
        }, AUTO_SAVE_DEBOUNCE_MS);
        setAutoSaveStatusSafe('pending');
      }
    }

    // Fade the indicator back to its resting state once a write has landed and
    // nothing new has been typed in the meantime.
    if (dirtyDatesRef.current.size === 0 && retryTimerRef.current === null) {
      clearStatusResetTimer();
      statusResetTimerRef.current = window.setTimeout(() => {
        statusResetTimerRef.current = null;
        if (dirtyDatesRef.current.size === 0) setAutoSaveStatusSafe('idle');
      }, AUTO_SAVE_STATUS_RESET_MS);
    }
  };

  /** Re-arms runSaveRef so timers always reach the newest closure. */
  useEffect(() => {
    runSaveRef.current = runSave;
  });

  const handleSave = () => {
    void runSaveRef.current([dateKey], { touchedOnly: false, silent: false, reason: 'manual' });
  };

  const handleExport = () => {
    const rows: string[] = [];

   // Report header: company name + selected date and day
rows.push(reportHeader.company);

const [day, month, year] = dateLabel.split('-');
const reportDate = new Date(`${year}-${month}-${day}T00:00:00`);

const dateAndDay = `${dateLabel} - ${reportDate.toLocaleDateString('en-US', {
  weekday: 'long',
})}`;

rows.push(dateAndDay);

    const header = [
      'Shift', 'Time', 'Machine', 'Bottle Name', 'Weight F', 'Weight M', 'Weight R',
      'AVG', 'Speed/Min', 'Packing Category', 'Packing Size', 'Cartons', 'Bottles in Nos.',
      'QTY EFF%', 'SQC', 'QC Hold', 'NUM', 'Defects', 'Remarks',
    ];
    rows.push(header.join(','));
    for (const pt of PRODUCTION_TIMES) {
      const e = productionStore[dateKey]?.[String(activeMachine)]?.[pt.time];
      if (!e) {
        rows.push([SHIFT_LABELS[pt.shift_id - 1], pt.time, `Machine ${activeMachine}`, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''].join(','));
        continue;
      }
      const bottleName = bottles.find((b) => b.id === e.bottle_id)?.name ?? e.bottle_id;
      const defectNames = defectGroups.length > 0
        ? defectGroups.flatMap((g) => g.items).filter((d) => e.defect_ids.includes(d))
        : (e.defect_ids ?? []);
      const eff = calcEffFor(e, activeMachine);
      rows.push(
        [
          SHIFT_LABELS[e.shift_id - 1] ?? SHIFT_LABELS[pt.shift_id - 1],
          e.production_time,
          `Machine ${activeMachine}`,
          bottleName,
          e.weight_front,
          e.weight_middle,
          e.weight_rear,
          calcRowAvgFor(e, activeMachine),
          e.speed_per_min,
          (e.packing_category ?? []).join(' / '),
          e.packing_size,
          e.cartons,
          calcBottlesInNosFor(e) || e.bottles_in_nos,
          eff,
          e.sqc,
          e.qc_hold,
          e.num,
          defectNames.join(' / '),
          e.remarks,
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
      );
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `production-quality-monitor-machine-${activeMachine}-${dateKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported Machine ${activeMachine} — ${dateLabel} to CSV`);
  };

  const [isPrinting, setIsPrinting] = useState(false);

  // Generates a landscape PDF of the currently loaded Quality Monitor data and
  // downloads it directly — mirrors the Production Planning module's print
  // behavior (jspdf + jspdf-autotable, no window.print() / browser dialog).
  const handlePrint = async () => {
    if (isPrinting) return;
    setIsPrinting(true);

    try {
      // jspdf + autoTable are only needed for printing — load them lazily so
      // the initial bundle stays small. CJS interop fallback via .default.
      const jspdfModule: any = await import('jspdf');
      const jsPDF = jspdfModule.jsPDF ?? jspdfModule.default?.jsPDF;
      const autoTableModule: any = await import('jspdf-autotable');
      const autoTable = autoTableModule.autoTable ?? autoTableModule.default;

      // Collect ALL currently available monitor data — the same in-memory store
      // the table renders from, so no extra API/database calls are needed.
      const byTime = productionStore[dateKey]?.[String(activeMachine)] ?? {};

      const bottleNameFor = (id: string) =>
        bottles.find((b) => b.id === id)?.name ?? id;

      const defectNamesFor = (entry?: QualityHourlyEntry): string[] => {
        if (defectGroups.length === 0) return entry?.defect_ids ?? [];
        return allDefectNames.filter((d) => (entry?.defect_ids ?? []).includes(d));
      };

      const doc = new jsPDF('landscape');

      // ── Header: report title block, date, machine + shift assignments ───
      // Report header — company name + selected date and day, centred.
const centerX = doc.internal.pageSize.getWidth() / 2;

doc.setFont('helvetica', 'bold');
doc.setFontSize(10);
doc.text(reportHeader.company, centerX, 10, { align: 'center' });

const [day, month, year] = dateLabel.split('-');
const reportDate = new Date(`${year}-${month}-${day}T00:00:00`);

const dateAndDay = `${dateLabel} - ${reportDate.toLocaleDateString('en-US', {
  weekday: 'long',
})}`;

doc.setFontSize(8);
doc.text(dateAndDay, centerX, 15.5, { align: 'center' });

      doc.setFontSize(10);
      doc.text('Hourly Production Monitor', 10, 22);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(`Date: ${dateLabel}    Machine: No. ${activeMachine}`, 10, 27.5);
      let y = 32;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text('Shift Assignments (Supervisor / Executive):', 10, y);

      y += 4;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);

      const shiftAssignments = DB_SHIFT_MASTER.map((sh) => {
        const a = getShiftAssignment(sh.shift_id);

        return `${sh.shift_name}: Sup. ${a.supervisor || '—'} | Exec. ${a.executive || '—'}`;
      });

      doc.text(shiftAssignments.join('     |     '), 10, y);

      const startY = y + 5;
      // ── Table header (two rows; Weight F/M/R depends on machine gob type) ─
      const headRowBase: any[] = [
        { content: 'Time', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Shift', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Bottle Name', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Weight (gms)', colSpan: hasM ? 3 : 2, styles: { halign: 'center' } },
        { content: 'Average', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Speed/Min', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Packing Category', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Packing Size', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Cartons', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Bottles', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'QTY EFF%', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'SQC', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'QC HOLD', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'NUM', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Defects', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
        { content: 'Remarks', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
      ];
      const head = [headRowBase, ['F', ...(hasM ? ['M'] : []), 'R']];

      // ── Body: all 24 hourly rows (calculations identical to on-screen) ───
      const body: any[][] = [];
      for (const pt of PRODUCTION_TIMES) {
        const e = byTime[pt.time];
        const defectNames = defectNamesFor(e);
        body.push([
          pt.time,
          SHIFT_LABELS[pt.shift_id - 1] ?? '',
          e?.bottle_id ? bottleNameFor(e.bottle_id) : '',
          e?.weight_front ?? '',
          ...(hasM ? [e?.weight_middle ?? ''] : []),
          e?.weight_rear ?? '',
          calcRowAvgFor(e, activeMachine),
          e?.speed_per_min ?? '',
          (e?.packing_category ?? []).join(' / '),
          e?.packing_size ?? '',
          e?.cartons ?? '',
          calcBottlesInNosFor(e) || e?.bottles_in_nos || '',
          calcEffFor(e, activeMachine),
          e?.sqc ?? '',
          e?.qc_hold != null ? String(e.qc_hold) : '0',
          e?.num ?? '',
          defectNames.join(' / '),
          e?.remarks ?? '',
        ]);
      }

      // Day Avg / Summary row — mirrors the on-screen totals.
      const colCount = hasM ? 18 : 17;
      const summary: any[] = new Array(colCount).fill('');
      summary[0] = {
        content: 'Day Avg / Summary',
        colSpan: 3,
        styles: { halign: 'right', fontStyle: 'bold' },
      };
      let wIdx = 3;
      summary[wIdx++] = dayAvgs.front;
      if (hasM) summary[wIdx++] = dayAvgs.middle;
      summary[wIdx++] = dayAvgs.rear;
      summary[wIdx++] = dayAvgs.avg;
      wIdx++; // Speed
      wIdx++; // Packing Category
      wIdx++; // Packing Size
      summary[wIdx++] = stats.totalCartons.toLocaleString();
      summary[wIdx++] = stats.totalBottles.toLocaleString();
      summary[wIdx++] = `${stats.avgEff}%`;
      body.push(summary);

      // ── Column widths + alignment (landscape A4 with 10mm page margins) ──
      const colWidths = hasM
        ? [13, 11, 34, 11, 11, 11, 13, 13, 16, 11, 11, 13, 11, 11, 11, 11, 24, 24]
        : [13, 11, 34, 11, 11, 13, 13, 16, 11, 11, 13, 11, 11, 11, 11, 24, 24];

      const columnStyles: Record<number, any> = {};
      colWidths.forEach((w, i) => {
        const leftAligned = i === 2 || i === colWidths.length - 1 || i === colWidths.length - 2;
        columnStyles[i] = { cellWidth: w, halign: leftAligned ? 'left' : 'center' };
      });

      // Rows flow onto additional pages automatically when the 24-hour table
      // and summary exceed a single physical page — nothing is truncated.
      autoTable(doc, {
        head,
        body,
        startY,
        margin: { top: startY, left: 10, right: 10, bottom: 12 },
        theme: 'grid',
        includeEmptyRows: true,
        columnStyles,
        styles: {
          fontSize: 6,
          cellPadding: 1.4,
          textColor: [30, 41, 59],
          lineColor: [203, 213, 225],
          lineWidth: 0.1,
          valign: 'middle',
        },
        headStyles: {
          fillColor: [30, 41, 59],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          fontSize: 6.5,
          halign: 'center',
        },
        alternateRowStyles: false,
        didParseCell: (data: any) => {
          if (data.section !== 'body') return;
          const idx = data.row.index;
          if (idx < PRODUCTION_TIMES.length) {
            const shiftIdx = Math.floor(idx / 8);
            data.cell.styles.fillColor = SHIFT_ROW_BG[shiftIdx];
          } else {
            data.cell.styles.fillColor = [240, 244, 250];
            data.cell.styles.fontStyle = 'bold';
          }
        },
      });

      // ── Footer with page numbers on every page ──────────────────────────
      const pageCount = doc.getNumberOfPages();
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.text(`Hourly Production Monitor — Machine ${activeMachine} — ${dateLabel}`, 10, pageH - 5);
        doc.text(`Page ${i} of ${pageCount}`, pageW - 10, pageH - 5, { align: 'right' });
      }

      doc.save(`Production_Quality_Monitor_${dateKey}.pdf`);
      toast.success('Generated PDF successfully.');
    } catch (error) {
      console.error(error);
      toast.error('Failed to generate PDF. Please try again.');
    } finally {
      setIsPrinting(false);
    }
  };

  const shiftDate = (delta: number) => {
    const d = new Date(navDate);
    d.setDate(d.getDate() + delta);
    setNavDate(d);
  };

  /** Date filter — jump straight to any historical date from the picker. */
  const pickDate = (iso: string) => {
    const d = fromIso(iso);
    if (d) setNavDate(d);
  };

  const thStyle = (last = false): React.CSSProperties => ({
    padding: '8px 6px',
    color: C.headerText,
    fontWeight: 600,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    borderRight: last ? 'none' : `1px solid ${C.border}`,
    whiteSpace: 'pre-line',
    lineHeight: 1.3,
    verticalAlign: 'middle',
    textAlign: 'center',
    backgroundColor: C.headerBg,
  });

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '5px 8px',
    fontSize: '12px',
    color: '#1e293b',
    backgroundColor: '#ffffff',
    border: `1px solid ${C.border}`,
    borderRadius: '5px',
    outline: 'none',
    transition: 'border-color 0.15s',
  };

  return (
    <div className="print-container p-4 md:p-5 max-w-[1920px] mx-auto animate-in fade-in duration-200">
      <style>{`
        @media print {
          @page { size: landscape; margin: 0.15in; }
          body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .print-container { padding: 0 !important; max-width: none !important; animation: none !important; }
          .no-print { display: none !important; }
          .print-header { display: block !important; }
          .print-header { margin-bottom: 3px !important; padding-bottom: 3px !important; }
          .print-header h2 { font-size: 11px !important; margin: 0 !important; }
          .print-header p { font-size: 9px !important; margin: 0 !important; }
          table { font-size: 7px !important; width: 100% !important; min-width: 0 !important; table-layout: fixed !important; border-collapse: collapse !important; }
          th, td { padding: 1px 2px !important; font-size: 7px !important; line-height: 1.1 !important; }
          thead tr th { font-size: 6.5px !important; }
          input, select, textarea { border: none !important; background: transparent !important; padding: 0 !important; font-size: 7px !important; color: #1e293b !important; -webkit-appearance: none !important; appearance: none !important; }
          tbody button { display: none !important; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          thead { display: table-header-group; }
        }
      `}</style>

      {/* Print-only header */}
      <div className="print-header" style={{ display: 'none', marginBottom: '6px', textAlign: 'center', borderBottom: '2px solid #1e293b', paddingBottom: '6px' }}>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#1e293b' }}>
          {COMPANY_NAME}
        </h2>
        <p style={{ margin: '1px 0 3px', fontSize: '11px', fontWeight: 600, color: '#1e293b' }}>
          {reportHeader.title}
        </p>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#1e293b' }}>
          Machine {activeMachine} — Production Quality Report
        </h2>
        <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#64748b' }}>
          Date: {dateLabel}
        </p>
      </div>
      {/* Page title row */}
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#1e293b', letterSpacing: '-0.01em' }}>
            Hourly Production Monitor
          </h1>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: C.textMuted }}>
            Hourly quality log — {dateLabel}{loadedDates[dateKey] ? '' : ' (loading…)'}
          </p>
          {loadErrors[dateKey] && (
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#b91c1c', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', padding: '6px 10px', display: 'inline-block' }}>
              {loadErrorDetails[dateKey]
                ? `Could not load saved data — ${loadErrorDetails[dateKey]} The grid may be out of date.`
                : 'Could not reach the server — showing an empty grid. Edits made now cannot be saved until the connection is restored.'}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={handlePrint}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px',
              fontSize: '12.5px', fontWeight: 500, color: '#1e293b', backgroundColor: '#ffffff',
              border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer',
              transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f8fafc'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
          >
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
          <button
            onClick={handleExport}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px',
              fontSize: '12.5px', fontWeight: 500, color: '#ffffff', backgroundColor: '#2563eb',
              border: 'none', borderRadius: '6px', cursor: 'pointer', transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#1d4ed8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#2563eb'; }}
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
        </div>
      </div>

      {/* Shift Assignment cards
      <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
        {DB_SHIFT_MASTER.map((sh, i) => {
          const assignment = getShiftAssignment(sh.shift_id);
          return (
            <div
              key={sh.shift_id}
              style={{
                flex: 1,
                backgroundColor: SHIFT_ROW_BG[i],
                border: `1px solid ${SHIFT_BORDERS[i]}`,
                borderRadius: '8px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  backgroundColor: SHIFT_CELL_BG[i],
                  borderBottom: `1px solid ${SHIFT_BORDERS[i]}`,
                  padding: '6px 12px',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '8px',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 700, color: SHIFT_CELL_COLOR[i], letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  {sh.shift_name}
                </span>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 400 }}>{sh.display_time}</span>
              </div>
              <div style={{ padding: '8px 12px', display: 'flex', gap: '10px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', fontWeight: 600, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '3px' }}>
                    Supervisor
                  </div>
                  <input
                    type="text"
                    value={assignment.supervisor}
                    disabled={!canEdit}
                    onChange={(e) => patchShiftAssignment(sh.shift_id, { supervisor: e.target.value })}
                    placeholder={canEdit ? 'Enter supervisor name...' : ''}
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = '#2563eb'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', fontWeight: 600, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '3px' }}>
                    Executive
                  </div>
                  <input
                    type="text"
                    value={assignment.executive}
                    disabled={!canEdit}
                    onChange={(e) => patchShiftAssignment(sh.shift_id, { executive: e.target.value })}
                    placeholder={canEdit ? 'Enter executive name...' : ''}
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = '#2563eb'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div> */}

      {/* White card */}
      <div style={{ backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: '10px', boxShadow: '0 1px 4px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
        {/* Machine tabs + date navigation */}
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${C.border}`, padding: '0 8px', backgroundColor: '#f8fafc', gap: '2px' }}>
          {DB_MACHINE_MASTER.map((m) => {
            const active = activeMachine === m.machine_no;
            return (
              <button
                key={m.machine_no}
                onClick={() => setActiveMachine(m.machine_no)}
                style={{
                  padding: '7px 18px',
                  margin: '8px 4px',
                  fontSize: '13px',
                  fontWeight: active ? 600 : 400,
                  color: active ? '#ffffff' : C.textMuted,
                  backgroundColor: active ? '#2563eb' : 'transparent',
                  border: `1px solid ${active ? '#2563eb' : C.border}`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  outline: 'none',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                Machine {m.machine_no}
              </button>
            );
          })}
          <button
            onClick={() => setActiveMachine(0)}
            style={{
              padding: '7px 18px',
              margin: '8px 4px',
              fontSize: '13px',
              fontWeight: activeMachine === 0 ? 600 : 400,
              color: activeMachine === 0 ? '#ffffff' : C.textMuted,
              backgroundColor: activeMachine === 0 ? '#2563eb' : 'transparent',
              border: `1px solid ${activeMachine === 0 ? '#2563eb' : C.border}`,
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.15s',
              outline: 'none',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => { if (activeMachine !== 0) e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
            onMouseLeave={(e) => { if (activeMachine !== 0) e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            All Machine
          </button>
          {reportId && activeMachine !== 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '6px', margin: '4px 0' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', letterSpacing: '0.02em' }}>
                Report ID: R{String(reportId).padStart(3, '0')}
              </span>
            </div>
          )}
          <div style={{ flex: 1 }} />

          {/* Date navigation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 6px' }}>
            <button
              onClick={() => shiftDate(-1)}
              style={{
                display: 'flex', alignItems: 'center', gap: '4px', padding: '5px 11px',
                fontSize: '12px', fontWeight: 500, color: C.textMuted, backgroundColor: 'transparent',
                border: `1px solid ${C.border}`, borderRadius: '6px', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span style={{ fontSize: '14px', lineHeight: 1 }}>‹</span> Previous Day
            </button>

            {/* Date filter — pick any date directly (shared by HRP + Daily Report) */}
            <label
              style={{
                display: 'flex', alignItems: 'center', gap: '5px', padding: '3px 8px',
                fontSize: '12px', fontWeight: 500, color: C.textMuted,
                backgroundColor: C.white,
                border: `1px solid ${C.border}`, borderRadius: '6px', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = C.white; }}
              title={dateLabel}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <input
                type="date"
                value={dateKey}
                onChange={(e) => pickDate(e.target.value)}
                style={{
                  border: 'none', outline: 'none', background: 'transparent',
                  fontSize: '12px', fontWeight: 600, color: '#1e293b',
                  padding: '2px 0', cursor: 'pointer',
                }}
              />
            </label>

            <button
              onClick={() => setNavDate(new Date())}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 12px',
                fontSize: '12px', fontWeight: isToday ? 700 : 500,
                color: isToday ? '#2563eb' : C.textMuted,
                backgroundColor: isToday ? '#eff6ff' : 'transparent',
                border: `1px solid ${isToday ? '#bfdbfe' : C.border}`,
                borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap',
                transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { if (!isToday) e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
              onMouseLeave={(e) => { if (!isToday) e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <CalendarDays className="w-3.5 h-3.5" /> Today
            </button>

            <button
              onClick={() => shiftDate(1)}
              style={{
                display: 'flex', alignItems: 'center', gap: '4px', padding: '5px 11px',
                fontSize: '12px', fontWeight: 500, color: C.textMuted, backgroundColor: 'transparent',
                border: `1px solid ${C.border}`, borderRadius: '6px', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              Next Day <span style={{ fontSize: '14px', lineHeight: 1 }}>›</span>
            </button>
          </div>
        </div>

        {activeMachine !== 0 && (
        <>
        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: hasM ? '1332px' : '1272px' }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={2} style={{ ...thStyle(), width: '38px', borderBottom: `2px solid ${C.border}`, padding: '9px 4px' }}>Shift</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '76px', borderBottom: `2px solid ${C.border}`, padding: '9px 6px' }}>Time</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '200px', borderBottom: `2px solid ${C.border}`, padding: '9px 10px', textAlign: 'left' }}>Bottle Name</th>
                <th colSpan={hasM ? 3 : 2} style={{ ...thStyle(), borderBottom: `1px solid ${C.border}` }}>Weight (gms)</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}`, color: '#475569' }}>Avg</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>{'Speed\n/Min'}</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>{'Packing\nCategory'}</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>{'Packing\nSize'}</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>Cartons</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>{'Bottles\nin Nos.'}</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>QTY EFF%</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>SQC</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>{'QC\nHOLD'}</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '68px', borderBottom: `2px solid ${C.border}` }}>NUM</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '120px', textAlign: 'left', borderBottom: `2px solid ${C.border}` }}>DEFECTS</th>
                <th rowSpan={2} style={{ ...thStyle(true), width: '120px', textAlign: 'left', borderBottom: `2px solid ${C.border}` }}>Remarks</th>
              </tr>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th style={{ ...thStyle(), width: '50px', fontSize: '10px', borderBottom: `2px solid ${C.border}`, color: '#475569' }}>F</th>
                {hasM && <th style={{ ...thStyle(), width: '50px', fontSize: '10px', borderBottom: `2px solid ${C.border}`, color: '#475569' }}>M</th>}
                <th style={{ ...thStyle(), width: '50px', fontSize: '10px', borderBottom: `2px solid ${C.border}`, color: '#475569' }}>R</th>
              </tr>
            </thead>
            <tbody>
              {PRODUCTION_TIMES.map((slot, idx) => {
                const { time } = slot;
                const shiftIdx = Math.floor(idx / 8);
                const isFirstInShift = idx % 8 === 0;
                const entry = activeRows[time];
                // Only the current entry of the running job carries the "+" and
                // "−" buttons; every earlier entry of that job — and every entry
                // of a job a later entry has replaced — is read-only plain text.
                const isActiveEntry = time === activeEntryTime;
                const bottleName = entry?.bottle_id
                  ? bottleNameById.get(entry.bottle_id) ?? entry.bottle_id
                  : '';

                return (
                  <QualityTimeRow
                    key={time}
                    time={time}
                    shiftIdx={shiftIdx}
                    isFirstInShift={isFirstInShift}
                    entry={entry}
                    gobCount={gobCount}
                    hasM={hasM}
                    bottles={machineBottles}
                    allDefectNames={allDefectNames}
                    defectGroups={defectGroups}
                    loadingDefects={loadingDefects}
                    selectBottle={selectBottle}
                    patchEntry={patchEntry}
                    copyRowDown={copyRowDown}
                    removeBottle={removeBottle}
                    canEdit={canEdit}
                    isActiveEntry={isActiveEntry}
                    bottleName={bottleName}
                  />
                );
              })}

              {/* Day Avg / Summary row */}
              <tr style={{ backgroundColor: '#f0f4fa', borderTop: `2px solid ${C.border}` }}>
                <td colSpan={3} style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontSize: '11px', color: '#334155', letterSpacing: '0.06em', textTransform: 'uppercase', borderRight: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                  Day Avg / Summary
                </td>
                <td style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 700, fontSize: '12px', color: '#1e293b', borderRight: `1px solid ${C.border}` }}>
                  {dayAvgs.front}
                </td>
                {hasM && (
                  <td style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 700, fontSize: '12px', color: '#1e293b', borderRight: `1px solid ${C.border}` }}>
                    {dayAvgs.middle}
                  </td>
                )}
                <td style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 700, fontSize: '12px', color: '#1e293b', borderRight: `1px solid ${C.border}` }}>
                  {dayAvgs.rear}
                </td>
                <td style={{ padding: '8px 6px', textAlign: 'center', borderRight: `1px solid ${C.border}` }}>
                  {dayAvgs.avg ? (
                    <span style={{ display: 'inline-block', backgroundColor: '#334155', color: '#ffffff', borderRadius: '4px', padding: '2px 7px', fontWeight: 700, fontSize: '12px' }}>
                      {dayAvgs.avg}
                    </span>
                  ) : ''}
                </td>
                <td style={{ padding: '8px 6px', borderRight: `1px solid ${C.border}` }} />
                <td style={{ padding: '8px 6px', borderRight: `1px solid ${C.border}` }} />
                <td style={{ padding: '8px 6px', borderRight: `1px solid ${C.border}` }} />
                <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#1e293b', fontSize: '13px', borderRight: `1px solid ${C.border}` }}>
                  {stats.totalCartons.toLocaleString()}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#1e293b', fontSize: '13px', borderRight: `1px solid ${C.border}` }}>
                  {stats.totalBottles.toLocaleString()}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center', borderRight: `1px solid ${C.border}` }}>
                  <span style={{ display: 'inline-block', backgroundColor: '#2563eb', color: '#ffffff', borderRadius: '4px', padding: '2px 8px', fontWeight: 700, fontSize: '12px' }}>
                    {stats.avgEff}%
                  </span>
                </td>
                <td style={{ padding: '8px 6px', borderRight: `1px solid ${C.border}` }} />
                <td style={{ padding: '8px 6px', borderRight: `1px solid ${C.border}` }} />
                <td style={{ padding: '8px 6px', borderRight: `1px solid ${C.border}` }} />
                <td colSpan={2} style={{ padding: '8px 10px' }} />
              </tr>
            </tbody>
          </table>
        </div>

        {/* Auto-save status + Save button */}
        <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '12px', padding: '10px 14px', borderTop: `1px solid ${C.border}`, backgroundColor: '#fafafa' }}>
          {autoSaveStatus !== 'idle' ? (
            <span
              title={autoSaveStatus === 'error' && autoSaveError ? autoSaveError : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                fontSize: '11.5px', color: AUTO_SAVE_STATUS_VIEW[autoSaveStatus].color, fontWeight: 600,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: '7px', height: '7px', borderRadius: '50%',
                  backgroundColor: AUTO_SAVE_STATUS_VIEW[autoSaveStatus].color,
                  opacity: autoSaveStatus === 'saving' ? 0.45 : 1,
                }}
              />
              {AUTO_SAVE_STATUS_VIEW[autoSaveStatus].label}
            </span>
          ) : (
            savedFlags[dateKey] && (
              <span style={{ fontSize: '11.5px', color: '#15803d', fontWeight: 600 }}>
                Saved for {dateLabel}
              </span>
            )
          )}
          {canEdit && (
            <button
              onClick={() => handleSave()}
              disabled={saving}
              style={{
                backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '6px',
                padding: '7px 22px', fontSize: '13px', fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
                letterSpacing: '0.01em', transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { if (!saving) e.currentTarget.style.backgroundColor = '#1d4ed8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#2563eb'; }}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
        </>
        )}
      </div>

      {activeMachine !== 0 && <QualityReport date={navDate} />}

      {activeMachine === 0 && <AllMachineReport date={navDate} />}

      <Toaster position="bottom-right" richColors />
    </div>
  );
};
