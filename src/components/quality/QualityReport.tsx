/**
 * QualityReport.tsx — Daily Production Performance Report (frontend only).
 *
 * Every figure in this report is calculated inside this file from the HPR /
 * Quality hourly records the application already fetches through the existing
 * qualityRepository (GET /api/production/quality/daily/). No new database
 * table, and no change to the Quality Module, production calculations, shift
 * logic or job logic — this is a read-only representation of existing data.
 *
 * The report takes the selected date as a prop from the Quality Module's Hourly
 * Production Monitor controls; it owns no date state and renders no date
 * buttons of its own.
 *
 * The job-wise production summary rendered below the report adds ONE extra
 * READ-ONLY call (GET /api/production/quality/daily/jobs/?date=) over the same
 * hpr tables the Quality Module already writes. It creates no table, changes no
 * existing endpoint and, whenever it is unavailable, falls back to rows derived
 * from the same hourly records the report above already loaded.
 *
 * Print and Refresh are read-only affordances on top of the same data: Print
 * sends only this report to the printer, Refresh re-reads the same date through
 * the same qualityRepository call. Neither touches the report's calculations,
 * the Quality Module, the API or the database.
 *
 * The Shift-Wise Efficiency Report
 rendered above the Daily
 * table is another read-only view of those SAME hourly records: actual bottle
 * production, an independent efficiency per machine and shift, and each
 * machine's overall day efficiency, calculated in this file only — no extra
 * API call and no schema or backend change.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { useERP } from '../../context/ERPContext';
import { planningRepository } from '../../services/planningRepository';
import {
  qualityRepository,
  QualityDayHourly,
  QualityHourlyEntry,
  QualityJobRow,
  hasMeaningfulData,
} from '../../services/qualityRepository';
import { getGobCountFromDB, calculateTheoreticalBottles } from '../../utils/calculations';
import {
  buildLayerOutTimeline,
  buildProductionTimeline,
  layerOutInputsFromSavedPeriods,
  LayerOutSlot,
  ProductionTimeSlot,
} from '../../utils/layerOutTimeline';

// ─── Hourly HPR slots — mirrors the Quality Module's 24-slot shift mapping ──
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

const MACHINE_NOS = [1, 2, 3, 4];

/** Last hourly key of each shift — the production-time boundary after it. */
const SHIFT_END_KEYS = [1, 2, 3].map((shiftId) => {
  const slots = PRODUCTION_TIMES.filter((pt) => pt.shift_id === shiftId);
  return slots[slots.length - 1].time;
});

interface ProductionShiftWindow {
  startMinutes: number;
  endMinutes: number;
}

/**
 * Production-time windows of the three shifts. The Production Timeline is
 * continuous across Lehr Out boundaries and midnight, so a bottle's target
 * minutes must be clipped against these windows instead of the Packing
 * Timeline labels: the shift-ending row absorbs the Lehr Out difference and a
 * carry-in row belongs to the previous day's third shift. Without this clip,
 * Shift-II minutes can leak into Shift-I's target denominator.
 */
const buildProductionShiftWindows = (
  productionSlots: Record<string, ProductionTimeSlot>
): ProductionShiftWindow[] => {
  const firstKey = PRODUCTION_TIMES[0]?.time ?? '';
  let cursor = productionSlots[firstKey]?.startMinutes ?? 0;
  return SHIFT_END_KEYS.map((key) => {
    const slot = productionSlots[key];
    const end = slot && Number.isFinite(slot.endMinutes) && slot.endMinutes > cursor
      ? slot.endMinutes
      : cursor + 480;
    const window = { startMinutes: cursor, endMinutes: end };
    cursor = end;
    return window;
  });
};

/**
 * Actual production minutes of one slot inside one shift. Falls back to the
 * Packing Timeline duration only when the Production Timeline is unavailable;
 * a real (zero-width) overlap is never replaced with the fallback.
 */
const productionMinutesForShift = (
  productionSlot: ProductionTimeSlot | undefined,
  window: ProductionShiftWindow,
  fallbackHours: number
): number => {
  const fallback = Number.isFinite(fallbackHours) && fallbackHours > 0 ? fallbackHours * 60 : 0;
  if (
    !productionSlot ||
    !Number.isFinite(productionSlot.startMinutes) ||
    !Number.isFinite(productionSlot.endMinutes) ||
    productionSlot.endMinutes <= productionSlot.startMinutes ||
    !Number.isFinite(window.startMinutes) ||
    !Number.isFinite(window.endMinutes) ||
    window.endMinutes <= window.startMinutes
  ) return fallback;

  const overlap = Math.min(productionSlot.endMinutes, window.endMinutes)
    - Math.max(productionSlot.startMinutes, window.startMinutes);
  return overlap > 0 ? overlap : 0;
};

/** Stable empty day — used while the selected date's window is not loaded yet. */
const EMPTY_DAY: QualityDayHourly = {};

const C = {
  border: '#e2e8f0',
  headerBg: '#f8fafc',
  headerText: '#1e293b',
  textMain: '#1e293b',
  textMuted: '#64748b',
  white: '#ffffff',
};

/**
 * Row background per machine — Daily Production Performance Report body rows.
 * All machines use white; total rows keep their own highlighting below.
 */
const MACHINE_ROW_BG: Record<number, string> = {
  1: '#ffffff',
  2: '#ffffff',
  3: '#ffffff',
  4: '#ffffff',
};

// ─── Helpers ───────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

const parseNum = (v?: string | null): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Actual production of one hourly HPR record, in bottles — the same
 * "Bottles in Nos." value the Quality Module shows (packing size × cartons),
 * falling back to the stored bottles_in_nos column.
 */
const hourlyUnits = (e?: QualityHourlyEntry | null): number => {
  if (!e) return 0;
  const ps = parseInt(e.packing_size ?? '', 10);
  const ct = parseInt(e.cartons ?? '', 10);
  if (ps > 0 && ct > 0) return ps * ct;
  const stored = parseInt(e.bottles_in_nos ?? '', 10);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
};

/**
 * ACTUAL produced bottles of one entry for the Job-wise Production Summary —
 * mirrors the backend's _entry_units(): the stored combined "Bottles in Nos."
 * (TYPE 1 + TYPE 2), with TYPE 1 packing size × cartons only as a legacy
 * fallback. Never the packed-carton quantity. Used by the local fallback when
 * the jobs endpoint is unavailable, so it stays consistent with the endpoint.
 */
const jobEntryUnits = (e?: QualityHourlyEntry | null): number => {
  const stored = parseInt(e?.bottles_in_nos ?? '', 10);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return hourlyUnits(e);
};

/**
 * Efficiency % of one hourly production segment — production-UNITS based only.
 *
 *   Efficiency % = (Segment Actual Production Units / Segment Expected Units) × 100
 *
 * "Expected Production Units" is the As-Per-Speed theoretical quantity
 * (Speed/min × 60 × Machine Gob × Duration/Hours). Weight, draw and weight
 * efficiency are never used here. Returns null when expected units are zero,
 * missing or non-finite so callers omit the segment. The exact calculated
 * value is returned — actual production can exceed the rated speed, so values
 * above 100% display uncapped, like the Quality grid.
 */
const calcUnitEfficiency = (actualUnits: number, expectedUnits: number): number | null => {
  const actual = Number(actualUnits);
  const expected = Number(expectedUnits);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  const efficiency = (actual / expected) * 100;
  return Number.isFinite(efficiency) ? efficiency : null;
};

/**
 * Weight Efficiency % — draw based only.
 *
 *   Weight Efficiency % = (Actual Total Draw / Total Draw as per Speed) × 100
 *
 * Kept as a dedicated function so the existing unit-based efficiency
 * calculations (calcUnitEfficiency and every caller) stay untouched.
 * Returns null when the as-per-speed draw is zero, missing or non-finite so
 * callers render '—' instead of dividing by zero, and shows the exact
 * calculated percentage like the Quality grid — no cap at 100%.
 */
const calcWeightEfficiency = (actualDraw: number, asPerSpeedDraw: number): number | null => {
  const actual = Number(actualDraw);
  const expected = Number(asPerSpeedDraw);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  const efficiency = (actual / expected) * 100;
  return Number.isFinite(efficiency) ? efficiency : null;
};

/**
 * Applicable weight of one hourly record — stored weight_avg when present,
 * otherwise the same F/M/R average the Quality Module computes from the
 * machine's gob type.
 */
const hourlyWeight = (e: QualityHourlyEntry | undefined, gobCount: number): number | null => {
  if (!e) return null;
  const avg = parseFloat(e.weight_avg);
  if (Number.isFinite(avg) && avg > 0) return avg;
  const rear = parseFloat(e.weight_rear);
  const vals = [parseFloat(e.weight_front), rear];
  if (gobCount === 3) vals.splice(1, 0, parseFloat(e.weight_middle));
  const valid = vals.filter((v) => Number.isFinite(v) && v > 0);
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
};

/** Machine gob count — same source the existing production formula uses. */
const machineGob = (
  machineNo: number,
  machines: { code: string; gobCount: number }[]
): number => {
  const code = `MAC-${String(machineNo).padStart(2, '0')}`;
  const fromErp = machines.find((m) => m.code === code)?.gobCount;
  if (fromErp && fromErp > 0) return fromErp;
  return getGobCountFromDB(machineNo);
};

/**
 * Bottle name for a production bottle id, read from the same bottle master the
 * Quality Monitor grid uses. The id is the identity (names collide), so an
 * unknown id is displayed as-is instead of guessing a name.
 */
const bottleNameFor = (bottleId: string, bottles: { id: string; name: string }[]): string => {
  const id = String(bottleId ?? '').trim();
  if (!id) return '';
  const hit = bottles.find((b) => String(b.id ?? '').trim() === id);
  return hit?.name?.trim() || id;
};

// ─── Print isolation ────────────────────────────────────────────────────────
/**
 * Marker attribute that takes everything except the report off the printed
 * page. Elements are only marked — never restyled or removed from the DOM — so
 * dropping the attribute again restores the page exactly as it was.
 */
const PRINT_HIDDEN_ATTR = 'data-dppr-print-hidden';

/**
 * Marks every element that is neither the report nor one of its ancestors, so
 * the printed output is the report alone: no navigation, no shift cards, no
 * Hourly Production Monitor grid, no buttons and no other module content.
 *
 * The walk goes all the way up to `body` and hides each level's siblings, which
 * keeps the report in normal flow at the top of the page instead of relying on
 * absolute positioning (an ancestor's `overflow` or transform would clip it).
 * `visibility` tricks are avoided for the same reason — they leave the rest of
 * the page's layout occupying space and push the report onto a later page.
 */
