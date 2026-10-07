/**
 * AllMachineReport.tsx — Monthly All-Machine Production Performance Report.
 *
 * Shows a date-wise side-by-side comparison of all four machines for the
 * selected month. All calculations reuse the same logic and data sources as
 * the existing Daily Production Performance Report (QualityReport).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useERP } from '../../context/ERPContext';
import {
  qualityRepository,
  QualityDayHourly,
  QualityHourlyEntry,
  hasMeaningfulData,
} from '../../services/qualityRepository';
import { getGobCountFromDB, calculateTheoreticalBottles } from '../../utils/calculations';

const MACHINE_NOS = [1, 2, 3, 4];
const MAX_ROWS = 35;

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

const parseNum = (v?: string | null): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

const hourlyUnits = (e?: QualityHourlyEntry | null): number => {
  if (!e) return 0;
  const ps = parseInt(e.packing_size ?? '', 10);
  const ct = parseInt(e.cartons ?? '', 10);
  if (ps > 0 && ct > 0) return ps * ct;
  const stored = parseInt(e.bottles_in_nos ?? '', 10);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
};

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

const fmt3 = (n: number) => n.toFixed(3);
const fmtEff = (n: number | null) => (n === null ? '—' : n.toFixed(1));

interface JobDisplay {
  bottleName: string;
  avgSpeed: number;
}

interface MachineDayData {
  machineNo: number;
  jobs: JobDisplay[];
  draw: number;
  finish: number;
  percent: number | null;
}

interface DayRow {
  date: Date;
  dateKey: string;
  dateLabel: string;
  machines: MachineDayData[];
  totalDraw: number;
  totalFinish: number;
  totalPercent: number | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const AllMachineReport: React.FC<{ date: Date }> = ({ date }) => {
  const { machines, bottles } = useERP();
  const [dayData, setDayData] = useState<Record<string, QualityDayHourly>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(date.getMonth());
  const [selectedYear, setSelectedYear] = useState(date.getFullYear());

  const dateRange = useMemo(() => {
    const start = new Date(selectedYear, selectedMonth, 1);
    const end = new Date(selectedYear, selectedMonth + 1, 0);
    const dates: Date[] = [];
    const current = new Date(start);
    while (current <= end) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }, [selectedMonth, selectedYear]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const keys = dateRange.map(toIso);
    Promise.all(keys.map((key) => qualityRepository.load(key)))
      .then((results) => {
        if (cancelled) return;
        const data: Record<string, QualityDayHourly> = {};
        keys.forEach((key, i) => {
          data[key] = results[i].hourly;
        });
        setDayData(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load data');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dateRange]);

  const allRows = useMemo<DayRow[]>(() => {
    return dateRange.map((d) => {
      const key = toIso(d);
      const dayHourly = dayData[key] ?? {};

      const machineDataList = MACHINE_NOS.map((machineNo) => {
        const gob = machineGob(machineNo, machines);
        const byTime = dayHourly[String(machineNo)] ?? {};
        const runs = splitMachineRuns(machineNo, byTime);

        let totalDraw = 0;
        let totalFinish = 0;
        const jobDisplays: JobDisplay[] = [];

        for (const run of runs) {
          if (run.points.length === 0) continue;

          let runTheoretical = 0;
          let runUnits = 0;
          let runWeightSum = 0;
          let runWeightHours = 0;
          let runWeightedWeight = 0;
          let runWeightedUnits = 0;
          let runSpeedSum = 0;
          let runSpeedHours = 0;

          for (const { entry, durationHours } of run.points) {
            const units = hourlyUnits(entry);
            const speed = parseNum(entry.speed_per_min);
            const weight = hourlyWeight(entry, gob);
            // Duration-weighted theoretical production: a split hour's segments
            // sum to exactly the unsplit hour (1 for hourly rows).
            const theoretical = calculateTheoreticalBottles(speed, gob, durationHours);

            runTheoretical += theoretical;
            runUnits += units;

            if (weight !== null) {
              runWeightSum += weight * durationHours;
              runWeightHours += durationHours;
              if (units > 0) {
                runWeightedWeight += units * weight;
                runWeightedUnits += units;
              }
            }
            if (speed > 0) {
              runSpeedSum += speed * durationHours;
              runSpeedHours += durationHours;
            }
          }

          const runWeight =
            runWeightedUnits > 0
              ? runWeightedWeight / runWeightedUnits
              : runWeightHours > 0
                ? runWeightSum / runWeightHours
                : 0;

          totalDraw += (runWeight * runTheoretical) / 1_000_000;
          totalFinish += (runWeight * runUnits) / 1_000_000;

          const avgSpeed = runSpeedHours > 0 ? runSpeedSum / runSpeedHours : 0;
          const bName = bottleNameFor(run.bottleId, bottles);
          if (bName) {
            jobDisplays.push({ bottleName: bName, avgSpeed });
          }
        }

        const percent = totalDraw > 0 ? (totalFinish / totalDraw) * 100 : null;

        return {
          machineNo,
          jobs: jobDisplays,
          draw: totalDraw,
          finish: totalFinish,
          percent,
        };
      });

      const totalDraw = machineDataList.reduce((s, m) => s + m.draw, 0);
      const totalFinish = machineDataList.reduce((s, m) => s + m.finish, 0);
      const totalPercent = totalDraw > 0 ? (totalFinish / totalDraw) * 100 : null;

      return {
        date: d,
        dateKey: key,
        dateLabel: toDisplay(d),
        machines: machineDataList,
        totalDraw,
        totalFinish,
        totalPercent,
      };
    });
  }, [dateRange, dayData, machines, bottles]);

  const rows = allRows.slice(0, MAX_ROWS);

  const monthLabel = `${MONTH_NAMES[selectedMonth]} ${selectedYear}`;

  const handleMonthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (!val) return;
    const [y, m] = val.split('-').map(Number);
    if (y && m) {
      setSelectedYear(y);
      setSelectedMonth(m - 1);
    }
  };

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
    <div style={{ marginTop: '16px' }}>
      <div
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
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, textAlign: 'center' }}>
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#1e293b' }}>
              All Machine — Monthly Production Performance
            </h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: C.textMuted,
                whiteSpace: 'nowrap',
              }}
            >
              Month:
            </label>
            <input
              type="month"
              value={`${selectedYear}-${pad(selectedMonth + 1)}`}
              onChange={handleMonthChange}
              style={{
                border: '1px solid #cbd5e1',
                borderRadius: '4px',
                padding: '5px 10px',
                fontSize: '12.5px',
                fontWeight: 600,
                color: '#1e293b',
                backgroundColor: C.white,
                cursor: 'pointer',
                outline: 'none',
              }}
            />
          </div>
          
        </div>

        {loading && (
          <div style={{ padding: '6px 14px', fontSize: '12px', color: C.textMuted, borderBottom: `1px solid ${C.border}` }}>
            Loading production data for {monthLabel}…
          </div>
        )}
        {error && (
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
            Could not load data — {error}
          </div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1800px' }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={2} style={{ ...thStyle(), width: '80px', borderBottom: `2px solid ${C.border}` }}>Date</th>
                {MACHINE_NOS.map((m) => (
                  <th key={m} colSpan={4} style={{ ...thStyle(), borderBottom: `1px solid ${C.border}` }}>
                    Machine No.{m}
                  </th>
                ))}
                <th colSpan={3} style={{ ...thStyle(true), borderBottom: `1px solid ${C.border}` }}>Total</th>
              </tr>
              <tr style={{ backgroundColor: C.headerBg }}>
                {MACHINE_NOS.map((m) => (
                  <React.Fragment key={m}>
                    <th style={{ ...thStyle(), width: '140px', borderBottom: `2px solid ${C.border}` }}>Job Name</th>
                    <th style={{ ...thStyle(), width: '80px', borderBottom: `2px solid ${C.border}` }}>Draw</th>
                    <th style={{ ...thStyle(), width: '80px', borderBottom: `2px solid ${C.border}` }}>Finish</th>
                    <th style={{ ...thStyle(), width: '60px', borderBottom: `2px solid ${C.border}` }}>%</th>
                  </React.Fragment>
                ))}
                <th style={{ ...thStyle(), width: '80px', borderBottom: `2px solid ${C.border}` }}>Draw</th>
                <th style={{ ...thStyle(), width: '80px', borderBottom: `2px solid ${C.border}` }}>Finish</th>
                <th style={{ ...thStyle(true), width: '60px', borderBottom: `2px solid ${C.border}` }}>%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.dateKey}>
                  <td style={{ ...td, fontWeight: 600 }}>{row.dateLabel}</td>
                  {row.machines.map((m) => (
                    <React.Fragment key={m.machineNo}>
                      <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', minWidth: '140px', verticalAlign: 'top' }}>
                        {m.jobs.length > 0 ? (
                          m.jobs.map((j, idx) => (
                            <div key={idx} style={idx > 0 ? { marginTop: '8px' } : undefined}>
                              <div>{j.bottleName}</div>
                              {j.avgSpeed > 0 && (
                                <div style={{ fontSize: '10px', color: C.textMuted, marginTop: '2px' }}>
                                  Avg Speed: {j.avgSpeed.toFixed(1)}
                                </div>
                              )}
                            </div>
                          ))
                        ) : ''}
                      </td>
                      <td style={td}>{m.draw > 0 ? fmt3(m.draw) : '—'}</td>
                      <td style={td}>{m.finish > 0 ? fmt3(m.finish) : '—'}</td>
                      <td style={td}>{fmtEff(m.percent)}</td>
                    </React.Fragment>
                  ))}
                  <td style={{ ...td, fontWeight: 600 }}>{row.totalDraw > 0 ? fmt3(row.totalDraw) : '—'}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{row.totalFinish > 0 ? fmt3(row.totalFinish) : '—'}</td>
                  <td style={{ ...tdLast, fontWeight: 600 }}>{fmtEff(row.totalPercent)}</td>
                </tr>
              ))}
              <tr style={{ backgroundColor: '#f0f4fa', borderTop: `2px solid ${C.border}` }}>
                <td style={{ ...td, fontWeight: 700 }}>Total</td>
                {MACHINE_NOS.map((m) => {
                  const machineTotal = rows.reduce(
                    (acc, row) => {
                      const md = row.machines.find((x) => x.machineNo === m);
                      return {
                        draw: acc.draw + (md?.draw ?? 0),
                        finish: acc.finish + (md?.finish ?? 0),
                      };
                    },
                    { draw: 0, finish: 0 }
                  );
                  const percent = machineTotal.draw > 0 ? (machineTotal.finish / machineTotal.draw) * 100 : null;
                  return (
                    <React.Fragment key={m}>
                      <td style={td} />
                      <td style={{ ...td, fontWeight: 700 }}>{machineTotal.draw > 0 ? fmt3(machineTotal.draw) : '—'}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{machineTotal.finish > 0 ? fmt3(machineTotal.finish) : '—'}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{fmtEff(percent)}</td>
                    </React.Fragment>
                  );
                })}
                {(() => {
                  const grandDraw = rows.reduce((s, r) => s + r.totalDraw, 0);
                  const grandFinish = rows.reduce((s, r) => s + r.totalFinish, 0);
                  const grandPercent = grandDraw > 0 ? (grandFinish / grandDraw) * 100 : null;
                  return (
                    <>
                      <td style={{ ...td, fontWeight: 700 }}>{grandDraw > 0 ? fmt3(grandDraw) : '—'}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{grandFinish > 0 ? fmt3(grandFinish) : '—'}</td>
                      <td style={{ ...tdLast, fontWeight: 700 }}>{fmtEff(grandPercent)}</td>
                    </>
                  );
                })()}
              </tr>
            </tbody>
          </table>
        </div>

        {!loading && !error && rows.length === 0 && (
          <div style={{ padding: '8px 14px', fontSize: '12px', color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            No production data found for {monthLabel}.
          </div>
        )}
      </div>
    </div>
  );
};

export default AllMachineReport;
