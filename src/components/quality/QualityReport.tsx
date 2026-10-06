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

interface HourPoint {
  slot: { time: string; shift_id: number };
  entry: QualityHourlyEntry;
}

/** One continuous machine + bottle/job period inside a single production date. */
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
 * One gap is closed so the split reflects real production and never a
 * half-filled cell: a record with production but no bottle belongs to the run
 * it physically sits in (previous run, or the next one when it comes first),
 * so filling the bottle in later does not break a machine row in two.
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
 * Builds one machine's report segments from the selected date, in the exact
 * implementation order the report requires:
 *
 *   1. FILTER to the selected 24-hour reporting window first — only the 24
 *      canonical HRP slot labels of this report date are read; records under
 *      any other time label, and every previous/future-day record the backend
 *      never returns for this `production_date`, are not part of the sequence
 *      at all. This is the same window the Hourly Production Monitor renders.
 *   2. DETECT bottle/job changes across those window records only.
 *   3. CREATE one run per continuous bottle segment (empty hours never break
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
  const points: HourPoint[] = [];
  for (const slot of PRODUCTION_TIMES) {
    const entry = byTime[slot.time];
    if (!hasMeaningfulData(entry)) continue;
    points.push({ slot, entry: entry as QualityHourlyEntry });
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
  weight: number;
  speed: number;
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
  remark: string;
}

/** One rendered row of the job-wise production summary table. */
interface JobWiseRow {
  key: string;
  machineNo: number;
  itemName: string;
  dateText: string;
  timeText: string;
  startSort: Date;
  units: number;
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
    // Window order (9:00 AM → 8:00 AM) is the physical order of the day.
    const points: HourPoint[] = [];
    for (const slot of PRODUCTION_TIMES) {
      const entry = byTime[slot.time];
      if (!hasMeaningfulData(entry)) continue;
      if (!entryJob(entry)) continue;
      points.push({ slot, entry: entry as QualityHourlyEntry });
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
      if (startDate) {
        out.push({
          machineNo,
          jobId,
          bottleId,
          startDate,
          startSort: overnightShift(startDate),
          units,
          remark: '',
        });
      }
      i = end;
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

        for (const { slot, entry } of run.points) {
          const units = hourlyUnits(entry);
          const speed = parseNum(entry.speed_per_min);
          const weight = hourlyWeight(entry, gob);
          const idx = slot.shift_id - 1;
          if (idx < 0 || idx > 2) continue;

          // As Per Speed (theoretical) production for the slot — the shared
          // formula Speed/min × 60 × Machine Gob × Duration/Hours, with this
          // machine's own gob count and the slot's one-hour duration. Over a
          // full 24-slot day at one speed this is exactly
          // Speed × Machine Gob × 60 × 24 (calculateProductionMetrics).
          const theoretical = calculateTheoreticalBottles(speed, gob, 1);

          shiftUnits[idx] += units;
          shiftTheoretical[idx] += theoretical;
          totalUnits += units;
          theoreticalTotal += theoretical;

          if (weight !== null) {
            weightSum += weight;
            weightHours += 1;
            if (units > 0) {
              weightedWeight += units * weight;
              weightedUnits += units;
            }
          }
          if (speed > 0) {
            speedSum += speed;
            speedHours += 1;
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

        // Shift Efficiency = the ACTUAL production of the complete 8-hour
        // shift / that shift's as-per-speed production × 100. Every hour of the
        // shift is summed first (all of them here, and across the bottle rows
        // the Total row adds up again), so an hourly Eff% value is never copied
        // and several bottles in one shift are simply added.
        const shiftEff = shiftUnits.map((u, i) =>
          shiftTheoretical[i] > 0 ? (u / shiftTheoretical[i]) * 100 : null
        );
        // Overall Efficiency = Actual Total Units / As Per Speed Total Units × 100
        const overallEff = theoreticalTotal > 0 ? (totalUnits / theoreticalTotal) * 100 : null;

        out.push({
          machineNo,
          rowKey: `${machineNo}-${run.runIndex}-${run.runKey}`,
          bottleName: bottleNameFor(run.bottleId, bottles),
          weight,
          speed,
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
  }, [dayHourly, machines, bottles]);

  // Total row — weighted from total actual / theoretical production, never an
  // average of the machine efficiencies.
  const totals = useMemo(() => {
    const shiftUnits = [0, 0, 0];
    const shiftTheoretical = [0, 0, 0];
    let asPerSpeedUnits = 0;
    let asPerSpeedDraw = 0;
    let actualUnits = 0;
    let actualDraw = 0;
    for (const r of rows) {
      asPerSpeedUnits += r.asPerSpeedUnits;
      asPerSpeedDraw += r.asPerSpeedDraw;
      actualUnits += r.actualUnits;
      actualDraw += r.actualDraw;
      r.shiftUnits.forEach((u, i) => {
        shiftUnits[i] += u;
      });
      r.shiftTheoretical.forEach((t, i) => {
        shiftTheoretical[i] += t;
      });
    }
    const shiftEff = shiftUnits.map((u, i) => (shiftTheoretical[i] > 0 ? (u / shiftTheoretical[i]) * 100 : null));
    const overallEff = asPerSpeedUnits > 0 ? (actualUnits / asPerSpeedUnits) * 100 : null;
    return { shiftUnits, asPerSpeedUnits, asPerSpeedDraw, actualUnits, actualDraw, shiftEff, overallEff };
  }, [rows]);

  const hasData = rows.some((r) => r.asPerSpeedUnits > 0 || r.actualUnits > 0);

  // Job-wise production summary — one row per machine + Job ID applicable to
  // the selected production date: the API rows when the job endpoint answered,
  // otherwise rows derived from this date's hourly records. Ordered by machine
  // first, then the newest job first within a machine on the actual 9 AM
  // production-day timeline. No blank rows: a machine without a job on the
  // date simply has no rows here.
  const jobWiseRows = useMemo<JobWiseRow[]>(() => {
    if (jobLoadedKey !== dateKey) return [];

    const source: JobSourceRow[] = jobRowsOk
      ? jobRows.flatMap((row) => {
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

    return source
      .map((s) => ({
        key: `${s.machineNo}-${s.jobId}`,
        machineNo: s.machineNo,
        itemName: bottleNameFor(s.bottleId, bottles),
        dateText: fmtDateSlash(s.startDate),
        timeText: fmtTime12(s.startDate),
        startSort: s.startSort,
        units: s.units,
        remark: s.remark,
      }))
      .sort((a, b) => a.machineNo - b.machineNo || b.startSort.getTime() - a.startSort.getTime());
  }, [jobLoadedKey, jobRowsOk, jobRows, dateKey, dayHourly, bottles]);

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
        .dppr-table tbody tr:hover td { background-color: #f8fafc; }
        .dppr-table tbody tr.dppr-total:hover td { background-color: #f0f4fa; }
        @media print {
          .dppr-table tbody tr:hover td { background-color: transparent; }
          .dppr-table tbody tr.dppr-total:hover td { background-color: #f0f4fa; }

          /* Applied by the Print button: everything except this report leaves
             the printed page, so only the report is sent to the printer. */
          [${PRINT_HIDDEN_ATTR}] { display: none !important; }

          /* Screen-only chrome is dropped and the table is given the full
             landscape page width, so all 15 columns print instead of being
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
          <table className="dppr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1300px' }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={2} style={{ ...thStyle(), width: '54px', borderBottom: `2px solid ${C.border}` }}>M/c No</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '132px', borderBottom: `2px solid ${C.border}` }}>Bottle Name</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '74px', borderBottom: `2px solid ${C.border}` }}>Weight</th>
                <th rowSpan={2} style={{ ...thStyle(), width: '74px', borderBottom: `2px solid ${C.border}` }}>Speed</th>
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
                <tr key={r.rowKey}>
                  <td style={{ ...td, fontWeight: 600 }}>{r.machineNo}</td>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }} title={r.bottleName || undefined}>
                    {r.bottleName || '—'}
                  </td>
                  <td style={td}>{r.weight > 0 ? fmt1(r.weight) : '—'}</td>
                  <td style={td}>{r.speed > 0 ? fmt1(r.speed) : '—'}</td>
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
                <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total</td>
                <td style={td} />
                <td style={td} />
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

        {/* Job-wise production summary — same date filter, same load/refresh,
            same card, printed with the report. One row per machine + Job ID. */}
        <div>
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
              <table className="dppr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }}>
                <thead>
                  <tr style={{ backgroundColor: C.headerBg }}>
                    <th style={{ ...thStyle(), width: '64px', borderBottom: `2px solid ${C.border}` }}>M/c</th>
                    <th style={{ ...thStyle(), width: '240px', borderBottom: `2px solid ${C.border}` }}>Item Description</th>
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
                      <td style={td}>{r.dateText}</td>
                      <td style={td}>{r.timeText}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{fmtUnits(r.units)}</td>
                      <td style={{ ...tdLast, textAlign: 'left', whiteSpace: 'normal' }}>{r.remark}</td>
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