const isolateReportForPrint = (area: HTMLElement): HTMLElement[] => {
  const hidden: HTMLElement[] = [];
  let node: HTMLElement | null = area;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute(PRINT_HIDDEN_ATTR)) continue;
      sibling.setAttribute(PRINT_HIDDEN_ATTR, '');
      hidden.push(sibling);
    }
    node = parent;
  }
  return hidden;
};

/** Undoes isolateReportForPrint — used after the print dialog closes. */
const releaseReportForPrint = (hidden: HTMLElement[]): void => {
  for (const el of hidden) el.removeAttribute(PRINT_HIDDEN_ATTR);
};

// ─── Machine + bottle/job runs ──────────────────────────────────────────────
const entryBottle = (e: QualityHourlyEntry | undefined): string => String(e?.bottle_id ?? '').trim();
const entryJob = (e: QualityHourlyEntry | undefined): string => String(e?.job_id ?? '').trim();

// ─── Manual-split time segments ──────────────────────────────────────────
// Split rows live under minute-granularity labels (e.g. "2:30 PM") and are
// separate time segments of the hour they divide — never extra production
// time. Durations come from production-timeline ordering over the full display
// key set (all 24 hourly labels plus the splits actually present), so one
// split hour's segments always sum to exactly 1 hour. With no splits every
// duration is 1 and every figure below is bit-identical to before. The split
// group id itself is grouping/history only and is never read here.
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

/**
 * Actual production duration in hours of one key: (own − previous) / 60, else 1.
 * Uses actual period_start/period_end when present, otherwise the ordering-derived
 * position. Supports split entries of any duration without missing or double-counting.
 */
