import { useReducer, useEffect, useCallback, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { AppContext, appReducer, initialState, useApp } from './store';
import { canAutoStartBackend, healthCheck, startBackend } from './api';
import { ProjectPersistenceContext, useProjectControls, useProjectPersistence } from './useProjectPersistence';
import ProjectBar from './components/ProjectBar';
import ChatPanel from './components/ChatPanel';
import CanvasPanel from './components/CanvasPanel';
import JobProgress from './components/JobProgress';
import EditPlanPanel from './components/EditPlanPanel';
import StylePanel from './components/StylePanel';
import HighlightsPanel from './components/HighlightsPanel';

interface AppMainContentProps {
  onRetryBackend: () => void;
  retryingBackend: boolean;
}

export function AppMainContent({ onRetryBackend, retryingBackend }: AppMainContentProps) {
  const { state, dispatch } = useApp();
  const project = useProjectControls();
  const [instructionsCollapsed, setInstructionsCollapsed] = useState(() => window.innerWidth <= 1100);

  if (project && !project.ready) return <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
    {project.status === 'error' ? 'Project restoration stopped. Retry restore above to keep your saved work safe.'
      : state.backendOnline ? 'Restoring your project…' : 'Waiting for the local backend…'}
    {!state.backendOnline ? <button type="button" disabled={retryingBackend} onClick={onRetryBackend}
      className="ml-3 text-accent">Reconnect backend</button> : null}
  </div>;

  return (
    <div className="flex flex-1 min-w-0 min-h-0" inert={project?.transitioning || project?.recoveryRequired || undefined}>
      {/* Left: Chat Panel */}
      <ChatPanel onRetryBackend={onRetryBackend} retryingBackend={retryingBackend}
        collapsed={instructionsCollapsed} onToggle={() => setInstructionsCollapsed((collapsed) => !collapsed)} />

      {/* Right: Video Canvas */}
      {state.mediaStatus === 'missing' ? <div className="min-w-0 flex-1 flex items-center justify-center p-4 text-sm text-text-secondary">
        {state.videoInfo?.original_name} · Source unavailable
      </div> : <CanvasPanel onOpenInstructions={() => setInstructionsCollapsed(false)} />}
      {state.videoId ? (
        <aside className="w-[280px] flex-shrink-0 border-l border-border bg-bg-panel flex flex-col min-h-0" aria-label="Editing tools">
          <nav className="flex border-b border-border p-2 gap-1 shrink-0" aria-label="Editing panels">
            {(['edit', 'style', 'highlights'] as const).map((tab) => (
              <button key={tab} type="button" aria-pressed={state.sidebarTab === tab}
                onClick={() => dispatch({ type: 'SET_SIDEBAR_TAB', tab })}
                className="min-h-8 flex-1 rounded border border-transparent px-2 text-ui capitalize text-text-secondary hover:bg-bg-surface aria-pressed:border-border-strong aria-pressed:bg-bg-surface aria-pressed:text-text-primary transition-colors">{tab}</button>
            ))}
          </nav>
          <fieldset disabled={state.mediaStatus === 'missing'} className="flex-1 min-h-0 min-w-0 overflow-y-auto border-0 p-0 m-0">
            {state.sidebarTab === 'style' ? <StylePanel /> : state.sidebarTab === 'highlights' ? <HighlightsPanel />
              : state.editPlan ? <EditPlanPanel />
              : <p className="p-4 text-sm text-text-secondary">Choose a source range below the canvas, or enter an editing instruction.</p>}
          </fieldset>
        </aside>
      ) : null}
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const project = useProjectPersistence(state, dispatch);
  const [retryingBackend, setRetryingBackend] = useState(false);

  const markBackendOnline = useCallback(() => {
    dispatch({ type: 'SET_BACKEND_STATE', status: 'online', error: null });
  }, []);

  const markBackendOffline = useCallback((error: string) => {
    dispatch({ type: 'SET_BACKEND_STATE', status: 'offline', error });
  }, []);

  const bootstrapBackend = useCallback(async () => {
    dispatch({ type: 'SET_BACKEND_STATE', status: 'checking', error: null });
    const online = await healthCheck();
    if (online) { markBackendOnline(); return; }
    if (!canAutoStartBackend()) {
      markBackendOffline('Start `cutai server --host 127.0.0.1 --port 18910` to connect.');
      return;
    }
    dispatch({ type: 'SET_BACKEND_STATE', status: 'starting', error: null });
    try {
      await startBackend();
      markBackendOnline();
    } catch (error) {
      markBackendOffline(error instanceof Error ? error.message : 'Failed to start backend.');
    }
  }, [markBackendOffline, markBackendOnline]);

  const retryBackend = useCallback(async () => {
    setRetryingBackend(true);
    try { await bootstrapBackend(); } finally { setRetryingBackend(false); }
  }, [bootstrapBackend]);

  useEffect(() => { void bootstrapBackend(); }, [bootstrapBackend]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const online = await healthCheck();
      if (online) { markBackendOnline(); return; }
      if (state.backendOnline) markBackendOffline('Lost connection to backend.');
    }, 10000);
    return () => clearInterval(interval);
  }, [markBackendOffline, markBackendOnline, state.backendOnline]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <ProjectPersistenceContext.Provider value={project}>
      <div className="flex flex-col h-screen w-screen bg-bg-base overflow-hidden">
        <ProjectBar />
        {/* Error toast */}
        {state.error && (
          <div role="alert" className="absolute top-14 left-1/2 -translate-x-1/2 z-50 flex max-w-[calc(100%-2rem)] items-center gap-2 px-4 py-2 bg-bg-panel border border-error rounded-md text-error text-ui">
            <AlertCircle size={12} />
            <span className="font-medium">{state.error}</span>
            <button aria-label="Dismiss error" onClick={() => dispatch({ type: 'SET_ERROR', error: null })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-bg-surface ml-1"><X size={16} /></button>
          </div>
        )}

        <AppMainContent onRetryBackend={retryBackend} retryingBackend={retryingBackend} />
        <JobProgress />
      </div>
      </ProjectPersistenceContext.Provider>
    </AppContext.Provider>
  );
}
