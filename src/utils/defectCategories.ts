/**
 * Shared defect-category helpers.
 *
 * Categories are data, not a fixed enum: the defect master comes from the
 * database and may contain categories added after this build (e.g. `Other`).
 * The arrays below only define DISPLAY PRIORITY and colours; they never limit
 * which categories can be fetched, grouped, selected or reported. Any category
 * not listed here is appended after the known ones and gets neutral styling.
 */

/** Known display order only — unknown/future categories are appended after these. */
export const DEFECT_CATEGORY_PRIORITY = ['Critical', 'Major', 'Minor', 'Other'] as const;

export interface DefectGroup {
  /** Defect category as stored in the database (e.g. Critical / Other / future values). */
  group: string;
  /** Defect names in this category, ascending by defect_sr. */
  items: string[];
}

export interface DefectCategoryStyle {
  color: string;
  bg: string;
  border: string;
}

export const DEFECT_CATEGORY_STYLE: Record<string, DefectCategoryStyle> = {
  Critical: { color: '#be123c', bg: '#fff1f2', border: '#fecdd3' },
  Major: { color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  Minor: { color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
  // Neutral slate theme for `Other` and any future category.
  Other: { color: '#475569', bg: '#f8fafc', border: '#cbd5e1' },
};

export const DEFAULT_DEFECT_CATEGORY_STYLE: DefectCategoryStyle = {
  color: '#475569',
  bg: '#f8fafc',
  border: '#cbd5e1',
};

export const styleForDefectCategory = (category?: string | null): DefectCategoryStyle =>
  (category && DEFECT_CATEGORY_STYLE[category]) || DEFAULT_DEFECT_CATEGORY_STYLE;

/** 1-based priority for known categories; all future categories share the last slot. */
export const defectCategoryPriority = (category: string): number => {
  const index = (DEFECT_CATEGORY_PRIORITY as readonly string[]).indexOf(category);
  return index === -1 ? DEFECT_CATEGORY_PRIORITY.length + 1 : index + 1;
};

type SortableDefect = {
  defect_type: string;
  defect_sr: number;
  defect_id?: number;
};

/** Critical → Major → Minor → Other → future categories, then defect_sr ascending. */
export const sortDefectsByCategory = <T extends SortableDefect>(defects: T[]): T[] =>
  [...defects].sort(
    (a, b) =>
      defectCategoryPriority(a.defect_type) - defectCategoryPriority(b.defect_type) ||
      a.defect_sr - b.defect_sr ||
      (a.defect_id ?? 0) - (b.defect_id ?? 0)
  );

/**
 * Group defects by whatever `defect_type` values the active master rows carry.
 * No category or defect-name list is hardcoded here: a new database category
 * automatically becomes a new group in tabs, dropdowns and report breakdowns.
 */
export const groupDefectsByType = <T extends SortableDefect & { defect_name: string }>(
  defects: T[]
): DefectGroup[] => {
  const byType = new Map<string, string[]>();
  for (const defect of sortDefectsByCategory(defects)) {
    const group = String(defect.defect_type ?? '').trim();
    if (!group) continue;
    const items = byType.get(group) ?? [];
    items.push(defect.defect_name);
    byType.set(group, items);
  }
  return [...byType.entries()]
    .sort(
      ([a], [b]) =>
        defectCategoryPriority(a) - defectCategoryPriority(b) || a.localeCompare(b)
    )
    .map(([group, items]) => ({ group, items }));
};
