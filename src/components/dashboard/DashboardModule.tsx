import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  Package,
  Percent,
  Printer,
  RefreshCw,
  Scale,
  ShoppingBag,
  Weight,
  type LucideIcon,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useERP } from '../../context/ERPContext';
import { planningRepository } from '../../services/planningRepository';
import {
  QualityDayHourly,
  QualityHourlyEntry,
  QualityJobRow,
  hasMeaningfulData,
  qualityRepository,
} from '../../services/qualityRepository';
import { calculateTheoreticalBottles, getGobCountFromDB } from '../../utils/calculations';

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
const DAY_MINUTES = 24 * 60;
const TIMELINE_TICKS = [0, 180, 360, 540, 720, 900, 1080, 1260, 1440];

const EMPTY_DAY: QualityDayHourly = {};

const C = {
  border: '#e2e8f0',
  headerBg: '#f8fafc',
  headerText: '#1e293b',
  textMain: '#1e293b',
  textMuted: '#64748b',
  white: '#ffffff',
};

const MACHINE_ROW_BG: Record<number, string> = {
  1: '#EFF6FF',
  2: '#F0FDF4',
  3: '#FFFBEB',
  4: '#F5F3FF',
};

const MACHINE_COLORS: Record<number, { main: string; light: string; seg: string }> = {
  1: { main: '#3B82F6', light: '#EFF6FF', seg: '#A7C7FA' },
  2: { main: '#22C55E', light: '#F0FDF4', seg: '#9CE5B7' },
  3: { main: '#F59E0B', light: '#FFFBEB', seg: '#FAD392' },
  4: { main: '#8B5CF6', light: '#F5F3FF', seg: '#CBD3FB' },
};

const PRINT_HIDDEN_ATTR = 'data-dash-print-hidden';

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

const calcUnitEfficiency = (actualUnits: number, expectedUnits: number): number | null => {
  const actual = Number(actualUnits);
  const expected = Number(expectedUnits);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  return (actual / expected) * 100;
};

const calcWeightEfficiency = (actualDraw: number, asPerSpeedDraw: number): number | null => {
  const actual = Number(actualDraw);
  const expected = Number(asPerSpeedDraw);
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || expected <= 0) return null;
  return (actual / expected) * 100;
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

const entryBottle = (e: QualityHourlyEntry | undefined): string => String(e?.bottle_id ?? '').trim();
const entryJob = (e: QualityHourlyEntry | undefined): string => String(e?.job_id ?? '').trim();

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

const toReportTimelineMinutes = (label: string): number | null => {
  const mins = parseReportLabelToMinutes(label);
  if (mins === null) return null;
  const nineAM = 9 * 60;
  return mins < nineAM ? mins + 24 * 60 - nineAM : mins - nineAM;
};

const fmtTimelineClock = (min: number): string => {
  const total = 9 * 60 + min;
  const h24 = Math.floor(total / 60) % 24;
  const mm = total % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${pad(mm)} ${suffix}`;
};

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

const fmtUnits = (n: number) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n: number) => n.toFixed(1);
const fmt3 = (n: number) => n.toFixed(3);
const fmtEff = (n: number | null) => (n === null ? '—' : n.toFixed(2));
const fmtSpeedShort = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const fmtDateSlash = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

const fmtTime12 = (d: Date): string => {
  const h = d.getHours();
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${h12}:${pad(d.getMinutes())} ${suffix}`;
};

const parseSlotDate = (dateKey: string, timeLabel: string): Date | null => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(timeLabel ?? '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  const [y, mo, d] = dateKey.split('-').map(Number);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d, h, parseInt(m[2], 10), 0, 0);
};

const overnightShift = (d: Date): Date => {
  if (d.getHours() >= 9) return d;
  const shifted = new Date(d.getTime());
  shifted.setDate(shifted.getDate() + 1);
  return shifted;
};

