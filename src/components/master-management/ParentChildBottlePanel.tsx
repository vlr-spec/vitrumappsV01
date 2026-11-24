import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Link2, Pencil, Search, Trash2, X } from 'lucide-react';
import { BottleMasterRow, ParentChildMappingRow } from '../../data/planningSchema';
import { planningRepository } from '../../services/planningRepository';
import { ConfirmationModal } from '../common/ConfirmationModal';

export type ParentChildBottleMapping = ParentChildMappingRow;

interface ParentChildBottlePanelProps {
  bottles: BottleMasterRow[];
  canEdit: boolean;
}

interface BottlePickerProps {
  label: string;
  placeholder: string;
  bottles: BottleMasterRow[];
  valueId: string;
  disabled?: boolean;
  onSelect: (bottleId: string) => void;
  multi?: boolean;
  selectedIds?: string[];
  onToggle?: (bottleId: string) => void;
  onClearSelection?: () => void;
}

const BottlePicker: React.FC<BottlePickerProps> = ({
  label,
  placeholder,
  bottles,
  valueId,
  disabled,
  onSelect,
  multi,
  selectedIds,
  onToggle,
  onClearSelection,
}) => {
  const [dropOpen, setDropOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dropRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => bottles.find((b) => b.bottle_id === valueId) ?? null,
    [bottles, valueId]
  );

  const isMulti = !!multi;
  const multiCount = selectedIds?.length ?? 0;
  const multiLabel =
    multiCount === 0
      ? placeholder
      : multiCount === 1
        ? (bottles.find((b) => b.bottle_id === selectedIds![0])?.bottle_name ?? placeholder)
        : `${multiCount} bottles selected`;
  const hasSelection = isMulti ? multiCount > 0 : !!selected;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bottles;
    return bottles.filter(
      (b) => b.bottle_name.toLowerCase().includes(q) || b.bottle_id.toLowerCase().includes(q)
    );
  }, [bottles, query]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</label>
      <div ref={dropRef} className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 z-10">
          <Search className="w-3.5 h-3.5" />
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setQuery('');
            setDropOpen((open) => !open);
          }}
          className={`w-full h-10 pl-7 pr-3 text-left text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${
            hasSelection
              ? 'font-medium text-gray-800 bg-white border-gray-200'
              : 'text-gray-400 bg-white border-gray-200'
          } ${disabled ? 'bg-gray-50 cursor-not-allowed' : ''}`}
        >
          {isMulti ? multiLabel : selected ? selected.bottle_name : placeholder}
        </button>

        {dropOpen && !disabled && (
          <div className="absolute z-20 top-11 left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
            <div className="p-2 border-b border-gray-100">
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search bottle name or ID..."
                className="w-full h-8 px-2.5 text-sm border border-gray-200 rounded-md bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              />
            </div>
            <div className="max-h-48 overflow-y-auto">
              {matches.length === 0 ? (
                <p className="px-3 py-3 text-xs text-gray-400">No bottles found.</p>
              ) : (
                matches.map((b) => {
                  const active = isMulti
                    ? (selectedIds ?? []).includes(b.bottle_id)
                    : b.bottle_id === valueId;
                  return (
                    <button
                      type="button"
                      key={b.bottle_id}
                      className={`w-full text-left flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition ${
                        active ? 'bg-blue-50' : 'hover:bg-blue-50'
                      }`}
                      onClick={() => {
                        if (isMulti) {
                          onToggle?.(b.bottle_id);
                        } else {
                          onSelect(b.bottle_id);
                          setDropOpen(false);
                          setQuery('');
                        }
                      }}
                    >
                      {isMulti && (
                        <input
                          type="checkbox"
                          readOnly
                          checked={active}
                          tabIndex={-1}
                          className="w-3.5 h-3.5 accent-blue-600 shrink-0 pointer-events-none"
                        />
                      )}
                      <span className="text-xs font-medium text-gray-800 flex-1 truncate">
                        {b.bottle_name}
                      </span>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">
                        {b.bottle_id}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {isMulti && (
              <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-white">
                <span className="text-[10px] text-gray-400">{multiCount} selected</span>
                {multiCount > 0 && (
                  <button
                    type="button"
                    onClick={() => onClearSelection?.()}
                    className="text-[10px] font-semibold text-blue-600 hover:text-blue-800"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

function sortBottles(list: BottleMasterRow[]): BottleMasterRow[] {
  return [...list].sort(
    (a, b) =>
      a.bottle_name.localeCompare(b.bottle_name, undefined, { sensitivity: 'base' }) ||
      a.bottle_id.localeCompare(b.bottle_id)
  );
}

export const ParentChildBottlePanel: React.FC<ParentChildBottlePanelProps> = ({
  bottles,
  canEdit,
}) => {
  const [mappings, setMappings] = useState<ParentChildBottleMapping[]>([]);
  const [parentOptions, setParentOptions] = useState<BottleMasterRow[]>([]);
  const [childOptions, setChildOptions] = useState<BottleMasterRow[]>([]);
  const [parentId, setParentId] = useState('');
  const [childIds, setChildIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParentChildBottleMapping | null>(null);
  const [selectedParentId, setSelectedParentId] = useState('');

  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bottleById = useMemo(() => {
    const map = new Map<string, BottleMasterRow>();
    for (const b of bottles) map.set(b.bottle_id, b);
    return map;
  }, [bottles]);

  const resolveBottleName = useCallback(
    (id: string, name?: string) =>
      name || bottleById.get(id)?.bottle_name || `Unknown bottle (ID: ${id})`,
    [bottleById]
  );

  const loadAll = useCallback(async () => {
    const [mappingResult, parentResult, childResult] = await Promise.all([
      planningRepository.fetchParentChildMappings(),
      planningRepository.fetchParentBottles(),
      planningRepository.fetchEligibleChildBottles(),
    ]);

    const errors: string[] = [];
    if (mappingResult.ok) setMappings(mappingResult.mappings);
    else errors.push(mappingResult.error || 'Failed to load saved mappings.');
    if (parentResult.ok) setParentOptions(parentResult.bottles);
    else errors.push(parentResult.error || 'Failed to load parent bottles.');
    if (childResult.ok) setChildOptions(childResult.bottles);
    else errors.push(childResult.error || 'Failed to load child bottles.');

    setErrorMsg(errors.length > 0 ? errors.join(' ') : null);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      await loadAll();
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [loadAll]);

  const parentBottles = useMemo(() => {
    const unique = new Map<string, BottleMasterRow>();
    for (const m of mappings) {
      if (unique.has(m.parentBottleId)) continue;
      unique.set(m.parentBottleId, {
        bottle_id: m.parentBottleId,
        bottle_name: resolveBottleName(m.parentBottleId, m.parentBottleName),
      });
    }
    return sortBottles([...unique.values()]);
  }, [mappings, resolveBottleName]);

  // Derived directly from `mappings`—instant, zero extra network calls, and always in sync.
  const visibleChildren = useMemo(() => {
    if (!selectedParentId) return [];
    return mappings
      .filter((m) => m.parentBottleId === selectedParentId)
      .sort((a, b) =>
        resolveBottleName(a.childBottleId, a.childBottleName).localeCompare(
          resolveBottleName(b.childBottleId, b.childBottleName),
          undefined,
          { sensitivity: 'base' }
        )
      );
  }, [mappings, selectedParentId, resolveBottleName]);

  useEffect(() => {
    if (selectedParentId && !mappings.some((m) => m.parentBottleId === selectedParentId)) {
      setSelectedParentId('');
    }
  }, [mappings, selectedParentId]);

  const addFormParentOptions = useMemo(() => {
    let list = parentOptions;
    const editing = editingId ? mappings.find((m) => m.id === editingId) : null;
    if (editing && !list.some((b) => b.bottle_id === editing.parentBottleId)) {
      list = [
        ...list,
        {
          bottle_id: editing.parentBottleId,
          bottle_name: resolveBottleName(editing.parentBottleId, editing.parentBottleName),
        },
      ];
    }
    return childIds.length > 0 ? list.filter((b) => !childIds.includes(b.bottle_id)) : list;
  }, [parentOptions, mappings, editingId, childIds, resolveBottleName]);

  const addFormChildOptions = useMemo(() => {
    let list = childOptions;
    const editing = editingId ? mappings.find((m) => m.id === editingId) : null;
    if (editing && !list.some((b) => b.bottle_id === editing.childBottleId)) {
      list = [
        ...list,
        {
          bottle_id: editing.childBottleId,
          bottle_name: resolveBottleName(editing.childBottleId, editing.childBottleName),
        },
      ];
    }
    return parentId ? list.filter((b) => b.bottle_id !== parentId) : list;
  }, [childOptions, mappings, editingId, parentId, resolveBottleName]);

  function resetForm() {
    setParentId('');
    setChildIds([]);
    setEditingId(null);
    setErrorMsg(null);
  }

  function toggleChild(id: string) {
    setChildIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
    setSaved(false);
    setErrorMsg(null);
  }

  function flashSaved() {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    setSaved(true);
    savedTimerRef.current = setTimeout(() => setSaved(false), 2500);
  }

  function applyAddedMappings(savedParentId: string, rows: ParentChildMappingRow[]) {
    const savedChildIds = new Set(rows.map((m) => m.childBottleId));
    setMappings((prev) => {
      const known = new Set(prev.map((m) => m.id));
      return [...prev, ...rows.filter((m) => !known.has(m.id))];
    });
    setChildOptions((prev) =>
      sortBottles(
        prev.filter((b) => b.bottle_id !== savedParentId && !savedChildIds.has(b.bottle_id))
      )
    );
    setParentOptions((prev) => {
      const next = prev.filter((b) => !savedChildIds.has(b.bottle_id));
      if (!next.some((b) => b.bottle_id === savedParentId)) {
        next.push({
          bottle_id: savedParentId,
          bottle_name:
            rows[0]?.parentBottleName ?? bottleById.get(savedParentId)?.bottle_name ?? savedParentId,
        });
      }
      return sortBottles(next);
    });
  }

  function applyUpdatedMapping(updated: ParentChildMappingRow, previousParentId: string) {
    const newParentId = updated.parentBottleId;
    setMappings((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));

    const oldStillHasChildren = mappings.some(
      (m) => m.parentBottleId === previousParentId && m.id !== updated.id
    );

    setChildOptions((prev) => {
      let next = prev.filter((b) => b.bottle_id !== newParentId);
      if (
        !oldStillHasChildren &&
        previousParentId !== newParentId &&
        !next.some((b) => b.bottle_id === previousParentId)
      ) {
        next = [
          ...next,
          {
            bottle_id: previousParentId,
            bottle_name: bottleById.get(previousParentId)?.bottle_name ?? previousParentId,
          },
        ];
      }
      return sortBottles(next);
    });

    setParentOptions((prev) => {
      if (prev.some((b) => b.bottle_id === newParentId)) return prev;
      return sortBottles([
        ...prev,
        {
          bottle_id: newParentId,
          bottle_name:
            updated.parentBottleName ?? bottleById.get(newParentId)?.bottle_name ?? newParentId,
        },
      ]);
    });
  }

  function validatePair(parent: string, child: string, ignoreId: string | null): string | null {
    if (!parent || !child) return 'Select both a parent bottle and a child bottle.';
    if (parent === child) return 'Parent bottle and child bottle cannot be the same.';
    if (!bottleById.has(parent) || !bottleById.has(child)) {
      return 'Selected bottle no longer exists in Bottle Master. Please choose again.';
    }
    const duplicate = mappings.some(
      (m) => m.parentBottleId === parent && m.childBottleId === child && m.id !== ignoreId
    );
    if (duplicate) return 'This parent–child mapping already exists.';
    const otherParent = mappings.find((m) => m.childBottleId === child && m.id !== ignoreId);
    if (otherParent) {
      return `Bottle ${child} is already mapped to parent ${otherParent.parentBottleId} (${otherParent.parentBottleName}). Remove or edit that mapping first.`;
    }
    return null;
  }

  async function handleAddOrUpdate() {
    if (!canEdit || saving) return;
    setErrorMsg(null);

    if (editingId) {
      const editing = mappings.find((m) => m.id === editingId);
      const child = childIds[0] ?? editing?.childBottleId ?? '';
      const error = validatePair(parentId, child, editingId);
      if (error) {
        setErrorMsg(error);
        return;
      }
      const previousParentId = editing?.parentBottleId ?? parentId;
      setSaving(true);
      try {
        const result = await planningRepository.updateParentChildMapping(child, parentId);
        if (!result.ok || !result.mapping) {
          setErrorMsg(result.error || 'Failed to save the parent-child mapping.');
          await loadAll();
          return;
        }
        applyUpdatedMapping(result.mapping, previousParentId);
        resetForm();
        flashSaved();
        setSelectedParentId(result.mapping.parentBottleId);
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!parentId || childIds.length === 0) {
      setErrorMsg('Select both a parent bottle and at least one child bottle.');
      return;
    }
    for (const child of childIds) {
      const error = validatePair(parentId, child, null);
      if (error) {
        setErrorMsg(error);
        return;
      }
    }

    setSaving(true);
    try {
      const result = await planningRepository.createParentChildMappingsBulk(parentId, childIds);
      if (!result.ok || !result.mappings || result.mappings.length === 0) {
        setErrorMsg(result.error || 'Failed to save the parent-child mapping.');
        await loadAll();
        return;
      }

      applyAddedMappings(parentId, result.mappings);
      setChildIds([]);
      setEditingId(null);
      flashSaved();
      setSelectedParentId(parentId);
    } finally {
      setSaving(false);
    }
  }

  function handleStartEdit(mapping: ParentChildBottleMapping) {
    if (!canEdit || saving) return;
    setEditingId(mapping.id);
    setParentId(mapping.parentBottleId);
    setChildIds([mapping.childBottleId]);
    setSaved(false);
    setErrorMsg(null);
  }

  async function handleConfirmDelete() {
    if (!canEdit || !deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setErrorMsg(null);
    setSaving(true);
    try {
      const result = await planningRepository.deleteParentChildMapping(target.childBottleId);
      if (!result.ok) {
        setErrorMsg(result.error || 'Failed to delete the parent-child mapping.');
        return;
      }
      if (editingId === target.id) resetForm();
      flashSaved();

      const remaining = mappings.filter((m) => m.id !== target.id);
      setMappings(remaining);

      setParentOptions((prev) =>
        prev.some((b) => b.bottle_id === target.childBottleId)
          ? prev
          : sortBottles([
              ...prev,
              {
                bottle_id: target.childBottleId,
                bottle_name: resolveBottleName(target.childBottleId, target.childBottleName),
              },
            ])
      );

      setChildOptions((prev) => {
        let next = prev;
        if (!next.some((b) => b.bottle_id === target.childBottleId)) {
          next = [
            ...next,
            {
              bottle_id: target.childBottleId,
              bottle_name: resolveBottleName(target.childBottleId, target.childBottleName),
            },
          ];
        }
        const parentStillHasChildren = remaining.some(
          (m) => m.parentBottleId === target.parentBottleId
        );
        if (
          !parentStillHasChildren &&
          !next.some((b) => b.bottle_id === target.parentBottleId)
        ) {
          next = [
            ...next,
            {
              bottle_id: target.parentBottleId,
              bottle_name: resolveBottleName(target.parentBottleId, target.parentBottleName),
            },
          ];
        }
        return sortBottles(next);
      });
    } finally {
      setSaving(false);
    }
  }

  const selectedParentName = selectedParentId
    ? parentBottles.find((b) => b.bottle_id === selectedParentId)?.bottle_name ??
      resolveBottleName(selectedParentId)
    : '';

  const formReady = parentId !== '' && childIds.length > 0;

  return (
    <div className="p-6 flex flex-col gap-5">
      {errorMsg && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-500 hover:text-red-700"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Add / Edit Mapping */}
      <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="text-blue-600">
            <Link2 className="w-3.5 h-3.5" />
          </span>
          <h3 className="text-sm font-semibold text-gray-800">
            {editingId ? 'Edit Parent–Child Mapping' : 'Add Parent–Child Mapping'}
          </h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <BottlePicker
            label="Parent Bottle"
            placeholder="Select parent bottle..."
            bottles={addFormParentOptions}
            valueId={parentId}
            disabled={!canEdit}
            onSelect={(id) => {
              setParentId(id);
              setSaved(false);
              setErrorMsg(null);
            }}
          />
          {editingId ? (
            <BottlePicker
              label="Child Bottle"
              placeholder="Select child bottle..."
              bottles={addFormChildOptions}
              valueId={childIds[0] ?? ''}
              disabled
              onSelect={() => {}}
            />
          ) : (
            <BottlePicker
              label="Child Bottles"
              placeholder="Select child bottle(s)..."
              bottles={addFormChildOptions}
              valueId=""
              disabled={!canEdit}
              onSelect={() => {}}
              multi
              selectedIds={childIds}
              onToggle={toggleChild}
              onClearSelection={() => {
                setChildIds([]);
                setSaved(false);
                setErrorMsg(null);
              }}
            />
          )}
        </div>
        <p className="text-[11px] text-gray-400">
          The parent bottle is the original internal Bottle Master entry; the child bottle is an
          alternative name used for sales identification. A parent can have multiple children —
          tick several child bottles to save them together in one step. Mappings are saved to the
          database and never modify Bottle Master names, IDs or machine configurations.
        </p>
        {canEdit && (
          <div className="flex justify-end items-center gap-2">
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 hover:text-gray-800 transition-all duration-200"
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={handleAddOrUpdate}
              disabled={!formReady || saving}
              className={`flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium transition-all duration-200 ${
                saved
                  ? 'bg-green-50 text-green-600 border border-green-200'
                  : !formReady || saving
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
              ) : editingId ? (
                'Update Mapping'
              ) : (
                'Add Mapping'
              )}
            </button>
          </div>
        )}
      </div>

      {/* Saved Mappings */}
      <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800">Saved Mappings</h3>
          <span className="text-[10px] text-gray-400 font-mono">
            {mappings.length} mapping{mappings.length === 1 ? '' : 's'}
          </span>
        </div>
        {mappings.length === 0 ? (
          <p className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-3">
            {loading
              ? 'Loading saved mappings...'
              : 'No parent–child mappings saved yet. Select a parent bottle and a child bottle above, then click Add Mapping.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="flex flex-col gap-1.5">
              <BottlePicker
                label="Parent Bottle"
                placeholder="Select parent bottle..."
                bottles={parentBottles}
                valueId={selectedParentId}
                onSelect={(id) => setSelectedParentId(id)}
              />
              <p className="text-[10px] text-gray-400">
                {parentBottles.length} parent{parentBottles.length === 1 ? '' : 's'} with saved
                child mapping{parentBottles.length === 1 ? '' : 's'}.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Child Bottles
              </label>
              <div className="rounded-lg border border-gray-100 bg-gray-50 overflow-hidden">
                {!selectedParentId ? (
                  <p className="px-4 py-3 text-[11px] text-gray-400">
                    Select a parent bottle to view its child bottles.
                  </p>
                ) : visibleChildren.length === 0 ? (
                  <p className="px-4 py-3 text-[11px] text-gray-400">
                    No child bottles mapped to this parent yet.
                  </p>
                ) : (
                  <>
                    <p className="px-4 pt-3 pb-1 text-[10px] text-gray-400">
                      {visibleChildren.length} child bottle{visibleChildren.length === 1 ? '' : 's'}{' '}
                      for <span className="font-semibold">{selectedParentName}</span>
                    </p>
                    {visibleChildren.map((m) => {
                      const childMissing = !m.childBottleName && !bottleById.has(m.childBottleId);
                      const isEditing = editingId === m.id;
                      return (
                        <div
                          key={m.id}
                          className={`flex items-center gap-3 px-4 py-2.5 bg-white border-t border-gray-100 first-of-type:mt-2 ${
                            isEditing ? 'bg-blue-50/60' : ''
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <span
                              className={`text-xs font-medium ${
                                childMissing ? 'text-amber-600' : 'text-gray-800'
                              }`}
                            >
                              {resolveBottleName(m.childBottleId, m.childBottleName)}
                            </span>
                            <span className="ml-2 text-[10px] text-gray-400 font-mono">
                              {m.childBottleId}
                            </span>
                          </div>
                          {canEdit && (
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                title="Edit mapping"
                                onClick={() => handleStartEdit(m)}
                                className="flex items-center gap-1 px-2.5 h-8 rounded-md text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-100 transition"
                              >
                                <Pencil className="w-3 h-3" />
                                Edit
                              </button>
                              <button
                                type="button"
                                title="Delete mapping"
                                onClick={() => setDeleteTarget(m)}
                                className="flex items-center gap-1 px-2.5 h-8 rounded-md text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-100 transition"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmationModal
        isOpen={deleteTarget !== null}
        title="Delete Mapping"
        message={
          deleteTarget
            ? `Delete the mapping "${resolveBottleName(
                deleteTarget.parentBottleId,
                deleteTarget.parentBottleName
              )}" → "${resolveBottleName(
                deleteTarget.childBottleId,
                deleteTarget.childBottleName
              )}"? Only this mapping is removed; both bottles stay in Bottle Master.`
            : ''
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        isDanger
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
};