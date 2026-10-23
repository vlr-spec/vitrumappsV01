import { QualityHourlyEntry } from '../services/qualityRepository';

// ═══════════════════════════════════════════════════════════════════════════
// Lehr Out timeline — hourly segment durations for the report.
//
// The Daily Production Performance Report's Shift I / II / III efficiencies
// average per-hour segment efficiencies whose expected units depend on each
// hour's REAL duration. That duration is not the plain (own − previous)/60
// schedule: the Hourly Production Monitor computes it from the Lehr Out
// timeline below — a shift-ending row keeps the Lehr Out minutes persisted in
// its saved period interval, the neighbouring hours start/end accordingly and
// the day's first row inherits the previous production day's third-shift
// carry-in. The report must read the exact same durations (rebuildable from
// the saved period_start / period_end labels alone, no previous-day lookups
// needed), otherwise its shift averages disagree with the monitor.
// ═══════════════════════════════════════════════════════════════════════════

const parseTimeLabelToMinutes = (label: string): number | null => {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(label);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (h < 1 || h > 12 || mins < 0 || mins > 59) return null;
  if (ap === 'AM') {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h += 12;
  }
  return h * 60 + mins;
};

const formatMinutesToLabel = (minsSinceMidnight: number): string => {
  const norm = ((minsSinceMidnight % 1440) + 1440) % 1440;
  const h24 = Math.floor(norm / 60);
  const mm = norm % 60;
  const ap = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
};

/** Minutes since the 9 AM production-day start (9 AM = 0 … 8:59 AM next day). */
const toTimelineMinutes = (label: string): number | null => {
  const mins = parseTimeLabelToMinutes(label);
  if (mins === null) return null;
  const nineAM = 9 * 60;
  return mins < nineAM ? mins + 24 * 60 - nineAM : mins - nineAM;
};

/** Formats a production-timeline minute value (9 AM = 0) as a clock label. */
const formatTimelineMinutes = (mins: number): string =>
  formatMinutesToLabel(mins + 9 * 60);

const LAYER_OUT_MIN_MINUTES = 0;
const LAYER_OUT_MAX_MINUTES = 119;

const SHIFT_BY_LAST_HOURLY_KEY: Record<string, number> = {
  '4:00 PM': 1,
  '12:00 AM': 2,
  '8:00 AM': 3,
};

export interface LayerOutSlot {
  start: string;
  end: string;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
}

type LayerOutValueMap = Record<number, number>;

/**
 * The ONE reusable timeline calculation. Starting from the ORIGINAL ordered
 * hourly/split keys it produces each row's actual [start, end] window:
 *
 *  - every row starts exactly when the previous row ends,
 *  - a shift-ending row lasts the entered Lehr Out minutes (0 = normal hour),
 *  - the next shift's first row starts at that adjusted end,
 *  - the previous production day's third-shift adjustment is carried into this
 *    day's first row (``carryInStartMinutes``),
 *  - a large Layer Out value (up to 119 min) may cross its own hour label but is
 *    clamped before the next key so no invalid/overlapping interval is created.
 */
export const buildLayerOutTimeline = (
  orderedKeys: string[],
  layerOut: LayerOutValueMap,
  carryInStartMinutes: number | null,
): Record<string, LayerOutSlot> => {
  const out: Record<string, LayerOutSlot> = {};
  if (orderedKeys.length === 0) return out;

  const firstKeyMinutes = toTimelineMinutes(orderedKeys[0]);
  // A carry-in from the previous day's final row sits in the morning part of
  // the timeline (e.g. 7:50 AM), i.e. numerically after this day's 9 AM key.
  // Shift this day's keys by one production day so the intervals stay ordered.
  const dayOffset =
    carryInStartMinutes !== null &&
    firstKeyMinutes !== null &&
    carryInStartMinutes > firstKeyMinutes
      ? 24 * 60
      : 0;

  let previousEnd: number | null = carryInStartMinutes;
  orderedKeys.forEach((key, index) => {
    const keyMinutes = toTimelineMinutes(key);
    if (keyMinutes === null) {
      const fallback = previousEnd ?? 0;
      out[key] = {
        start: key,
        end: key,
        startMinutes: fallback,
        endMinutes: fallback,
        durationMinutes: 0,
      };
      previousEnd = fallback;
      return;
    }

    const endPosition = keyMinutes + dayOffset;
    const startPosition =
      index === 0
        ? (previousEnd !== null ? previousEnd : endPosition - 60)
        : (previousEnd as number);

    let end = endPosition;
    const shiftId = SHIFT_BY_LAST_HOURLY_KEY[key];
    if (shiftId) {
      const layerMinutes = Math.max(
        LAYER_OUT_MIN_MINUTES,
        Math.min(LAYER_OUT_MAX_MINUTES, layerOut[shiftId] ?? 0),
      );
      if (layerMinutes > 0) {
        end = startPosition + layerMinutes;
        // Never run into the next row's own time key. In the normal schedule
        // LAYER_OUT_MAX_MINUTES keeps the end just before that key; this guard
        // only matters when a manual split sits after the shift-ending key.
        if (index + 1 < orderedKeys.length) {
          const nextMinutes = toTimelineMinutes(orderedKeys[index + 1]);
          if (nextMinutes !== null) {
            const nextPosition = nextMinutes + dayOffset;
            if (nextPosition <= end) {
              end = Math.max(startPosition, nextPosition - 1);
            }
          }
        }
      }
    }

    const durationMinutes = Math.max(0, end - startPosition);
    out[key] = {
      start: formatTimelineMinutes(startPosition),
      end: formatTimelineMinutes(end),
      startMinutes: startPosition,
      endMinutes: end,
      durationMinutes,
    };
    previousEnd = end;
  });

  return out;
};

