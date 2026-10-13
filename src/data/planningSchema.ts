/**
 * planningSchema.ts — TypeScript interfaces for the production planning data layer.
 *
 * These interfaces mirror the backend database schema and API responses.
 * All data is fetched from the FastAPI backend (AWS PostgreSQL) via planningRepository.
 * There is no hardcoded seed data here — the database is the source of truth.
 */

export type JobStatusSchema = 'Planned' | 'Running' | 'Completed' | 'Hold';

export interface MachineMasterRow {
  machine_no: string;   // e.g. "MAC-01"
  gob_type: string;     // e.g. "Triple Gob" | "Double Gob"
  gob_count: number;    // e.g. 3 or 2
  max_section: number;  // e.g. 8 or 10
}

export interface BottleMasterRow {
  bottle_id: string;    // e.g. "123" (integer from DB as string)
  bottle_name: string;  // e.g. "100 ml Dropper"
  weight?: number;      // grams, shared by every machine (null on legacy rows)
}

/**
 * One saved parent -> child relationship.
 *
 * Mirrors the backend ParentChildMappingResponse. Both sides are resolved
 * through production.bottle_master.group_id, so every id here is the real
 * bottle_id stored in the database and the names come from the same row
 * (no second lookup, no browser storage).
 *
 * `id` is the child bottle_id: a child bottle has at most one parent, so it
 * uniquely identifies the mapping.
 */
export interface ParentChildMappingRow {
  id: string;
  parentBottleId: string;
  parentBottleName: string;
  childBottleId: string;
  childBottleName: string;
}

export interface BottleConfigurationRow {
  machine_no: string;   // e.g. "MAC-01"
  bottle_id: string;    // e.g. "123"
  section: number;      // e.g. 8
  weight: number;       // grams, e.g. 97
  speeds: number;       // cuts per minute, e.g. 118.5
}

export interface ProductionJobRow {
  job_id?: string;                      // FK to job_master.job_id (backend-generated, never frontend-generated)
  plan_date: string;              // "YYYY-MM-DD"
  machine_no: string;             // "MAC-01"
  bottle_id: string;              // "123"
  section: number;
  weight: number;
  speeds: number;
  draw: number;
  quantity: number;
  production_hours?: number;
  start_time: string;
  requiredBottles?: number;             // "HH:MM"
  estimated_completion: string;   // "YYYY-MM-DDTHH:MM:00"
  completion_time?: string;       // "YYYY-MM-DDTHH:MM:00"
  changeover_minutes?: number;
  status: JobStatusSchema;
  packaging?: JobPackagingRow[];
}

export interface JobPackagingRow {
  plan_date: string;
  machine_no: string;
  bottle_id: string;
  section: number;
  start_time: string;
  packaging_type: string;
  quantity: number;
  pallet_packing: string;
  pallet_quantity: number;
}
