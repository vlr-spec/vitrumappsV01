import React, { useEffect, useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import {
  repackingRepository,
  RepackingSqcQcHoldEntry,
  BottleNameItem,
} from '../../services/repackingRepository';

/**
 * Production Report Module — classic, print-friendly report sheets.
 *
 *   • Numbering Report   — static 17-column pallet-sorting register shell
 *   • SQC / QC HOLD (QA-F-10) — LIVE report built from the same saved entries
 *     the Quality Module's SQC/QC HOLD tab uses, via repackingRepository.
 *
 * No file outside this module is modified; the Quality Module keeps its own
 * behaviour and storage untouched.
 */

const MACHINE_NUMBERS = [1, 2, 3, 4] as const;
type MachineNo = (typeof MACHINE_NUMBERS)[number];
type MachineFilter = 'all' | MachineNo;

const NUMBERING_BOTTLE_ROWS = [0, 1, 2, 3, 4];
const NUMBERING_SHIFT_ROWS = ['1st Shift', '2nd Shift', '3rd Shift'];
const BIRD_SWING_ROWS = [1, 2, 3, 4];
const MIN_SQC_ROWS = 6;
const MIN_HOLD_ROWS = 4;

const ROMAN_SHIFT: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III' };

// ─── Date helpers (local calendar date, no timezone drift) ──────────────────
const pad2 = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
const shiftIso = (iso: string, days: number): string => {
  const d = fromIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
};
/** YYYY-MM-DD → DD.MM.YYYY (the format printed in the QA-F-10 header). */
const toDisplayDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d || '00'}.${m || '00'}.${y || '0000'}`;
};
const isValidIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

// ─── Small value helpers ────────────────────────────────────────────────────
const asNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const asText = (v: unknown): string => (v == null ? '' : String(v).trim());
const dedupe = (values: string[]): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = asText(raw);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.join(', ');
};
/** DEFECTS are saved as defect_ids and returned by the backend as names. */
const defectNamesOf = (entry: RepackingSqcQcHoldEntry): string[] => {
  if (Array.isArray(entry.defect_names) && entry.defect_names.length > 0) {
    return entry.defect_names.map((n) => asText(n)).filter(Boolean);
  }
  return asText(entry.defect_name)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
};
const hasDefect = (entry: RepackingSqcQcHoldEntry, needle: string): boolean =>
  defectNamesOf(entry).some((name) => name.toLowerCase().includes(needle.toLowerCase()));

// ─── Aggregated report row ──────────────────────────────────────────────────
interface SqcGroupRow {
  key: string;
  machineNo: MachineNo;
  jobName: string;
  shift: number;
  lotNo: string;
  pcsPerPack: number;
  packs: number;
  looseBottles: number;
  qty: number;
  reason: string;
  cav: string;
  sec: string;
  remarks: string;
}

interface BirdSwingRow {
  machineNo: MachineNo;
  totalBottles: number;
  info: string;
}

interface HoldRow {
  machineNo: MachineNo;
  jobName: string;
  lotNo: string;
  remarks: string;
  reasons: string;
}

const PRM_STYLES = `
.prm-root {
  padding: 20px 24px 32px;
  max-width: 1920px;
  margin: 0 auto;
  color: #0f172a;
  font-family: "Segoe UI", Arial, Helvetica, sans-serif;
  box-sizing: border-box;
}
.prm-root *, .prm-root *::before, .prm-root *::after { box-sizing: border-box; }

/* ── Tab state (CSS only — the report tabs are purely presentational) ───── */
.prm-radio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.prm-view { display: none; }
#prm-tab-numbering:checked ~ .prm-view--numbering { display: block; }
#prm-tab-sqc:checked ~ .prm-view--sqc { display: block; }

/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.prm-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 20px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.prm-tab-labels { display: flex; gap: 4px; padding: 3px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 9px; }
.prm-tab-label {
  cursor: pointer; padding: 7px 14px; border-radius: 6px; border: 1px solid transparent;
  font-size: 12.5px; font-weight: 600; line-height: 1.2; color: #475569;
  white-space: nowrap; user-select: none;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}