/**
 * A saved row's real period duration (minutes) read back from the period
 * labels the backend re-emits for it (period_start / period_end — derived from
 * the duration the save embedded into the row's own production_time timestamp).
 * Null when the row carries no usable period. Labels that straddle midnight
 * or the 9 AM day start are repaired by one production-day forward step, the
 * same rule the save-side duration extraction uses.
 */
const layerOutDurationFromPeriod = (entry?: QualityHourlyEntry): number | null => {
  if (!entry?.period_start || !entry?.period_end) return null;
  const start = toTimelineMinutes(entry.period_start);
  const end = toTimelineMinutes(entry.period_end);
  if (start === null || end === null) return null;
  let diff = end - start;
  if (diff <= 0) diff += 24 * 60;
  if (diff <= 0 || diff >= 24 * 60) return null;
  return diff;
};

/**
 * Rebuilds the persisted Lehr Out values and the day's carry-in from the
 * periods the backend returned for a machine's loaded rows — the same rebuild
 * the Hourly Production Monitor performs when a date loads:
 *
 *  - perShift: each shift's saved Lehr Out value, read from its shift-ending
 *    row (4 PM / 12 AM / 8 AM). The row's real period duration IS the value;
 *    a row that covers exactly the default hour (previous key → own key,
 *    including rows where a following split shortens that default) means "no
 *    adjustment" and yields none. Durations beyond one Lehr Out range are
 *    ignored — they can only come from missing rows, never an entry.
 *  - carryMinutes: the previous production day's third-shift end, read from
 *    this day's FIRST row (its start label is exactly where the previous
 *    day's final row stopped; the previous day's 8 AM row runs from its 7 AM
 *    key, so the adjustment is start − 7:00 AM). Values 0 and 60 both mean
 *    "the previous hour ended exactly at the 8 AM key" and are equivalent —
 *    neither is reported.
 *
 * ``orderedKeys`` is the day's display keys in production-timeline order (the
 * caller's canonical ordering, e.g. the report's getReportOrderedKeys).
 */
export const layerOutInputsFromSavedPeriods = (
  rows: Record<string, QualityHourlyEntry>,
  orderedKeys: string[],
): { perShift: Record<number, number>; carryMinutes: number | null } => {
  const perShift: Record<number, number> = {};
  const zeroSlots = buildLayerOutTimeline(orderedKeys, { 1: 0, 2: 0, 3: 0 }, null);

  for (const [lastKey, shiftId] of Object.entries(SHIFT_BY_LAST_HOURLY_KEY)) {
    if (!rows[lastKey]) continue;
    const diff = layerOutDurationFromPeriod(rows[lastKey]);
    if (diff === null) continue;
    const defaultDuration = zeroSlots[lastKey]?.durationMinutes ?? 60;
    if (diff === defaultDuration || diff > LAYER_OUT_MAX_MINUTES) continue;
    perShift[shiftId] = diff;
  }

  let carryMinutes: number | null = null;
  const firstKey = orderedKeys[0];
  const firstRow = firstKey ? rows[firstKey] : undefined;
  if (firstRow?.period_start) {
    const pos = toTimelineMinutes(firstRow.period_start);
    const base = toTimelineMinutes('7:00 AM');
    if (pos !== null && base !== null) {
      const carry = ((pos - base) % (24 * 60) + 24 * 60) % (24 * 60);
      if (carry >= 1 && carry <= LAYER_OUT_MAX_MINUTES) {
        carryMinutes = carry;
      }
    }
  }
  return { perShift, carryMinutes };
};
