/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ERPProvider, useERP } from './context/ERPContext';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
// import { DashboardModule } from './components/dashboard/DashboardModule';
import { PlanningModule } from './components/planning/PlanningModule';
import { MachinesModule } from './components/master-management/MachinesModule';
import { QualityControlModule } from './components/quality/ProductionQualityMonitor';
import { SettingsModule } from './components/settings/SettingsModule';
import { ProfileModule } from './components/profile/ProfileModule';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ModulePlaceholder } from './components/common/ModulePlaceholder';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './components/auth/LoginPage';

/** Screens with a dedicated implementation. Anything else (e.g. a module that
 *  was registered in module_master after this build) renders the generic
 *  placeholder below, still behind the same database-driven read check. */
const BUILT_IN_MODULES = [
  'Dashboard',
  'Production Planning',
  'Master Management',
  'Quality Control',
  'Settings',
  'Profile',
];

const MainLayout: React.FC = () => {
  const { activeModule } = useERP();

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col font-sans text-slate-900 antialiased selection:bg-blue-500 selection:text-white">
      {/* Top Navigation Header */}
      <Header />

      {/* Main Body with Collapsible Sidebar & Content Workspace */}
      <div className="app-body flex flex-1 overflow-hidden">
        <Sidebar />

        <main className="app-main flex-1 overflow-y-auto bg-[#F8FAFC] pb-6 flex flex-col justify-between">
          <ErrorBoundary>
            {/* {activeModule === 'Dashboard' && <DashboardModule />} */}
            {activeModule === 'Production Planning' && <PlanningModule />}
            {activeModule === 'Master Management' && <MachinesModule />}
            {activeModule === 'Quality Control' && <QualityControlModule />}
            {activeModule === 'Settings' && <SettingsModule />}
            {activeModule === 'Profile' && <ProfileModule />}
            {!BUILT_IN_MODULES.includes(activeModule) && (
              <ModulePlaceholder moduleName={activeModule} />
            )}
          </ErrorBoundary>

          {/* Footer Status Bar matching Professional Polish theme */}
          {/* <div className="mx-4 md:mx-6 mt-6 flex items-center gap-6 py-2 px-4 bg-slate-800 text-white text-[10px] uppercase font-bold tracking-widest rounded-lg shadow-sm">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              Factory System Live
            </div>
            <div className="opacity-50 text-white">•</div>
            <div>Sync Status: Cloud Updated</div>
            <div className="opacity-50 text-white">•</div>
            <div>Shift: Morning (06:00 - 14:00)</div>
            <div className="ml-auto opacity-70">v3.4.1 Production Core</div>
          </div> */}
        </main>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}

const AuthenticatedApp: React.FC = () => {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="min-h-screen bg-slate-100" />;
  if (!user) return <LoginPage />;
  return <ERPProvider><MainLayout /></ERPProvider>;
};
