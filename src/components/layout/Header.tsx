import React, { useState } from 'react';
import {
  ChevronDown,
  Layers,
  Menu,
  User,
  Settings,
  LogOut,
} from 'lucide-react';
import { useERP } from '../../context/ERPContext';
import officialLogo from '../../assets/logo';
import { useAuth } from '../../context/AuthContext';
import { MOBILE_SIDEBAR_EVENT } from './Sidebar';

export const Header: React.FC = () => {
  const {
    activeModule,
    setActiveModule,
  } = useERP();
  const { user, logout } = useAuth();

  const [showUserDropdown, setShowUserDropdown] = useState(false);
  // const [showSearchResults, setShowSearchResults] = useState(false);

  const userName = user?.employee_name ?? 'User';
  const userRole = user?.role ?? 'Employee';
  const userEmail = user?.email ?? 'No email provided';
  const userDepartment = user?.department ?? 'General';
  const userInitials = userName
    .split(' ')
    .filter(Boolean)
    .map((name) => name[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'U';

  return (
    <header className="app-header h-16 bg-white border-b border-slate-200 px-4 md:px-6 flex items-center justify-between sticky top-0 z-40 shadow-xs">
      {/* Left: Brand Logo & Title */}
      <div className="flex items-center gap-2">
        {/* Mobile-only hamburger: opens the sidebar drawer (hidden on desktop). */}
        <button
          type="button"
          className="mobile-nav-toggle"
          aria-label="Open navigation"
          title="Open navigation"
          onClick={() => window.dispatchEvent(new Event(MOBILE_SIDEBAR_EVENT))}
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="brand-block flex items-center gap-3 min-w-56">
          <div className="w-15 h-10 flex items-center justify-center overflow-hidden shadow-xs">
            <img src={officialLogo} alt="Empire Industries" className="w-full h-full object-contain" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900 leading-none tracking-tight">VITRUM GLASS</h1>
            <span className="brand-sub text-[10px] uppercase font-semibold text-slate-400 tracking-wider">
              ERP SYSTEM
            </span>
          </div>
        </div>
      </div>

      {/* Center: Current Module Name */}
      <div className="hidden md:flex items-center justify-center flex-1">
        <h2 className="text-3xl font-bold text-blue-900 bg-slate-50 px-5 py-1.5 rounded-full border border-slate-200/80">
          {activeModule === 'Quality Control' ? 'Hourly Production Report' : activeModule}
        </h2>
      </div>

      {/* Right: Search, Profile */}
      <div className="flex items-center gap-3">

        {/* User Profile Avatar & Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowUserDropdown(!showUserDropdown)}
            className="flex items-center gap-2.5 p-1 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <div className="w-8 h-8 rounded-full bg-blue-600 text-white font-bold text-xs flex items-center justify-center ring-2 ring-blue-100">
              {userInitials}
            </div>
            <div className="hidden lg:block text-left">
              <p className="text-xs font-semibold text-slate-900 leading-tight">{userName}</p>
              <p className="text-[10px] text-slate-400 leading-tight">{userRole}</p>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>

          {showUserDropdown && (
            <div className="absolute right-0 top-11 w-64 bg-white border border-slate-200 rounded-xl shadow-xl z-50 p-2 animate-in fade-in-50">
              <div className="p-2 border-b border-slate-100">
                <p className="text-xs font-bold text-slate-900">{userName}</p>
                <p className="text-[11px] text-slate-500">{userEmail}</p>
                <span className="inline-block mt-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-semibold">
                  {userDepartment}
                </span>
              </div>

              <div className="py-1">
                <button
                  onClick={() => {
                    setActiveModule('Profile');
                    setShowUserDropdown(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  <User className="w-4 h-4 text-slate-400" />
                  Profile Details
                </button>

                <button
                  onClick={() => {
                    setActiveModule('Settings');
                    setShowUserDropdown(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  <Settings className="w-4 h-4 text-slate-400" />
                  Settings
                </button>
              </div>

              <div className="pt-1 border-t border-slate-100">
                <button
                  onClick={() => {
                    setShowUserDropdown(false);
                    void logout();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out of ERP
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
