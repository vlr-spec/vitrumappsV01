import React, { useState, useEffect, useCallback } from 'react';
import { Package, Pencil, Trash2, Check } from 'lucide-react';
import { planningRepository } from '../../services/planningRepository';
import { PackagingMasterRow } from '../../data/planningSchema';
import { useAuth, MODULES } from '../../context/AuthContext';
import { ConfirmationModal } from '../common/ConfirmationModal';

/**
 * Packaging Master — CRUD screen for the existing `hpr.packaging_master` table.
 *
 * - Shows only Packaging Code, Packaging Description and Actions. `packaging_id`
 *   stays internal: it is the key used for UPDATE/DELETE and never rendered.
 * - Visibility/editability follows the same database-driven Master Management
 *   permission checks as the Bottle Master and Holiday Master tabs: anyone who
 *   can read Master Management sees the tab (read-only), and only users with
 *   edit rights get the form and the Edit / Delete actions.
 * - The list is re-fetched from the database after every add, edit and delete.
 */
export const PackagingMasterPanel: React.FC = () => {
  const { hasPermission } = useAuth();
  // Write access = edit on a Master Management child module, mirroring the
  // require_any_module_edit guard on /api/production/packaging/.
  const canEdit =
    hasPermission(MODULES.BOTTLE_MASTER, 'edit') || hasPermission(MODULES.HOLIDAY_MASTER, 'edit');

  const [rows, setRows] = useState<PackagingMasterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Add / edit form
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Delete confirmation popup
  const [deleteTarget, setDeleteTarget] = useState<PackagingMasterRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadPackaging = useCallback(async () => {
    setLoading(true);
    const result = await planningRepository.getPackagingMasters();
    setRows(result.rows);
    setLoadError(result.ok ? '' : result.error || 'Failed to load packaging records.');
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadPackaging();
  }, [loadPackaging]);

  const trimmedCode = code.trim();
  const trimmedDescription = description.trim();
  const canSave = trimmedCode !== '' && trimmedDescription !== '' && !saving;

  function resetForm() {
    setCode('');
    setDescription('');
    setEditingId(null);
    setSaved(false);
  }

  /** Adds a new record, or updates the row identified by packaging_id. */
  async function handleSave() {
    if (!canEdit || !canSave) return;

    // Same exact-match rule as the packaging_code UNIQUE constraint in the
    // database, so the client check and the server check can never disagree.
    const duplicate = rows.some(
      (r) => r.packaging_code === trimmedCode && r.packaging_id !== editingId
    );
    if (duplicate) {
      alert(`A packaging with code "${trimmedCode}" already exists.`);
      return;
    }

    setSaving(true);
    const result =
      editingId === null
        ? await planningRepository.createPackagingMaster(trimmedCode, trimmedDescription)
        : await planningRepository.updatePackagingMaster(editingId, trimmedCode, trimmedDescription);
    setSaving(false);

    if (!result.ok) {
      alert(result.error || 'Failed to save packaging record.');
      return;
    }

    resetForm();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await loadPackaging();
  }

  function startEdit(row: PackagingMasterRow) {
    setEditingId(row.packaging_id);
    setCode(row.packaging_code);
    setDescription(row.packaging_description);
    setSaved(false);
  }

  /** Deletes the confirmed row by its packaging_id, then refreshes the list. */
  async function handleConfirmDelete() {
    if (!canEdit || !deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    const result = await planningRepository.deletePackagingMaster(target.packaging_id);
    setDeleting(false);
    setDeleteTarget(null);
    if (!result.ok) {
      alert(result.error || 'Failed to delete packaging record.');
      return;
    }
    if (editingId === target.packaging_id) resetForm();
    await loadPackaging();
  }

  return (
    <div className="w-full min-w-0 bg-white rounded-xl border border-gray-200 flex flex-col shadow-sm">
      <div className="flex items-center gap-2.5 px-5 md:px-6 py-4 border-b border-gray-100 shrink-0">
        <span className="text-blue-600"><Package className="w-5 h-5" /></span>
        <h2 className="text-base font-semibold text-gray-800">Packaging Master</h2>
      </div>

      <div className="flex-1 p-5 md:p-6 flex flex-col gap-5">
        {/* Add / Edit form — hidden for read-only users */}
        {canEdit && (
          <div className="rounded-lg border border-gray-200 p-5 flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-gray-800">
              {editingId !== null ? 'Edit Packaging' : 'Add New Packaging'}
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Packaging Code
                </label>
                <input
                  type="text"
                  maxLength={20}
                  placeholder="e.g. ST"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setSaved(false);
                  }}
                  className="w-full h-10 px-3 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Packaging Description
                </label>
                <input
                  type="text"
                  maxLength={150}
                  placeholder="e.g. Shrink Tray"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setSaved(false);
                  }}
                  className="w-full h-10 px-3 text-sm border border-gray-200 rounded-lg bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              {editingId !== null && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 h-9 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className={`flex items-center gap-1.5 px-5 h-9 rounded-lg text-sm font-medium transition-all duration-200 ${
                  saved
                    ? 'bg-green-50 text-green-600 border border-green-200'
                    : !canSave
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
                ) : editingId !== null ? (
                  'Save Changes'
                ) : (
                  'Add Packaging'
                )}
              </button>
            </div>
          </div>
        )}

        {/* Records table — only Packaging Code, Description and Actions */}
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
            Packaging Records ({rows.length})
          </div>
          {!canEdit && (
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border border-gray-200 rounded-full px-2.5 py-1">
              Read-only
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 text-center py-6">Loading...</p>
        ) : loadError ? (
          <p className="text-sm text-red-500 text-center py-6">{loadError}</p>
        ) : (
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            {/* Horizontal scroll keeps the table usable on mobile */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-sm">
                <thead>
                  <tr className="bg-blue-50 border-b border-blue-100">
                    <th className="px-3 sm:px-4 py-2.5 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider whitespace-nowrap">
                      Packaging Code
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider">
                      Packaging Description
                    </th>
                    <th className="px-3 sm:px-4 py-2.5 text-right text-xs font-semibold text-blue-700 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-sm text-gray-400">
                        No packaging records found.
                      </td>
                    </tr>
                  )}
                  {rows.map((row) => (
                    <tr
                      key={row.packaging_id}
                      className={`border-b border-gray-100 last:border-b-0 transition ${
                        editingId === row.packaging_id ? 'bg-blue-50' : 'bg-white hover:bg-gray-50'
                      }`}
                    >
                      <td className="px-3 sm:px-4 py-3 text-sm font-mono font-semibold text-gray-800 whitespace-nowrap">
                        {row.packaging_code}
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-sm text-gray-600 break-words">
                        {row.packaging_description}
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-right">
                        {canEdit && (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => startEdit(row)}
                              className="flex items-center gap-1 px-2.5 h-7 rounded-md text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 transition"
                            >
                              <Pencil className="w-3 h-3" />
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(row)}
                              className="flex items-center gap-1 px-2.5 h-7 rounded-md text-xs font-medium text-red-500 hover:text-red-600 hover:bg-red-50 transition"
                            >
                              <Trash2 className="w-3 h-3" />
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation popup */}
      <ConfirmationModal
        isOpen={deleteTarget !== null}
        title="Delete Packaging"
        message={
          deleteTarget
            ? `Are you sure you want to delete packaging code "${deleteTarget.packaging_code}" (${deleteTarget.packaging_description})? This action cannot be undone.`
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