interface MachineReportRow {
  machineNo: number;
  rowKey: string;
  bottleName: string;
  packingName: string;
  weight: number;
  speed: number;
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

interface RunDetail extends MachineReportRow {
  jobId: string;
  hasPoints: boolean;
  startMin: number;
  endMin: number;
}

interface JobSourceRow {
  machineNo: number;
  jobId: string;
  bottleId: string;
  startDate: Date;
  startSort: Date;
  units: number;
  remark: string;
}

interface JobWiseRow {
  key: string;
  machineNo: number;
  bottleId: string;
  itemName: string;
  packingName: string;
  dateText: string;
  timeText: string;
  startSort: Date;
  units: number;
  remark: string;
}

interface TimelineSegment {
  key: string;
  machineNo: number;
  jobId: string;
  bottleName: string;
  packingName: string;
  startMin: number;
  endMin: number;
  startText: string;
  endText: string;
  durationMin: number;
  weight: number;
  speed: number;
  units: number;
  draw: number;
  eff: number | null;
}

const deriveJobSourcesFromDay = (dayHourly: QualityDayHourly, dateKey: string): JobSourceRow[] => {
  const out: JobSourceRow[] = [];
  for (const machineNo of MACHINE_NOS) {
    const byTime = dayHourly[String(machineNo)] ?? {};
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
      if (startDate && units > 0) {
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
      out.set(mapKey, i > 0 ? ordered[i - 1] : ordered[i]);
    }
  }
  return out;
};

const kfmt = (v: number): string => (v >= 1000 ? `${Math.round(v / 1000)}K` : String(v));

interface ChartTooltipEntry {
  name?: string;
  value?: number | null;
  color?: string;
}

const ChartTooltip = ({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string;
  format?: (v: number | null | undefined) => string;
}) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 12,
        color: '#1e293b',
        boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
        minWidth: 150,
      }}
    >
      {label && (
        <div style={{ fontWeight: 700, marginBottom: 4, color: '#0f172a' }}>{label}</div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: p.color ?? '#1e293b' }}>
          <span>{p.name}</span>
          <span style={{ fontWeight: 600 }}>{format ? format(p.value) : p.value ?? '—'}</span>
        </div>
      ))}
    </div>
  );
};

interface KpiDef {
  label: string;
  value: string;
  unit?: string;
  icon: LucideIcon;
  color: string;
  tint: string;
  valueColor: string;
}

