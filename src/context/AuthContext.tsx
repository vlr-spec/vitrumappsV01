import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';

export type ModulePermission = { read: boolean; edit: boolean };

/**
 * A row from the database module master (auth.module_master).
 * The catalog is fetched from the backend so newly registered modules are
 * picked up automatically - nothing module-specific is hardcoded here.
 */
export interface ModuleInfo {
  module_id: number;
  module_name: string;
  parent_module_id: number | null;
  is_active: boolean;
}

/**
 * Module identifiers used by screens to name the module_master row they belong
 * to. These are NAME keys only - permission values always come from the
 * database. `Master Management` is intentionally absent: it is a parent module
 * whose access is derived from its children via `parent_module_id`.
 */
export const MODULES = {
  PRODUCTION_PLANNING: 'Production Planning',
  QUALITY_CONTROL: 'Quality Control',
  BOTTLE_MASTER: 'Bottle Master',
  HOLIDAY_MASTER: 'Holiday Master',
} as const;

/**
 * Screen names that are not module_master rows but still belong to one.
 * Resorting owns Numbering, SQC/QC HOLD and Resorting Logs, so it follows
 * Quality Control (module_id = 2) -- there is no separate Resorting module.
 */
export const SCREEN_MODULE_ALIASES: Record<string, string> = {
  Resorting: MODULES.QUALITY_CONTROL,
};

const resolveModuleName = (module: string): string => SCREEN_MODULE_ALIASES[module] ?? module;

/** Modules that belong to the application shell (no module_master row). */
export const APP_MODULES = ['Dashboard', 'Settings', 'Profile'];

export interface AuthUser {
  employee_id: string;
  employee_name: string;
  department: string;
  email: string;
  phone_number: string;
  role: 'Editor' | 'Viewer';
  modules: ModuleInfo[];
  permissions: Record<string, ModulePermission>;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  /** Live module catalog from module_master (empty until the user resolves). */
  modules: ModuleInfo[];
  /** Direct read/edit check for one module (edit always implies read). */
  hasPermission: (module: string, access: 'read' | 'edit') => boolean;
  /**
   * Read check for a module AND every descendant of it, derived from the
   * module_master hierarchy. A parent module (e.g. "Master Management")
   * becomes visible when any child module is readable - no hardcoded lists.
   */
  canReadModule: (module: string) => boolean;
  /** Re-reads module catalog + permissions from the database. */
  refreshPermissions: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  signup: (
    details: Omit<AuthUser, 'role' | 'permissions' | 'modules'> & {
      password: string;
      role: AuthUser['role'];
    }
  ) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** How often the logged-in client re-reads permissions from the backend. */
const PERMISSION_REFRESH_MS = 60_000;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const userRef = useRef<AuthUser | null>(null);
  userRef.current = user;

  useEffect(() => {
    if (!localStorage.getItem('authToken')) {
      setIsLoading(false);
      return;
    }
    apiFetch('/api/auth/me')
      .then((me) => setUser({ ...me, modules: me.modules ?? [], permissions: me.permissions ?? {} }))
      .catch(() => localStorage.removeItem('authToken'))
      .finally(() => setIsLoading(false));
  }, []);

  /**
   * Permission changes are database changes: re-reading them on an interval
   * (and whenever the tab regains focus) means an admin edit takes effect in
   * a running app without any rebuild or redeploy.
   */
  const refreshPermissions = useCallback(async () => {
    if (!userRef.current) return;
    try {
      const access = await apiFetch('/api/auth/permissions');
      setUser((prev) =>
        prev
          ? {
              ...prev,
              modules: access.modules ?? prev.modules ?? [],
              permissions: access.permissions ?? {},
            }
          : prev
      );
    } catch {
      // Session expiry surfaces on the next API call; keep the current state.
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => void refreshPermissions(), PERMISSION_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshPermissions();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, refreshPermissions]);

  /**
   * `identifier` is the Employee ID, email address or mobile number the user
   * typed on the login form. The backend resolves any of the three against
   * auth.users, so the value is sent through as-is.
   */
  const login = async (identifier: string, password: string) => {
    const result = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ user_id: identifier, password }) });
    localStorage.setItem('authToken', result.token);
    setUser({ ...result.user, modules: result.user.modules ?? [], permissions: result.user.permissions ?? {} });
  };

  const signup = async (
    details: Omit<AuthUser, 'role' | 'permissions' | 'modules'> & { password: string; role: AuthUser['role'] }
  ) => {
    await apiFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify(details) });
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
  };

  /**
   * Single source of truth: the module permission rows returned by the backend.
   * can_edit never grants anything when can_read is false.
   */
  const hasPermission = (module: string, access: 'read' | 'edit') => {
    if (!user) return false;
    const perm = user.permissions?.[resolveModuleName(module)];
    if (!perm) return false;
    if (access === 'read') return perm.read;
    return perm.read && perm.edit;
  };

  const canReadModule = (module: string): boolean => {
    if (!user) return false;
    const masterModule = resolveModuleName(module);
    if (hasPermission(masterModule, 'read')) return true;

    const modules = user.modules ?? [];
    const byId = new Map<number, ModuleInfo>(modules.map((m) => [m.module_id, m]));

    // Readable descendants make an ancestor (parent) module readable too.
    return modules.some((child) => {
      if (child.module_name === masterModule || !hasPermission(child.module_name, 'read')) return false;
      let parent = child.parent_module_id != null ? byId.get(child.parent_module_id) : undefined;
      while (parent) {
        if (parent.module_name === masterModule) return true;
        parent = parent.parent_module_id != null ? byId.get(parent.parent_module_id) : undefined;
      }
      return false;
    });
  };

  const logout = async () => {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } finally {
      localStorage.removeItem('authToken');
      setUser(null);
      if (typeof window !== 'undefined' && window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        modules: user?.modules ?? [],
        hasPermission,
        canReadModule,
        refreshPermissions,
        login,
        signup,
        changePassword,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