const durationHoursForReportKey = (
  orderedKeys: string[],
  key: string,
  slots?: Record<string, { startMinutes: number; endMinutes: number }>
): number => {
  const idx = orderedKeys.indexOf(key);
  if (idx <= 0) {
    if (slots && key in slots) {
      const s = slots[key];
      if (s && s.endMinutes !== null && s.endMinutes !== undefined && s.startMinutes !== null && s.startMinutes !== undefined) {
        return (s.endMinutes - s.startMinutes) / 60 || 1;
      }
    }
    return 1;
  }
  const tPrev = toReportTimelineMinutes(orderedKeys[idx - 1]);
  const tOwn = toReportTimelineMinutes(key);
  if (tPrev === null || tOwn === null) return 1;
  const diff = tOwn - tPrev;
  if (diff <= 0 || diff > 12 * 60) return 1;
  return diff / 60;
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

interface HourPoint {
  slot: { time: string; shift_id: number };
  entry: QualityHourlyEntry;
  /** Actual production duration in hours (1 for hourly rows, fractional for split segments). */
  durationHours: number;
}

/** Timeline slot for one report key: actual start/end in production-day minutes. */
interface TimelineSlot {
  startMinutes: number;
  endMinutes: number;
}

/** One continuous machine + bottle/job/speed period inside a single production date. */
interface JobRun {
  machineNo: number;
  runIndex: number;
  bottleId: string;
  jobId: string;
  runKey: string;
  points: HourPoint[];
}

/**
 * Identity key of the bottle each hourly record is running, in window order.
 *
 * The bottle is the identity of a run: the backend's canonical `job_id` is
 * one job per contiguous same-bottle run, so a bottle change is always a job
 * change. The job id alone must never split a row — partial (auto-)saves mint
 * a fresh job id for a single touched hour while the rest of the same-bottle
 * run keeps the old one, which would cut one bottle into several rows with
 * quantities from different periods of the day.
 *
 * Speed is the second half of the identity: a speed change starts a new run
 * even when the bottle/job is unchanged, because expected production is
 * speed × gob × duration per period. Without this, two periods at different
 * speeds collapse into one row whose speed is a blended average and whose
 * expected/actual totals belong to different reference lines (e.g. Machine 2
 * on 09/10/2026 ran 100 ML BRUT at 132 and at 119: merging yields speed
 * 124.1 with expected 317,640 instead of the reference's 119.0 / 185,640
 * plus a separate 132-speed line). Records with no usable speed carry no
 * speed identity and join the adjacent run via the same gap-closing passes,
 * so they can never split an otherwise continuous run.
 *
 * One gap is closed so the split reflects real production and never a
 * half-filled cell: a record with production but no bottle belongs to the run
 * it physically sits in (previous run, or the next one when it comes first),
 * so filling the bottle in later does not break a machine row in two.
 */
const runKeysFor = (points: HourPoint[]): string[] => {
  // Bottle half of the identity, with the long-standing gap-closing passes so
  // a record with production but no bottle joins the run it sits in.
  const bottles = points.map((p) => {
    const bottle = entryBottle(p.entry);
    return bottle ? `b:${bottle}` : '';
  });
  let inherited = '';
  for (let i = 0; i < bottles.length; i++) {
    if (bottles[i]) inherited = bottles[i];
    else bottles[i] = inherited;
  }
  inherited = '';
  for (let i = bottles.length - 1; i >= 0; i--) {
    if (bottles[i]) inherited = bottles[i];
    else bottles[i] = inherited;
  }
  // Speed half of the identity (parsed number, so "132" and "132.00" are the
  // same period). Gap-closed identically so a record without a usable speed
  // never splits an otherwise continuous run.
  const speeds = points.map((p) => {
    const speed = parseNum(p.entry.speed_per_min);
    return speed > 0 ? `s:${speed}` : '';
  });
  inherited = '';
  for (let i = 0; i < speeds.length; i++) {
    if (speeds[i]) inherited = speeds[i];
    else speeds[i] = inherited;
  }
  inherited = '';
  for (let i = speeds.length - 1; i >= 0; i--) {
    if (speeds[i]) inherited = speeds[i];
    else speeds[i] = inherited;
  }
  return points.map((_, i) => `${bottles[i]}|${speeds[i]}`);
};

/**
 * Builds one machine's report segments from the selected date, in the exact
 * implementation order the report requires:
 *
 *   1. FILTER to the selected 24-hour reporting window first — only the 24
 *      canonical HRP slot labels of this report date plus any manual-split
 *      segment labels actually stored for it are read; records under any other
 *      time label, and every previous/future-day record the backend
 *      never returns for this `production_date`, are not part of the sequence
 *      at all. Split segments are separate time segments of the hour they
 *      divide (their durations sum to exactly that hour), so daily/monthly
 *      totals stay consistent and no production is ever duplicated.
 *   2. DETECT bottle/job/speed changes across those window records only.
 *   3. CREATE one run per continuous bottle/speed segment (empty hours never break
 *      a run because they are not part of the sequence).
 *
 * Nothing about bottles or machines is hard-coded; every row comes from the
 * actual hourly records of the selected window — never from a machine's full
 * job history.
 */
const splitMachineRuns = (
  machineNo: number,
  byTime: Record<string, QualityHourlyEntry>,
  timelineSlots?: Record<string, TimelineSlot>
): JobRun[] => {
  const ordered = getReportOrderedKeys(byTime);
  const points: HourPoint[] = [];
  for (const key of ordered) {
    const entry = byTime[key];
    if (!hasMeaningfulData(entry)) continue;
    points.push({
      slot: { time: key, shift_id: shiftIdForReportKey(key) },
      entry: entry as QualityHourlyEntry,
      durationHours: durationHoursForReportKey(ordered, key, timelineSlots),
    });
  }

  // No records at all for this machine: keep the machine on the report with a
  // single empty row, exactly as before the job split existed.
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

const fmtUnits = (n: number) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n: number) => n.toFixed(1);
const fmt3 = (n: number) => n.toFixed(3);
const fmtEff = (n: number | null) => (n === null ? '—' : n.toFixed(1));

// ─── Job-wise table helpers ───────────────────────────────────────────────

/** DD/MM/YYYY — the Date of Starting format of the job-wise table. */
const fmtDateSlash = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

/** "hh:mm AM/PM" — the Time of Starting format of the job-wise table. */
const fmtTime12 = (d: Date): string => {
  const h = d.getHours();
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${h12}:${pad(d.getMinutes())} ${suffix}`;
};

/**
 * Start value of an hourly slot for DISPLAY: the production date (the report
 * date the slot is stored under) + the slot's clock time. A 1:00 AM start is
 * therefore dated with the production day it belongs to — 9:00 AM to 11:59 PM
 * on the calendar date itself, 12:00 AM to 8:59 AM on the previous production
 * date's grid — never the next calendar day.
 */
const parseSlotDate = (dateKey: string, timeLabel: string): Date | null => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(timeLabel ?? '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  const [y, mo, d] = dateKey.split('-').map(Number);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d, h, parseInt(m[2], 10), 0, 0);
};

/**
 * Overnight-aware ORDERING key: a production day runs 9:00 AM → 8:59 AM of the
 * next calendar day, so the 12:00 AM – 8:59 AM slots physically come AFTER the
 * same production date's evening slots. Only row order uses this value — the
 * Date of Starting column always shows the un-shifted production date.
 */
const overnightShift = (d: Date): Date => {
  if (d.getHours() >= 9) return d;
  const shifted = new Date(d.getTime());
  shifted.setDate(shifted.getDate() + 1);
  return shifted;
};

interface MachineReportRow {
  machineNo: number;
  /** One continuous machine + bottle/job period of the selected date. */
  rowKey: string;
  bottleName: string;
  /** Packing name mapped to the row's configured/parent bottle (read-only). */
  packingName: string;
  weight: number;
  speed: number;
  /** Actual runtime of this job segment in minutes. */
  runtimeMinutes: number;
  asPerSpeedUnits: number;
  asPerSpeedDraw: number;
  shiftUnits: number[];
  actualUnits: number;
  actualDraw: number;
  shiftEff: (number | null)[];
  overallEff: number | null;
  /** As-Per-Speed target units of each shift, used as the efficiency denominator. */
  shiftAsPerSpeedUnits: number[];
}

/** One machine + Job ID before name/format resolution — shared by the job
 *  endpoint rows and the hourly-records fallback. */
interface JobSourceRow {
  machineNo: number;
  jobId: string;
  bottleId: string;
  /** Production date + start clock time (what Date/Time of Starting show). */
  startDate: Date;
  /** Overnight-aware timeline value used only for row ordering. */
  startSort: Date;
  units: number;
  /** All hourly remarks of this machine + Job ID, numbered in timeline order. */
  remark: string;
}

/** One rendered row of the job-wise production summary table. */
interface JobWiseRow {
  key: string;
  machineNo: number;
  /** Bottle id of the day segment — part of the row key so two bottles sharing
   *  one job id still render as separate rows, never merged. Display only. */
  bottleId: string;
  itemName: string;
  /** Packing name mapped to the row's configured/parent bottle (read-only). */
  packingName: string;
  dateText: string;
  timeText: string;
  startSort: Date;
  units: number;
  /** All hourly remarks of this machine + Job ID, numbered in timeline order. */
  remark: string;
}

/**
 * Fallback source for the job-wise table when the job endpoint is
 * unavailable: groups this date's hourly records into consecutive Job IDs —
 * one row per job, never one per hour — with the job's first record as its
 * start inside the production day, and that Job ID's actual bottles as its
 * production. Cross-day starts/sums need the endpoint; everything else stays
 * correct. Records without a Job ID belong to no job row, exactly as on the
 * backend.
 */
const deriveJobSourcesFromDay = (dayHourly: QualityDayHourly, dateKey: string): JobSourceRow[] => {
  const out: JobSourceRow[] = [];
  for (const machineNo of MACHINE_NOS) {
    const byTime = dayHourly[String(machineNo)] ?? {};
    // Window order (9:00 AM → 8:00 AM) is the physical order of the day,
    // including manual-split segments as separate time segments.
    const ordered = getReportOrderedKeys(byTime);
    const points: HourPoint[] = [];
    for (const key of ordered) {
      const entry = byTime[key];
      if (!hasMeaningfulData(entry)) continue;
      if (!entryJob(entry)) continue;
      points.push({
        slot: { time: key, shift_id: shiftIdForReportKey(key) },
        entry: entry as QualityHourlyEntry,
        durationHours: durationHoursForReportKey(ordered, key),
      });
    }

    let i = 0;
    while (i < points.length) {
      const jobId = entryJob(points[i].entry);
      let bottleId = '';
      let units = 0;
      let end = i;
      while (end < points.length && entryJob(points[end].entry) === jobId) {
        if (!bottleId) bottleId = entryBottle(points[end].entry);
        units += jobEntryUnits(points[end].entry);
        end++;
      }
      const startDate = parseSlotDate(dateKey, points[i].slot.time);
      // Zero actual production on the date is never a summary row — the job
      // must have produced to be listed, exactly as on the backend.
      if (startDate && units > 0) {
        // Aggregate hourly remarks for this job segment (fallback path)
        const remarks: string[] = [];
        const seen = new Set<string>();
        for (let j = i; j < end; j++) {
          const re = points[j].entry.remarks;
          if (re && typeof re === 'string') {
            const t = re.trim();
            if (t && !seen.has(t)) {
              seen.add(t);
              remarks.push(t);
            }
          }
        }
        out.push({
          machineNo,
          jobId,
          bottleId,
          startDate,
          startSort: overnightShift(startDate),
          units,
          remark: remarks.length ? remarks.map((t, idx) => `${idx + 1}. ${t}`).join('\n') : '',
        });
      }
      i = end;
    }
  }
  return out;
};

/**
 * Exact start time of each job segment on the loaded date — the start of the
 * FIRST production entry associated with that machine + Job ID + bottle.
 *
 * An hourly row covers the production period ENDING at its own label, so a
 * row's production actually begins at the previous displayed row's time — the
 * same start the Quality Table's Time column shows for that row. When a manual
 * split carved a minute boundary (e.g. a "12:35 PM" segment), the first row
 * after that boundary begins at exactly 12:35 PM — never a rounded hour and
 * never a default shift start. Taking the earliest entry of a segment in
 * production-timeline order therefore yields its actual start, and it stays
 * correct when a job starts midway through an hourly interval or when a new
 * bottle/job is selected mid-interval.
 *
 * Keyed by `${machineNo}|${jobId}|${bottleId}` — the job ID and machine are
 * always part of the key (one bottle can run in several jobs), and the bottle
 * separates the segments of ONE job id that ran two bottles on the date, so
 * the second bottle can never inherit the first bottle's start. Records without
 * a Job ID belong to no job and are ignored, exactly as in the report's own job
 * grouping. The day's very first row has no earlier period, so its own label is
 * used.
 */
const jobStartLabels = (dayHourly: QualityDayHourly): Map<string, string> => {
  const out = new Map<string, string>();
  for (const machineNo of MACHINE_NOS) {
    const byTime = dayHourly[String(machineNo)] ?? {};
    const ordered = getReportOrderedKeys(byTime);
    for (let i = 0; i < ordered.length; i++) {
      const entry = byTime[ordered[i]];
      if (!entry) continue;
      if (!hasMeaningfulData(entry)) continue;
      const jobId = entryJob(entry);
      if (!jobId) continue;
      const mapKey = `${machineNo}|${jobId}|${entryBottle(entry)}`;
      if (out.has(mapKey)) continue;
      // Use the actual period_start from the entry if present (has minute granularity,
      // e.g. "9:17 AM", "12:38 PM"), otherwise fall back to the timeline label for
      // gap-closing when the entry has no stored period_start.
      const periodStart = (entry.period_start ?? '').trim();
      out.set(mapKey, periodStart || (i > 0 ? ordered[i - 1] : ordered[i]));
    }
  }
  return out;
};

// ─── Shift-Wise Efficiency Report ─────────────────────────────
/** One machine's row of the Shift-Wise Efficiency Report
. */
interface ShiftWiseRow {
  machineNo: number;
  /** Actual bottles of each shift — null when the shift has no records. */
  actualUnits: (number | null)[];
  /** As-Per-Speed target bottles of each shift, used as the efficiency denominator. */
  targetUnits: number[];
  /** Efficiency % of each shift = actual units ÷ As-Per-Speed target units × 100. */
  efficiency: (number | null)[];
  /** The machine's exact DAY AVG / SUMMARY PIECES EFF% value, or null when absent. */
  overallEff: number | null;
}

/**
 * One-decimal percentage for the Shift-Wise report — "85.0%", "88.6%", "93.1%".
 * Display formatting of the shown value only: the underlying calculated
 * figure is never stored rounded, and the Daily report's formatter is left
 * untouched. The precision mirrors the Hourly Production Monitor's own
 * displayed efficiency (grid cells and Day Avg / Summary row).
 */
const fmtPctWhole = (n: number | null): string =>
  (n === null ? '—' : `${n.toFixed(1)}%`);

/** Parse the monitor's already-formatted Day Avg / Summary PIECES EFF% value. */
const parseSummaryEff = (value: string | undefined): number | null => {
  const text = (value ?? '').trim();
  if (!text || text === '—') return null;
  const parsed = parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Builds the Shift-Wise Efficiency Report — a frontend-only view that reads
 * the already-loaded hourly records of the selected date and changes nothing
 * else (no new API call, no database or backend change, no shared mutable
 * state, and no change to the Hourly Production Monitor's own row cells).
 *
 * Every meaningful hourly HPR/Quality record of the selected date is grouped
 * by machine and by the report's own shift mapping (shiftIdForReportKey —
 * the same 24-slot mapping the Quality Module uses; manual splits inherit
 * their parent hour's shift), then per machine + shift:
 *
 *   • Actual Production — the ACTUAL bottles produced (packing size × cartons,
 *     falling back to bottles_in_nos — the same "Bottles in Nos." basis the
 *     Quality Module shows). Never theoretical/As-Per-Speed units and never
 *     draw in tons.
 *
 *   • Shift Efficiency % — the shift's summed actual bottles ÷ the shift's
 *     summed As-Per-Speed target bottles × 100. Targets use Speed/min × Gob ×
 *     each row's actual PRODUCTION minutes inside that shift, clipped to the
 *     shift's Production Timeline window so carry-in/Lehr Out minutes never
 *     leak into another shift's denominator. No efficiency value is averaged.
 *
 *   • Overall EFF% — the machine's exact PIECES EFF% value from its DAY AVG /
 *     SUMMARY row in the Hourly Production Monitor, displayed as-is (or '—'
 *     when that machine has no summary data). Never derived from the shifts.
 *
 * Row durations come from the shared Lehr Out timeline
 * (buildLayerOutTimeline over the rows' saved period_start/period_end), then
 * the Production Timeline (the same Packing Timeline shifted back by Lehr Out)
 * is clipped to the three shift windows. Split segments, shift-ending Lehr Out
 * differences and previous-day carry-in are therefore all counted exactly
 * once, in the shift where production actually happened.
 *
 * A shift with no records keeps null production, and a column with no valid
 * positive target keeps null efficiency, so the caller renders '—' instead of
 * inventing values. Values above 100% stay uncapped.
 */
const buildShiftWiseRows = (
  dayHourly: QualityDayHourly,
  machines: { code: string; gobCount: number }[],
  dayAvgSummaryEffByMachine?: Record<number, string>
): ShiftWiseRow[] => {
  const out: ShiftWiseRow[] = [];
  for (const machineNo of MACHINE_NOS) {
    const gob = machineGob(machineNo, machines);
    const byTime = dayHourly[String(machineNo)] ?? {};
    const ordered = getReportOrderedKeys(byTime);

    // Real per-row durations — the exact Lehr Out timeline the HPM stored
    // the segments' efficiencies with (previous day's carry-in into the day's
    // first row, shift-ending Lehr Out adjustments), rebuilt from the saved
    // period labels exactly like the Daily report does above.
    const { perShift } = layerOutInputsFromSavedPeriods(byTime, ordered);
    let carryInStartMinutes: number | null = null;
    const firstKey = ordered[0];
    const firstRow = firstKey ? byTime[firstKey] : undefined;
    if (firstRow?.period_start && firstRow?.period_end) {
      const start = toReportTimelineMinutes(firstRow.period_start);
      const end = toReportTimelineMinutes(firstRow.period_end);
      if (start !== null && end !== null) {
        let diff = end - start;
        if (diff <= 0) diff += 24 * 60;
        if (diff > 0 && diff < 24 * 60) {
          carryInStartMinutes = 1440 - diff;
        }
      }
    }
    const timelineSlots = buildLayerOutTimeline(ordered, perShift, carryInStartMinutes);
    const shiftIdxByKey: Record<string, number> = {};
    for (const key of ordered) {
      shiftIdxByKey[key] = Math.max(0, shiftIdForReportKey(key) - 1);
    }
    const productionSlots = buildProductionTimeline(ordered, timelineSlots, shiftIdxByKey, perShift);
    const shiftWindows = buildProductionShiftWindows(productionSlots);

    const hasRecord = [false, false, false];
    const actual = [0, 0, 0];
    const target = [0, 0, 0];

    for (const key of ordered) {
      const entry = byTime[key];
      if (!entry || !hasMeaningfulData(entry)) continue;
      const idx = shiftIdForReportKey(key) - 1;
      if (idx < 0 || idx > 2) continue;
      hasRecord[idx] = true;
      actual[idx] += hourlyUnits(entry);

      // Fallback Packing Timeline duration; the target denominator below uses
      // the Production Timeline minutes clipped to this shift instead.
      const slot = timelineSlots[key];
      const durationHours = slot
        ? slot.durationMinutes / 60
        : durationHoursForReportKey(ordered, key, timelineSlots);

      // As-Per-Speed target units of this row = Speed/min × Gob × the row's
      // actual PRODUCTION minutes inside this shift. Clipping to the shift
      // window keeps carry-in/Lehr Out minutes from leaking into another shift.
      const shiftMinutes = productionMinutesForShift(
        productionSlots[key],
        shiftWindows[idx],
        durationHours
      );
      const theoretical = calculateTheoreticalBottles(
        parseFloat(entry.speed_per_min),
        gob,
        shiftMinutes / 60
      );
      if (Number.isFinite(theoretical) && theoretical > 0) target[idx] += theoretical;
    }

    out.push({
      machineNo,
      actualUnits: hasRecord.map((seen, i) => (seen ? actual[i] : null)),
      targetUnits: target,
      efficiency: hasRecord.map((seen, i) =>
        seen ? calcUnitEfficiency(actual[i], target[i]) : null
      ),
      // Direct source mapping: use the exact PIECES EFF% already calculated in
      // this machine's DAY AVG / SUMMARY row of the Hourly Production Monitor.
      // Never derive this from the three shift columns.
      overallEff: parseSummaryEff(dayAvgSummaryEffByMachine?.[machineNo]),
    });
  }
  return out;
};

// ─── Report ────────────────────────────────────────────────────────────────
/**
 * The report is read-only and has no date state of its own: `date` is the
 * single selected date owned by the Quality Module's Hourly Production Monitor
 * controls, so both sections always show the same day.
 */
export const QualityReport: React.FC<{
  date: Date;
  dayAvgSummaryEffByMachine?: Record<number, string>;
}> = ({ date, dayAvgSummaryEffByMachine }) => {
  const { machines, bottles } = useERP();

  // ── Packing Names ─────────────────────────────────────────────────────────
  // The Quality Table stores the configured/parent bottle id, so the "Packed
  // Bottle Name" of a report row lists EVERY bottle_name mapped to that
  // parent as a child, read read-only from the SAME existing parent/child
  // mapping API the Quality grid already uses
  // (production.bottle_master.group_id). No new database field, table or
  // endpoint is introduced. All children stay in the same report row, shown
  // without any serial number; a single child renders just its name. A
  // bottle without children falls back to its own production
  // bottle name. Fetched once per mount; on failure the report still renders,
  // using the production bottle name as the fallback.
  const [childNamesByParent, setChildNamesByParent] = useState<Map<string, string[]>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    planningRepository
      .fetchParentChildMappings()
      .then((res) => {
        if (cancelled || !res.ok) return;
        const grouped = new Map<string, { id: string; name: string }[]>();
        for (const m of res.mappings) {
          const list = grouped.get(m.parentBottleId);
          if (list) list.push({ id: m.childBottleId, name: m.childBottleName });
          else grouped.set(m.parentBottleId, [{ id: m.childBottleId, name: m.childBottleName }]);
        }
        const next = new Map<string, string[]>();
        for (const [parentId, children] of grouped) {
          const names = [...new Set(
            children
              .map((c) => String(c.name ?? '').trim())
              .filter((n) => n.length > 0)
          )].sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
          );
          if (names.length === 0) continue;
          next.set(parentId, names);
        }
        setChildNamesByParent(next);
      })
      .catch(() => { /* keep the report correct without packing names */ });
    return () => { cancelled = true; };
  }, []);

  /** Every packing (child) name for a stored (parent/configured) bottle id, or [] if unmapped. */
  const packingNamesFor = useCallback((bottleId: string): string[] => {
    const id = String(bottleId ?? '').trim();
    return id ? (childNamesByParent.get(id) ?? []) : [];
  }, [childNamesByParent]);

  /**
   * Packed Bottle Name display for one report row: every packing name in the
   * same cell, plain names without any serial number ("a, b, c"). Falls back
   * to the row's own production bottle name when no packing name exists.
   */
  const formatPackedName = useCallback((packingNames: string[], fallbackBottleName: string): string => {
    const names = (packingNames ?? [])
      .map((n) => String(n ?? '').trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) return String(fallbackBottleName ?? '');
    return names.join(', ');
  }, []);

  const [hourly, setHourly] = useState<QualityDayHourly>({});
  // The date the stored `hourly` was loaded for. Rows are only ever built
  // from it while it matches the selected date, so a date change can never
  // show another day's records under the new date while the fetch is in
  // flight — the report always reflects the selected 24-hour window only.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  // Hide/Show Total — controls every total row of the Daily Production
  // Performance Report together (machine-wise totals + the bottom Grand Total).
  // Purely a display toggle: no data is re-fetched and no calculation changes.
  const [totalsHidden, setTotalsHidden] = useState(false);

  // Job-wise rows for the same selected date. `jobLoadedKey` mirrors
  // `loadedKey`: the job table is only ever rendered while these rows belong
  // to the selected date, so a date change can never flash another day's jobs.
  const [jobRows, setJobRows] = useState<QualityJobRow[]>([]);
  const [jobLoadedKey, setJobLoadedKey] = useState<string | null>(null);
  const [jobRowsOk, setJobRowsOk] = useState(false);

  // Print area — the only part of the page the Print button sends to the
  // printer.
  const printAreaRef = useRef<HTMLDivElement | null>(null);
  // Identifies the newest load. A response for a superseded request (a date
  // change, an unmount, or a newer Refresh) is discarded instead of applied,
  // so the table can never end up showing one request's numbers under another.
  const requestRef = useRef(0);

  const dateKey = toIso(date);
  const dateLabel = toDisplay(date);
  const [dateDd, dateMm, dateYyyy] = dateLabel.split('-');

  /**
   * The report's single data entry point: the existing qualityRepository call
   * for GET /api/production/quality/daily/. The first load and the Refresh
   * button both run it, so a refresh re-reads the same production date from the
   * database through the same API — no local cache. The job-wise rows for the
   * same date are fetched alongside it and share the same request token.
   */
  const loadDay = useCallback(async (targetKey: string) => {
    const token = (requestRef.current += 1);
    setLoading(true);
    // Job-wise rows for the SAME date, fetched in parallel with the hourly
    // records so the first load and the Refresh button keep both tables in
    // sync. A failure only affects the job table: it falls back to rows
    // derived from the hourly data below and leaves this report untouched.
    qualityRepository
      .loadJobs(targetKey)
      .then(({ rows, ok }) => {
        if (token !== requestRef.current) return;
        setJobRows(ok === false ? [] : rows);
        setJobRowsOk(ok !== false);
        setJobLoadedKey(targetKey);
      })
      .catch(() => {
        if (token !== requestRef.current) return;
        setJobRows([]);
        setJobRowsOk(false);
        setJobLoadedKey(targetKey);
      });
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

  /**
   * Refresh — re-fetches the selected report date through the same
   * qualityRepository call the initial load uses. `dateKey` comes from the same
   * `date` prop the report already renders, so the selected date, every filter
   * and the table itself are left untouched; only the fetched records are
   * replaced, and rows/totals recompute from them exactly as they do on first
   * load.
   */
  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void loadDay(dateKey).finally(() => setRefreshing(false));
  }, [dateKey, loadDay, refreshing]);

  /**
   * Print — prints the report only. Everything outside the report card is
   * marked as hidden, the browser prints the isolated report, and the page is
   * restored as soon as the dialog closes. The printed table is the rendered
   * one, so title, report date, columns and every figure are exactly what the
   * screen shows.
   */
  const handlePrint = useCallback(() => {
    const area = printAreaRef.current;
    if (!area) return;
    const hidden = isolateReportForPrint(area);
    // Restored only once the browser has actually finished printing. Restoring
    // synchronously after window.print() would strip the isolation in browsers
    // where the print job renders asynchronously, printing the whole page.
    const restore = () => {
      releaseReportForPrint(hidden);
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    try {
      window.print();
    } catch {
      // Printing unavailable/blocked — never leave the page in the isolated
      // state, which would hide everything but this report on screen.
      restore();
    }
  }, []);

  // The hourly records of the SELECTED date's 24-hour window only. Rows are
  // never built from the store while it still holds another date, so the
  // report can only ever show the currently selected report period.
  const dayHourly: QualityDayHourly = loadedKey === dateKey ? hourly : EMPTY_DAY;

  // Per-machine report rows — built strictly in this order:
  //   1. the machine's hourly HPR records are filtered to the selected
  //      24-hour reporting window (the same window the HRP renders),
  //   2. consecutive window records are grouped by their active bottle/job,
  //   3. one row is created per continuous bottle segment.
  // A machine therefore appears once, and only gains another row when the
  // bottle/job actually changed inside the window — never from a previous or
  // future day's part of a continuous job. Every figure below is summed from
  // that row's window records only.
  // Timeline slots are computed from period_start/period_end labels using the
  // shared Lehr Out timeline (buildLayerOutTimeline) which correctly handles
  // midnight crossings, variable Lehr Out times, and previous-day carry-in
  // with absolute timeline minutes (not modulo 1440).
  const rows = useMemo<MachineReportRow[]>(() => {
    const out: MachineReportRow[] = [];
    for (const machineNo of MACHINE_NOS) {
      const gob = machineGob(machineNo, machines);
      const byTime = dayHourly[String(machineNo)] ?? {};

      // Build ordered keys and reconstruct Layer Out timeline from saved periods
      const orderedKeys = getReportOrderedKeys(byTime);
      const { perShift } = layerOutInputsFromSavedPeriods(byTime, orderedKeys);

      // Compute absolute carry-in start minutes from first row's saved period.
      // layerOutInputsFromSavedPeriods returns carryMinutes as Lehr Out value (e.g., 40),
      // but buildLayerOutTimeline needs absolute timeline position (e.g., 1360).
      // For first row (9:00 AM key at timeline 0), its period_end is at 1440 in
      // continuous timeline. If period_start="7:40 AM", period_end="9:00 AM",
      // duration=80min, so carryInStartMinutes = 1440 - 80 = 1360.
      let carryInStartMinutes: number | null = null;
      const firstKey = orderedKeys[0];
      const firstRow = firstKey ? byTime[firstKey] : undefined;
      if (firstRow?.period_start && firstRow?.period_end) {
        const start = toReportTimelineMinutes(firstRow.period_start);
        const end = toReportTimelineMinutes(firstRow.period_end);
        if (start !== null && end !== null) {
          let diff = end - start;
          if (diff <= 0) diff += 24 * 60;
          if (diff > 0 && diff < 24 * 60) {
            carryInStartMinutes = 1440 - diff;
          }
        }
      }

      const timelineSlots = buildLayerOutTimeline(orderedKeys, perShift, carryInStartMinutes);

      // Convert to TimelineSlot format for splitMachineRuns
      const timelineSlotsByKey: Record<string, TimelineSlot> = {};
      for (const [key, slot] of Object.entries(timelineSlots)) {
        timelineSlotsByKey[key] = {
          startMinutes: slot.startMinutes,
          endMinutes: slot.endMinutes,
        };
      }

      // Production Time — the Packing Timeline shifted back by the applicable
      // Lehr Out minutes (the same builder the Hourly Production Monitor uses).
      // It supplies the row MIN and the exact production minutes used by the
      // shift efficiency denominators. Weight/speed/draw and the displayed
      // As-Per-Speed totals still use the Packing Timeline values below.
      const shiftIdxByKey: Record<string, number> = {};
      for (const key of orderedKeys) {
        shiftIdxByKey[key] = Math.max(0, shiftIdForReportKey(key) - 1);
      }
      const productionTimeSlotsByKey = buildProductionTimeline(
        orderedKeys,
        timelineSlots,
        shiftIdxByKey,
        perShift,
      );
      const shiftWindows = buildProductionShiftWindows(productionTimeSlotsByKey);

      for (const run of splitMachineRuns(machineNo, byTime, timelineSlotsByKey)) {
        const shiftUnits = [0, 0, 0];
        const shiftAsPerSpeedUnits = [0, 0, 0];
        let totalUnits = 0;
        let weightSum = 0;
        let weightHours = 0;
        let weightedWeight = 0;
        let weightedUnits = 0;
        let speedSum = 0;
        let speedHours = 0;

        for (const { slot, entry, durationHours } of run.points) {
          const units = hourlyUnits(entry);
          const speed = parseNum(entry.speed_per_min);
          const weight = hourlyWeight(entry, gob);
          const idx = slot.shift_id - 1;
          if (idx < 0 || idx > 2) continue;

          // Shift target units = Speed/min × Gob × this bottle's actual
          // PRODUCTION minutes inside this shift. The Production Timeline slot
          // is clipped to the shift window, so a shift-ending Lehr Out row or a
          // previous-day carry-in cannot add another shift's minutes to this
          // bottle's denominator. Multiple bottles on one machine therefore
          // contribute disjoint minute slices that sum to the shift's real
          // production minutes. The report's displayed "As Per Speed" Total
          // Units / Total Draw columns still use the packing-time values below.
          const shiftMinutes = productionMinutesForShift(
            productionTimeSlotsByKey[slot.time],
            shiftWindows[idx],
            durationHours
          );
          const theoretical = calculateTheoreticalBottles(speed, gob, shiftMinutes / 60);

          shiftUnits[idx] += units;
          totalUnits += units;

          if (Number.isFinite(theoretical) && theoretical > 0) {
            shiftAsPerSpeedUnits[idx] += theoretical;
          }

          if (weight !== null) {
            weightSum += weight * durationHours;
            weightHours += durationHours;
            if (units > 0) {
              weightedWeight += units * weight;
              weightedUnits += units;
            }
          }
          if (speed > 0) {
            speedSum += speed * durationHours;
            speedHours += durationHours;
          }
        }

        // Applicable weight/speed from the HPR data. Weight is production
        // weighted when several hours ran, so Actual Total Draw = Units ×
        // Weight / 1,000,000 stays exact across the whole period.
        const weight =
          weightedUnits > 0
            ? weightedWeight / weightedUnits
            : weightHours > 0
              ? weightSum / weightHours
              : 0;
        const speed = speedHours > 0 ? speedSum / speedHours : 0;

        // Actual Total Draw = Actual Total Units × Weight / 1,000,000
        const actualDraw = (weight * totalUnits) / 1_000_000;

        // Shift efficiency % = this run's actual units in the shift ÷ its
        // As-Per-Speed target units in the shift × 100.
        const shiftEff = shiftAsPerSpeedUnits.map((targetUnits, i) =>
          calcUnitEfficiency(shiftUnits[i], targetUnits)
        );

        // MIN — actual production runtime in minutes within the production day,
        // calculated from the run's actual start to end time using the
        // PRODUCTION TIME positions (Packing Timeline shifted back by Lehr Out).
        // Each key label is the END of its own period, so the run's window is
        // [first label − first duration, last label]: the first point's duration
        // locates the run's start, and the last label is the run's end. Every
        // split segment is a separate point with its own duration, so a split of
        // any length is included whole and adjacent jobs partition the day
        // without gaps or double-counting — a machine running the full day
        // totals exactly 1,440 minutes. Timeline minutes are continuous across
        // midnight, and the value is clamped to the production day's 1,440.
        let runtimeMinutes = 0;
        const first = run.points[0];
        const last = run.points[run.points.length - 1];
        if (run.points.length > 0 && first && last) {
          const firstSlot = productionTimeSlotsByKey ? productionTimeSlotsByKey[first.slot.time] : undefined;
          const lastSlot = productionTimeSlotsByKey ? productionTimeSlotsByKey[last.slot.time] : undefined;
          if (firstSlot && lastSlot) {
            const startMin = firstSlot.startMinutes;
            const endMin = lastSlot.endMinutes;
            runtimeMinutes = Math.round(Math.max(0, Math.min(1440, endMin - startMin)));
          } else {
            // Fallback: use ordering-derived positions when no actual period data.
            const firstMin = toReportTimelineMinutes(first.slot.time) ?? 0;
            const lastMin = toReportTimelineMinutes(last.slot.time) ?? firstMin;
            const startMin = firstMin - first.durationHours * 60;
            runtimeMinutes = Math.round(Math.max(0, Math.min(1440, lastMin - startMin)));
          }
        } else {
          runtimeMinutes = Math.round(
            run.points.reduce((sum, p) => sum + p.durationHours * 60, 0)
          );
        }

        const bottleName = bottleNameFor(run.bottleId, bottles);

        // ── As Per Speed – Total Units & Total Draw ─────────────────────────
        // Calculated ONLY from what this report already displays for the row —
        // the average Speed and the applicable Weight (never from Bottle
        // Master), this machine's own Gob count (existing machine gob
        // configuration) and the row's MIN:
        //
        //   Total Units = Average Speed × Machine Gob × MIN
        //   Total Draw  = (Weight × Total Units) / 1,000,000
        //
        // Speed and Weight are taken at the exact single decimal the table
        // shows (fmt1), so both figures can be reproduced straight from the
        // displayed cells. Machine Total and Grand Total rows keep summing
        // these row values.
        const displaySpeed = Number.isFinite(speed) ? parseFloat(fmt1(speed)) : 0;
        const displayWeight = Number.isFinite(weight) ? parseFloat(fmt1(weight)) : 0;
        const asPerSpeedUnits = displaySpeed * gob * runtimeMinutes;
        const asPerSpeedDraw = (displayWeight * asPerSpeedUnits) / 1_000_000;

        // Overall efficiency % = this bottle row's total actual units ÷ its
        // As-Per-Speed total units.
        const overallEff = calcUnitEfficiency(totalUnits, asPerSpeedUnits);

        out.push({
          machineNo,
          rowKey: `${machineNo}-${run.runIndex}-${run.runKey}`,
          bottleName,
          packingName: formatPackedName(packingNamesFor(run.bottleId), bottleName),
          weight,
          speed,
          runtimeMinutes,
          asPerSpeedUnits,
          asPerSpeedDraw,
          shiftUnits,
          actualUnits: totalUnits,
          actualDraw,
          shiftEff,
          overallEff,
          shiftAsPerSpeedUnits,
        });
      }
    }
    return out;
  }, [dayHourly, machines, bottles, packingNamesFor, formatPackedName]);

  // Total row — quantities are straight sums. Every efficiency % is the ratio
  // of summed actual units to summed As-Per-Speed target units for that column;
  // no stored or per-segment efficiency value is averaged.
  const totals = useMemo(() => {
    const shiftUnits = [0, 0, 0];
    const shiftAsPerSpeedUnits = [0, 0, 0];
    let asPerSpeedUnits = 0;
    let asPerSpeedDraw = 0;
    let actualUnits = 0;
    let actualDraw = 0;
    let runtimeMinutes = 0;
    for (const r of rows) {
      asPerSpeedUnits += r.asPerSpeedUnits;
      asPerSpeedDraw += r.asPerSpeedDraw;
      actualUnits += r.actualUnits;
      actualDraw += r.actualDraw;
      runtimeMinutes += r.runtimeMinutes;
      r.shiftUnits.forEach((u, i) => {
        shiftUnits[i] += u;
      });
      r.shiftAsPerSpeedUnits.forEach((targetUnits, i) => {
        shiftAsPerSpeedUnits[i] += targetUnits;
      });
    }
    const shiftEff = shiftAsPerSpeedUnits.map((targetUnits, i) =>
      calcUnitEfficiency(shiftUnits[i], targetUnits)
    );
    const overallEff = calcUnitEfficiency(actualUnits, asPerSpeedUnits);
    return { shiftUnits, asPerSpeedUnits, asPerSpeedDraw, actualUnits, actualDraw, shiftEff, overallEff, runtimeMinutes };
  }, [rows]);

  const hasData = rows.some((r) => r.asPerSpeedUnits > 0 || r.actualUnits > 0);

  // Weight Efficiency % for the selected day — (Actual Total Draw / Total Draw
  // as per Speed) × 100, computed from the existing report totals above.
  // Null-safe: a zero/missing as-per-speed draw renders as '—', never NaN,
  // Infinity or a division by zero. Existing efficiency calculations are untouched.
  const weightEfficiency = calcWeightEfficiency(totals.actualDraw, totals.asPerSpeedDraw);

  // Shift-Wise Production & Efficiency Report — one row per machine, grouped
  // from the SAME already-loaded hourly records (dayHourly) of the selected
  // date but calculated by its own helper: actual bottles plus an independent
  // efficiency for each machine + shift. Overall EFF% is passed in directly
  // from each machine's DAY AVG / SUMMARY PIECES EFF% value. It never reads or
  // changes the Daily report's rows/totals above, the job-wise rows below, the
  // API or the database.
  const shiftWiseRows = useMemo<ShiftWiseRow[]>(
    () => buildShiftWiseRows(dayHourly, machines, dayAvgSummaryEffByMachine),
    [dayHourly, machines, dayAvgSummaryEffByMachine]
  );
  // True once at least one hourly record sits behind the Shift-Wise table —
  // only used for its own "no records" note, never for a calculation.
  const hasShiftWiseData = shiftWiseRows.some((r) => r.actualUnits.some((v) => v !== null));

  // Machine-wise totals — aggregated ONLY from the original bottle/job rows of
  // each machine (never from another total row), so the Grand Total below can
  // keep aggregating the same original rows without double-counting. Each
  // efficiency % is actual units ÷ As-Per-Speed target units for that column.
  const machineTotals = useMemo(() => {
    const map = new Map<number, {
      machineNo: number;
      asPerSpeedUnits: number;
      asPerSpeedDraw: number;
      shiftUnits: number[];
      actualUnits: number;
      actualDraw: number;
      runtimeMinutes: number;
      shiftEff: (number | null)[];
      overallEff: number | null;
    }>();
    for (const machineNo of MACHINE_NOS) {
      const shiftUnits = [0, 0, 0];
      const shiftAsPerSpeedUnits = [0, 0, 0];
      let asPerSpeedUnits = 0;
      let asPerSpeedDraw = 0;
      let actualUnits = 0;
      let actualDraw = 0;
      let runtimeMinutes = 0;
      for (const r of rows) {
        if (r.machineNo !== machineNo) continue;
        asPerSpeedUnits += r.asPerSpeedUnits;
        asPerSpeedDraw += r.asPerSpeedDraw;
        actualUnits += r.actualUnits;
        actualDraw += r.actualDraw;
        runtimeMinutes += r.runtimeMinutes;
        r.shiftUnits.forEach((u, i) => {
          shiftUnits[i] += u;
        });
        r.shiftAsPerSpeedUnits.forEach((targetUnits, i) => {
          shiftAsPerSpeedUnits[i] += targetUnits;
        });
      }
      map.set(machineNo, {
        machineNo,
        asPerSpeedUnits,
        asPerSpeedDraw,
        shiftUnits,
        actualUnits,
        actualDraw,
        runtimeMinutes,
        shiftEff: shiftAsPerSpeedUnits.map((targetUnits, i) =>
          calcUnitEfficiency(shiftUnits[i], targetUnits)
        ),
        overallEff: calcUnitEfficiency(actualUnits, asPerSpeedUnits),
      });
    }
    return map;
  }, [rows]);

  // Grand Total Overall EFF% — total actual units ÷ total As-Per-Speed target
  // units from the original rows, the same basis as the Grand Total row.
  const grandOverallEff = totals.overallEff;

  // Job-wise production summary — one row per machine + Job ID applicable to
  // the selected production date: the API rows when the job endpoint answered,
  // otherwise rows derived from this date's hourly records. Ordered by machine
  // first, then the newest job first within a machine on the actual 9 AM
  // production-day timeline. No blank rows: a machine without a job on the
  // date simply has no rows here.
  //
  // Data-selection guard: only jobs the selected day's own hourly records
  // (this Daily Production Performance Report) actually contain are shown, so
  // a still-active job from an earlier date — or a job from a machine with no
  // production that day — can never leak in from the endpoint. The guard is
  // skipped only while the day has no job-bearing records at all, preserving
  // the previous fallback behaviour in that case.
  const jobWiseRows = useMemo<JobWiseRow[]>(() => {
    if (jobLoadedKey !== dateKey) return [];

    const dayJobKeys = new Set<string>();
    for (const [mStr, byTime] of Object.entries(dayHourly ?? {})) {
      for (const entry of Object.values(byTime ?? {})) {
        const jid = String((entry as QualityHourlyEntry)?.job_id ?? '').trim();
        if (jid) dayJobKeys.add(`${Number(mStr)}|${jid}`);
      }
    }

    const endpointRows = jobRowsOk
      ? (dayJobKeys.size > 0
        ? jobRows.filter((row) =>
          dayJobKeys.has(`${row.machine_no}|${String(row.job_id ?? '').trim()}`))
        : jobRows)
      : [];

    const source: JobSourceRow[] = jobRowsOk
      ? endpointRows.flatMap((row) => {
        const startDate = new Date(row.job_start_time);
        if (Number.isNaN(startDate.getTime())) return [];
        return [{
          machineNo: row.machine_no,
          jobId: row.job_id,
          bottleId: row.bottle_id == null ? '' : String(row.bottle_id),
          startDate,
          startSort: overnightShift(startDate),
          units: Math.max(0, Math.round(row.production_units ?? 0)),
          remark: (row.remarks ?? '').trim(),
        }];
      })
      : deriveJobSourcesFromDay(dayHourly, dateKey);

    // Actual start of each job segment's first production entry on this date
    // (minute level for manual splits), used for the Time of Starting column.
    // Matched on machine + Job ID + bottle so two bottles running under one
    // job id each keep their own start instead of both showing the first
    // bottle's time. A segment with no matching entry (e.g. a job that began
    // on an earlier date) keeps the endpoint's own start — never a default.
    const startLabels = jobStartLabels(dayHourly);

    // Date + machine + job-wise remarks for the selected production date: each
    // job shows only its own remarks recorded in this date's hourly production
    // entries belonging to that job. Remarks are scoped to the specific machine +
    // job + bottle combination so they do not leak across jobs on the same machine.
    // Job ID + bottle ID together form the strongest existing identifier.
    const remarkByJob = new Map<string, string>();
    // Build per-job remark map from hourly entries
    for (const machineNo of MACHINE_NOS) {
      const byTime = dayHourly[String(machineNo)] ?? {};
      const ordered = getReportOrderedKeys(byTime);
      const jobRemarksMap = new Map<string, string[]>(); // key: "${jobId}|${bottleId}", value: [remark texts]
      for (const key of ordered) {
        const entry = byTime[key];
        if (!entry) continue;
        const jobId = String(entry.job_id ?? '').trim();
        const bottleId = String(entry.bottle_id ?? '').trim();
        if (!jobId && !bottleId) continue; // skip entries without job or bottle identity
        const remarkKey = `${jobId}|${bottleId}`;
        const t = String(entry.remarks ?? '').trim();
        if (t) {
          if (!jobRemarksMap.has(remarkKey)) jobRemarksMap.set(remarkKey, []);
          const arr = jobRemarksMap.get(remarkKey)!;
          if (!arr.includes(t)) arr.push(t);
        }
      }
      // Assign remarks to each job-wise source row for this machine
      for (const s of source) {
        if (s.machineNo !== machineNo) continue;
        const remarkKey = `${s.jobId}|${s.bottleId}`;
        const arr = jobRemarksMap.get(remarkKey) || [];
        // Deduplicate while preserving order
        const seen = new Set<string>();
        const texts: string[] = [];
        for (const r of arr) {
          if (!seen.has(r)) {
            seen.add(r);
            texts.push(r);
          }
        }
        const comment = texts.map((t, idx) => `${idx + 1}. ${t}`).join('  ');
        // Only set remark if this job actually has remarks; otherwise leave blank
        // We store per-job so different jobs on the same machine get independent remarks
        remarkByJob.set(`${s.machineNo}|${s.jobId}|${s.bottleId}`, comment);
      }
    }

    return source
      .map((s) => {
        // The displayed start is the segment's first production entry on the
        // selected date. A continuing job that began on an earlier day keeps
        // the job endpoint's true start date/time untouched.
        let startDate = s.startDate;
        const dayStartLabel = startLabels.get(`${s.machineNo}|${s.jobId}|${s.bottleId}`);
        if (dayStartLabel && toIso(s.startDate) === dateKey) {
          const parsed = parseSlotDate(dateKey, dayStartLabel);
          if (parsed) startDate = parsed;
        }
        const itemName = bottleNameFor(s.bottleId, bottles);
        return {
          key: `${s.machineNo}-${s.jobId}-${s.bottleId}`,
          machineNo: s.machineNo,
          bottleId: s.bottleId,
          itemName,
          packingName: formatPackedName(packingNamesFor(s.bottleId), itemName),
          dateText: fmtDateSlash(startDate),
          timeText: fmtTime12(startDate),
          startSort: overnightShift(startDate),
          units: s.units,
          remark: remarkByJob.get(`${s.machineNo}|${s.jobId}|${s.bottleId}`) ?? '',
        };
      })
      .sort((a, b) => a.machineNo - b.machineNo || b.startSort.getTime() - a.startSort.getTime());
  }, [jobLoadedKey, jobRowsOk, jobRows, dateKey, dayHourly, bottles, packingNamesFor, formatPackedName]);

  const thStyle = (last = false): React.CSSProperties => ({
    padding: '7px 6px',
    color: C.headerText,
    fontWeight: 600,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    borderRight: last ? 'none' : `1px solid ${C.border}`,
    lineHeight: 1.3,
    verticalAlign: 'middle',
    textAlign: 'center',
    backgroundColor: C.headerBg,
  });

  const td: React.CSSProperties = {
    padding: '7px 8px',
    borderBottom: `1px solid ${C.border}`,
    borderRight: `1px solid ${C.border}`,
    fontSize: '12.5px',
    color: C.textMain,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };
  const tdLast: React.CSSProperties = { ...td, borderRight: 'none' };

  // ── Shift-Wise Production & Efficiency Report styling ────────────────────
  // Same fonts, sizes and spacing as the tables above, with the mockup's
  // grouped pale-blue headers and subtle borders.
  const swBorder = '#bfdbfe';
  const swTh = (group = false, last = false): React.CSSProperties => ({
    padding: '7px 8px',
    color: '#1e40af',
    fontWeight: 600,
    fontSize: '11px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    lineHeight: 1.3,
    verticalAlign: 'middle',
    textAlign: 'center',
    // Group row (Actual Production / Efficiency %) a touch deeper than the
    // Shift 1/2/3 sub-header row beneath it.
    backgroundColor: group ? '#dbeafe' : '#eff6ff',
    borderRight: last ? 'none' : `1px solid ${swBorder}`,
    borderBottom: `1px solid ${swBorder}`,
  });
  const swThBottom = (last = false): React.CSSProperties => ({
    ...swTh(false, last),
    borderBottom: `2px solid ${swBorder}`,
  });

  const swTd: React.CSSProperties = {
    padding: '7px 10px',
    borderBottom: `1px solid ${C.border}`,
    borderRight: `1px solid ${C.border}`,
    fontSize: '12.5px',
    color: C.textMain,
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };
  const swTdLast: React.CSSProperties = { ...swTd, borderRight: 'none' };

  return (
    // Rendered inside the Quality Module's already-padded container, so this
    // wrapper only adds spacing — no page padding (avoids double inset).
    <div className="dppr-print-root" ref={printAreaRef} style={{ marginTop: '16px' }}>
      <style>{`
        .dppr-table tbody tr:not(.dppr-m1):not(.dppr-m2):not(.dppr-m3):not(.dppr-m4):hover td { background-color: #f8fafc; }
        .dppr-table tbody tr.dppr-total:hover td { background-color: #f0f4fa; }
        .dppr-table tbody tr.dppr-machine-total:hover td { background-color: #eff6ff; }
        .dppr-table tbody tr.dppr-grand-total:hover td { background-color: #dbeafe; }
        .dppr-table tbody tr.dppr-m1:hover td { background-color: #ffffff; }
        .dppr-table tbody tr.dppr-m2:hover td { background-color: #ffffff; }
        .dppr-table tbody tr.dppr-m3:hover td { background-color: #ffffff; }
        .dppr-table tbody tr.dppr-m4:hover td { background-color: #ffffff; }

        /* Shift Efficiency % table — responsive card + contained horizontal
           scrolling. Columns keep a usable minimum width on small screens
           instead of compressing or overflowing the page. */
        .dppr-sw-card {
          width: 30%;
          max-width: 30%;
          margin-left: auto;
          margin-right: auto;
          box-sizing: border-box;
        }
        .dppr-sw-scroll {
          width: 100%;
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
          -webkit-overflow-scrolling: touch;
        }
        .dppr-sw-scroll .dppr-table {
          width: 100%;
          min-width: 380px;
          table-layout: fixed;
          border-collapse: collapse;
        }
        @media screen and (max-width: 1200px) {
          .dppr-sw-card { width: 45%; max-width: 45%; }
        }
        @media screen and (max-width: 900px) {
          .dppr-sw-card { width: 70%; max-width: 70%; }
        }
        @media screen and (max-width: 640px) {
          .dppr-sw-card { width: 100%; max-width: 100%; }
          .dppr-sw-scroll .dppr-table { min-width: 400px; }
        }
        @media print {
          .dppr-table tbody tr:hover td { background-color: transparent; }
          .dppr-table tbody tr.dppr-total:hover td { background-color: #f0f4fa; }
          .dppr-table tbody tr.dppr-machine-total:hover td { background-color: #eff6ff; }
          .dppr-table tbody tr.dppr-grand-total:hover td { background-color: #dbeafe; }

          /* Applied by the Print button: everything except this report leaves
             the printed page, so only the report is sent to the printer. */
          [${PRINT_HIDDEN_ATTR}] { display: none !important; }

          /* Screen-only chrome is dropped and the table is given the full
             landscape page width, so all 16 columns print instead of being
             clipped by the screen min-width / horizontal scroller. */
          .dppr-print-root { margin-top: 0 !important; }
          .dppr-print-root .dppr-card { border: none !important; border-radius: 0 !important; box-shadow: none !important; }
          .dppr-print-root .dppr-table-scroll { overflow: visible !important; }
          .dppr-print-root .dppr-table { width: 100% !important; min-width: 0 !important; table-layout: fixed !important; }
          .dppr-print-root .dppr-table th,
          .dppr-print-root .dppr-table td { padding: 1px 2px !important; font-size: 7px !important; line-height: 1.15 !important; white-space: normal !important; }
          .dppr-print-root .dppr-table thead tr:first-child th { font-size: 6.5px !important; }
          .dppr-print-root .dppr-table thead { display: table-header-group; }
          .dppr-print-root .dppr-table tr { page-break-inside: avoid; page-break-after: auto; }
        }
      `}</style>

      {/* Shift-Wise Production & Efficiency Report — sits immediately below
          the Hourly Production Monitor (rendered by the Quality Module above
          this component) and above the Daily Production Performance Report.
          Frontend-only: every figure comes from buildShiftWiseRows over the
          same already-loaded hourly records of the selected date — no extra
          API call, no database or backend change. It shares the card, table
          and scroll classes so the existing print and responsive rules apply
          to it unchanged. */}

      {/* Shift-Wise Production & Efficiency Report
    Frontend-only. Uses existing loaded hourly records.
    No database, backend, API, or calculation changes. */}

      
<div
  className="dppr-card dppr-sw-card"
  style={{
    backgroundColor: C.white,
    border: `1px solid ${C.border}`,
    borderRadius: '10px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
    overflow: 'hidden',
    marginBottom: '16px',
  }}
>
  <div
    className="dppr-table-scroll dppr-sw-scroll"
    style={{ overflowX: 'auto', overflowY: 'hidden', width: '100%' }}
  >
    <table
      className="dppr-table"
      style={{
        width: '100%',
        borderCollapse: 'collapse',
      }}
    >
      <colgroup>
        <col style={{ width: '20%' }} />
        <col style={{ width: '20%' }} />
        <col style={{ width: '20%' }} />
        <col style={{ width: '20%' }} />
        <col style={{ width: '20%' }} />
      </colgroup>

      <thead>
        {/* Main heading */}
        <tr>
          <th
            colSpan={5}
            style={{
              ...swTh(true, true),
              textAlign: 'center',
              fontWeight: 700,
              borderBottom: `2px solid ${swBorder}`,
            }}
          >
            Shift Efficiency %
          </th>
        </tr>

        {/* Column headings */}
        <tr>
          <th style={swTh()}>
            M/C No
          </th>

          <th style={swThBottom()}>
            Shift 1
          </th>

          <th style={swThBottom()}>
            Shift 2
          </th>

          <th style={swThBottom()}>
            Shift 3
          </th>

          <th style={swThBottom(true)}>
            Overall EFF%
          </th>
        </tr>
      </thead>

      <tbody>
        {shiftWiseRows.map((r, i) => (
          <tr
            key={r.machineNo}
            style={{
              backgroundColor:
                i % 2 === 0 ? C.white : '#f8fafc',
              printColorAdjust: 'exact',
            }}
          >
            <td
              style={{
                ...swTd,
                textAlign: 'center',
                fontWeight: 600,
              }}
            >
              {r.machineNo}
            </td>

            {r.efficiency.map((v, s) => (
              <td key={`eff-${s}`} style={swTd}>
                {fmtPctWhole(v)}
              </td>
            ))}

            <td style={{ ...swTdLast, fontWeight: 600 }}>
              {fmtPctWhole(r.overallEff)}
            </td>
          </tr>
        ))}

        {/* Total row */}
        <tr
          style={{
            backgroundColor: '#dbeafe',
            fontWeight: 700,
            borderTop: '2px solid #93c5fd',
            printColorAdjust: 'exact',
          }}
        >
          <td
            style={{
              ...swTd,
              textAlign: 'center',
              fontWeight: 700,
              backgroundColor: '#dbeafe',
            }}
          >
            Total
          </td>

          {[0, 1, 2].map((shiftIndex) => {
            const totalActual = shiftWiseRows.reduce(
              (sum, r) => sum + (r.actualUnits[shiftIndex] ?? 0),
              0
            );
            const totalTarget = shiftWiseRows.reduce(
              (sum, r) => sum + r.targetUnits[shiftIndex],
              0
            );
            const eff = calcUnitEfficiency(totalActual, totalTarget);

            return (
              <td
                key={`total-shift-${shiftIndex}`}
                style={{
                  ...swTd,
                  fontWeight: 700,
                  backgroundColor: '#dbeafe',
                  borderTop: '2px solid #93c5fd',
                }}
              >
                {fmtPctWhole(eff)}
              </td>
            );
          })}

          <td
            style={{
              ...swTdLast,
              fontWeight: 700,
              backgroundColor: '#dbeafe',
              borderTop: '2px solid #93c5fd',
            }}
          >
            {fmtPctWhole(
              calcUnitEfficiency(
                shiftWiseRows.reduce(
                  (sum, r) =>
                    sum + r.actualUnits.reduce<number>((s, v) => (s ?? 0) + (v ?? 0), 0),
                  0
                ),
                shiftWiseRows.reduce(
                  (sum, r) =>
                    sum + r.targetUnits.reduce((s, v) => s + v, 0),
                  0
                )
              )
            )}
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  {!loading && !loadError && !hasShiftWiseData && (
    <div
      style={{
        padding: '8px 14px',
        fontSize: '12px',
        color: C.textMuted,
        borderTop: `1px solid ${C.border}`,
      }}
    >
      No hourly HPR / Quality production records found for{' '}
      {dateLabel}.
    </div>
  )}
</div>




      <div
        className="dppr-card"
        style={{
          backgroundColor: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: '10px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          overflow: 'hidden',
        }}


      >


        {/* Header: title · shared report date (date controls live in the HRP bar above) */}
        <div className="dppr-head-row"



          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '9px 12px',
            backgroundColor: C.headerBg,
            borderBottom: `1px solid ${C.border}`,
          }}
        >


          <div
            style={{
              borderRadius: '4px',
              padding: '5px 12px',
              fontSize: '12.5px',
              fontWeight: 700,
              color: '#1e293b',
              whiteSpace: 'nowrap',
            }}
          >
            DATE :- {dateDd}/{dateMm}/{dateYyyy}
          </div>


          <div style={{ flex: 1, textAlign: 'center' }}>
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#1e293b' }}>
              Machine Wise Production and Efficiency
            </h2>
          </div>



          {/* Print / Refresh — screen only; never part of the printed report. */}
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setTotalsHidden((hidden) => !hidden)}
              title={totalsHidden ? 'Show machine-wise and Grand Total rows' : 'Hide machine-wise and Grand Total rows'}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px',
                fontSize: '12.5px', fontWeight: 500, color: '#1e293b', backgroundColor: '#ffffff',
                border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f8fafc'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
            >
              {totalsHidden ? 'Show Total' : 'Hide Total'}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              title="Print this report"
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px',
                fontSize: '12.5px', fontWeight: 500, color: '#1e293b', backgroundColor: '#ffffff',
                border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'background-color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f8fafc'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
            >
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Re-fetch the latest data for the selected date"
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px',
                fontSize: '12.5px', fontWeight: 500, color: '#1e293b', backgroundColor: '#ffffff',
                border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'background-color 0.15s',
                opacity: refreshing ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f8fafc'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#ffffff'; }}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Status strip */}
        {loading && (
          <div style={{ padding: '6px 14px', fontSize: '12px', color: C.textMuted, borderBottom: `1px solid ${C.border}` }}>
            Loading HPR / Quality data for {dateLabel}…
          </div>
        )}
        {loadError && (
          <div
            style={{
              margin: '10px 14px 0',
              fontSize: '12px',
              color: '#b91c1c',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '6px',
              padding: '6px 10px',
            }}
          >
            Could not load saved data — {loadError} The report may be out of date.
          </div>
        )}

        {/* Report table */}
        <div className="dppr-table-scroll" style={{ overflowX: 'auto' }}>
          <table className="dppr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1388px' }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={2} style={{ ...thStyle(), width: '54px', borderBottom: `2px solid ${C.border}` }}>M/c No</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '150px', borderBottom: `2px solid ${C.border}` }}>Bottle Name</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '74px', borderBottom: `2px solid ${C.border}` }}>Weight</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '74px', borderBottom: `2px solid ${C.border}` }}>Speed</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '64px', borderBottom: `2px solid ${C.border}` }}>MIN</th>
                <th colSpan={2} style={{ ...thStyle(), borderBottom: `1px solid ${C.border}` }}>As Per Speed</th>
                <th colSpan={3} style={{ ...thStyle(), borderBottom: `1px solid ${C.border}` }}>Actual Production</th>
                <th colSpan={2} style={{ ...thStyle(), borderBottom: `1px solid ${C.border}` }}>Actual Total</th>
                <th colSpan={4} style={{ ...thStyle(true), borderBottom: `1px solid ${C.border}` }}>Efficiency %</th>
              </tr>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th style={{ ...thStyle(), width: '98px', borderBottom: `2px solid ${C.border}` }}>Total Units</th>
                <th style={{ ...thStyle(), width: '90px', borderBottom: `2px solid ${C.border}` }}>Total Draw</th>
                <th style={{ ...thStyle(), width: '94px', borderBottom: `2px solid ${C.border}` }}>Shift - I</th>
                <th style={{ ...thStyle(), width: '94px', borderBottom: `2px solid ${C.border}` }}>Shift - II</th>
                <th style={{ ...thStyle(), width: '94px', borderBottom: `2px solid ${C.border}` }}>Shift - III</th>
                <th style={{ ...thStyle(), width: '98px', borderBottom: `2px solid ${C.border}` }}>Units</th>
                <th style={{ ...thStyle(), width: '90px', borderBottom: `2px solid ${C.border}` }}>Draw</th>
                <th style={{ ...thStyle(), width: '76px', borderBottom: `2px solid ${C.border}` }}>Shift - I</th>
                <th style={{ ...thStyle(), width: '76px', borderBottom: `2px solid ${C.border}` }}>Shift - II</th>
                <th style={{ ...thStyle(), width: '76px', borderBottom: `2px solid ${C.border}` }}>Shift - III</th>
                <th style={{ ...thStyle(true), width: '82px', borderBottom: `2px solid ${C.border}` }}>Overall</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((r, idx) => {
                // Row-wise Overall Efficiency — this bottle row's total actual
                // units ÷ its As-Per-Speed total units.
                const rowOverallEff = r.overallEff;
                const row = (
                  <tr
                    key={r.rowKey}
                    className={`dppr-m${r.machineNo}`}
                    style={{ backgroundColor: MACHINE_ROW_BG[r.machineNo] ?? 'transparent', printColorAdjust: 'exact' }}
                  >
                    <td style={{ ...td, fontWeight: 600 }}>{r.machineNo}</td>
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }} title={(r.packingName || r.bottleName) || undefined}>
                      {r.packingName || r.bottleName || '—'}
                    </td>
                    <td style={td}>{r.weight > 0 ? fmt1(r.weight) : '—'}</td>
                    <td style={td}>{r.speed > 0 ? fmt1(r.speed) : '—'}</td>
                    <td style={td}>{r.runtimeMinutes > 0 ? r.runtimeMinutes : '—'}</td>
                    <td style={td}>{fmtUnits(r.asPerSpeedUnits)}</td>
                    <td style={td}>{fmt3(r.asPerSpeedDraw)}</td>
                    <td style={td}>{fmtUnits(r.shiftUnits[0])}</td>
                    <td style={td}>{fmtUnits(r.shiftUnits[1])}</td>
                    <td style={td}>{fmtUnits(r.shiftUnits[2])}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{fmtUnits(r.actualUnits)}</td>
                    <td style={td}>{fmt3(r.actualDraw)}</td>
                    <td style={td}>{fmtEff(r.shiftEff[0])}</td>
                    <td style={td}>{fmtEff(r.shiftEff[1])}</td>
                    <td style={td}>{fmtEff(r.shiftEff[2])}</td>
                    <td style={{ ...tdLast, fontWeight: 700 }}>{fmtEff(rowOverallEff)}</td>
                  </tr>
                );

                // Machine-wise total row — inserted immediately after the last
                // bottle/job entry of this machine. Hidden by the Hide Total
                // button together with the Grand Total below.
                const lastOfMachine =
                  idx === rows.length - 1 || rows[idx + 1].machineNo !== r.machineNo;
                if (!lastOfMachine || totalsHidden) return [row];

                const mt = machineTotals.get(r.machineNo);
                // UI-only: the Machine 1–4 subtotal efficiency cells mirror the
                // exact values of this machine's row in the Shift Efficiency % table.
                // The trailing '%' is stripped so the text matches the other
                // efficiency cells in this table; no calculation is changed.
                const shiftEffRow = shiftWiseRows.find(
                  (sw) => sw.machineNo === r.machineNo
                );
                const shiftEffText = (value: number | null) =>
                  fmtPctWhole(value).replace(/%$/, '');
                const totalRow = (
                  <tr
                    key={`machine-total-${r.machineNo}`}
                    className="dppr-total dppr-machine-total"
                    style={{
                      backgroundColor: '#eff6ff',
                      borderTop: '2px solid #bfdbfe',
                      printColorAdjust: 'exact',
                    }}
                  >
                    <td style={{ ...td, fontWeight: 700, textAlign: 'left', whiteSpace: 'normal' }} colSpan={2}>
                      Machine {r.machineNo} Total
                    </td>
                    <td style={td} />
                    <td style={td} />
                    <td style={{ ...td, fontWeight: 700 }}>{mt?.runtimeMinutes ? mt.runtimeMinutes : '—'}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(mt?.asPerSpeedUnits ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmt3(mt?.asPerSpeedDraw ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(mt?.shiftUnits[0] ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(mt?.shiftUnits[1] ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(mt?.shiftUnits[2] ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(mt?.actualUnits ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmt3(mt?.actualDraw ?? 0)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>
                      {shiftEffRow ? shiftEffText(shiftEffRow.efficiency[0]) : fmtEff(mt?.shiftEff[0] ?? null)}
                    </td>
                    <td style={{ ...td, fontWeight: 700 }}>
                      {shiftEffRow ? shiftEffText(shiftEffRow.efficiency[1]) : fmtEff(mt?.shiftEff[1] ?? null)}
                    </td>
                    <td style={{ ...td, fontWeight: 700 }}>
                      {shiftEffRow ? shiftEffText(shiftEffRow.efficiency[2]) : fmtEff(mt?.shiftEff[2] ?? null)}
                    </td>
                    <td style={{ ...tdLast, fontWeight: 700 }}>
                      {shiftEffRow ? shiftEffText(shiftEffRow.overallEff) : fmtEff(mt?.overallEff ?? null)}
                    </td>
                  </tr>
                );
                return [
                  row,
                  totalRow,
                  <tr key={`machine-total-space-${r.machineNo}`} aria-hidden="true">
                    <td
                      colSpan={16}
                      style={{
                        padding: 0,
                        border: 'none',
                        height: '6px',
                        lineHeight: 0,
                        fontSize: 0,
                        backgroundColor: 'transparent',
                      }}
                    />
                  </tr>,
                ];
              })}

              {/* Grand Total — production columns still come from the existing
                  Daily report totals (original rows only, never the machine-wise
                  total rows); each Efficiency % is that column's summed actual
                  units ÷ summed As-Per-Speed target units. */}
              {!totalsHidden && (
                <>
                <tr
                  className="dppr-total dppr-grand-total"
                  style={{
                    backgroundColor: '#dbeafe',
                    borderTop: '2px solid #93c5fd',
                    printColorAdjust: 'exact',
                  }}
                >
                  <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total</td>
                  <td style={td} />
                  <td style={td} />
                  <td style={td}></td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(totals.asPerSpeedUnits)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmt3(totals.asPerSpeedDraw)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(totals.shiftUnits[0])}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(totals.shiftUnits[1])}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(totals.shiftUnits[2])}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtUnits(totals.actualUnits)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmt3(totals.actualDraw)}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtEff(totals.shiftEff[0])}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtEff(totals.shiftEff[1])}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtEff(totals.shiftEff[2])}</td>
                  <td style={{ ...tdLast, fontWeight: 700 }}>{fmtEff(grandOverallEff)}</td>
                </tr>
                <tr key="grand-total-space" aria-hidden="true">
                  <td
                    colSpan={16}
                    style={{
                      padding: 0,
                      border: 'none',
                      height: '6px',
                      lineHeight: 0,
                      fontSize: 0,
                      backgroundColor: 'transparent',
                    }}
                  />
                </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {!loading && !loadError && !hasData && (
          <div style={{ padding: '8px 14px', fontSize: '12px', color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            No hourly HPR / Quality production records found for {dateLabel}.
          </div>
        )}

        {/* Weight Efficiency — displayed in the space between the main report
            table and the Job-wise Production Summary, from the existing
            report totals above: (Actual Total Draw / Total Draw as per
            Speed) × 100, formatted to two decimals. Existing efficiency
            calculations are unchanged. */}
        <div style={{ padding: '12px 14px', textAlign: 'right' }}>
          <span style={{ fontSize: '13.5px', fontWeight: 700, color: '#1e293b' }}>
            Weight Efficiency = {weightEfficiency === null ? '—' : `${weightEfficiency.toFixed(2)}%`}
          </span>
        </div>

        {/* Job-wise production summary — same date filter, same load/refresh,
            same card, printed with the report. One row per machine + Job ID. */}
        <div style={{ marginTop: '4px' }}>
          <div
            style={{
              padding: '9px 12px',
              backgroundColor: C.headerBg,
              borderTop: `1px solid ${C.border}`,
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#1e293b' }}>
              Job-wise Production Summary
            </h3>
          </div>

          {jobLoadedKey !== dateKey && (
            <div style={{ padding: '8px 14px', fontSize: '12px', color: C.textMuted }}>
              Loading job-wise data for {dateLabel}…
            </div>
          )}

          {jobLoadedKey === dateKey && jobWiseRows.length > 0 && (
            <div className="dppr-table-scroll" style={{ overflowX: 'auto' }}>
              <table className="dppr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: '700px' }}>
                <thead>
                  <tr style={{ backgroundColor: C.headerBg }}>
                    <th style={{ ...thStyle(), width: '64px', borderBottom: `2px solid ${C.border}` }}>M/c</th>
                    <th style={{ ...thStyle(), width: '180px', borderBottom: `2px solid ${C.border}` }}>Bottle Name</th>
                    <th style={{ ...thStyle(), width: '130px', borderBottom: `2px solid ${C.border}` }}>Date of Starting</th>
                    <th style={{ ...thStyle(), width: '120px', borderBottom: `2px solid ${C.border}` }}>Time of Starting</th>
                    <th style={{ ...thStyle(true), width: '150px', borderBottom: `2px solid ${C.border}` }}>Production to Date</th>
                  </tr>
                </thead>
                <tbody>
                  {jobWiseRows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ ...td, fontWeight: 600 }}>{r.machineNo}</td>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }} title={(r.packingName || r.itemName) || undefined}>
                        {r.packingName || r.itemName || '—'}
                      </td>
                      <td style={td}>{r.dateText}</td>
                      <td style={td}>{r.timeText}</td>
                      <td style={{ ...tdLast, fontWeight: 600 }}>{fmtUnits(r.units)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !loadError && jobLoadedKey === dateKey && jobWiseRows.length === 0 && (
            <div style={{ padding: '8px 14px', fontSize: '12px', color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
              No job records found for {dateLabel}.
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default QualityReport;