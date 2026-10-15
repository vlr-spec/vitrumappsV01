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
 * Very light pastel row background per machine — Daily Production Performance
 * Report body rows only. Header, total row, Weight Efficiency strip and the
 * job-wise table are intentionally left untinted.
 */
const MACHINE_ROW_BG: Record<number, string> = {
  1: '#EFF6FF',
  2: '#F0FDF4',
  3: '#FFFBEB',
  4: '#F5F3FF',
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
 * Shift/Overall Efficiency % — production-UNITS based only.
 *
 *   Shift Efficiency %   = (Shift Actual Production Units / Shift Expected Production Units) × 100
 *   Overall Efficiency % = (Total Actual Production Units / Total Expected Production Units) × 100
 *
 * "Expected Production Units" is the As-Per-Speed theoretical quantity
 * (Speed/min × 60 × Machine Gob × Duration/Hours). Weight, draw and weight
 * efficiency are never used here. Returns null when expected units are zero,
 * missing or non-finite so callers render '—' instead of dividing by zero.
 */
const calcUnitEfficiency = (actualUnits: number, expectedUnits: number): number | null => {
  const actual = Number(actualUnits);
  const expected = Number(expectedUnits);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  return (actual / expected) * 100;
};

/**
 * Weight Efficiency % — draw based only.
 *
 *   Weight Efficiency % = (Actual Total Draw / Total Draw as per Speed) × 100
 *
 * Kept as a dedicated function so the existing unit-based efficiency
 * calculations (calcUnitEfficiency and every caller) stay untouched.
 * Returns null when the as-per-speed draw is zero, missing or non-finite so
 * callers render '—' instead of dividing by zero.
 */
const calcWeightEfficiency = (actualDraw: number, asPerSpeedDraw: number): number | null => {
  const actual = Number(actualDraw);
  const expected = Number(asPerSpeedDraw);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  return (actual / expected) * 100;
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

/** Actual production duration in hours of one key: (own − previous) / 60, else 1. */
const durationHoursForReportKey = (orderedKeys: string[], key: string): number => {
  const idx = orderedKeys.indexOf(key);
  if (idx <= 0) return 1;
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
      durationHours: durationHoursForReportKey(ordered, key),
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
const fmtEff = (n: number | null) => (n === null ? '—' : n.toFixed(2));

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
  shiftTheoretical: number[];
  actualUnits: number;
  actualDraw: number;
  shiftEff: (number | null)[];
  overallEff: number | null;
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
        units += hourlyUnits(points[end].entry);
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
      if (!hasMeaningfulData(entry)) continue;
      const jobId = entryJob(entry);
      if (!jobId) continue;
      const mapKey = `${machineNo}|${jobId}|${entryBottle(entry)}`;
      if (out.has(mapKey)) continue;
      // Start of this first entry's period: the previous displayed row's time,
      // or the entry's own label when it is the day's very first row.
      out.set(mapKey, i > 0 ? ordered[i - 1] : ordered[i]);
    }
  }
  return out;
};

// ─── Report ────────────────────────────────────────────────────────────────
/**
 * The report is read-only and has no date state of its own: `date` is the
 * single selected date owned by the Quality Module's Hourly Production Monitor
 * controls, so both sections always show the same day.
 */
