import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Link2, Pencil, Search, Trash2, X } from 'lucide-react';
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
  /** When true the dropdown allows picking several bottles via checkboxes. */
  multi?: boolean;
  selectedIds?: string[];
  onToggle?: (bottleId: string) => void;
  onClearSelection?: () => void;
}

/**
 * Searchable bottle dropdown following the existing Bottle Master
 * picker styling (button + search input + scrollable option list).
 * In `multi` mode the same panel shows checkboxes and stays open so several
 * child bottles can be picked for one parent in a single save.
 */
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

  const selected = bottles.find((b) => b.bottle_id === valueId) ?? null;
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
                    <div
                      key={b.bottle_id}
                      className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition ${
                        active ? 'bg-blue-50' : 'hover:bg-blue-50'
                      }`}
                      onMouseDown={() => {
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
                      <span className="text-xs font-medium text-gray-800 flex-1 truncate">{b.bottle_name}</span>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">{b.bottle_id}</span>
                    </div>
                  );
                })
              )}
            </div>
            {isMulti && (
              <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-white">
                <span className="text-[10px] text-gray-400">
                  {multiCount} selected
                </span>
                {multiCount > 0 && (
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onClearSelection?.();
                    }}
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

/**
 * Parent–Child Bottle Mapping, backed by the database.
 *
 * A parent bottle is the original internal Bottle Master entry (group_id ==
 * bottle_id); a child bottle points at its parent through
 * production.bottle_master.group_id (group_id == parent.bottle_id). A parent
 * may have several children, picked together in the child dropdown and saved
 * in a single request.
 *
 * Everything is read from and written to the FastAPI backend, so mappings
 * survive a refresh, a logout and another browser — there is no
 * localStorage/sessionStorage copy and no sample data. Bottle Master names,
 * IDs, machine configurations and production records are never modified here.
 *
 * Saves are fast by design: after the database confirms a write, the
 * component patches only the affected rows/options from the confirmed
 * response instead of re-fetching the whole section.
 */
export const ParentChildBottlePanel: React.FC<ParentChildBottlePanelProps> = ({
  bottles,
  canEdit,
}) => {
  const [mappings, setMappings] = useState<ParentChildBottleMapping[]>([]);
  const [parentOptions, setParentOptions] = useState<BottleMasterRow[]>([]);
  const [childOptions, setChildOptions] = useState<BottleMasterRow[]>([]);
  const [parentId, setParentId] = useState('');
  // Add mode may hold several children, saved together in one bulk request.
  // Edit mode always holds exactly the one child being re-pointed.
  const [childIds, setChildIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ParentChildBottleMapping | null>(null);
  // Child bottles of the parent selected in the Saved Mappings viewer.
  const [visibleChildren, setVisibleChildren] = useState<ParentChildBottleMapping[]>([]);
  // Parent selected in the Saved Mappings viewer (left dropdown).
  const [selectedParentId, setSelectedParentId] = useState('');

  const bottleById = useMemo(() => {
    const map = new Map<string, BottleMasterRow>();
    for (const b of bottles) map.set(b.bottle_id, b);
    return map;
  }, [bottles]);

  const parentName = (id: string, name?: string) =>
    name || bottleById.get(id)?.bottle_name || `Unknown bottle (ID: ${id})`;
  const childName = (id: string, name?: string) =>
    name || bottleById.get(id)?.bottle_name || `Unknown bottle (ID: ${id})`;

  /**
   * Loads the saved mappings plus both dropdown sources from the backend.
   * Called on open and again after every successful write, so only the
   * mapping data this screen needs is ever refreshed.
   */
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

    if (errors.length > 0) alert(errors.join('\n'));
  }, []);

  // Load everything once when the component opens.
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      await loadAll();
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [loadAll]);

  /**
   * Unique parent bottles that have at least one saved child mapping,
   * sorted by bottle name. Built from the backend response, so the parent
   * dropdown and the parent count always match the database.
   */
  const parentBottles = useMemo(() => {
    const unique = new Map<string, BottleMasterRow>();
    for (const m of mappings) {
      if (unique.has(m.parentBottleId)) continue;
      unique.set(m.parentBottleId, {
        bottle_id: m.parentBottleId,
        bottle_name: parentName(m.parentBottleId, m.parentBottleName),
      });
    }
    return [...unique.values()].sort((a, b) =>
      a.bottle_name.localeCompare(b.bottle_name, undefined, { sensitivity: 'base' })
    );
  }, [mappings, bottleById]);

  // Drop the viewer selection when its parent no longer has any child
  // mappings (deleted, edited away, or refreshed). The selection is
  // otherwise preserved across updates.
  useEffect(() => {
    if (
      selectedParentId &&
      !mappings.some((m) => m.parentBottleId === selectedParentId)
    ) {
      setSelectedParentId('');
    }
  }, [mappings, selectedParentId]);

  // Fetch the child bottles of the selected parent from the database.
  useEffect(() => {
    if (!selectedParentId) {
      setVisibleChildren([]);
      return;
    }
    let active = true;
    setLoadingChildren(true);
    planningRepository.fetchChildBottlesForParent(selectedParentId).then((result) => {
      if (!active) return;
      setLoadingChildren(false);
      if (!result.ok) {
        setVisibleChildren([]);
        alert(result.error || 'Failed to load child bottles for this parent.');
        return;
      }
      setVisibleChildren(result.mappings);
    });
    return () => {
      active = false;
    };
  }, [selectedParentId]);

  /**
   * Add-form parent list: parents from the database plus, while editing, the
   * parent of the mapping being edited (so its name still renders). Every
   * currently selected child is filtered out so a bottle can never be picked
   * as both parent and child.
   */
  const addFormParentOptions = useMemo(() => {
    let list = parentOptions;
    const editing = editingId ? mappings.find((m) => m.id === editingId) : null;
    if (editing && !list.some((b) => b.bottle_id === editing.parentBottleId)) {
      list = [
        ...list,
        {
          bottle_id: editing.parentBottleId,
          bottle_name: parentName(editing.parentBottleId, editing.parentBottleName),
        },
      ];
    }
    return childIds.length > 0 ? list.filter((b) => !childIds.includes(b.bottle_id)) : list;
  }, [parentOptions, mappings, editingId, childIds, bottleById]);

  /** Add-form child list: eligible bottles from the database, minus the selected parent. */
  const addFormChildOptions = useMemo(() => {
    let list = childOptions;
    const editing = editingId ? mappings.find((m) => m.id === editingId) : null;
    if (editing && !list.some((b) => b.bottle_id === editing.childBottleId)) {
      list = [
        ...list,
        {
          bottle_id: editing.childBottleId,
          bottle_name: childName(editing.childBottleId, editing.childBottleName),
        },
      ];
    }
    return parentId ? list.filter((b) => b.bottle_id !== parentId) : list;
  }, [childOptions, mappings, editingId, parentId, bottleById]);

  function resetForm() {
    setParentId('');
    setChildIds([]);
    setEditingId(null);
  }

  function toggleChild(id: string) {
    setChildIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
    setSaved(false);
  }

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  /** Alphabetical bottle order, matching the backend dropdown ordering. */
  function sortBottles(list: BottleMasterRow[]): BottleMasterRow[] {
    return [...list].sort(
      (a, b) =>
        a.bottle_name.localeCompare(b.bottle_name, undefined, { sensitivity: 'base' }) ||
        a.bottle_id.localeCompare(b.bottle_id)
    );
  }

  /**
   * Merges database-confirmed new rows into every piece of local state, so a
   * successful save refreshes the component and the Saved Mappings viewer
   * without re-fetching. No duplicate mappings can appear: ids are unique per
   * child bottle and already-present rows are skipped.
   */
  function applyAddedMappings(savedParentId: string, rows: ParentChildMappingRow[]) {
    const savedChildIds = new Set(rows.map((m) => m.childBottleId));
    setMappings((prev) => {
      const known = new Set(prev.map((m) => m.id));
      return [...prev, ...rows.filter((m) => !known.has(m.id))];
    });
    // Saved children leave both dropdowns; a parent gaining its first child
    // leaves the child dropdown (it can no longer become a child itself).
    setChildOptions((prev) =>
      sortBottles(prev.filter((b) => b.bottle_id !== savedParentId && !savedChildIds.has(b.bottle_id)))
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

  /** Merges a database-confirmed parent change into the local state. */
  function applyUpdatedMapping(updated: ParentChildMappingRow, previousParentId: string) {
    const newParentId = updated.parentBottleId;
    setMappings((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    // The new parent can no longer be picked as a child; the previous parent
    // becomes eligible again only when it keeps no other children.
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
    setVisibleChildren((prev) => {
      if (selectedParentId === newParentId) {
        return prev.some((m) => m.id === updated.id)
          ? prev.map((m) => (m.id === updated.id ? updated : m))
          : [...prev, updated];
      }
      return prev.filter((m) => m.id !== updated.id);
    });
  }

  /**
   * Shared validation for add + edit. Returns an error message, or null
   * when the (parent, child) pair is acceptable. Uses alert() to match the
   * existing Bottle Master notification pattern.
   */
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
      return `Bottle ${child} is already mapped to parent ${otherParent.parentBottleId} (${
        otherParent.parentBottleName
      }). Remove or edit that mapping first.`;
    }
    return null;
  }

  async function handleAddOrUpdate() {
    if (!canEdit || saving) return;

    // Edit moves exactly one already-mapped child under a (possibly new)
    // parent; the child itself is fixed while editing.
    if (editingId) {
      const editing = mappings.find((m) => m.id === editingId);
      const child = childIds[0] ?? editing?.childBottleId ?? '';
      const error = validatePair(parentId, child, editingId);
      if (error) {
        alert(error);
        return;
      }
      const previousParentId = editing?.parentBottleId ?? parentId;
      setSaving(true);
      try {
        const result = await planningRepository.updateParentChildMapping(child, parentId);
        // Success is reported only after the database confirms the write.
        if (!result.ok || !result.mapping) {
          alert(result.error || 'Failed to save the parent-child mapping.');
          // Resync the dropdowns with what the database actually holds.
          await loadAll();
          return;
        }
        applyUpdatedMapping(result.mapping, previousParentId);
        resetForm();
        flashSaved();
        // Point the Saved Mappings viewer at the saved parent so the parent
        // dropdown, mapping count and child list update immediately.
        setSelectedParentId(result.mapping.parentBottleId);
      } finally {
        setSaving(false);
      }
      return;
    }

    // Add saves one or more children under the same parent in a single
    // request — no duplicate mappings: already-mapped pairs are rejected
    // before anything is sent.
    if (!parentId || childIds.length === 0) {
      alert('Select both a parent bottle and a child bottle.');
      return;
    }
    for (const child of childIds) {
      const error = validatePair(parentId, child, null);
      if (error) {
        alert(error);
        return;
      }
    }

    setSaving(true);
    try {
      const result = await planningRepository.createParentChildMappingsBulk(parentId, childIds);
      // Success is reported only after the database confirms the write.
      if (!result.ok || !result.mappings || result.mappings.length === 0) {
        alert(result.error || 'Failed to save the parent-child mapping.');
        // Resync the dropdowns with what the database actually holds.
        await loadAll();
        return;
      }

      applyAddedMappings(parentId, result.mappings);
      if (selectedParentId === parentId) {
        setVisibleChildren((prev) => {
          const known = new Set(prev.map((m) => m.id));
          return [...prev, ...result.mappings!.filter((m) => !known.has(m.id))];
        });
      }
      // Keep the parent selected so further children can be added to the same
      // parent without re-picking it; only the child selection is cleared.
      setChildIds([]);
      setEditingId(null);
      flashSaved();
      // Point the Saved Mappings viewer at the saved parent so the parent
      // dropdown, mapping count and child list update immediately. Set after
      // the local update so the selection is never dropped as "no longer mapped".
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
  }

  async function handleConfirmDelete() {
    if (!canEdit || !deleteTarget) return;
    const target = deleteTarget;
    // Close first so a double click cannot submit the same delete twice.
    setDeleteTarget(null);
    setSaving(true);
    try {
      const result = await planningRepository.deleteParentChildMapping(target.childBottleId);
      if (!result.ok) {
        alert(result.error || 'Failed to delete the parent-child mapping.');
        return;
      }
      if (editingId === target.id) resetForm();
      flashSaved();
      // Patch only the affected data from the confirmed delete: drop the row
      // and restore the released bottles' dropdown eligibility, no refetch.
      const remaining = mappings.filter((m) => m.id !== target.id);
      setMappings(remaining);
      setVisibleChildren((prev) => prev.filter((m) => m.id !== target.id));
      setParentOptions((prev) =>
        prev.some((b) => b.bottle_id === target.childBottleId)
          ? prev
          : sortBottles([
              ...prev,
              {
                bottle_id: target.childBottleId,
                bottle_name: childName(target.childBottleId, target.childBottleName),
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
              bottle_name: childName(target.childBottleId, target.childBottleName),
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
              bottle_name: parentName(target.parentBottleId, target.parentBottleName),
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
      parentName(selectedParentId)
    : '';

  const formReady = parentId !== '' && childIds.length > 0;

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Add / Edit Mapping — dropdowns only, Bottle Master untouched */}
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
              }}
            />
          )}
        </div>
        <p className="text-[11px] text-gray-400">
          The parent bottle is the original internal Bottle Master entry; the child bottle is an
          alternative name used for sales identification. A parent can have multiple children —
          tick several child bottles to save them together in one step.
          Mappings are saved to the database and never modify Bottle Master names, IDs or machine
          configurations.
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

      {/* Saved Mappings — parent dropdown (left) + child bottles panel (right) */}
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
                ) : loadingChildren ? (
                  <p className="px-4 py-3 text-[11px] text-gray-400">Loading child bottles...</p>
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
                    {visibleChildren.map((m, i) => {
                      const childMissing = !m.childBottleName && !bottleById.has(m.childBottleId);
                      const isEditing = editingId === m.id;
                      return (
                        <div
                          key={m.id}
                          className={`flex items-center gap-3 px-4 py-2.5 bg-white ${
                            i > 0 ? 'border-t border-gray-100' : 'border-t border-gray-100 mt-2'
                          } ${isEditing ? 'bg-blue-50/60' : ''}`}
                        >
                          <div className="flex-1 min-w-0">
                            <span
                              className={`text-xs font-medium ${
                                childMissing ? 'text-amber-600' : 'text-gray-800'
                              }`}
                            >
                              {childName(m.childBottleId, m.childBottleName)}
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
            ? `Delete the mapping "${parentName(
                deleteTarget.parentBottleId,
                deleteTarget.parentBottleName
              )}" → "${childName(
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