.prm-tab-label:hover { color: #1d4ed8; background: #e2e8f0; }
#prm-tab-numbering:checked ~ .prm-toolbar .prm-tab-label--numbering,
#prm-tab-sqc:checked ~ .prm-toolbar .prm-tab-label--sqc {
  background: #2563eb; border-color: #2563eb; color: #ffffff;
  box-shadow: 0 1px 3px rgba(37, 99, 235, 0.3);
}
#prm-tab-numbering:checked ~ .prm-toolbar .prm-tab-label--numbering:hover,
#prm-tab-sqc:checked ~ .prm-toolbar .prm-tab-label--sqc:hover { color: #ffffff; }

.prm-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
.prm-control-group { display: flex; align-items: center; gap: 8px; }
.prm-field-label { font-size: 11.5px; font-weight: 600; color: #475569; white-space: nowrap; }
.prm-input, .prm-select {
  height: 32px; padding: 0 9px; border: 1px solid #cbd5e1; border-radius: 7px;
  background: #ffffff; color: #0f172a; font-size: 12px; font-family: inherit; outline: none;
}
.prm-input:focus, .prm-select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.13); }
.prm-input[type="date"] { min-width: 152px; }
.prm-select { min-width: 138px; cursor: pointer; }
.prm-day-btn {
  height: 32px; padding: 0 10px; border: 1px solid #cbd5e1; border-radius: 7px;
  background: #ffffff; color: #334155; font-size: 11.5px; font-weight: 600;
  font-family: inherit; white-space: nowrap; cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.prm-day-btn:hover { background: #f1f5f9; border-color: #94a3b8; }
.prm-actions { margin-left: auto; display: flex; gap: 8px; }
.prm-action-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 14px; border-radius: 7px; font-size: 12px; font-weight: 700;
  font-family: inherit; white-space: nowrap; cursor: pointer;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.prm-action-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.prm-action-btn svg { width: 14px; height: 14px; }
.prm-action-btn--primary { background: #2563eb; color: #ffffff; border: 1px solid #2563eb; box-shadow: 0 1px 2px rgba(37, 99, 235, 0.25); }
.prm-action-btn--primary:hover:not(:disabled) { background: #1d4ed8; }
.prm-action-btn--outline { background: #ffffff; color: #1d4ed8; border: 1px solid #93c5fd; }
.prm-action-btn--outline:hover:not(:disabled) { background: #eff6ff; }

/* ── Sheet / captions ────────────────────────────────────────────────────── */
.prm-sheet {
  background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 22px 24px 26px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
}
.prm-sheet-caption {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
  gap: 8px 20px; margin-bottom: 9px; font-size: 12px; color: #1e293b;
}
.prm-sheet-caption-date { font-weight: 700; white-space: nowrap; }
.prm-status {
  font-size: 11px; font-weight: 600; color: #64748b;
  margin: 0 0 8px; padding: 5px 9px; border-radius: 6px; background: #f8fafc;
  border: 1px solid #e2e8f0;
}
.prm-status--error { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }

/* ── Classic bordered grid ───────────────────────────────────────────────── */
.prm-grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px; line-height: 1.25; color: #000000; }
.prm-grid th, .prm-grid td {
  border: 1px solid #000000; padding: 5px 4px; text-align: center; vertical-align: middle;
  overflow: hidden; word-break: break-word;
}
.prm-grid th { font-weight: 700; background: #f8fafc; }
.prm-grid-title {
  font-family: Georgia, "Times New Roman", serif; font-size: 16px; font-weight: 700;
  letter-spacing: 0.5px; padding: 9px 4px !important; background: #ffffff !important;
}
.prm-grid-group { font-weight: 700; }
.prm-mc-cell { font-weight: 700; background: #f8fafc; white-space: nowrap; }
.prm-name-cell { text-align: left !important; padding-left: 7px !important; }
.prm-shift-row { background: #f8fafc; }
.prm-shift-name { font-weight: 700; }
.prm-total-row td { font-weight: 700; background: #f8fafc; }
.prm-grid--sqc th { background: #dce6f1; }
.prm-grid--sqc .prm-grid-title, .prm-grid--sqc .prm-grid-subtitle { background: #dce6f1 !important; }
.prm-grid-subtitle { font-size: 11.5px; font-weight: 600; text-align: left !important; padding-left: 8px !important; }
.prm-grid-code { font-weight: 700; }
.prm-mc-cell--sqc { background: #dce6f1; }
.prm-muted-cell { color: #334155; }

/* ── Sub-tables on the SQC sheet ─────────────────────────────────────────── */
.prm-subtable { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 18px; font-size: 11px; color: #000000; }
.prm-subtable th, .prm-subtable td { border: 1px solid #000000; padding: 6px 8px; text-align: left; vertical-align: middle; }
.prm-subtable th { background: #dce6f1; font-weight: 700; }
.prm-subtable-center { text-align: center !important; }
.prm-subtable-note td { font-size: 10.5px; }
.prm-subtable-notes td { height: 30px; }
.prm-subtable-num { text-align: center !important; font-weight: 700; }

/* ── Signatures / distribution ───────────────────────────────────────────── */
.prm-signatures { display: flex; justify-content: space-between; gap: 24px; margin-top: 30px; }
.prm-signature { width: 180px; border-top: 1px solid #000000; padding-top: 6px; text-align: center; font-size: 11.5px; font-weight: 700; color: #000000; }
.prm-cc { margin-top: 22px; font-size: 10.5px; color: #334155; }

/* ── Print: only the QA-F-10 sheet, regardless of the selected tab ───────── */
@media print {
  @page { size: A4 landscape; margin: 8mm; }
  .prm-root { padding: 0 !important; max-width: none !important; margin: 0 !important; }
  .prm-toolbar, .prm-radio, .prm-status { display: none !important; }
  .prm-view--numbering { display: none !important; }
  .prm-view--sqc { display: block !important; }
  .prm-sheet { border: 0 !important; border-radius: 0 !important; box-shadow: none !important; padding: 0 !important; }
  .prm-sheet-caption { font-size: 10px !important; }
  .prm-grid { font-size: 8.5px !important; }
  .prm-subtable { font-size: 9px !important; }
  .prm-grid-title { font-size: 13px !important; }
  .prm-grid th, .prm-grid td, .prm-subtable th, .prm-subtable td {
    border-color: #000000 !important; padding-top: 2px !important; padding-bottom: 2px !important;
  }
  .prm-signatures { margin-top: 16px !important; }
  .prm-cc { margin-top: 12px !important; }
  .prm-grid tr, .prm-subtable tr { break-inside: avoid; page-break-inside: avoid; }
  .prm-root * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

/** Static placeholder tail of a Numbering data row (15 cells after M/c.). */
const NumberingTailCells: React.FC = () => (
  <>
    <td>0</td>
    <td>0</td><td>0</td>
    <td>0</td><td>0</td>
    <td>0</td><td>0</td>
    <td>0</td>
    <td>0</td>
    <td>0</td><td>0</td>
    <td>0</td><td>0</td>
    <td>0</td>
    <td>0</td>
  </>
);

// ─── Aggregation helpers ────────────────────────────────────────────────────

const bottleNameFor = (
  entry: RepackingSqcQcHoldEntry,
  lookup: Map<string, string>
): string => asText(entry.bottle_name) || lookup.get(String(entry.bottle_id ?? '')) || '';

/** Group saved SQC entries by machine + JOB NAME + SHIFT + LOT NO + PACK SIZE. */
const aggregateSqc = (
  entries: RepackingSqcQcHoldEntry[],
  lookup: Map<string, string>
): Map<MachineNo, SqcGroupRow[]> => {
  const byMachine = new Map<MachineNo, SqcGroupRow[]>();
  for (const m of MACHINE_NUMBERS) byMachine.set(m, []);

  for (const entry of entries) {
    const machineNo = asNum(entry.machine_no) as MachineNo;
    if (!byMachine.has(machineNo)) continue;
    const jobName = bottleNameFor(entry, lookup);
    const shift = asNum(entry.shift) || 1;
    const lotNo = asText(entry.lot_no);
    const pcsPerPack = asNum(entry.pcs_per_pack);
    const key = `${machineNo}|${jobName.toLowerCase()}|${shift}|${lotNo.toLowerCase()}|${pcsPerPack}`;

    const rows = byMachine.get(machineNo)!;
    let group = rows.find((r) => r.key === key);
    if (!group) {
      group = {
        key,
        machineNo,
        jobName,
        shift,
        lotNo,
        pcsPerPack,
        packs: 0,
        looseBottles: 0,
        qty: 0,
        reason: '',
        cav: '',
        sec: '',
        remarks: '',
      };
      rows.push(group);
    }
    group.packs += asNum(entry.cartons);
    group.looseBottles += asNum(entry.defective_bottles);
    group.reason = dedupe(
      group.reason ? [...group.reason.split(', '), ...defectNamesOf(entry)] : defectNamesOf(entry)
    );
    group.cav = dedupe(group.cav ? [...group.cav.split(', '), asText(entry.mould)] : [asText(entry.mould)]);
    group.sec = dedupe(
      group.sec ? [...group.sec.split(', '), asText(entry.section_no)] : [asText(entry.section_no)]
    );
    const remark = asText(entry.remarks) || asText(entry.qa_shift_ex_name);
    if (remark) group.remarks = group.remarks ? `${group.remarks} ${remark}` : remark;
  }

  for (const rows of byMachine.values()) {
    for (const row of rows) {
      row.qty = row.pcsPerPack * row.packs + row.looseBottles;
    }
  }
  return byMachine;
};

const aggregateBirdSwing = (
  entries: RepackingSqcQcHoldEntry[],
  lookup: Map<string, string>
): Map<MachineNo, BirdSwingRow> => {
  const result = new Map<MachineNo, BirdSwingRow>();
  for (const m of MACHINE_NUMBERS) {
    result.set(m, { machineNo: m, totalBottles: 0, info: '' });
  }
  for (const entry of entries) {
    if (!hasDefect(entry, 'bird swing')) continue;
    const machineNo = asNum(entry.machine_no) as MachineNo;
    const row = result.get(machineNo);
    if (!row) continue;
    row.totalBottles += asNum(entry.cartons) * asNum(entry.pcs_per_pack) + asNum(entry.defective_bottles);
    const mould = asText(entry.mould);
    row.info = dedupe([
      ...(row.info ? row.info.split(', ') : []),
      bottleNameFor(entry, lookup),
      mould ? `Mould ${mould}` : '',
    ]);
  }
  return result;
};

const collectHoldRows = (
  entries: RepackingSqcQcHoldEntry[],
  lookup: Map<string, string>
): HoldRow[] => {
  const rows: HoldRow[] = [];
  for (const entry of entries) {
    const remarks = asText(entry.remarks) || asText(entry.qa_shift_ex_name);
    const reasons = dedupe(defectNamesOf(entry));
    const isHold = reasons.toLowerCase().includes('qc hold') || reasons.toLowerCase().includes('qc-hold');
    if (!remarks && !isHold) continue;
    rows.push({
      machineNo: asNum(entry.machine_no) as MachineNo,
      jobName: bottleNameFor(entry, lookup),
      lotNo: asText(entry.lot_no),
      remarks,
      reasons,
    });
  }
  return rows;
};

// ─── Component ──────────────────────────────────────────────────────────────

export const ProductionReportModule: React.FC = () => {
  const [dateIso, setDateIso] = useState<string>(() => toIso(new Date()));
  const [machineFilter, setMachineFilter] = useState<MachineFilter>('all');
  const [entries, setEntries] = useState<RepackingSqcQcHoldEntry[]>([]);
  const [bottleNames, setBottleNames] = useState<BottleNameItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exporting, setExporting] = useState(false);

  // Same API source the Quality Module's SQC/QC HOLD tab reads from.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    repackingRepository
      .getRepackingData(dateIso)
      .then(({ sqc, bottleNames: names }) => {
        if (!active) return;
        setEntries(Array.isArray(sqc) ? sqc : []);
        setBottleNames(Array.isArray(names) ? names : []);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load SQC/QC HOLD report data:', err);
        setEntries([]);
        setLoadError('Could not load saved SQC/QC HOLD entries for this date.');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dateIso]);

  const bottleLookup = useMemo(
    () => new Map(bottleNames.map((b) => [String(b.bottle_id), asText(b.bottle_name)])),
    [bottleNames]
  );
  const groupedByMachine = useMemo(() => aggregateSqc(entries, bottleLookup), [entries, bottleLookup]);
  const birdSwingByMachine = useMemo(() => aggregateBirdSwing(entries, bottleLookup), [entries, bottleLookup]);
  const holdRows = useMemo(() => collectHoldRows(entries, bottleLookup), [entries, bottleLookup]);

  const visibleMachines = useMemo(
    () => (machineFilter === 'all' ? [...MACHINE_NUMBERS] : [machineFilter]),
    [machineFilter]
  );
  const visibleGroups = useMemo(
    () => visibleMachines.flatMap((m) => groupedByMachine.get(m) ?? []),
    [visibleMachines, groupedByMachine]
  );
  const grandTotalQty = useMemo(
    () => visibleGroups.reduce((sum, row) => sum + row.qty, 0),
    [visibleGroups]
  );
  const visibleHoldRows = useMemo(
    () => holdRows.filter((row) => machineFilter === 'all' || row.machineNo === machineFilter),
    [holdRows, machineFilter]
  );
  const dateLabel = isValidIso(dateIso) ? toDisplayDate(dateIso) : 'DD.MM.YYYY';

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const exceljsModule: any = await import('exceljs');
      const ExcelJS = exceljsModule.Workbook ? exceljsModule : exceljsModule.default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('SQC QC Hold');

      sheet.mergeCells('A1:J1');
      sheet.getCell('A1').value = 'REPORT OF NON CONFORMING MATERIALS';
      sheet.getCell('A1').font = { bold: true, size: 14, name: 'Times New Roman' };
      sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.getCell('K1').value = 'QA-F-10';
      sheet.getCell('K1').font = { bold: true };

      sheet.mergeCells('A2:J2');
      sheet.getCell('A2').value = 'Material kept aside for Resorting. ( SQC).';
      sheet.getCell('K2').value = dateLabel;
      sheet.getCell('K2').font = { bold: true };

      const headers = [
        'M/c.', 'Bottle Name', 'Shift', 'Lot #', 'Pcs / Pack', 'Packs',
        'Qty', 'Reason', 'Cav. #', 'Sec #', 'Remarks',
      ];
      const headerRow = sheet.addRow(headers);
      headerRow.font = { bold: true };
      headerRow.eachCell((cell: any) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });

      for (const machineNo of visibleMachines) {
        const rows = groupedByMachine.get(machineNo) ?? [];
        rows.forEach((row, idx) => {
          const packs = row.packs > 0 || row.qty > 0 ? row.packs : 0;
          const shift = row.packs > 0 || row.qty > 0 ? ROMAN_SHIFT[row.shift] || String(row.shift) : '';
          const sheetRow = sheet.addRow([
            idx === 0 ? `M/c. ${machineNo}` : '',
            row.jobName,
            shift,
            row.lotNo,
            row.pcsPerPack,
            packs,
            row.qty,
            row.reason,
            row.cav,
            row.sec,
            row.remarks,
          ]);
          sheetRow.eachCell((cell: any) => {
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
          });
        });
      }
      const totalRow = sheet.addRow(['', 'Total', '', '', '', '', grandTotalQty]);
      totalRow.font = { bold: true };

      sheet.addRow([]);
      const birdHeader = sheet.addRow(['Machinewise Bird Swing Report :', '', 'Total Bottles']);
      birdHeader.font = { bold: true };
      for (const no of BIRD_SWING_ROWS) {
        const m = no as MachineNo;
        const data = visibleMachines.includes(m) ? birdSwingByMachine.get(m) : undefined;
        sheet.addRow([no, data?.info ?? '', data?.totalBottles ?? 0]);
      }

      sheet.addRow([]);
      const holdHeader = sheet.addRow(['QC HOLD :']);
      holdHeader.font = { bold: true };
      visibleHoldRows.forEach((row, idx) => {
        sheet.addRow([`${idx + 1}. M/c. ${row.machineNo} ${row.jobName} ${row.lotNo} ${row.remarks} ${row.reasons}`.trim()]);
      });
      sheet.addRow(['Note : Amber colour of the bottle is within specification.']);

      sheet.columns = [
        { width: 10 }, { width: 22 }, { width: 8 }, { width: 12 }, { width: 11 },
        { width: 9 }, { width: 10 }, { width: 24 }, { width: 11 }, { width: 11 }, { width: 22 },
      ];

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SQC_Hold_Report_${dateLabel}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export SQC / QC HOLD report:', err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="prm-root">
      <style>{PRM_STYLES}</style>

      <input className="prm-radio" type="radio" name="prm-report-view" id="prm-tab-numbering" />
      <input className="prm-radio" type="radio" name="prm-report-view" id="prm-tab-sqc" defaultChecked />

      {/* ── Top control & filter bar ─────────────────────────────────────── */}
      <div className="prm-toolbar">
        <div className="prm-tab-labels" role="tablist" aria-label="Report view">
          <label className="prm-tab-label prm-tab-label--numbering" htmlFor="prm-tab-numbering">
            Numbering Report
          </label>
          <label className="prm-tab-label prm-tab-label--sqc" htmlFor="prm-tab-sqc">
            SQC / QC HOLD Report
          </label>
        </div>

        <div className="prm-controls">
          <div className="prm-control-group">
            <label className="prm-field-label" htmlFor="prm-report-date">Report Date</label>
            <input
              className="prm-input"
              id="prm-report-date"
              type="date"
              value={dateIso}
              onChange={(e) => {
                if (isValidIso(e.target.value)) setDateIso(e.target.value);
              }}
            />
          </div>
          <div className="prm-control-group">
            <button className="prm-day-btn" type="button" onClick={() => setDateIso((p) => shiftIso(p, -1))}>
              &lt; Previous Day
            </button>
            <button className="prm-day-btn" type="button" onClick={() => setDateIso(toIso(new Date()))}>
              Today
            </button>
            <button className="prm-day-btn" type="button" onClick={() => setDateIso((p) => shiftIso(p, 1))}>
              Next Day &gt;
            </button>
          </div>
          <div className="prm-control-group">
            <label className="prm-field-label" htmlFor="prm-machine">Machine</label>
            <select
              className="prm-select"
              id="prm-machine"
              value={machineFilter}
              onChange={(e) => setMachineFilter(e.target.value as MachineFilter)}
            >
              <option value="all">All Machines</option>
              {MACHINE_NUMBERS.map((m) => (
                <option key={m} value={m}>Machine {m}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="prm-actions">
          <button className="prm-action-btn prm-action-btn--primary" type="button" onClick={handleExport} disabled={exporting}>
            <Download /> {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
          <button className="prm-action-btn prm-action-btn--outline" type="button" onClick={() => window.print()}>
            <Printer /> Print PDF
          </button>
        </div>
      </div>

      {/* ── Layout 1 : Numbering Report (static shell) ───────────────────── */}
      <div className="prm-view prm-view--numbering">
        <div className="prm-sheet">
          <div className="prm-sheet-caption">
            <span>Please find below the Daily Report of Bottles kept aside for Pallet Sorting. ( Numbering).</span>
            <span className="prm-sheet-caption-date">Date : DD.MM.YYYY</span>
          </div>

          <table className="prm-grid">
            <colgroup>
              <col style={{ width: '5%' }} /><col style={{ width: '14%' }} /><col style={{ width: '5%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '6%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '5%' }} /><col style={{ width: '6%' }} /><col style={{ width: '5%' }} />
              <col style={{ width: '5%' }} /><col style={{ width: '5%' }} /><col style={{ width: '5%' }} />
              <col style={{ width: '4%' }} /><col style={{ width: '5%' }} />
            </colgroup>
            <thead>
              <tr><th className="prm-grid-title" colSpan={17}>NUMBERING REPORT</th></tr>
              <tr className="prm-grid-group">
                <th rowSpan={3}>M/c.</th><th rowSpan={3}>Bottle Name</th><th rowSpan={3}>Pcs</th>
                <th colSpan={6}>Shift wise ( Packets and Qty.)</th>
                <th rowSpan={3}>Total Qty.</th><th rowSpan={3}>Previous Balance Qty.</th>
                <th rowSpan={3}>Today OK Pack</th><th rowSpan={3}>Today OK Qty.</th>
                <th rowSpan={3}>Today Rej. Pack</th><th rowSpan={3}>Today Rej. Qty.</th>
                <th rowSpan={3}>%</th><th rowSpan={3}>Cumm. Balance Qty.</th>
              </tr>
              <tr className="prm-grid-group">
                <th colSpan={2}>I</th><th colSpan={2}>II</th><th colSpan={2}>III</th>
              </tr>
              <tr className="prm-grid-group">
                <th>Pack</th><th>Qty.</th><th>Pack</th><th>Qty.</th><th>Pack</th><th>Qty.</th>
              </tr>
            </thead>
            <tbody>
              {MACHINE_NUMBERS.map((machine) => (
                <React.Fragment key={`numbering-mc-${machine}`}>
                  {NUMBERING_BOTTLE_ROWS.map((row) => (
                    <tr key={`numbering-mc-${machine}-bottle-${row}`}>
                      {row === 0 ? <td className="prm-mc-cell" rowSpan={8}>M/c. {machine}</td> : null}
                      <td className="prm-name-cell">&nbsp;</td>
                      <NumberingTailCells />
                    </tr>
                  ))}
                  {NUMBERING_SHIFT_ROWS.map((shift) => (
                    <tr className="prm-shift-row" key={`numbering-mc-${machine}-${shift}`}>
                      <td className="prm-name-cell prm-shift-name">{shift}</td>
                      <NumberingTailCells />
                    </tr>
                  ))}
                </React.Fragment>
              ))}
              <tr className="prm-total-row">
                <td>&nbsp;</td><td className="prm-name-cell">Total</td><NumberingTailCells />
              </tr>
            </tbody>
          </table>

          <div className="prm-signatures">
            <div className="prm-signature">Q.A. Executive</div>
            <div className="prm-signature">HOD QA</div>
          </div>
          <div className="prm-cc">cc : Director / Design &amp; Dev. / Mould Workshop / Costing / Warehouse / Glass.</div>
        </div>
      </div>

      {/* ── Layout 2 : SQC / QC HOLD Report (QA-F-10) — live data ────────── */}
      <div className="prm-view prm-view--sqc">
        <div className="prm-sheet">
          {loading ? (
            <p className="prm-status">Loading saved SQC / QC HOLD entries…</p>
          ) : loadError ? (
            <p className="prm-status prm-status--error">{loadError}</p>
          ) : entries.length === 0 ? (
            <p className="prm-status">No saved SQC / QC HOLD entries for {dateLabel}.</p>
          ) : null}

          <table className="prm-grid prm-grid--sqc">
            <colgroup>
              <col style={{ width: '6%' }} /><col style={{ width: '14%' }} /><col style={{ width: '6%' }} />
              <col style={{ width: '9%' }} /><col style={{ width: '8%' }} /><col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} /><col style={{ width: '20%' }} /><col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} /><col style={{ width: '9%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="prm-grid-title" colSpan={10}>REPORT OF NON CONFORMING MATERIALS</th>
                <th className="prm-grid-code">QA-F-10</th>
              </tr>
              <tr>
                <th className="prm-grid-subtitle" colSpan={10}>Material kept aside for Resorting. ( SQC).</th>
                <th>{dateLabel}</th>
              </tr>
              <tr className="prm-grid-group">
                <th>M/c.</th><th>Bottle Name</th><th>Shift</th><th>Lot #</th><th>Pcs / Pack</th>
                <th>Packs</th><th>Qty</th><th>Reason</th><th>Cav. #</th><th>Sec #</th><th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {visibleMachines.map((machineNo) => {
                const rows = groupedByMachine.get(machineNo) ?? [];
                const blockRows = Math.max(MIN_SQC_ROWS, rows.length);
                return (
                  <React.Fragment key={`sqc-mc-${machineNo}`}>
                    {Array.from({ length: blockRows }, (_, idx) => {
                      const group = rows[idx];
                      const hasData = !!group && (group.packs > 0 || group.qty > 0);
                      return (
                        <tr key={`sqc-mc-${machineNo}-row-${idx}`}>
                          {idx === 0 ? (
                            <td className="prm-mc-cell prm-mc-cell--sqc" rowSpan={blockRows}>M/c. {machineNo}</td>
                          ) : null}
                          <td className="prm-name-cell">{group?.jobName || '\u00a0'}</td>
                          <td>{hasData ? ROMAN_SHIFT[group.shift] || String(group.shift) : '\u00a0'}</td>
                          <td>{group?.lotNo || '\u00a0'}</td>
                          <td>{group && group.pcsPerPack > 0 ? group.pcsPerPack : '\u00a0'}</td>
                          <td>{group && group.packs > 0 ? group.packs : '\u00a0'}</td>
                          <td>{group && group.qty > 0 ? group.qty : '\u00a0'}</td>
                          <td>{group?.reason || '\u00a0'}</td>
                          <td>{group?.cav || '\u00a0'}</td>
                          <td>{group?.sec || '\u00a0'}</td>
                          <td className="prm-name-cell">{group?.remarks || '\u00a0'}</td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
              <tr className="prm-total-row">
                <td className="prm-name-cell" colSpan={2}>Total</td>
                <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
                <td>{grandTotalQty}</td>
                <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
              </tr>
            </tbody>
          </table>

          {/* Sub-table 1 — Machinewise Bird Swing Report */}
          <table className="prm-subtable">
            <colgroup><col style={{ width: '10%' }} /><col style={{ width: '72%' }} /><col style={{ width: '18%' }} /></colgroup>
            <thead>
              <tr>
                <th colSpan={2}>Machinewise Bird Swing Report :</th>
                <th className="prm-subtable-center">Total Bottles</th>
              </tr>
            </thead>
            <tbody>
              {BIRD_SWING_ROWS.map((no) => {
                const m = no as MachineNo;
                const data = visibleMachines.includes(m) ? birdSwingByMachine.get(m) : undefined;
                return (
                  <tr key={`bird-swing-${no}`}>
                    <td className="prm-subtable-center">{no}</td>
                    <td className="prm-name-cell">{data?.info || '\u00a0'}</td>
                    <td className="prm-subtable-num">{data?.totalBottles || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Sub-table 2 — QC HOLD */}
          <table className="prm-subtable">
            <colgroup><col style={{ width: '100%' }} /></colgroup>
            <thead><tr><th>QC HOLD :</th></tr></thead>
            <tbody className="prm-subtable-notes">
              {Array.from({ length: Math.max(MIN_HOLD_ROWS, visibleHoldRows.length) }, (_, idx) => {
                const hold = visibleHoldRows[idx];
                const text = hold
                  ? `${idx + 1}. M/c. ${hold.machineNo} · ${hold.jobName}${hold.lotNo ? ` · Lot ${hold.lotNo}` : ''}${hold.reasons ? ` · ${hold.reasons}` : ''}${hold.remarks ? ` — ${hold.remarks}` : ''}`
                  : '\u00a0';
                return <tr key={`qc-hold-${idx}`}><td className="prm-name-cell">{text}</td></tr>;
              })}
              <tr className="prm-subtable-note">
                <td>Note : Amber colour of the bottle is within specification.</td>
              </tr>
            </tbody>
          </table>

          <div className="prm-signatures">
            <div className="prm-signature">Q.A. Executive</div>
            <div className="prm-signature">HOD QA</div>
          </div>
          <div className="prm-cc">cc : Director / Design &amp; Dev. / Mould Workshop / Costing / Warehouse / Glass.</div>
        </div>
      </div>
    </div>
  );
};
