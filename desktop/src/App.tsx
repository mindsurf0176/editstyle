import { useReducer, useEffect, useCallback, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { AppContext, appReducer, initialState, useApp } from './store';
import type { AppState } from './store';
import { canAutoStartBackend, healthCheck, startBackend } from './api';
import { initializeAppState, persistPreviewResolution } from './previewResolutionStorage';
import {
  initializeRecentOutputHistoryState,
  persistRecentOutputs,
} from './recentOutputHistoryStorage';
import { initializeRenderPresetState, persistRenderPreset } from './renderPresetStorage';
import {
  initializeSubtitleExportModeState,
  persistSubtitleExportMode,
} from './subtitleExportModeStorage';
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

  return (
    <div className="flex flex-1 h-full min-h-0">
      {/* Left: Chat Panel */}
      <ChatPanel onRetryBackend={onRetryBackend} retryingBackend={retryingBackend} />

      {/* Right: Video Canvas */}
      <CanvasPanel />
      {state.videoId ? (
        <aside className="w-80 flex-shrink-0 border-l border-border bg-bg-panel flex flex-col min-h-0" aria-label="Editing tools">
          <nav className="flex border-b border-border p-2 gap-2" aria-label="Editing panels">
            {(['edit', 'style', 'highlights'] as const).map((tab) => (
              <button key={tab} type="button" aria-pressed={state.sidebarTab === tab}
                onClick={() => dispatch({ type: 'SET_SIDEBAR_TAB', tab })}
                className="px-2 py-1 text-xs capitalize text-text-secondary aria-pressed:text-accent">{tab}</button>
            ))}
          </nav>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {state.sidebarTab === 'style' ? <StylePanel /> : state.sidebarTab === 'highlights' ? <HighlightsPanel />
              : state.editPlan ? <EditPlanPanel />
              : <p className="p-4 text-xs text-text-muted">Choose a source range below the canvas, or enter an editing instruction.</p>}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(
    appReducer,
    initialState,
    (baseState: AppState) =>
      initializeSubtitleExportModeState(
        initializeRenderPresetState(
          initializeRecentOutputHistoryState(
            initializeAppState(
              baseState,
              typeof window === 'undefined' ? undefined : window.localStorage
            ),
            typeof window === 'undefined' ? undefined : window.localStorage
          ),
          typeof window === 'undefined' ? undefined : window.localStorage
        ),
        typeof window === 'undefined' ? undefined : window.localStorage
      )
  );
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

  useEffect(() => { persistPreviewResolution(typeof window === 'undefined' ? undefined : window.localStorage, state.previewResolution); }, [state.previewResolution]);
  useEffect(() => { persistRenderPreset(typeof window === 'undefined' ? undefined : window.localStorage, state.renderPreset); }, [state.renderPreset]);
  useEffect(() => { persistSubtitleExportMode(typeof window === 'undefined' ? undefined : window.localStorage, state.subtitleExportMode); }, [state.subtitleExportMode]);
  useEffect(() => { persistRecentOutputs(typeof window === 'undefined' ? undefined : window.localStorage, state.recentOutputs); }, [state.recentOutputs]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <div className="flex flex-col h-screen w-screen bg-bg-base overflow-hidden">
        {/* Error toast */}
        {state.error && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 bg-error/10 border border-error/20 rounded-lg text-error text-xs">
            <AlertCircle size={12} />
            <span className="font-medium">{state.error}</span>
            <button onClick={() => dispatch({ type: 'SET_ERROR', error: null })} className="p-0.5 rounded hover:bg-error/20 ml-1"><X size={10} /></button>
          </div>
        )}

        <AppMainContent onRetryBackend={retryBackend} retryingBackend={retryingBackend} />
        <JobProgress />
      </div>
    </AppContext.Provider>
  );
}
