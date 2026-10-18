import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** Which state of the model the Explorer shows: a date and/or a scenario (see ModelView). */
export interface ViewState {
  asOf: string;
  scenario: string;
}

const EMPTY: ViewState = { asOf: '', scenario: '' };
const KEY = 'd4.view';

const ViewContext = createContext<{ view: ViewState; setView(v: ViewState): void }>({ view: EMPTY, setView: () => {} });

function stored(): ViewState {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<ViewState> | null;
    return { asOf: typeof v?.asOf === 'string' ? v.asOf : '', scenario: typeof v?.scenario === 'string' ? v.scenario : '' };
  } catch {
    return EMPTY;
  }
}

/** Kept per browser tab, so the chosen date and scenario survive navigation and reloads. */
export function ViewProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [view, setView] = useState<ViewState>(stored);
  // A scenario belongs to one workspace: clear it when the workspace changes (not on first load).
  const lastWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (lastWorkspace.current === workspaceId) return;
    lastWorkspace.current = workspaceId;
    setView((v) => (v.scenario ? { ...v, scenario: '' } : v));
  }, [workspaceId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(view));
    } catch {
      /* storage unavailable: the view still works for this page */
    }
  }, [view]);
  return <ViewContext.Provider value={{ view, setView }}>{children}</ViewContext.Provider>;
}

export const useView = () => useContext(ViewContext);

/** Query-string values for the API (`asOf`, `scenario`); empty values are left out. */
export const viewQuery = (v: ViewState) => ({ asOf: v.asOf || undefined, scenario: v.scenario || undefined });
export const isBaselineToday = (v: ViewState) => !v.asOf && !v.scenario;
