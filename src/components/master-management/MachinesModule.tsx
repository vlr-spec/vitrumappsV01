import React, { useEffect, useState, useCallback } from 'react';
import { FlaskConical, CalendarDays, Package } from 'lucide-react';
import { planningRepository } from '../../services/planningRepository';
import { MachineMasterRow, BottleMasterRow, BottleConfigurationRow } from '../../data/planningSchema';
import { BottleMasterPanel } from './BottleMasterPanel';
import { HolidayMasterPanel } from './HolidayMasterPanel';
import { PackagingMasterPanel } from './PackagingMasterPanel';
import { useAuth, MODULES } from '../../context/AuthContext';

type MasterTabId = 'bottle' | 'holiday' | 'packaging';

interface MasterTab {
  id: MasterTabId;
  label: string;
  icon: React.ReactNode;
}

const MASTER_TABS: MasterTab[] = [
  { id: 'bottle', label: 'Bottle Master', icon: <FlaskConical size={16} /> },
  { id: 'holiday', label: 'Holiday Master', icon: <CalendarDays size={16} /> },
  { id: 'packaging', label: 'Packaging Master', icon: <Package size={16} /> },
];

export const MachinesModule: React.FC = () => {
  const { hasPermission } = useAuth();
  const [machineRows, setMachineRows] = useState<MachineMasterRow[]>([]);
  const [bottles, setBottles] = useState<BottleMasterRow[]>([]);
  const [configs, setConfigs] = useState<BottleConfigurationRow[]>([]);
  const [activeTab, setActiveTab] = useState<MasterTabId>('bottle');

  const availableTabs = MASTER_TABS.filter((tab) => {
    switch (tab.id) {
      case 'bottle':
        return hasPermission(MODULES.BOTTLE_MASTER, 'read');
      case 'holiday':
        return hasPermission(MODULES.HOLIDAY_MASTER, 'read');
      // Packaging Master has no module_master row of its own: it is a panel of
      // Master Management, so it is readable by anyone who can read a Master
      // Management child module (the same derivation that reveals the parent
      // module in the sidebar). Writes inside the panel are checked separately.
      case 'packaging':
        return (
          hasPermission(MODULES.BOTTLE_MASTER, 'read') ||
          hasPermission(MODULES.HOLIDAY_MASTER, 'read')
        );
      default:
        return false;
    }
  });

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.some((t) => t.id === activeTab)) {
      setActiveTab(availableTabs[0].id);
    }
  }, [availableTabs, activeTab]);

  const refresh = useCallback(() => {
    setMachineRows(planningRepository.getMachines());
    setBottles(planningRepository.getBottles());
    setConfigs(planningRepository.getAllConfigurations());
  }, []);

  const fullInit = useCallback(() => {
    planningRepository.init().then(refresh);
  }, [refresh]);

  useEffect(() => {
    fullInit();
  }, [fullInit]);

  if (availableTabs.length === 0) return null;

  return (
    <div className="p-4 md:p-6 max-w-[1920px] mx-auto min-h-[calc(100vh-9rem)]">
      {/* Master tab navigation */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-200">
        {availableTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active master panel */}
      {activeTab === 'bottle' && (
        <BottleMasterPanel
          machines={machineRows}
          bottles={bottles}
          configs={configs}
          onRefresh={refresh}
        />
      )}
      {activeTab === 'holiday' && <HolidayMasterPanel />}
      {activeTab === 'packaging' && <PackagingMasterPanel />}
    </div>
  );
};