export const DashboardModule: React.FC = () => {
  const { machines, bottles } = useERP();

  const [date, setDate] = useState<Date>(() => new Date());
  const [childNameByParent, setChildNameByParent] = useState<Map<string, string>>(() => new Map());
  const [hourly, setHourly] = useState<QualityDayHourly>({});
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [jobRows, setJobRows] = useState<QualityJobRow[]>([]);
  const [jobLoadedKey, setJobLoadedKey] = useState<string | null>(null);
  const [jobRowsOk, setJobRowsOk] = useState(false);
  const [remarkTip, setRemarkTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [segTip, setSegTip] = useState<{ seg: TimelineSegment; x: number; y: number } | null>(null);

  const printAreaRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const dateKey = toIso(date);
  const dateLabel = toDisplay(date);
  const [dateDd, dateMm, dateYyyy] = dateLabel.split('-');

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
      .catch(() => { /* packing names stay empty */ });
    return () => { cancelled = true; };
  }, []);

  const packingNameFor = useCallback((bottleId: string): string => {
    const id = String(bottleId ?? '').trim();
    return id ? (childNameByParent.get(id) ?? '') : '';
  }, [childNameByParent]);

  const loadDay = useCallback(async (targetKey: string) => {
    const token = (requestRef.current += 1);
    setLoading(true);
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

  useEffect(() => {
    if (!remarkTip && !segTip) return;
    const hide = () => {
      setRemarkTip(null);
      setSegTip(null);
    };
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [remarkTip, segTip]);

  const remarkTipFlip = remarkTip !== null && remarkTip.y + 240 > window.innerHeight;

  const dayHourly: QualityDayHourly = loadedKey === dateKey ? hourly : EMPTY_DAY;

  const machineRuns = useMemo<RunDetail[]>(() => {
    const out: RunDetail[] = [];
    for (const machineNo of MACHINE_NOS) {
      const gob = machineGob(machineNo, machines);
      const byTime = dayHourly[String(machineNo)] ?? {};
      const runs = splitMachineRuns(machineNo, byTime);
      runs.forEach((run, idx) => {
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
          const idx2 = slot.shift_id - 1;
          if (idx2 < 0 || idx2 > 2) continue;

          const theoretical = calculateTheoreticalBottles(speed, gob, durationHours);

          shiftUnits[idx2] += units;
          shiftTheoretical[idx2] += theoretical;
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

        const weight =
          weightedUnits > 0
            ? weightedWeight / weightedUnits
            : weightHours > 0
              ? weightSum / weightHours
              : 0;
        const speed = speedHours > 0 ? speedSum / speedHours : 0;

        const asPerSpeedDraw = (weight * theoreticalTotal) / 1_000_000;
        const actualDraw = (weight * totalUnits) / 1_000_000;

        const shiftEff = shiftUnits.map((u, i) => calcUnitEfficiency(u, shiftTheoretical[i]));
        const overallEff = calcUnitEfficiency(totalUnits, theoreticalTotal);

        const runtimeMinutes = Math.round(
          run.points.reduce(
            (sum, p) => (hourlyUnits(p.entry) > 0 ? sum + p.durationHours * 60 : sum),
            0
          )
        );

        let startMin = 0;
        let endMin = DAY_MINUTES;
        const first = run.points[0];
        const last = run.points[run.points.length - 1];
        if (first && last) {
          startMin = toReportTimelineMinutes(first.slot.time) ?? 0;
          const lastLabelMin = toReportTimelineMinutes(last.slot.time) ?? startMin;
          const rawEnd = lastLabelMin + last.durationHours * 60;
          const nextFirst = runs[idx + 1]?.points[0];
          const nextStart = nextFirst
            ? toReportTimelineMinutes(nextFirst.slot.time) ?? DAY_MINUTES
            : undefined;
          endMin = Math.min(
            nextStart ?? DAY_MINUTES,
            Math.max(startMin + 1, Math.min(DAY_MINUTES, rawEnd))
          );
        }

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
          jobId: run.jobId,
          hasPoints: run.points.length > 0,
          startMin,
          endMin,
        });
      });
    }
    return out;
  }, [dayHourly, machines, bottles, packingNameFor]);

  const rows = useMemo<MachineReportRow[]>(
    () =>
      machineRuns.map((r) => ({
        machineNo: r.machineNo,
        rowKey: r.rowKey,
        bottleName: r.bottleName,
        packingName: r.packingName,
        weight: r.weight,
        speed: r.speed,
        runtimeMinutes: r.runtimeMinutes,
        asPerSpeedUnits: r.asPerSpeedUnits,
        asPerSpeedDraw: r.asPerSpeedDraw,
        shiftUnits: r.shiftUnits,
        shiftTheoretical: r.shiftTheoretical,
        actualUnits: r.actualUnits,
        actualDraw: r.actualDraw,
        shiftEff: r.shiftEff,
        overallEff: r.overallEff,
      })),
    [machineRuns]
  );

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
    const shiftEff = [0, 1, 2].map((i) => calcUnitEfficiency(shiftUnits[i], shiftTheoretical[i]));
    const overallEff = calcUnitEfficiency(actualUnits, asPerSpeedUnits);
    return { shiftUnits, asPerSpeedUnits, asPerSpeedDraw, actualUnits, actualDraw, shiftEff, overallEff, runtimeMinutes };
  }, [rows]);

  const hasData = rows.some((r) => r.asPerSpeedUnits > 0 || r.actualUnits > 0);

  const weightEfficiency = calcWeightEfficiency(totals.actualDraw, totals.asPerSpeedDraw);

  const timeline = useMemo(
    () =>
      MACHINE_NOS.map((m) => {
        const runs = machineRuns.filter((r) => r.machineNo === m);
        const segments: TimelineSegment[] = [];
        const changes: { min: number; text: string }[] = [];
        runs.forEach((r) => {
          if (!r.hasPoints) return;
          segments.push({
            key: r.rowKey,
            machineNo: r.machineNo,
            jobId: r.jobId,
            bottleName: r.bottleName,
            packingName: r.packingName,
            startMin: r.startMin,
            endMin: r.endMin,
            startText: fmtTimelineClock(r.startMin),
            endText: fmtTimelineClock(r.endMin),
            durationMin: Math.max(0, r.endMin - r.startMin),
            weight: r.weight,
            speed: r.speed,
            units: r.actualUnits,
            draw: r.actualDraw,
            eff: r.overallEff,
          });
        });
        runs.forEach((r, idx) => {
          if (idx === 0 || !r.hasPoints) return;
          if (r.startMin > 0 && r.startMin < DAY_MINUTES) {
            changes.push({ min: r.startMin, text: fmtTimelineClock(r.startMin) });
          }
        });
        return { machineNo: m, segments, changes };
      }),
    [machineRuns]
  );

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
          dayJobKeys.has(`${row.machine_no}|${String(row.job_id ?? '').trim()}`)
        )
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

  const machineProdData = useMemo(
    () =>
      MACHINE_NOS.map((m) => {
        const rs = rows.filter((r) => r.machineNo === m);
        return {
          name: `M/C ${m}`,
          theoretical: rs.reduce((s, r) => s + r.asPerSpeedUnits, 0),
          actual: rs.reduce((s, r) => s + r.actualUnits, 0),
        };
      }),
    [rows]
  );

  const shiftData = useMemo(
    () =>
      [0, 1, 2].map((i) => ({
        name: `Shift - ${['I', 'II', 'III'][i]}`,
        units: totals.shiftUnits[i],
      })),
    [totals]
  );

  const machineEffData = useMemo(
    () =>
      MACHINE_NOS.map((m) => {
        const rs = rows.filter((r) => r.machineNo === m);
        const su = [0, 0, 0];
        const st = [0, 0, 0];
        let au = 0;
        let at = 0;
        rs.forEach((r) => {
          r.shiftUnits.forEach((u, i) => { su[i] += u; });
          r.shiftTheoretical.forEach((t, i) => { st[i] += t; });
          au += r.actualUnits;
          at += r.asPerSpeedUnits;
        });
        return {
          name: `M/C ${m}`,
          shift1: calcUnitEfficiency(su[0], st[0]),
          shift2: calcUnitEfficiency(su[1], st[1]),
          shift3: calcUnitEfficiency(su[2], st[2]),
          overall: calcUnitEfficiency(au, at),
        };
      }),
    [rows]
  );

  const kpis: KpiDef[] = [
    {
      label: 'Total Actual Units',
      value: loading ? '—' : fmtUnits(totals.actualUnits),
      unit: 'Units',
      icon: Package,
      color: '#2563EB',
      tint: '#EFF6FF',
      valueColor: '#1D4ED8',
    },
    {
      label: 'Actual Draw',
      value: loading ? '—' : fmt3(totals.actualDraw),
      unit: 'Tons',
      icon: Weight,
      color: '#7C3AED',
      tint: '#F5F3FF',
      valueColor: '#6D28D9',
    },
    {
      label: 'Overall Efficiency',
      value: loading || totals.overallEff === null ? '—' : `${totals.overallEff.toFixed(2)}%`,
      icon: Percent,
      color: '#16A34A',
      tint: '#F0FDF4',
      valueColor: '#15803D',
    },
    {
      label: 'Weight Efficiency',
      value: loading || weightEfficiency === null ? '—' : `${weightEfficiency.toFixed(2)}%`,
      icon: Scale,
      color: '#D97706',
      tint: '#FFFBEB',
      valueColor: '#B45309',
    },
    {
      label: 'Theoretical Units',
      value: loading ? '—' : fmtUnits(totals.asPerSpeedUnits),
      unit: 'Units',
      icon: BarChart3,
      color: '#2563EB',
      tint: '#EFF6FF',
      valueColor: '#1D4ED8',
    },
    {
      label: 'Theoretical Draw',
      value: loading ? '—' : fmt3(totals.asPerSpeedDraw),
      unit: 'Tons',
      icon: ShoppingBag,
      color: '#DB2777',
      tint: '#FDF2F8',
      valueColor: '#BE185D',
    },
  ];

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

  const segTipFlipX = segTip !== null && segTip.x + 340 > window.innerWidth;
  const segTipFlipY = segTip !== null && segTip.y + 280 > window.innerHeight;

  return (
    <div
      className="dash-print-root"
      ref={printAreaRef}
      style={{
        padding: '14px 18px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        printColorAdjust: 'exact',
      }}
    >
      <style>{`
        .dash-card {
          background-color: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          box-shadow: 0 1px 4px rgba(0,0,0,0.05);
          print-color-adjust: exact;
          -webkit-print-color-adjust: exact;
        }
        .dash-kpi-grid {
          display: grid;
          grid-template-columns: repeat(6, 1fr);
          gap: 12px;
        }
        .dash-kpi-card {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          min-width: 0;
        }
        .dash-kpi-icon {
          width: 38px;
          height: 38px;
          border-radius: 9px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .dash-kpi-label {
          font-size: 11px;
          font-weight: 500;
          color: #64748b;
          line-height: 1.25;
        }
        .dash-kpi-value {
          font-size: 21px;
          font-weight: 800;
          line-height: 1.15;
          white-space: nowrap;
        }
        .dash-kpi-unit {
          font-size: 10.5px;
          color: #94a3b8;
        }
        .dash-chart-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
        }
        .dash-chart {
          height: 250px;
          width: 100%;
        }
        .dash-table-scroll {
          overflow-x: auto;
        }
        .dash-table {
          width: 100%;
          border-collapse: collapse;
        }
        .dash-table tbody tr:not(.dash-total):hover td { background-color: #f8fafc; }
        .dash-table tbody tr.dash-total:hover td { background-color: #f0f4fa; }
        .dash-table tbody tr.dash-m1:hover td { background-color: #EFF6FF; }
        .dash-table tbody tr.dash-m2:hover td { background-color: #F0FDF4; }
        .dash-table tbody tr.dash-m3:hover td { background-color: #FFFBEB; }
        .dash-table tbody tr.dash-m4:hover td { background-color: #F5F3FF; }
        .dash-jobchange {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 96px;
          margin-left: -48px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1px;
          background: repeating-linear-gradient(45deg, #f8fafc 0 6px, #e2e8f0 6px 8px);
          border: 1px dashed #94a3b8;
          border-radius: 4px;
          z-index: 3;
          pointer-events: none;
          print-color-adjust: exact;
          -webkit-print-color-adjust: exact;
        }
        .dash-seg-label {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 8px;
          font-size: 11px;
          font-weight: 600;
          color: #1e293b;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          pointer-events: none;
        }
        .dash-seg {
          position: absolute;
          top: 0;
          bottom: 0;
          cursor: pointer;
          z-index: 1;
          transition: filter 0.12s;
        }
        .dash-seg:hover {
          filter: brightness(0.96);
          box-shadow: inset 0 0 0 2px rgba(30,41,59,0.35);
        }
        .dash-remark-text {
          display: block;
          white-space: normal;
          overflow-wrap: break-word;
        }
        .dash-remark-tip {
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
        .dash-seg-tip {
          position: fixed;
          width: 320px;
          max-width: 80vw;
          background: #ffffff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
          padding: 10px 12px;
          font-size: 12px;
          color: #1e293b;
          z-index: 9999;
          pointer-events: none;
        }
        .dash-seg-tip-row {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          line-height: 1.5;
        }
        .dash-seg-tip-row span:first-child { color: #64748b; }
        .dash-seg-tip-row span:last-child { font-weight: 600; text-align: right; }
        .dash-seg-tip-title {
          font-weight: 700;
          color: #0f172a;
          margin-bottom: 4px;
        }
        @media (max-width: 1280px) {
          .dash-kpi-grid { grid-template-columns: repeat(3, 1fr); }
        }
        @media (max-width: 640px) {
          .dash-kpi-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 1200px) {
          .dash-chart-grid { grid-template-columns: 1fr; }
        }
        @media print {
          .no-print { display: none !important; }
          [${PRINT_HIDDEN_ATTR}] { display: none !important; }
          .dash-print-root { padding: 0 !important; gap: 10px !important; }
          .dash-card { box-shadow: none !important; break-inside: avoid; }
          .dash-kpi-grid { grid-template-columns: repeat(6, 1fr) !important; gap: 6px !important; }
          .dash-chart { height: 210px !important; }
          .dash-chart-grid { grid-template-columns: repeat(3, 1fr) !important; gap: 8px !important; }
          .dash-table-scroll { overflow: visible !important; }
          .dash-table { width: 100% !important; min-width: 0 !important; table-layout: fixed !important; }
          .dash-table th, .dash-table td { padding: 1px 2px !important; font-size: 7px !important; line-height: 1.15 !important; white-space: normal !important; }
          .dash-table thead tr:first-child th { font-size: 6.5px !important; }
          .dash-table thead { display: table-header-group; }
          .dash-table tr { page-break-inside: avoid; }
          .dash-seg-label { font-size: 8px !important; }
          .dash-remark-tip, .dash-seg-tip { display: none !important; }
        }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 auto', minWidth: 240 }}>
          <BarChart3 size={22} color="#2563EB" />
          <h1 style={{ fontSize: 19, fontWeight: 800, color: '#0F172A', margin: 0, whiteSpace: 'nowrap' }}>
            Daily Production Performance Dashboard
          </h1>
        </div>
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
          <div
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              backgroundColor: '#ffffff',
              border: '1px solid #CBD5E1',
              borderRadius: 8,
              cursor: 'pointer',
            }}
            title="Select production date"
          >
            <CalendarDays size={15} color="#2563EB" />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E293B' }}>
              {dateDd}/{dateMm}/{dateYyyy}
            </span>
            <input
              type="date"
              value={dateKey}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const [y, m, d] = v.split('-').map(Number);
                if (y && m && d) setDate(new Date(y, m - 1, d));
              }}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%' }}
              aria-label="Production date"
            />
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Re-fetch the latest data for the selected date"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12.5,
              fontWeight: 500,
              color: '#2563EB',
              backgroundColor: '#EFF6FF',
              border: '1px solid #BFDBFE',
              borderRadius: 8,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={handlePrint}
            title="Print this dashboard"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              fontSize: 12.5,
              fontWeight: 500,
              color: '#1E293B',
              backgroundColor: '#ffffff',
              border: '1px solid #D1D5DB',
              borderRadius: 8,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <Printer size={14} />
            Print
          </button>
        </div>
      </div>

      {loading && (
        <div
          style={{
            padding: '6px 14px',
            fontSize: 12,
            color: C.textMuted,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            backgroundColor: '#ffffff',
          }}
        >
          Loading production data for {dateDd}/{dateMm}/{dateYyyy}…
        </div>
      )}
      {loadError && (
        <div
          style={{
            fontSize: 12,
            color: '#b91c1c',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            padding: '6px 10px',
          }}
        >
          Could not load saved data — {loadError} The dashboard may be out of date.
        </div>
      )}

      <div className="dash-kpi-grid">
        {kpis.map((k) => (
          <div key={k.label} className="dash-card dash-kpi-card">
            <div className="dash-kpi-icon" style={{ backgroundColor: k.tint, color: k.color }}>
              <k.icon size={20} strokeWidth={2} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="dash-kpi-label">{k.label}</div>
              <div className="dash-kpi-value" style={{ color: k.valueColor }}>{k.value}</div>
              {k.unit && <div className="dash-kpi-unit">{k.unit}</div>}
            </div>
          </div>
        ))}
      </div>

      <section className="dash-card" style={{ padding: '12px 14px' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>
          24-Hour Job Timeline (09:00 AM – 08:59 AM)
        </h3>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{ width: 40, flexShrink: 0 }} />
            <div style={{ position: 'relative', flex: 1, height: 16 }}>
              {TIMELINE_TICKS.map((t, i) => (
                <span
                  key={t}
                  style={{
                    position: 'absolute',
                    left: `${(t / DAY_MINUTES) * 100}%`,
                    transform:
                      i === 0
                        ? 'translateX(0)'
                        : i === TIMELINE_TICKS.length - 1
                          ? 'translateX(-100%)'
                          : 'translateX(-50%)',
                    fontSize: 10.5,
                    color: '#64748b',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtTimelineClock(t)}
                </span>
              ))}
            </div>
          </div>
          {timeline.map((row) => (
            <div key={row.machineNo} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              <div
                style={{
                  width: 40,
                  flexShrink: 0,
                  textAlign: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#ffffff',
                  backgroundColor: MACHINE_COLORS[row.machineNo].main,
                  borderRadius: 6,
                  padding: '3px 0',
                }}
              >
                M{row.machineNo}
              </div>
              <div
                style={{
                  position: 'relative',
                  flex: 1,
                  height: 38,
                  backgroundColor: '#F1F5F9',
                  border: '1px solid #E2E8F0',
                  borderRadius: 7,
                  overflow: 'hidden',
                }}
              >
                {TIMELINE_TICKS.slice(1, -1).map((t) => (
                  <div
                    key={t}
                    style={{
                      position: 'absolute',
                      left: `${(t / DAY_MINUTES) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: 1,
                      backgroundColor: '#E8EDF3',
                      zIndex: 0,
                    }}
                  />
                ))}
                {row.segments.length === 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: 12,
                      fontSize: 11,
                      color: '#94A3B8',
                    }}
                  >
                    No production records
                  </div>
                )}
                {row.segments.map((seg) => {
                  const pct = ((seg.endMin - seg.startMin) / DAY_MINUTES) * 100;
                  return (
                    <div
                      key={seg.key}
                      className="dash-seg"
                      style={{
                        left: `${(seg.startMin / DAY_MINUTES) * 100}%`,
                        width: `${pct}%`,
                        backgroundColor: MACHINE_COLORS[seg.machineNo].seg,
                        borderRight: '1px solid rgba(30,41,59,0.15)',
                      }}
                      onMouseEnter={(e) => setSegTip({ seg, x: e.clientX, y: e.clientY })}
                      onMouseMove={(e) => setSegTip({ seg, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setSegTip(null)}
                    >
                      {pct >= 7 && (
                        <div className="dash-seg-label">
                          {seg.bottleName || '—'}
                          {pct >= 9 && seg.speed > 0 ? `  (Speed: ${fmtSpeedShort(seg.speed)})` : ''}
                        </div>
                      )}
                    </div>
                  );
                })}
                {row.changes.map((c) => (
                  <div
                    key={c.min}
                    className="dash-jobchange"
                    style={{ left: `${(c.min / DAY_MINUTES) * 100}%` }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>Job Change</div>
                    <div style={{ fontSize: 10, color: '#475569', fontWeight: 600 }}>{c.text}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="dash-chart-grid">
        <section className="dash-card" style={{ padding: '12px 14px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>
            Machine-wise Production (Units)
          </h3>
          {hasData ? (
            <div className="dash-chart" style={{ printColorAdjust: 'exact' } as React.CSSProperties}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={machineProdData} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#EDF1F7" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={{ stroke: '#E2E8F0' }}
                  />
                  <YAxis
                    domain={[0, 800000]}
                    ticks={[0, 200000, 400000, 600000, 800000]}
                    tickFormatter={kfmt}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                    width={46}
                  />
                  <Tooltip
                    content={<ChartTooltip format={(v) => fmtUnits(Number(v ?? 0))} />}
                    cursor={{ fill: 'rgba(148,163,184,0.10)' }}
                  />
                  <Legend
                    iconType="rect"
                    iconSize={9}
                    verticalAlign="top"
                    align="right"
                    wrapperStyle={{ fontSize: 11, paddingBottom: 8 }}
                  />
                  <Bar
                    dataKey="theoretical"
                    name="As Per Speed (Theoretical)"
                    fill="#93C5FD"
                    radius={[3, 3, 0, 0]}
                    barSize={30}
                    isAnimationActive={false}
                  >
                    <LabelList
                      dataKey="theoretical"
                      position="top"
                      fontSize={10}
                      fill="#475569"
                      formatter={(v: unknown) => fmtUnits(Number(v))}
                    />
                  </Bar>
                  <Bar
                    dataKey="actual"
                    name="Actual Production"
                    fill="#1D4ED8"
                    radius={[3, 3, 0, 0]}
                    barSize={30}
                    isAnimationActive={false}
                  >
                    <LabelList
                      dataKey="actual"
                      position="top"
                      fontSize={10}
                      fill="#1E3A8A"
                      fontWeight={700}
                      formatter={(v: unknown) => fmtUnits(Number(v))}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div
              style={{
                height: 250,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94A3B8',
                fontSize: 13,
              }}
            >
              No production data for the selected date
            </div>
          )}
        </section>

        <section className="dash-card" style={{ padding: '12px 14px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>
            Shift-wise Actual Production (Units)
          </h3>
          {hasData ? (
            <div className="dash-chart" style={{ printColorAdjust: 'exact' } as React.CSSProperties}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={shiftData} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashShift1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7FB3E8" />
                      <stop offset="100%" stopColor="#4A90D9" />
                    </linearGradient>
                    <linearGradient id="dashShift2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3B7DD8" />
                      <stop offset="100%" stopColor="#2B5EA7" />
                    </linearGradient>
                    <linearGradient id="dashShift3" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2447A3" />
                      <stop offset="100%" stopColor="#1B3577" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#EDF1F7" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={{ stroke: '#E2E8F0' }}
                  />
                  <YAxis
                    domain={[0, 800000]}
                    ticks={[0, 200000, 400000, 600000, 800000]}
                    tickFormatter={kfmt}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                    width={46}
                  />
                  <Tooltip
                    content={<ChartTooltip format={(v) => fmtUnits(Number(v ?? 0))} />}
                    cursor={{ fill: 'rgba(148,163,184,0.10)' }}
                  />
                  <Bar
                    dataKey="units"
                    name="Actual Production"
                    radius={[3, 3, 0, 0]}
                    barSize={52}
                    isAnimationActive={false}
                  >
                    {shiftData.map((s, i) => (
                      <Cell key={s.name} fill={['url(#dashShift1)', 'url(#dashShift2)', 'url(#dashShift3)'][i]} />
                    ))}
                    <LabelList
                      dataKey="units"
                      position="top"
                      fontSize={11}
                      fill="#1E3A8A"
                      fontWeight={700}
                      formatter={(v: unknown) => fmtUnits(Number(v))}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div
              style={{
                height: 250,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94A3B8',
                fontSize: 13,
              }}
            >
              No production data for the selected date
            </div>
          )}
        </section>

        <section className="dash-card" style={{ padding: '12px 14px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>
            Machine-wise Efficiency (%)
          </h3>
          {hasData ? (
            <div className="dash-chart" style={{ printColorAdjust: 'exact' } as React.CSSProperties}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={machineEffData} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#EDF1F7" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    tickLine={false}
                    axisLine={{ stroke: '#E2E8F0' }}
                  />
                  <YAxis
                    domain={[0, 200]}
                    ticks={[0, 50, 100, 150, 200]}
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                    width={34}
                    unit="%"
                  />
                  <Tooltip
                    content={<ChartTooltip format={(v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2) + '%')} />}
                    cursor={{ fill: 'rgba(148,163,184,0.10)' }}
                  />
                  <Legend
                    iconType="rect"
                    iconSize={9}
                    verticalAlign="top"
                    align="right"
                    wrapperStyle={{ fontSize: 11, paddingBottom: 8 }}
                  />
                  <Bar dataKey="shift1" name="Shift - I" fill="#3B82F6" radius={[3, 3, 0, 0]} barSize={16} isAnimationActive={false}>
                    <LabelList
                      dataKey="shift1"
                      position="top"
                      fontSize={9.5}
                      fill="#475569"
                      formatter={(v: unknown) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))}
                    />
                  </Bar>
                  <Bar dataKey="shift2" name="Shift - II" fill="#22C55E" radius={[3, 3, 0, 0]} barSize={16} isAnimationActive={false}>
                    <LabelList
                      dataKey="shift2"
                      position="top"
                      fontSize={9.5}
                      fill="#475569"
                      formatter={(v: unknown) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))}
                    />
                  </Bar>
                  <Bar dataKey="shift3" name="Shift - III" fill="#F97316" radius={[3, 3, 0, 0]} barSize={16} isAnimationActive={false}>
                    <LabelList
                      dataKey="shift3"
                      position="top"
                      fontSize={9.5}
                      fill="#475569"
                      formatter={(v: unknown) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))}
                    />
                  </Bar>
                  <Bar dataKey="overall" name="Overall" fill="#1E3A8A" radius={[3, 3, 0, 0]} barSize={16} isAnimationActive={false}>
                    <LabelList
                      dataKey="overall"
                      position="top"
                      fontSize={9.5}
                      fill="#1E3A8A"
                      fontWeight={700}
                      formatter={(v: unknown) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div
              style={{
                height: 250,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#94A3B8',
                fontSize: 13,
              }}
            >
              No production data for the selected date
            </div>
          )}
        </section>
      </div>

      <section className="dash-card" style={{ padding: '12px 14px' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>
          Machine-wise Performance Details
        </h3>
        <div className="dash-table-scroll">
          <table className="dash-table" style={{ minWidth: '1520px' }}>
            <thead>
              <tr style={{ backgroundColor: C.headerBg }}>
                <th rowSpan={2} style={{ ...thStyle(), width: '54px', borderBottom: `2px solid ${C.border}` }}>M/C No</th>
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
                  className={`dash-m${r.machineNo}`}
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

              <tr className="dash-total" style={{ backgroundColor: '#f0f4fa', borderTop: `2px solid ${C.border}` }}>
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
          <div style={{ padding: '8px 14px', fontSize: 12, color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            No hourly HPR / Quality production records found for {dateLabel}.
          </div>
        )}
      </section>

      <section className="dash-card" style={{ padding: '12px 14px' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: 13.5, fontWeight: 700, color: '#1E293B' }}>
          Job-wise Production Summary
        </h3>

        {jobLoadedKey !== dateKey && !loadError && (
          <div style={{ padding: '8px 14px', fontSize: 12, color: C.textMuted }}>
            Loading job-wise data for {dateLabel}…
          </div>
        )}

        {jobLoadedKey === dateKey && jobWiseRows.length > 0 && (
          <div className="dash-table-scroll">
            <table className="dash-table" style={{ minWidth: '940px' }}>
              <thead>
                <tr style={{ backgroundColor: C.headerBg }}>
                  <th style={{ ...thStyle(), width: '64px', borderBottom: `2px solid ${C.border}` }}>M/C</th>
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
                          className="dash-remark-text"
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
          <div style={{ padding: '8px 14px', fontSize: 12, color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            No job records found for {dateLabel}.
          </div>
        )}
      </section>

      {remarkTip && (
        <div
          className="dash-remark-tip"
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

      {segTip && (
        <div
          className="dash-seg-tip"
          role="tooltip"
          style={{
            left: segTip.x,
            top: segTip.y,
            transform: `${segTipFlipX ? 'translate(calc(-100% - 16px), ' : 'translate(16px, '}${segTipFlipY ? 'calc(-100% - 16px)' : '0'})`,
          }}
        >
          <div className="dash-seg-tip-title">M/C {segTip.seg.machineNo}</div>
          <div className="dash-seg-tip-row"><span>Job ID</span><span>{segTip.seg.jobId || '—'}</span></div>
          <div className="dash-seg-tip-row"><span>Production Bottle</span><span>{segTip.seg.bottleName || '—'}</span></div>
          <div className="dash-seg-tip-row"><span>Packed Bottle</span><span>{segTip.seg.packingName || segTip.seg.bottleName || '—'}</span></div>
          <div className="dash-seg-tip-row"><span>Start Time</span><span>{segTip.seg.startText}</span></div>
          <div className="dash-seg-tip-row"><span>End Time</span><span>{segTip.seg.endText}</span></div>
          <div className="dash-seg-tip-row"><span>Duration</span><span>{segTip.seg.durationMin} min</span></div>
          <div className="dash-seg-tip-row"><span>Weight</span><span>{segTip.seg.weight > 0 ? fmt1(segTip.seg.weight) : '—'}</span></div>
          <div className="dash-seg-tip-row"><span>Speed</span><span>{segTip.seg.speed > 0 ? fmt1(segTip.seg.speed) : '—'}</span></div>
          <div className="dash-seg-tip-row"><span>Units</span><span>{fmtUnits(segTip.seg.units)}</span></div>
          <div className="dash-seg-tip-row"><span>Draw</span><span>{fmt3(segTip.seg.draw)}</span></div>
          <div className="dash-seg-tip-row"><span>Efficiency</span><span>{segTip.seg.eff === null ? '—' : `${segTip.seg.eff.toFixed(2)}%`}</span></div>
        </div>
      )}
    </div>
  );
};

export default DashboardModule;
