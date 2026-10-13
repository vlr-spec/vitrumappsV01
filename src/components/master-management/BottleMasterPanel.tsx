import React, { useState, useRef, useEffect, useMemo } from 'react';
import { FlaskConical, Search, Check, ChevronDown, Pencil } from 'lucide-react';
import { planningRepository } from '../../services/planningRepository';
import { MachineMasterRow, BottleMasterRow, BottleConfigurationRow } from '../../data/planningSchema';
import { useAuth, MODULES } from '../../context/AuthContext';
import { BottleExportPanel } from './BottleExportPanel';
import { ParentChildBottlePanel } from './ParentChildBottlePanel';

interface BottleMasterPanelProps {
  machines: MachineMasterRow[];
  bottles: BottleMasterRow[];
  configs: BottleConfigurationRow[];
  onRefresh: () => void;
}

interface SectionFormRow {
  section: number;
  speeds: string;
  isBase: boolean;
}

/** Tabs of the Bottle Master panel. 'export' is read-only. */
type BottleTab = 'new' | 'edit' | 'mapping' | 'export';

/** Parses a free-text numeric field into a number, or null when blank/invalid. */
function parseNumberInput(value: string): number | null {
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

export const BottleMasterPanel: React.FC<BottleMasterPanelProps> = ({
  machines,
  bottles,
  configs,
  onRefresh,
}) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission(MODULES.BOTTLE_MASTER, 'edit');
  const [tab, setTab] = useState<BottleTab>(canEdit ? 'new' : 'edit');

  // ── Add New tab ─────────────────────────────────────────────
  const [formBottleName, setFormBottleName] = useState('');
  const [addSaving, setAddSaving] = useState(false);
  const [addSaved, setAddSaved] = useState(false);

  // ── Rename Existing Bottle (inside Add New tab) ─────────────
  const [renameTargetId, setRenameTargetId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameSaved, setRenameSaved] = useState(false);
  const [renameDropOpen, setRenameDropOpen] = useState(false);
  const [renameQuery, setRenameQuery] = useState('');
  const renameDropRef = useRef<HTMLDivElement>(null);

  // ── Edit Machine › Section 1: Manage Configured Bottles ─────
  const [machineNo, setMachineNo] = useState<string>('');
  const [formRows, setFormRows] = useState<SectionFormRow[]>([]);
  const [formWeight, setFormWeight] = useState('');
  const [query, setQuery] = useState('');
  const [dropOpen, setDropOpen] = useState(false);
  const [selectedBase, setSelectedBase] = useState<BottleMasterRow | null>(null);
  const [overriddenSections, setOverriddenSections] = useState<Set<number>>(new Set());
  const dropRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [origSnapshot, setOrigSnapshot] = useState<{ weight: string; rows: SectionFormRow[] } | null>(null);

  // ── Edit Machine › Section 2: Add Bottle to This Machine ────
  const [allocTargetId, setAllocTargetId] = useState('');
  const [allocQuery, setAllocQuery] = useState('');
  const [allocDropOpen, setAllocDropOpen] = useState(false);
  const allocDropRef = useRef<HTMLDivElement>(null);
  // Pending allocation form opened after clicking "Add Bottle".
  const [allocPending, setAllocPending] = useState<BottleMasterRow | null>(null);
  const [allocWeight, setAllocWeight] = useState('');
  const [allocRows, setAllocRows] = useState<SectionFormRow[]>([]);
  const [allocOverridden, setAllocOverridden] = useState<Set<number>>(new Set());
  const [allocSaving, setAllocSaving] = useState(false);
  const [allocSaved, setAllocSaved] = useState(false);

  const selectedMachine = machines.find((m) => m.machine_no === machineNo) ?? null;

  const renameTarget = useMemo(
    () => bottles.find((b) => b.bottle_id === renameTargetId) ?? null,
    [bottles, renameTargetId]
  );

  useEffect(() => {
    if (!canEdit && tab !== 'edit' && tab !== 'export' && tab !== 'mapping') setTab('edit');
  }, [canEdit, tab]);

  // Load the current name of the chosen bottle into the rename box.
  // Keys off stored values so background refresh cannot wipe typing.
  useEffect(() => {
    setRenameValue(renameTarget ? renameTarget.bottle_name : '');
    if (renameTarget) setRenameSaved(false);
  }, [renameTargetId, renameTarget?.bottle_name]);

  // Machine-level sections from DB (unique sections across ALL bottles on this machine)
  const machineSections = useMemo(() => {
    if (!machineNo) return [];
    return planningRepository.getMachineSections(machineNo).sort((a, b) => b - a); // descending
  }, [machineNo, machines, configs]);

  const baseSections = useMemo(() => {
    if (!machineNo) return [];
    return planningRepository.getBaseSections(machineNo);
  }, [machineNo]);

  // Pre-index configs once so lookups are O(1).
  const configIndex = useMemo(() => {
    const byKey = new Map<string, BottleConfigurationRow>();
    const byMachineBottle = new Map<string, BottleConfigurationRow[]>();
    for (const c of configs) {
      byKey.set(`${c.machine_no}|${c.bottle_id}|${c.section}`, c);
      const mbKey = `${c.machine_no}|${c.bottle_id}`;
      const list = byMachineBottle.get(mbKey);
      if (list) list.push(c);
      else byMachineBottle.set(mbKey, [c]);
    }
    return { byKey, byMachineBottle };
  }, [configs]);

  /**
   * Machine-specific weight for the selected bottle on the selected machine.
   * Read ONLY from this machine's bottle_configuration rows — never from
   * bottle_master.weight and never from another machine.
   */
  const selectedWeight = useMemo<number | null>(() => {
    if (!selectedBase || !machineNo) return null;
    const existing = configIndex.byMachineBottle.get(`${machineNo}|${selectedBase.bottle_id}`) ?? [];
    const withWeight = existing.find((c) => c.weight > 0) ?? existing[0];
    return withWeight ? withWeight.weight : null;
  }, [selectedBase, machineNo, configIndex]);

  // bottle_ids with at least one configuration row on the selected machine.
  const machineBottleIds = useMemo(() => {
    const ids = new Set<string>();
    if (!machineNo) return ids;
    for (const c of configs) {
      if (c.machine_no === machineNo) ids.add(c.bottle_id);
    }
    return ids;
  }, [machineNo, configs]);

  // Section 1 picker: only bottles configured on the selected machine.
  const filteredConfigured = useMemo(
    () =>
      bottles
        .filter((b) => machineBottleIds.has(b.bottle_id))
        .filter(
          (b) =>
            b.bottle_name.toLowerCase().includes(query.toLowerCase()) ||
            b.bottle_id.toLowerCase().includes(query.toLowerCase())
        ),
    [bottles, machineBottleIds, query]
  );

  const sortedMachines = useMemo(
    () =>
      [...machines].sort((a, b) => {
        const numA = parseInt(a.machine_no.replace(/\D/g, ''), 10);
        const numB = parseInt(b.machine_no.replace(/\D/g, ''), 10);
        return numA - numB;
      }),
    [machines]
  );

  const sortedBottles = useMemo(
    () =>
      [...bottles].sort((a, b) =>
        a.bottle_name.localeCompare(b.bottle_name, undefined, { sensitivity: 'base' })
      ),
    [bottles]
  );

  const renameMatches = useMemo(() => {
    const q = renameQuery.trim().toLowerCase();
    if (!q) return sortedBottles;
    return sortedBottles.filter(
      (b) => b.bottle_name.toLowerCase().includes(q) || b.bottle_id.toLowerCase().includes(q)
    );
  }, [sortedBottles, renameQuery]);

  // Section 2 picker: master bottles NOT yet configured for this machine.
  // A bottle configured on another machine is still allocatable here.
  const allocAvailable = useMemo(() => {
    if (!machineNo) return [];
    return sortedBottles.filter((b) => !machineBottleIds.has(b.bottle_id));
  }, [sortedBottles, machineBottleIds, machineNo]);

  const allocMatches = useMemo(() => {
    const q = allocQuery.trim().toLowerCase();
    if (!q) return allocAvailable;
    return allocAvailable.filter(
      (b) => b.bottle_name.toLowerCase().includes(q) || b.bottle_id.toLowerCase().includes(q)
    );
  }, [allocAvailable, allocQuery]);

  const allocTarget = useMemo(
    () => bottles.find((b) => b.bottle_id === allocTargetId) ?? null,
    [bottles, allocTargetId]
  );

  // Rebuild Section 1 rows when machine + configured bottle are chosen.
  // Each machine shows and saves only its own configuration for that bottle.
  useEffect(() => {
    if (tab !== 'edit' || !selectedMachine || !selectedBase) {
      setFormRows([]);
      setOrigSnapshot(null);
      return;
    }
    const bottleId = selectedBase.bottle_id;
    const rows: SectionFormRow[] = machineSections.map((sec) => {
      const existing = configIndex.byKey.get(`${machineNo}|${bottleId}|${sec}`);
      const isBase = baseSections.includes(sec);
      return { section: sec, speeds: existing ? String(existing.speeds) : '', isBase };
    });
    setFormRows(rows);
    setFormWeight(selectedWeight !== null ? String(selectedWeight) : '');
    setOverriddenSections(new Set());
    setOrigSnapshot({ weight: selectedWeight !== null ? String(selectedWeight) : '', rows });
    setSaved(false);
  }, [tab, machineNo, selectedBase, configs, configIndex, machineSections, baseSections, selectedMachine, selectedWeight]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node;
      if (dropRef.current && !dropRef.current.contains(target)) setDropOpen(false);
      if (renameDropRef.current && !renameDropRef.current.contains(target)) setRenameDropOpen(false);
      if (allocDropRef.current && !allocDropRef.current.contains(target)) setAllocDropOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function switchTab(next: BottleTab) {
    setTab(next);
    setMachineNo('');
    setFormBottleName('');
    setAddSaved(false);
    setRenameTargetId('');
    setRenameValue('');
    setRenameSaved(false);
    setRenameDropOpen(false);
    setRenameQuery('');
    setFormRows([]);
    setFormWeight('');
    setQuery('');
    setDropOpen(false);
    setAllocTargetId('');
    setAllocQuery('');
    setAllocDropOpen(false);
    setAllocPending(null);
    setAllocWeight('');
    setAllocRows([]);
    setAllocOverridden(new Set());
    setAllocSaved(false);
    setSelectedBase(null);
    setOverriddenSections(new Set());
    setSaved(false);
    setOrigSnapshot(null);
  }

  function selectRenameTarget(bottleId: string) {
    setRenameTargetId(bottleId);
    const next = bottles.find((b) => b.bottle_id === bottleId) ?? null;
    setRenameValue(next ? next.bottle_name : '');
    setRenameSaved(false);
    setRenameDropOpen(false);
    setRenameQuery('');
  }

  // ── Add New: name only ──────────────────────────────────────
  async function handleCreateBottle() {
    if (!canEdit || addSaving) return;
    const name = formBottleName.trim();
    if (!name) {
      alert('Bottle name cannot be empty.');
      return;
    }
    const duplicate = bottles.some(
      (b) => b.bottle_name.trim().toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      alert('A bottle with this name already exists.');
      return;
    }
    setAddSaving(true);
    const result = await planningRepository.createBottle(name);
    setAddSaving(false);
    if (!result.ok) {
      alert(result.error || 'Failed to create bottle.');
      return;
    }
    setAddSaved(true);
    setTimeout(() => setAddSaved(false), 2500);
    setFormBottleName('');
    onRefresh();
  }

  // ── Rename: name only, ID and configs untouched ─────────────
  const renameNameDirty =
    !!renameTarget && renameValue.trim() !== '' && renameValue.trim() !== renameTarget.bottle_name;
  const canSaveRename = !!renameTarget && !renameSaving && renameNameDirty;

  async function handleRenameSave() {
    if (!canEdit || renameSaving || !renameTarget) return;
    const newName = renameValue.trim();
    if (!newName) {
      alert('Bottle name cannot be empty.');
      return;
    }
    if (newName === renameTarget.bottle_name) return;
    const duplicate = bottles.some(
      (b) => b.bottle_name.trim().toLowerCase() === newName.toLowerCase() && b.bottle_id !== renameTarget.bottle_id
    );
    if (duplicate) {
      alert('A bottle with this name already exists.');
      return;
    }
    const bottleIdInt = parseInt(renameTarget.bottle_id, 10);
    if (isNaN(bottleIdInt)) {
      alert('Invalid bottle ID.');
      return;
    }
    setRenameSaving(true);
    // Weight omitted: backend leaves bottle_master.weight untouched, and no
    // bottle_configuration row is sent, so machine configs are never modified.
    const result = await planningRepository.updateBottle(bottleIdInt, newName);
    setRenameSaving(false);
    if (!result.ok) {
      alert(result.error || 'Failed to update bottle name.');
      return;
    }
    setRenameSaved(true);
    setTimeout(() => setRenameSaved(false), 2500);
    onRefresh();
  }

  function changeMachine(next: string) {
    // Discard unsaved Section 1 + Section 2 state so nothing is ever saved
    // against the wrong machine.
    setMachineNo(next);
    setQuery('');
    setDropOpen(false);
    setAllocTargetId('');
    setAllocQuery('');
    setAllocDropOpen(false);
    setAllocPending(null);
    setAllocWeight('');
    setAllocRows([]);
    setAllocOverridden(new Set());
    setAllocSaved(false);
    setSelectedBase(null);
    setFormRows([]);
    setFormWeight('');
    setSaved(false);
    setOverriddenSections(new Set());
    setOrigSnapshot(null);
  }

  function selectBottle(b: BottleMasterRow) {
    setSelectedBase(b);
    setQuery('');
    setDropOpen(false);
    setFormWeight('');
    setOverriddenSections(new Set());
    setSaved(false);
    setOrigSnapshot(null);
  }

  function selectAllocTarget(bottleId: string) {
    setAllocTargetId(bottleId);
    setAllocSaved(false);
    setAllocDropOpen(false);
    setAllocQuery('');
  }

  /**
   * Opens the machine-specific configuration form for the chosen master bottle.
   * Nothing is written yet: weight and speeds start blank so no other
   * machine's weight is ever used as a default.
   */
  function handleOpenAllocForm() {
    if (!canEdit || !selectedMachine || !allocTarget) return;
    if (machineBottleIds.has(allocTarget.bottle_id)) {
      alert('This bottle is already configured on this machine.');
      setAllocTargetId('');
      return;
    }
    if (machineSections.length === 0) {
      alert('This machine has no sections to configure.');
      return;
    }
    setAllocPending(allocTarget);
    setAllocWeight('');
    setAllocRows(
      machineSections.map((sec) => ({
        section: sec,
        speeds: '',
        isBase: baseSections.includes(sec),
      }))
    );
    setAllocOverridden(new Set());
    setAllocSaved(false);
  }

  function cancelAllocForm() {
    setAllocPending(null);
    setAllocWeight('');
    setAllocRows([]);
    setAllocOverridden(new Set());
  }

  /**
   * Saves a newly allocated bottle to bottle_configuration only.
   * Uses the existing bottle_id — no bottle_master insert, no new ID, no
   * other machine touched. Backend upserts on (machine_no, bottle_id, section)
   * so duplicates cannot appear.
   */
  async function handleSaveAllocForm() {
    if (!canEdit || allocSaving || !selectedMachine || !allocPending) return;
    const weightNum = parseNumberInput(allocWeight);
    if (weightNum === null || weightNum <= 0) {
      alert('Weight must be a number greater than 0.');
      return;
    }
    const speedsParsed = allocRows.map((r) => ({ section: r.section, val: parseNumberInput(r.speeds) }));
    if (speedsParsed.length === 0) {
      alert('This machine has no sections to configure.');
      return;
    }
    const invalid = speedsParsed.find((s) => s.val === null || (s.val as number) <= 0);
    if (invalid) {
      alert(`Enter a cut speed greater than 0 for every section (missing: Section ${invalid.section}).`);
      return;
    }
    const machineInt = parseInt(selectedMachine.machine_no.replace(/\D/g, ''), 10);
    const bottleIdInt = parseInt(allocPending.bottle_id, 10);
    if (isNaN(machineInt) || isNaN(bottleIdInt)) {
      alert('Invalid machine or bottle.');
      return;
    }
    setAllocSaving(true);
    const result = await planningRepository.bulkUpsertBottleConfigurations(
      allocRows.map((r) => ({
        machine_no: machineInt,
        bottle_id: bottleIdInt,
        section: r.section,
        weight: weightNum,
        speeds: parseFloat(r.speeds),
      }))
    );
    setAllocSaving(false);
    if (!result.ok) {
      alert(result.error || 'Failed to save configuration.');
      return;
    }
    const savedBottle = allocPending;
    setAllocSaved(true);
    setTimeout(() => setAllocSaved(false), 2500);
    setAllocPending(null);
    setAllocWeight('');
    setAllocRows([]);
    setAllocOverridden(new Set());
    setAllocTargetId('');
    setAllocQuery('');
    onRefresh();
    // Show the new bottle in Configured Bottles right away.
    selectBottle(savedBottle);
  }

  function handleCancel() {
    if (!selectedBase || !origSnapshot) return;
    setFormWeight(origSnapshot.weight);
    setFormRows(origSnapshot.rows.map((r) => ({ ...r })));
    setOverriddenSections(new Set());
    setSaved(false);
  }

  // BPM auto-calculation for Section 1 form.
  function updateHighestBpm(value: string) {
    const numValue = parseFloat(value);
    setFormRows((prev) => {
      if (prev.length === 0) return prev;
      const highestSection = prev[0].section;
      return prev.map((r) => {
        if (r.section === highestSection) return { ...r, speeds: value };
        if (overriddenSections.has(r.section)) return r;
        if (!isNaN(numValue) && numValue > 0 && highestSection > 0) {
          const speedPerSection = numValue / highestSection;
          const calculated = speedPerSection * r.section;
          const rounded = Math.round(calculated * 100) / 100;
          return { ...r, speeds: String(rounded) };
        }
        return { ...r, speeds: '' };
      });
    });
    setSaved(false);
  }

  function updateSectionSpeed(section: number, value: string) {
    setFormRows((prev) => {
      if (prev.length === 0) return prev;
      const highestSection = prev[0].section;
      return prev.map((r) => {
        if (r.section === section) return { ...r, speeds: value };
        if (section === highestSection) {
          const numValue = parseFloat(value);
          if (overriddenSections.has(r.section)) return r;
          if (!isNaN(numValue) && numValue > 0 && highestSection > 0) {
            const speedPerSection = numValue / highestSection;
            const calculated = speedPerSection * r.section;
            const rounded = Math.round(calculated * 100) / 100;
            return { ...r, speeds: String(rounded) };
          }
          return { ...r, speeds: '' };
        }
        return r;
      });
    });
    const highestSection = formRows.length > 0 ? formRows[0].section : null;
    if (section !== highestSection) {
      setOverriddenSections((prev) => {
        const next = new Set(prev);
        const numVal = parseFloat(value);
        if (!isNaN(numVal) && numVal > 0) next.add(section);
        else next.delete(section);
        return next;
      });
    } else {
      setOverriddenSections((prev) => {
        const next = new Set(prev);
        next.delete(section);
        return next;
      });
    }
    setSaved(false);
  }

  // Same auto-calculation for the Section 2 allocation form.
  function updateAllocSectionSpeed(section: number, value: string) {
    setAllocRows((prev) => {
      if (prev.length === 0) return prev;
      const highestSection = prev[0].section;
      return prev.map((r) => {
        if (r.section === section) return { ...r, speeds: value };
        if (section === highestSection) {
          const numValue = parseFloat(value);
          if (allocOverridden.has(r.section)) return r;
          if (!isNaN(numValue) && numValue > 0 && highestSection > 0) {
            const speedPerSection = numValue / highestSection;
            const calculated = speedPerSection * r.section;
            const rounded = Math.round(calculated * 100) / 100;
            return { ...r, speeds: String(rounded) };
          }
          return { ...r, speeds: '' };
        }
        return r;
      });
    });
    const highestSection = allocRows.length > 0 ? allocRows[0].section : null;
    if (section !== highestSection) {
      setAllocOverridden((prev) => {
        const next = new Set(prev);
        const numVal = parseFloat(value);
        if (!isNaN(numVal) && numVal > 0) next.add(section);
        else next.delete(section);
        return next;
      });
    } else {
      setAllocOverridden((prev) => {
        const next = new Set(prev);
        next.delete(section);
        return next;
      });
    }
    setAllocSaved(false);
  }

  /**
   * Saves Section 1: this machine's weight + section speeds for the selected
   * bottle. Only (this machine, this bottle) rows are sent — the same bottle
   * on other machines is never touched, and bottle_master is never written.
   */
  async function handleSave() {
    if (!canEdit || saving) return;
    if (!selectedMachine || !selectedBase) return;
    const machineInt = parseInt(selectedMachine.machine_no.replace(/\D/g, ''), 10);
    const bottleIdInt = parseInt(selectedBase.bottle_id, 10);
    if (isNaN(machineInt) || isNaN(bottleIdInt)) {
      alert('Invalid machine or bottle.');
      return;
    }
    const weightNum = parseNumberInput(formWeight);
    if (weightNum === null || weightNum <= 0) {
      alert('Weight must be a number greater than 0.');
      return;
    }
    const rowsToSave = formRows
      .filter((row) => {
        const speeds = parseFloat(row.speeds);
        return !isNaN(speeds) && speeds > 0;
      })
      .map((row) => ({
        machine_no: machineInt,
        bottle_id: bottleIdInt,
        section: row.section,
        weight: weightNum,
        speeds: parseFloat(row.speeds),
      }));
    if (rowsToSave.length === 0) {
      alert('Enter a cut speed greater than 0 for at least one section.');
      return;
    }
    setSaving(true);
    const result = await planningRepository.bulkUpsertBottleConfigurations(rowsToSave);
    setSaving(false);
    if (!result.ok) {
      alert(result.error || 'Failed to save changes.');
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    onRefresh();
  }

  const isDirty =
    tab === 'edit' &&
    selectedBase !== null &&
    origSnapshot !== null &&
    (formWeight !== origSnapshot.weight ||
      formRows.some((r, i) => r.speeds !== origSnapshot.rows[i]?.speeds));

  const showForm = tab === 'edit' && selectedMachine !== null && selectedBase !== null && formRows.length > 0;

  const machineSelect = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Machine No.</label>
      <div className="relative">
        <select
          value={machineNo}
          onChange={(e) => changeMachine(e.target.value)}
          className="w-full h-10 px-3 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition appearance-none cursor-pointer pr-8"
        >
          <option value="">Select machine...</option>
          {sortedMachines.map((m) => (
            <option key={m.machine_no} value={m.machine_no}>
              Machine {m.machine_no.replace(/\D/g, '')} — {m.gob_type}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 opacity-60">
          <ChevronDown className="w-4 h-4" />
        </span>
      </div>
      {selectedMachine && machineSections.length > 0 && (
        <p className="text-[10px] text-gray-400">
          {machineSections.length} sections ({machineSections[machineSections.length - 1]}–{machineSections[0]})
        </p>
      )}
    </div>
  );

  const configuredPicker = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Configured Bottles</label>
      <div className="flex items-center gap-2">
        <div ref={dropRef} className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 z-10">
            <Search className="w-3.5 h-3.5" />
          </span>
          <button
            type="button"
            disabled={!machineNo}
            onClick={() => {
              setQuery('');
              setDropOpen((open) => !open);
            }}
            className={`w-full h-10 pl-7 pr-3 text-left text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${selectedBase
              ? 'font-medium text-gray-800 bg-white border-gray-200'
              : 'text-gray-400 bg-white border-gray-200'
              } ${!machineNo ? 'bg-gray-50 cursor-not-allowed' : ''}`}
          >
            {selectedBase
              ? selectedBase.bottle_name
              : machineNo
                ? 'Select or search bottle...'
                : 'Select machine first...'}
          </button>
          {dropOpen && (
            <div className="absolute z-20 top-11 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              <div className="p-2 border-b border-gray-100">
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="Search bottle name or ID..."
                  className="w-full h-8 px-2.5 text-sm border border-gray-200 rounded-md bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {filteredConfigured.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-gray-400">
                    {machineBottleIds.size === 0
                      ? 'No bottles configured for this machine yet. Use Add Bottle to This Machine below.'
                      : 'No bottles found.'}
                  </p>
                ) : (
                  filteredConfigured.map((b) => (
                    <div
                      key={b.bottle_id}
                      className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition ${b.bottle_id === selectedBase?.bottle_id ? 'bg-blue-50' : 'hover:bg-blue-50'
                        }`}
                      onMouseDown={() => selectBottle(b)}
                    >
                      <span className="text-xs font-medium text-gray-800">{b.bottle_name}</span>
                      <span className="text-[10px] text-gray-400 font-mono">{b.bottle_id}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const sectionSpeedsTable = (
    rows: SectionFormRow[],
    overridden: Set<number>,
    onChange: (section: number, value: string) => void
  ) => (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Section Speeds (CUT/MIN)
        </label>
        {machineSections.length > 0 && (
          <span className="text-[10px] text-gray-400 font-mono">
            {machineSections[machineSections.length - 1]}–{machineSections[0]} (descending)
          </span>
        )}
      </div>
      <div className="rounded-lg border border-gray-100 bg-gray-50 overflow-hidden">
        {rows.map((r, i) => {
          const isHighest = i === 0;
          const isOverridden = overridden.has(r.section);
          return (
            <div
              key={r.section}
              className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-gray-100' : ''}`}
            >
              <div className="w-7 h-7 rounded bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
                {r.section}
              </div>
              <span className="text-sm text-gray-600 font-medium min-w-17.5">
                Section {r.section}
              </span>
              <input
                type="number"
                step="0.01"
                placeholder={isHighest ? 'Enter highest CUT/MIN' : 'Auto-calculated'}
                value={r.speeds}
                onChange={(e) => onChange(r.section, e.target.value)}
                className={`flex-1 h-9 px-3 text-sm border rounded-md transition ${isOverridden
                  ? 'bg-amber-50 text-amber-800 border-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent'
                  : isHighest
                    ? 'bg-white text-gray-800 placeholder-gray-400 border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                    : 'bg-gray-50 text-gray-700 placeholder-gray-400 border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
                  }`}
              />
              <span className="text-xs text-gray-400 font-medium shrink-0">CUT/MIN</span>
              <div className="w-6 h-6 shrink-0" />
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 flex flex-col shadow-sm w-full">
      <div className="flex items-center gap-2.5 px-6 py-4 border-b border-gray-100">
        <span className="text-blue-600"><FlaskConical className="w-5 h-5" /></span>
        <h2 className="text-base font-semibold text-gray-800">Bottle Master</h2>
      </div>

      <div className="flex border-b border-gray-100 px-6">
        {canEdit &&
          (['new', 'edit'] as const).map((t) => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`py-3 px-0 mr-6 text-sm font-semibold border-b-2 -mb-px transition-colors ${tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
            >
              {t === 'new' ? 'Add/Edit Bottle' : 'Edit Machine'}
            </button>
          ))}
        <button
          onClick={() => switchTab('mapping')}
          className={`py-3 px-0 mr-6 text-sm font-semibold border-b-2 -mb-px transition-colors ${tab === 'mapping' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
        >
          Parent–Child Bottle
        </button>
        <button
          onClick={() => switchTab('export')}
          className={`py-3 px-0 mr-6 text-sm font-semibold border-b-2 -mb-px transition-colors ${tab === 'export' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
        >
          Export Bottle
        </button>
      </div>

      {tab === 'export' ? (
        <BottleExportPanel />
      ) : tab === 'new' ? (
        <div className="p-6 flex flex-col gap-5">
          {/* Add New Bottle — name only */}
          <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-gray-800">Add New Bottle</h3>
            <div className="flex flex-col gap-1.5 max-w-90">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Bottle Name</label>
              <input
                type="text"
                placeholder="e.g. Amber 500ml"
                value={formBottleName}
                onChange={(e) => {
                  setFormBottleName(e.target.value);
                  setAddSaved(false);
                }}
                className="w-full h-10 px-3 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              />
            </div>
            <p className="text-[11px] text-gray-400">
              Only the bottle name is saved. No machine configuration is created — allocate it to a machine in the Edit Machine tab.
            </p>
            {canEdit && (
              <div className="flex justify-end items-center gap-2">
                <button
                  onClick={handleCreateBottle}
                  disabled={!formBottleName.trim() || addSaving}
                  className={`flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium transition-all duration-200 ${addSaved
                    ? 'bg-green-50 text-green-600 border border-green-200'
                    : !formBottleName.trim() || addSaving
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}
                >
                  {addSaved ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Saved
                    </>
                  ) : addSaving ? (
                    'Saving...'
                  ) : (
                    'Save Bottle'
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Rename Existing Bottle — name only, ID preserved */}
          <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className="text-blue-600"><Pencil className="w-3.5 h-3.5" /></span>
              <h3 className="text-sm font-semibold text-gray-800">Edit Existing Bottle</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Select Existing Bottle
                </label>
                <div ref={renameDropRef} className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 z-10">
                    <Search className="w-3.5 h-3.5" />
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRenameQuery('');
                      setRenameDropOpen((open) => !open);
                    }}
                    className={`w-full h-10 pl-7 pr-3 text-left text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${renameTarget
                      ? 'font-medium text-gray-800 bg-white border-gray-200'
                      : 'text-gray-400 bg-white border-gray-200'
                      }`}
                  >
                    {renameTarget ? renameTarget.bottle_name : 'Select or search bottle...'}
                  </button>
                  {renameDropOpen && (
                    <div className="absolute z-20 top-11 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                      <div className="p-2 border-b border-gray-100">
                        <input
                          type="text"
                          autoFocus
                          value={renameQuery}
                          onChange={(e) => setRenameQuery(e.target.value)}
                          placeholder="Search bottle name or ID..."
                          className="w-full h-8 px-2.5 text-sm border border-gray-200 rounded-md bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                        />
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {renameMatches.length === 0 ? (
                          <p className="px-3 py-3 text-xs text-gray-400">No bottles found.</p>
                        ) : (
                          renameMatches.map((b) => (
                            <div
                              key={b.bottle_id}
                              className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition ${b.bottle_id === renameTargetId ? 'bg-blue-50' : 'hover:bg-blue-50'
                                }`}
                              onMouseDown={() => selectRenameTarget(b.bottle_id)}
                            >
                              <span className="text-xs font-medium text-gray-800">{b.bottle_name}</span>
                              <span className="text-[10px] text-gray-400 font-mono">{b.bottle_id}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  New Bottle Name
                </label>
                <input
                  type="text"
                  placeholder={renameTarget ? renameTarget.bottle_name : 'Select a bottle to rename'}
                  value={renameValue}
                  disabled={!renameTarget}
                  onChange={(e) => {
                    setRenameValue(e.target.value);
                    setRenameSaved(false);
                  }}
                  className="w-full h-10 px-3 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
                />
                <p className="text-[10px] text-gray-400">
                  {renameTarget
                    ? `Only the name is updated. Bottle ID ${renameTarget.bottle_id} and its machine configurations stay the same.`
                    : 'Pick an existing bottle to load its current name.'}
                </p>
              </div>
            </div>
            {canEdit && (
              <div className="flex justify-end items-center gap-2">
                <button
                  onClick={handleRenameSave}
                  disabled={!canSaveRename}
                  className={`flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium transition-all duration-200 ${renameSaved
                    ? 'bg-green-50 text-green-600 border border-green-200'
                    : !canSaveRename
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}
                >
                  {renameSaved ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Saved
                    </>
                  ) : renameSaving ? (
                    'Saving...'
                  ) : (
                    'Save Name'
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : tab === 'mapping' ? (
        <ParentChildBottlePanel bottles={bottles} canEdit={canEdit} />
      ) : (
        <div className="p-6 flex flex-col gap-6">
          {/* Section 1: Manage Configured Bottles */}
          <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-5">
            <h3 className="text-sm font-semibold text-gray-800">Manage Configured Bottles</h3>
            <div className={`grid grid-cols-1 gap-5 ${selectedMachine ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
              {machineSelect}
              {selectedMachine && configuredPicker}
              {selectedMachine && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Weight (Grams)
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 450"
                      value={formWeight}
                      disabled={!selectedBase}
                      onChange={(e) => {
                        setFormWeight(e.target.value);
                        setSaved(false);
                      }}
                      className="w-full h-10 px-3 pr-8 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:bg-gray-50 disabled:cursor-not-allowed"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">g</span>
                  </div>
                  <p className="text-[10px] text-gray-400">
                    {selectedBase
                      ? `Machine-specific: only Machine ${selectedMachine.machine_no.replace(/\D/g, '')} is updated.`
                      : 'Select a configured bottle to load its weight.'}
                  </p>
                </div>
              )}
            </div>

            {!selectedMachine && (
              <p className="text-[11px] text-gray-400">
                Select a machine to manage its configured bottles.
              </p>
            )}

            {selectedMachine && machineBottleIds.size === 0 && (
              <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-3">
                No bottles are configured for this machine yet. Use the Add Bottle to This Machine section below to allocate one.
              </p>
            )}

            {selectedMachine && selectedBase && (
              <p className="text-[11px] text-gray-500">
                Bottle ID: <span className="font-mono font-semibold text-gray-700">{selectedBase.bottle_id}</span>
                {' '}· Machine: <span className="font-semibold text-gray-700">Machine {selectedMachine.machine_no.replace(/\D/g, '')}</span>
              </p>
            )}

            {showForm && canEdit && sectionSpeedsTable(formRows, overriddenSections, updateSectionSpeed)}

            {selectedMachine && selectedBase && !showForm && (
              <p className="text-[11px] text-gray-400">Loading sections…</p>
            )}

            {canEdit && showForm && (
              <div className="flex justify-end items-center gap-2">
                {isDirty && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 hover:text-gray-800 transition-all duration-200"
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !selectedBase}
                  className={`flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium transition-all duration-200 ${saved
                    ? 'bg-green-50 text-green-600 border border-green-200'
                    : saving || !selectedBase
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                    }`}
                >
                  {saved ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Saved
                    </>
                  ) : saving ? (
                    'Saving...'
                  ) : (
                    'Save Changes'
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Section 2: Add Bottle to This Machine */}
          <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-5">
            <h3 className="text-sm font-semibold text-gray-800">Add Bottle to This Machine</h3>
            {!selectedMachine ? (
              <p className="text-[11px] text-gray-400">
                Select a machine above to allocate a bottle from the master list.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Select Bottle from Master
                  </label>
                  <div className="flex items-center gap-2">
                    <div ref={allocDropRef} className="relative flex-1">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 z-10">
                        <Search className="w-3.5 h-3.5" />
                      </span>
                      <button
                        type="button"
                        disabled={!!allocPending}
                        onClick={() => {
                          setAllocQuery('');
                          setAllocDropOpen((open) => !open);
                        }}
                        className={`w-full h-10 pl-7 pr-3 text-left text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${allocTarget && !allocPending
                          ? 'font-medium text-gray-800 bg-white border-gray-200'
                          : 'text-gray-400 bg-white border-gray-200'
                          } ${allocPending ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                      >
                        {allocPending
                          ? allocPending.bottle_name
                          : allocTarget
                            ? allocTarget.bottle_name
                            : 'Select or search master bottle...'}
                      </button>
                      {allocDropOpen && !allocPending && (
                        <div className="absolute z-20 top-11 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                          <div className="p-2 border-b border-gray-100">
                            <input
                              type="text"
                              autoFocus
                              value={allocQuery}
                              onChange={(e) => setAllocQuery(e.target.value)}
                              placeholder="Search bottle name or ID..."
                              className="w-full h-8 px-2.5 text-sm border border-gray-200 rounded-md bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                            />
                          </div>
                          <div className="max-h-48 overflow-y-auto">
                            {allocMatches.length === 0 ? (
                              <p className="px-3 py-3 text-xs text-gray-400">
                                {allocAvailable.length === 0
                                  ? 'Every master bottle is already configured on this machine.'
                                  : 'No bottles found.'}
                              </p>
                            ) : (
                              allocMatches.map((b) => (
                                <div
                                  key={b.bottle_id}
                                  className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition ${b.bottle_id === allocTargetId ? 'bg-blue-50' : 'hover:bg-blue-50'
                                    }`}
                                  onMouseDown={() => selectAllocTarget(b.bottle_id)}
                                >
                                  <span className="text-xs font-medium text-gray-800">{b.bottle_name}</span>
                                  <span className="text-[10px] text-gray-400 font-mono">{b.bottle_id}</span>
                                </div>
                              ))
                            )}
                          </div>
                          <div className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">
                            {allocAvailable.length} bottle{allocAvailable.length === 1 ? '' : 's'} not yet on this machine
                          </div>
                        </div>
                      )}
                    </div>
                    {!allocPending && (
                      <button
                        type="button"
                        onClick={handleOpenAllocForm}
                        disabled={!allocTarget}
                        className={`flex items-center gap-1.5 px-5 h-10 rounded-lg text-sm font-medium transition-all duration-200 shrink-0 ${!allocTarget
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                          }`}
                      >
                        Add Bottle
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-400">
                    Only bottles not yet configured for Machine {selectedMachine.machine_no.replace(/\D/g, '')} are listed. A bottle on another machine can still be added here.
                  </p>
                </div>

                {allocPending && (
                  <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-4 flex flex-col gap-4">
                    <p className="text-[12px] text-gray-700">
                      Configuring <span className="font-semibold">{allocPending.bottle_name}</span>
                      {' '}(ID: <span className="font-mono font-semibold">{allocPending.bottle_id}</span>)
                      {' '}on Machine {selectedMachine.machine_no.replace(/\D/g, '')}
                    </p>
                    <div className="flex flex-col gap-1.5 max-w-90">
                      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        Weight (Grams)
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          step="0.01"
                          placeholder="e.g. 450"
                          value={allocWeight}
                          onChange={(e) => {
                            setAllocWeight(e.target.value);
                            setAllocSaved(false);
                          }}
                          className="w-full h-10 px-3 pr-8 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">g</span>
                      </div>
                    </div>
                    {sectionSpeedsTable(allocRows, allocOverridden, updateAllocSectionSpeed)}
                    <div className="flex justify-end items-center gap-2">
                      <button
                        type="button"
                        onClick={cancelAllocForm}
                        className="flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 hover:text-gray-800 transition-all duration-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveAllocForm}
                        disabled={allocSaving}
                        className={`flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium transition-all duration-200 ${allocSaved
                          ? 'bg-green-50 text-green-600 border border-green-200'
                          : allocSaving
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-blue-600 hover:bg-blue-700 text-white'
                          }`}
                      >
                        {allocSaved ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            Saved
                          </>
                        ) : allocSaving ? (
                          'Saving...'
                        ) : (
                          'Save Configuration'
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
