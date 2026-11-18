export type SectionType = 'Single Gob' | 'Double Gob' | 'Triple Gob' | 'Quad Gob';

export type JobStatus = 'Planned' | 'Running' | 'Completed' | 'Hold' | 'Pending' | 'Changeover';

export type JobPriority = 'Low' | 'Medium' | 'High' | 'Urgent';

export type PlanningLifecycleStatus = 'ACTIVE' | 'COMPLETED';

export type PackingCategory = 'Palletized' | 'Carton Pack' | 'Shrink Wrapped' | 'Bulk Tray';

export type PalletType = 'Wooden Standard (1200x1000)' | 'Euro Pallet (1200x800)' | 'Plastic Heavy Duty' | 'Heat Treated Export';

export interface BottleMasterRecord {
  id: string;
  mch: string; // Machine Name e.g. "Machine No. 1" or ID "MAC-01"
  bottleName: string; // e.g. "750ml Bordeaux Wine Heavy"
  section: number; // e.g. 6, 7, 8, 9, 10
  weightGrams: number; // Wt (grams)
  speed: number; // Speeds (cuts per min)
  drawingNumber?: string;
  capacityMl?: number;
  customerName?: string;
  category?: 'Wine' | 'Beer' | 'Spirits' | 'Pharma' | 'Beverage' | 'Food Jar';
}

export interface BottleMaster {
  id: string;
  name: string;
  drawingNumber: string;
  weightGrams: number;
  capacityMl: number;
  sectionType: SectionType;
  standardCutPerMin: number;
  customerName: string;
  category: 'Wine' | 'Beer' | 'Spirits' | 'Pharma' | 'Beverage' | 'Food Jar';
}

export interface ISMachine {
  id: string;
  name: string;
  code: string;
  gobCount: number;
  sectionsCount: number; // Current active section count
  defaultSectionsCount: number; // Default section count (8 or 10)
  availableSections: number[]; // Configurable section options e.g. [6,7,8] or [8,9,10]
  sectionType: SectionType;
  status: 'Running' | 'Stopped' | 'Maintenance' | 'Changeover';
  currentJobId?: string;
  feederTemperatureC: number; // e.g. 1180°C
  gobCutSpeed: number; // cuts per min
  oeePercent: number; // e.g. 88.5%
  packRatePercent: number; // e.g. 89.2%
  dailyTargetTons: number;
}

export interface ProductionJob {
  id: string;
  // FK to job_master.job_id when loaded from the backend.
  jobId?: string;
  jobNumber: string; // e.g. JOB-2026-089
  machineId: string;
  bottleId: string;
  customerName: string;
  sectionCount: number; // Sections used
  weightGrams: number;
  cutPerMin: number;
  grossQuantity: number; // Target quantity in pcs
  producedQuantity: number; // Actual produced so far
  remainingQuantity: number;
  drawTonsPerDay: number; // Calculated tons/day
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  status: JobStatus;
  priority: JobPriority;
  packingCategory: PackingCategory;
  palletType: PalletType;
  changeoverHours?: number; // e.g. 4.5 hours if Changeover
  remarks?: string;

  // Scheduler-specific fields (single-day planning unit)
  date?: string; // YYYY-MM-DD
  startTime?: string; // HH:mm
  expectedEndTime?: string; // HH:mm
  completionTime?: string; // Actual completion from backend (YYYY-MM-DDTHH:mm)
  productionQuantity?: number; // Planned quantity for this specific day job
  productionHours?: number; // Planned production hours for this specific day job (max 24)
  requiredBottles?: number | null; // User-entered Required Bottles / Quantity for this job
  linkedJobGroupId?: string;
  sequenceNumber?: number; // Vertical stack order inside machine-day cell
  lifecycleStatus?: PlanningLifecycleStatus;
  locked?: boolean;
  packaging?: { packaging_type: string; quantity: number; pallet_packing: string; pallet_quantity: number; }[];
}

export interface DailyPlanningEntry {
  date: string; // YYYY-MM-DD
  machineId: string;
  jobId: string;
  bottleName: string;
  drawingNumber: string;
  section: number;
  weightGrams: number;
  cutPerMin: number;
  dayQuantity: number;
  drawTons: number;
  status: JobStatus;
  changeoverHours?: number;
}

/**
 * A module currently shown by the application. The first members are the
 * built-in screens; the trailing `string` arm allows any module registered in
 * the database module master to be navigated to without a type change, so new
 * modules are supported without rewriting routing code.
 */
export type ActiveModule =
  | 'Dashboard'
  | 'Production Planning'
  | 'Master Management'
  | 'Quality Control'
  | 'Reports'
  | 'Settings'
  | 'Profile'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | (string & {});
