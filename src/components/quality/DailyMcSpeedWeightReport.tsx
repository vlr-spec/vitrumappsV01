/**
 * DailyMcSpeedWeightReport.tsx — Daily M/C Speed and Weight Report (frontend only).
 *
 * Hour-wise report for ONE selected production day: hourly rows from 8:00 AM
 * through 7:00 AM, with the average Speed and average Weight of each hour for
 * every machine, plus a daily-average footer per machine/job column.
 *
 * All figures are calculated inside this file from the Quality Module's hourly
 * records fetched through the existing qualityRepository
 * (GET /api/production/quality/daily/?date=). No new table, no change to the
 * Quality Module, production calculations, shift logic, job logic or save flow
 * — this is a read-only representation of existing data.
 *
 * Job changes are handled exactly like the existing All Machine Monthly Report
 * (AllMachineReport.tsx): each machine's day is split into continuous
 * same-bottle runs and every run gets its own Weight/Speed column group, so a
 * mid-day job change appears as a separate column group with its own hourly
 * values and its own daily average.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { useERP } from '../../context/ERPContext';
import {
  qualityRepository,
  QualityDayHourly,
  QualityHourlyEntry,
  hasMeaningfulData,
} from '../../services/qualityRepository';
import { getGobCountFromDB } from '../../utils/calculations';

const MACHINE_NOS = [1, 2, 3, 4];

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

/** Display order for this report: 8:00 AM → 7:00 AM (same 24 labels, rotated). */
const DISPLAY_TIMES: { time: string; shift_id: number }[] = [
  ...PRODUCTION_TIMES.slice(-1),
  ...PRODUCTION_TIMES.slice(0, -1),
];

const EMPTY_DAY: QualityDayHourly = {};