export const QualityReport: React.FC<{ date: Date }> = ({ date }) => {
  const { machines, bottles } = useERP();

  // ── Packing Name ──────────────────────────────────────────────────────────
  // The Quality Table stores the configured/parent bottle id, so the "Packing
  // Name" of a report row is the bottle_name of that bottle's mapped child,
  // read read-only from the SAME existing parent/child mapping API the Quality
  // grid already uses (production.bottle_master.group_id). No new database
  // field, table or endpoint is introduced. A parent with several mapped
  // children uses the alphabetically-first child — exactly the rule the grid's
  // saved-row display uses — so the report and the grid always agree. A bottle
  // without children has no packing name (rendered as '—'). Fetched once per
  // mount; on failure the report still renders, just without packing names.
  const [childNameByParent, setChildNameByParent] = useState<Map<string, string>>(() => new Map());
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
        const next = new Map<string, string>();
        for (const [parentId, children] of grouped) {
          if (children.length === 0) continue;
          const first = [...children].sort((a, b) =>
            String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' })
          )[0];
          next.set(parentId, first.name);
        }
        setChildNameByParent(next);
      })
      .catch(() => { /* keep the report correct without packing names */ });
    return () => { cancelled = true; };
  }, []);

  /** Packing name for a stored (parent/configured) bottle id, or '' if unmapped. */
  const packingNameFor = useCallback((bottleId: string): string => {
    const id = String(bottleId ?? '').trim();
    return id ? (childNameByParent.get(id) ?? '') : '';
  }, [childNameByParent]);

  const [hourly, setHourly] = useState<QualityDayHourly>({});
  // The date the stored `hourly` was loaded for. Rows are only ever built
  // from it while it matches the selected date, so a date change can never
  // show another day's records under the new date while the fetch is in
  // flight — the report always reflects the selected 24-hour window only.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Job-wise rows for the same selected date. `jobLoadedKey` mirrors
  // `loadedKey`: the job table is only ever rendered while these rows belong
  // to the selected date, so a date change can never flash another day's jobs.
  const [jobRows, setJobRows] = useState<QualityJobRow[]>([]);
  const [jobLoadedKey, setJobLoadedKey] = useState<string | null>(null);
  const [jobRowsOk, setJobRowsOk] = useState(false);

  // Hovered remark tooltip — follows the cursor and is shown on the LEFT side
  // of it. `text` is the remark to display; `x`/`y` are the last cursor
  // viewport coordinates. Null when no remark is hovered. Read-only affordance
  // only: remark editing behaviour is unchanged.
  const [remarkTip, setRemarkTip] = useState<{ text: string; x: number; y: number } | null>(null);

  // A scroll under a hovering cursor would leave the fixed tooltip floating at
  // stale viewport coordinates — dismiss it on any scroll instead.
  useEffect(() => {
    if (!remarkTip) return;
    const hide = () => setRemarkTip(null);
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [remarkTip]);

  // Flip the tooltip above the cursor when there is no room below it in the viewport.
  const remarkTipFlip = remarkTip !== null && remarkTip.y + 240 > window.innerHeight;

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
  const rows = useMemo<MachineReportRow[]>(() => {
    const out: MachineReportRow[] = [];
    for (const machineNo of MACHINE_NOS) {
      const gob = machineGob(machineNo, machines);
      const byTime = dayHourly[String(machineNo)] ?? {};

      for (const run of splitMachineRuns(machineNo, byTime)) {
        const shiftUnits = [0, 0, 0];
        const shiftTheoretical = [0, 0, 0];
        let totalUnits = 0;
        let theoreticalTotal = 0;
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

          // As Per Speed (theoretical) production for the segment — the shared
          // formula Speed/min × 60 × Machine Gob × Duration/Hours, with this
          // machine's own gob count and the segment's actual duration (1 for
          // hourly rows, fractional for split segments). Over a full 24-slot
          // day at one speed this is exactly
          // Speed × Machine Gob × 60 × 24 (calculateProductionMetrics), and a
          // split hour's segments sum to exactly the unsplit hour.
          const theoretical = calculateTheoreticalBottles(speed, gob, durationHours);

          shiftUnits[idx] += units;
          shiftTheoretical[idx] += theoretical;
          totalUnits += units;
          theoreticalTotal += theoretical;

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
        // weighted when several hours ran, so Total Draw = Units × Weight /
        // 1,000,000 stays exact across the whole period.
        const weight =
          weightedUnits > 0
            ? weightedWeight / weightedUnits
            : weightHours > 0
              ? weightSum / weightHours
              : 0;
        const speed = speedHours > 0 ? speedSum / speedHours : 0;

        // As Per Speed – Total Draw = Weight × As Per Speed Total Units / 1,000,000
        const asPerSpeedDraw = (weight * theoreticalTotal) / 1_000_000;
        // Actual Total Draw = Actual Total Units × Weight / 1,000,000
        const actualDraw = (weight * totalUnits) / 1_000_000;

        // Shift Efficiency % (UNITS based only — never weight/draw/weight-efficiency):
        //   Shift I/II/III Efficiency % = (Shift Actual Production Units /
        //   Shift Expected Production Units) × 100, where Expected = that
        //   shift's As-Per-Speed theoretical units. Every hour of the shift is
        //   summed first (all of them here, and across the bottle rows the
        //   Total row adds up again), so an hourly Eff% value is never copied
        //   and several bottles in one shift are simply added. Zero or missing
        //   expected units yield null (rendered as '—'), never a division by zero.
        const shiftEff = shiftUnits.map((u, i) => calcUnitEfficiency(u, shiftTheoretical[i]));
        // Overall Efficiency % = (Total Actual Production Units /
        // Total Expected Production Units) × 100 — units only.
        const overallEff = calcUnitEfficiency(totalUnits, theoreticalTotal);

        // MIN — actual production runtime only. A run point counts toward the
        // runtime only when that hour actually recorded production; an empty
        // hourly row that merely inherited the job/bottle (e.g. an idle
        // 8:00–9:00 AM hour) no longer adds time the job did not run. Every
        // producing row keeps its own duration (1 for an hourly row, fractional
        // for a manual split), so a job that starts or ends partway through an
        // hour still counts its exact elapsed minutes through to the next job's
        // change time. Only the MIN column is affected.
        const runtimeMinutes = Math.round(
          run.points.reduce(
            (sum, p) => (hourlyUnits(p.entry) > 0 ? sum + p.durationHours * 60 : sum),
            0
          )
        );

        out.push({
          machineNo,
          rowKey: `${machineNo}-${run.runIndex}-${run.runKey}`,
          bottleName: bottleNameFor(run.bottleId, bottles),
          packingName: packingNameFor(run.bottleId),
          weight,
          speed,
          runtimeMinutes,
          asPerSpeedUnits: theoreticalTotal,
          asPerSpeedDraw,
          shiftUnits,
          shiftTheoretical,
          actualUnits: totalUnits,
          actualDraw,
          shiftEff,
          overallEff,
        });
      }
    }
    return out;
  }, [dayHourly, machines, bottles, packingNameFor]);

// Total row — Efficiency % is weighted from total actual / total expected
// production units, never an average of the row Efficiency % values and
// never weight/draw. Unit/production totals above it are straight sums, and
// each Total Efficiency % below re-applies calcUnitEfficiency to those sums,
// so a short run (e.g. Machine 2's 160-min segment) can never count equally
// with a long run (e.g. its 780-min segment).
const totals = useMemo(() => {
    const shiftUnits = [0, 0, 0];
    const shiftTheoretical = [0, 0, 0];
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
      r.shiftTheoretical.forEach((t, i) => {
        shiftTheoretical[i] += t;
      });
    }
    // Total Shift Efficiency % = (Total Shift Actual Units /
    // Total Shift Expected Units) × 100 per shift, aggregated across every run
    // in that shift. Total Overall Efficiency % = (Total Actual Units /
    // Total Expected Units) × 100 over the full 24-hour reporting period.
    // Zero or missing expected units yield null (rendered as '—') via
    // calcUnitEfficiency — never NaN, Infinity or a division by zero.
    const shiftEff = [0, 1, 2].map((i) => calcUnitEfficiency(shiftUnits[i], shiftTheoretical[i]));
    const overallEff = calcUnitEfficiency(actualUnits, asPerSpeedUnits);
    return { shiftUnits, asPerSpeedUnits, asPerSpeedDraw, actualUnits, actualDraw, shiftEff, overallEff, runtimeMinutes };
  }, [rows]);

  const hasData = rows.some((r) => r.asPerSpeedUnits > 0 || r.actualUnits > 0);

  // Weight Efficiency % for the selected day — (Actual Total Draw / Total Draw
  // as per Speed) × 100, computed from the existing report totals above.
  // Null-safe: a zero/missing as-per-speed draw renders as '—', never NaN,
  // Infinity or a division by zero. Existing efficiency calculations are untouched.
  const weightEfficiency = calcWeightEfficiency(totals.actualDraw, totals.asPerSpeedDraw);

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

    // Date + machine-wise remarks for the selected production date: each
    // machine shows only its own remarks recorded in this date's hourly
    // records, across all of that machine's jobs, in production-timeline
    // (chronological) order with serial numbering. Job ID is never used for
    // grouping here. Joined as one sentence-wise line in the same row cell.
    const remarkByMachine = new Map<number, string>();
    for (const machineNo of MACHINE_NOS) {
      const byTime = dayHourly[String(machineNo)] ?? {};
      const ordered = getReportOrderedKeys(byTime);
      const texts: string[] = [];
      const seen = new Set<string>();
      for (const key of ordered) {
        const t = String((byTime[key] as QualityHourlyEntry | undefined)?.remarks ?? '').trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          texts.push(t);
        }
      }
      if (texts.length === 0) {
        for (const s of source) {
          if (s.machineNo !== machineNo) continue;
          const raw = String(s.remark ?? '').trim();
          if (!raw) continue;
          for (const line of raw.split('\n')) {
            const cleaned = line.replace(/^\s*\d+\.\s*/, '').trim() || line.trim();
            if (cleaned && !seen.has(cleaned)) {
              seen.add(cleaned);
              texts.push(cleaned);
            }
          }
        }
      }
      remarkByMachine.set(machineNo, texts.map((t, idx) => `${idx + 1}. ${t}`).join('  '));
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
        return {
          key: `${s.machineNo}-${s.jobId}-${s.bottleId}`,
          machineNo: s.machineNo,
          bottleId: s.bottleId,
          itemName: bottleNameFor(s.bottleId, bottles),
          packingName: packingNameFor(s.bottleId),
          dateText: fmtDateSlash(startDate),
          timeText: fmtTime12(startDate),
          startSort: overnightShift(startDate),
          units: s.units,
          remark: remarkByMachine.get(s.machineNo) ?? '',
        };
      })
      .sort((a, b) => a.machineNo - b.machineNo || b.startSort.getTime() - a.startSort.getTime());
  }, [jobLoadedKey, jobRowsOk, jobRows, dateKey, dayHourly, bottles, packingNameFor]);

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

  return (
    // Rendered inside the Quality Module's already-padded container, so this
    // wrapper only adds spacing — no page padding (avoids double inset).
    <div className="dppr-print-root" ref={printAreaRef} style={{ marginTop: '16px' }}>
      <style>{`
        .dppr-table tbody tr:not(.dppr-m1):not(.dppr-m2):not(.dppr-m3):not(.dppr-m4):hover td { background-color: #f8fafc; }
        .dppr-table tbody tr.dppr-total:hover td { background-color: #f0f4fa; }
        .dppr-table tbody tr.dppr-m1:hover td { background-color: #EFF6FF; }
        .dppr-table tbody tr.dppr-m2:hover td { background-color: #F0FDF4; }
        .dppr-table tbody tr.dppr-m3:hover td { background-color: #FFFBEB; }
        .dppr-table tbody tr.dppr-m4:hover td { background-color: #F5F3FF; }
        .dppr-remark-text { display: block; white-space: normal; overflow-wrap: break-word; }
        .dppr-remark-tip {
          display: none;
          position: absolute;
          bottom: calc(100% + 8px);
          right: 200px;
          width: 320px;
          max-width: 60vw;
          max-height: 200px;
          overflow-y: auto;
          white-space: normal;
          overflow-wrap: break-word;
          word-break: break-word;
          text-align: left;
          background-color: #ffffff;
          color: #1e293b;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
          padding: 12px 14px;
          font-size: 13px;
          line-height: 1.55;
          z-index: 60;
        }
        @media print {
          .dppr-remark-tip { display: none !important; }
          .dppr-table tbody tr:hover td { background-color: transparent; }
          .dppr-table tbody tr.dppr-total:hover td { background-color: #f0f4fa; }

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
        <div



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
              Daily Production Performance Report
            </h2>
          </div>



          {/* Print / Refresh — screen only; never part of the printed report. */}
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
          <table className="dppr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1520px' }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={2} style={{ ...thStyle(), width: '54px', borderBottom: `2px solid ${C.border}` }}>M/c No</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '132px', borderBottom: `2px solid ${C.border}` }}>Production Bottle Name</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '150px', borderBottom: `2px solid ${C.border}` }}>Packed Bottle Name</th>
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
              {rows.map((r) => (
                <tr
                  key={r.rowKey}
                  className={`dppr-m${r.machineNo}`}
                  style={{ backgroundColor: MACHINE_ROW_BG[r.machineNo] ?? 'transparent', printColorAdjust: 'exact' }}
                >
                  <td style={{ ...td, fontWeight: 600 }}>{r.machineNo}</td>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }} title={r.bottleName || undefined}>
                    {r.bottleName || '—'}
                  </td>
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
                  <td style={{ ...tdLast, fontWeight: 700 }}>{fmtEff(r.overallEff)}</td>
                </tr>
              ))}

              {/* Total row — weighted from totals, never an average of efficiencies */}
              <tr className="dppr-total" style={{ backgroundColor: '#f0f4fa', borderTop: `2px solid ${C.border}` }}>
                <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Total</td>
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
                <td style={{ ...tdLast, fontWeight: 700 }}>{fmtEff(totals.overallEff)}</td>
              </tr>
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
              <table className="dppr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: '940px' }}>
                <thead>
                  <tr style={{ backgroundColor: C.headerBg }}>
                    <th style={{ ...thStyle(), width: '64px', borderBottom: `2px solid ${C.border}` }}>M/c</th>
                    <th style={{ ...thStyle(), width: '240px', borderBottom: `2px solid ${C.border}` }}>Production Bottle Name</th>
                    <th style={{ ...thStyle(), width: '180px', borderBottom: `2px solid ${C.border}` }}>Packed Bottle Name</th>
                    <th style={{ ...thStyle(), width: '130px', borderBottom: `2px solid ${C.border}` }}>Date of Starting</th>
                    <th style={{ ...thStyle(), width: '120px', borderBottom: `2px solid ${C.border}` }}>Time of Starting</th>
                    <th style={{ ...thStyle(), width: '150px', borderBottom: `2px solid ${C.border}` }}>Production to Date</th>
                    <th style={{ ...thStyle(true), borderBottom: `2px solid ${C.border}` }}>Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {jobWiseRows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ ...td, fontWeight: 600 }}>{r.machineNo}</td>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }} title={r.itemName || undefined}>
                        {r.itemName || '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }} title={(r.packingName || r.itemName) || undefined}>
                        {r.packingName || r.itemName || '—'}
                      </td>
                      <td style={td}>{r.dateText}</td>
                      <td style={td}>{r.timeText}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{fmtUnits(r.units)}</td>
                      <td style={{ ...tdLast, textAlign: 'left', whiteSpace: 'normal' }}>
                        {r.remark ? (
                          <span
                            className="dppr-remark-text"
                            onMouseEnter={(e) => setRemarkTip({ text: r.remark, x: e.clientX, y: e.clientY })}
                            onMouseMove={(e) => setRemarkTip({ text: r.remark, x: e.clientX, y: e.clientY })}
                            onMouseLeave={() => setRemarkTip(null)}
                          >
                            {r.remark.split('\n').map((line, i) => (
                              <React.Fragment key={i}>
                                {i > 0 && <br />}
                                {line}
                              </React.Fragment>
                            ))}
                          </span>
                        ) : (
                          r.remark
                        )}
                      </td>
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

      {/* Remark hover tooltip — fixed to the viewport on the LEFT side of the
          cursor (its right edge sits 12px left of the cursor) and follows the
          cursor while a remark is hovered; flips above the cursor when there
          is no room below. Screen only: the print stylesheet hides it. */}
      {remarkTip && (
        <div
          className="dppr-remark-tip"
          role="tooltip"
          style={{
            position: 'fixed',
            left: remarkTip.x,
            top: remarkTip.y + (remarkTipFlip ? -12 : 14),
            transform: remarkTipFlip
              ? 'translate(calc(-100% - 12px), -100%)'
              : 'translateX(calc(-100% - 12px))',
            display: 'block',
            bottom: 'auto',
            right: 'auto',
            margin: 0,
            whiteSpace: 'pre-line',
            zIndex: 9999,
          }}
        >
          {remarkTip.text}
        </div>
      )}
    </div>
  );
};

export default QualityReport;