const C = {
  border: '#e2e8f0',
  headerBg: '#f8fafc',
  headerText: '#1e293b',
  textMain: '#1e293b',
  textMuted: '#64748b',
  white: '#ffffff',
};

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDisplay = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/**
 * Applicable weight of one hourly record — stored weight_avg when present,
 * otherwise the same F/M/R average the Quality Module computes from the
 * machine's gob type. Mirrors AllMachineReport.hourlyWeight exactly.
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

const hourlySpeed = (e: QualityHourlyEntry | undefined): number | null => {
  if (!e) return null;
  const s = parseFloat(e.speed_per_min);
  return Number.isFinite(s) && s > 0 ? s : null;
};

const machineGob = (
  machineNo: number,
  machines: { code: string; gobCount: number }[]
): number => {
  const code = `MAC-${String(machineNo).padStart(2, '0')}`;
  const fromErp = machines.find((m) => m.code === code)?.gobCount;
  if (fromErp && fromErp > 0) return fromErp;
  return getGobCountFromDB(machineNo);
};

const bottleNameFor = (bottleId: string, bottles: { id: string; name: string }[]): string => {
  const id = String(bottleId ?? '').trim();
  if (!id) return '';
  const hit = bottles.find((b) => String(b.id ?? '').trim() === id);
  return hit?.name?.trim() || id;
};

// ─── Machine + bottle/job runs (identical to AllMachineReport) ──────────────
const entryBottle = (e: QualityHourlyEntry | undefined): string => String(e?.bottle_id ?? '').trim();
const entryJob = (e: QualityHourlyEntry | undefined): string => String(e?.job_id ?? '').trim();

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

/** One column group per continuous same-bottle run — same split as AllMachineReport. */
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
  if (points.length === 0) {
    return [{ machineNo, runIndex: 0, bottleId: '', jobId: '', runKey: '', points: [] }];
  }
  const keys = runKeysFor(points);
  const runs: JobRun[] = [];
  let currentKey: string | null = null;
  for (let i = 0; i < points.length; i++) {
    if (runs.length === 0 || keys[i] !== currentKey) {
      currentKey = keys[i];
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

const fmt1 = (n: number) => n.toFixed(1);

interface RunColumn {
  key: string;
  machineNo: number;
  bottleId: string;
  jobId: string;
  bottleName: string;
  /** Hours (production-day order) belonging to this run. */
  times: Set<string>;
  avgWeight: number | null;
  avgSpeed: number | null;
}

const PRINT_HIDDEN_ATTR = 'data-dswr-print-hidden';

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

const releaseReportForPrint = (hidden: HTMLElement[]): void => {
  for (const el of hidden) el.removeAttribute(PRINT_HIDDEN_ATTR);
};

/**
 * Read-only hour-wise report for the selected production day. `date` is owned
 * by the Quality Module's Hourly Production Monitor controls; this report owns
 * no date state and renders no date buttons of its own.
 */
export const DailyMcSpeedWeightReport: React.FC<{ date: Date }> = ({ date }) => {
  const { machines, bottles } = useERP();
  const [hourly, setHourly] = useState<QualityDayHourly>({});
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const printAreaRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const dateKey = toIso(date);
  const dateLabel = toDisplay(date);
  const [dateDd, dateMm, dateYyyy] = dateLabel.split('-');

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

  useEffect(() => {
    void loadDay(dateKey);
    return () => {
      requestRef.current += 1;
    };
  }, [dateKey, loadDay]);

  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void loadDay(dateKey).finally(() => setRefreshing(false));
  }, [dateKey, loadDay, refreshing]);

  const handlePrint = useCallback(() => {
    const area = printAreaRef.current;
    if (!area) return;
    const hidden = isolateReportForPrint(area);
    const restore = () => {
      releaseReportForPrint(hidden);
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    try {
      window.print();
    } catch {
      restore();
    }
  }, []);

  const dayHourly: QualityDayHourly = loadedKey === dateKey ? hourly : EMPTY_DAY;

  // Dynamic column groups: one Weight/Speed pair per machine run. A machine
  // with no job change yields exactly one group, i.e. the plain
  // Machine N → Weight, Speed columns from the requirement.
  const columns = useMemo<RunColumn[]>(() => {
    const out: RunColumn[] = [];
    for (const machineNo of MACHINE_NOS) {
      const gob = machineGob(machineNo, machines);
      const byTime = dayHourly[String(machineNo)] ?? {};
      for (const run of splitMachineRuns(machineNo, byTime)) {
        let wSum = 0;
        let wCount = 0;
        let sSum = 0;
        let sCount = 0;
        const times = new Set<string>();
        for (const { slot, entry } of run.points) {
          times.add(slot.time);
          const w = hourlyWeight(entry, gob);
          if (w !== null) {
            wSum += w;
            wCount += 1;
          }
          const s = hourlySpeed(entry);
          if (s !== null) {
            sSum += s;
            sCount += 1;
          }
        }
        out.push({
          key: `${machineNo}-${run.runIndex}-${run.runKey || 'empty'}`,
          machineNo,
          bottleId: run.bottleId,
          jobId: run.jobId,
          bottleName: bottleNameFor(run.bottleId, bottles),
          times,
          avgWeight: wCount > 0 ? wSum / wCount : null,
          avgSpeed: sCount > 0 ? sSum / sCount : null,
        });
      }
    }
    return out;
  }, [dayHourly, machines, bottles]);

  const gobByMachine = useMemo(() => {
    const m: Record<number, number> = {};
    for (const n of MACHINE_NOS) m[n] = machineGob(n, machines);
    return m;
  }, [machines]);

  const hasData = columns.some((c) => c.times.size > 0);

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
    <div className="dswr-print-root" ref={printAreaRef} style={{ marginTop: '16px' }}>
      <style>{`
        .dswr-table tbody tr:hover td { background-color: #f8fafc; }
        .dswr-table tbody tr.dswr-total:hover td { background-color: #f0f4fa; }
        @media print {
          .dswr-table tbody tr:hover td { background-color: transparent; }
          .dswr-table tbody tr.dswr-total:hover td { background-color: #f0f4fa; }
          [${PRINT_HIDDEN_ATTR}] { display: none !important; }
          .dswr-print-root { margin-top: 0 !important; }
          .dswr-print-root .dswr-card { border: none !important; border-radius: 0 !important; box-shadow: none !important; }
          .dswr-print-root .dswr-table-scroll { overflow: visible !important; }
          .dswr-print-root .dswr-table { width: 100% !important; min-width: 0 !important; }
          .dswr-print-root .dswr-table th,
          .dswr-print-root .dswr-table td { padding: 2px 3px !important; font-size: 8px !important; line-height: 1.2 !important; white-space: normal !important; }
          .dswr-print-root .dswr-table thead { display: table-header-group; }
          .dswr-print-root .dswr-table tr { page-break-inside: avoid; page-break-after: auto; }
        }
      `}</style>

      <div
        className="dswr-card"
        style={{
          backgroundColor: C.white,
          border: `1px solid ${C.border}`,
          borderRadius: '10px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          overflow: 'hidden',
        }}
      >
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
              Daily M/C Speed and Weight Report
            </h2>
          </div>



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

        {loading && (
          <div style={{ padding: '6px 14px', fontSize: '12px', color: C.textMuted, borderBottom: `1px solid ${C.border}` }}>
            Loading speed and weight data for {dateLabel}…
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

        <div className="dswr-table-scroll" style={{ overflowX: 'auto' }}>
          <table className="dswr-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${120 + columns.length * 130}px` }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={3} style={{ ...thStyle(), width: '90px', borderBottom: `2px solid ${C.border}` }}>Time</th>
                {columns.map((c, i) => (
                  <th key={c.key} colSpan={2} style={{ ...(i === columns.length - 1 ? thStyle(true) : thStyle()), borderBottom: `1px solid ${C.border}` }}>
                    Machine {c.machineNo}
                  </th>
                ))}
              </tr>
              <tr style={{ backgroundColor: C.headerBg }}>
                {columns.map((c, i) => {
                  const last = i === columns.length - 1;
                  return (
                    <th
                      key={c.key}
                      colSpan={2}
                      title={c.bottleName || undefined}
                      style={{
                        ...(last ? thStyle(true) : thStyle()),
                        borderBottom: `1px solid ${C.border}`,
                        fontSize: '10.5px',
                        textTransform: 'none',
                        letterSpacing: '0',
                        maxWidth: '260px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.bottleName || '—'}
                      {c.jobId ? <span style={{ color: C.textMuted, fontWeight: 400 }}> ({c.jobId})</span> : null}
                    </th>
                  );
                })}
              </tr>
              <tr style={{ backgroundColor: C.headerBg }}>
                {columns.map((c, i) => (
                  <React.Fragment key={c.key}>
                    <th style={{ ...thStyle(), width: '65px', borderBottom: `2px solid ${C.border}` }}>Weight</th>
                    <th style={{ ...(i === columns.length - 1 ? thStyle(true) : thStyle()), width: '65px', borderBottom: `2px solid ${C.border}` }}>Speed</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {DISPLAY_TIMES.map((slot) => {
                const byTimeCache: Record<string, QualityHourlyEntry | undefined> = {};
                for (const n of MACHINE_NOS) {
                  byTimeCache[String(n)] = dayHourly[String(n)]?.[slot.time];
                }
                return (
                  <tr key={slot.time}>
                    <td style={{ ...td, fontWeight: 600 }}>{slot.time}</td>
                    {columns.map((c, i) => {
                      const isLastCol = i === columns.length - 1;
                      const inRun = c.times.has(slot.time);
                      const entry = inRun ? byTimeCache[String(c.machineNo)] : undefined;
                      const w = inRun ? hourlyWeight(entry, gobByMachine[c.machineNo]) : null;
                      const s = inRun ? hourlySpeed(entry) : null;
                      return (
                        <React.Fragment key={c.key}>
                          <td style={td}>{w !== null ? fmt1(w) : '—'}</td>
                          <td style={isLastCol ? tdLast : td}>{s !== null ? fmt1(s) : '—'}</td>
                        </React.Fragment>
                      );
                    })}
                  </tr>
                );
              })}
              <tr className="dswr-total" style={{ backgroundColor: '#f0f4fa', borderTop: `2px solid ${C.border}` }}>
                <td style={{ ...td, fontWeight: 700 }}>Daily Avg</td>
                {columns.map((c, i) => {
                  const isLastCol = i === columns.length - 1;
                  return (
                    <React.Fragment key={c.key}>
                      <td style={{ ...td, fontWeight: 700 }}>{c.avgWeight !== null ? fmt1(c.avgWeight) : '—'}</td>
                      <td style={{ ...(isLastCol ? tdLast : td), fontWeight: 700 }}>{c.avgSpeed !== null ? fmt1(c.avgSpeed) : '—'}</td>
                    </React.Fragment>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>

        {!loading && !loadError && !hasData && (
          <div style={{ padding: '8px 14px', fontSize: '12px', color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            No hourly speed / weight records found for {dateLabel}.
          </div>
        )}
      </div>
    </div>
  );
};

export default DailyMcSpeedWeightReport;
