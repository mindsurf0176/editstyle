import { useState, useRef, useEffect } from 'react';
import { Send, Upload, Scissors, Subtitles, Clapperboard, Wand2, RefreshCw, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useApp } from '../store';
import { createPlan, uploadVideo, getVideoInfo, analyzeVideo } from '../api';
import { useProjectControls } from '../useProjectPersistence';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

const SUGGESTIONS = [
  { icon: Scissors, text: 'Remove all silent parts' },
  { icon: Subtitles, text: 'Add subtitles' },
  { icon: Clapperboard, text: 'Make it cinematic' },
  { icon: Wand2, text: 'Speed up boring parts' },
];

interface ChatPanelProps {
  onRetryBackend: () => void;
  retryingBackend: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}

export default function ChatPanel({ onRetryBackend, retryingBackend, collapsed = false, onToggle }: ChatPanelProps) {
  const { state, dispatch } = useApp();
  const project = useProjectControls();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const revisionRef = useRef(state.editRevision);
  revisionRef.current = state.editRevision;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const jobBusy = state.activeJob?.status === 'running' || state.activeJob?.status === 'pending';
  const busy = loading || uploading || jobBusy || Boolean(project && (!project.ready || project.transitioning));
  const sourceAvailable = state.mediaStatus !== 'missing';

  useEffect(() => { setMessages([]); setInput(''); }, [state.videoId]);

  useEffect(() => {
    if (collapsed) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    messagesEndRef.current?.scrollIntoView?.({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
  }, [messages, collapsed]);

  const addMessage = (role: ChatMessage['role'], content: string) => {
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role, content, timestamp: new Date() }]);
  };

  const handleUpload = async (file: File) => {
    if (busy || !state.backendOnline) return;
    if (!file.type.startsWith('video/')) {
      addMessage('system', 'Please select a video file.');
      return;
    }
    addMessage('system', `Uploading ${file.name}...`);
    setUploading(true);
    dispatch({ type: 'SET_UPLOAD_PROGRESS', progress: 0 });
    try {
      const onProgress = (progress: number) => {
        dispatch({ type: 'SET_UPLOAD_PROGRESS', progress });
      };
      const imported = project ? await project.importVideo(file, onProgress) : null;
      if (project && !imported) return;
      const video_id = imported?.video_id ?? (await uploadVideo(file, onProgress)).video_id;
      const videoInfo = imported?.video_info ?? await getVideoInfo(video_id);
      if (!project) dispatch({ type: 'SET_VIDEO', videoId: video_id, videoInfo });
      dispatch({ type: 'SET_TRANSCRIBE_ON_IMPORT', enabled: state.transcribeOnImport });
      addMessage('assistant', `${file.name} loaded (${Math.round(videoInfo.duration)}s, ${videoInfo.width}×${videoInfo.height}). Analyzing scenes${state.transcribeOnImport ? ' and speech' : ' without transcription'}…`);
      const { job_id } = await analyzeVideo(video_id, state.transcribeOnImport);
      dispatch({ type: 'SET_ACTIVE_JOB', videoId: video_id, job: { job_id, type: 'analysis', status: 'running', progress: 0 } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      addMessage('system', `❌ ${msg}`);
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSend = async (text?: string) => {
    const instruction = text || input;
    if (!instruction.trim() || busy || !sourceAvailable || !state.backendOnline) return;
    if (!text) setInput('');

    addMessage('user', instruction);

    if (!state.videoId) {
      addMessage('assistant', 'Drop a video first, then I can edit it for you.');
      return;
    }
    if (!state.analysis) {
      addMessage('assistant', 'Wait for video analysis to finish before requesting a plan.');
      return;
    }

    setLoading(true);
    try {
      const revision = state.editRevision;
      const plan = await createPlan(state.videoId, instruction, { stylePreset: state.planningStylePreset?.file ?? state.planningStylePreset?.name });
      if (revisionRef.current !== revision) throw new Error('The edit changed while planning. Please send the instruction again.');
      if (plan.operations.some((operation) => operation.type === 'subtitle') && state.analysis.transcript.length === 0) {
        throw new Error('Subtitles need a transcript. Enable speech transcription and import the video again.');
      }
      dispatch({ type: 'APPLY_PLAN_PROPOSAL', plan, revision });
      dispatch({ type: 'SET_SIDEBAR_TAB', tab: 'edit' });
      dispatch({ type: 'SET_VIEW', view: 'editor' });

      const opSummary = plan.operations.map((op: { type: string; description?: string }) => `• ${op.type}: ${op.description || ''}`).join('\n');
      addMessage('assistant', plan.operations.length > 0 ? `Added to the edit plan:\n\n${opSummary}\n\nReview the operations or generate a preview.` : plan.summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create plan';
      addMessage('assistant', `Sorry, something went wrong: ${msg}`);
      dispatch({ type: 'SET_ERROR', error: msg });
    } finally {
      setLoading(false);
    }
  };

  const retryAnalysis = async () => {
    if (!state.videoId || busy || !sourceAvailable || !state.backendOnline) return;
    setLoading(true);
    try {
      const { job_id } = await analyzeVideo(state.videoId, state.transcribeOnImport);
      dispatch({ type: 'SET_ACTIVE_JOB', videoId: state.videoId,
        job: { job_id, type: 'analysis', status: 'running', progress: 0 } });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', error: error instanceof Error ? error.message : 'Analysis could not start.' });
    } finally { setLoading(false); }
  };

  const isEmpty = messages.length === 0;

  return (
    <aside aria-label="AI instructions" className={`${collapsed ? 'w-12' : 'w-[260px]'} flex flex-col bg-bg-panel border-r border-border flex-shrink-0 min-h-0`}>
      {/* Header */}
      <div className={`h-12 flex items-center ${collapsed ? 'justify-center' : 'justify-between px-3'} border-b border-border flex-shrink-0`}>
        {!collapsed ? <h2 className="text-ui font-medium text-text-primary">AI instructions</h2> : null}
        <button ref={toggleRef} type="button" onClick={() => { onToggle?.(); toggleRef.current?.focus(); }}
          aria-label={collapsed ? 'Expand AI instructions' : 'Collapse AI instructions'}
          aria-expanded={!collapsed} aria-controls="ai-instructions-content"
          title={collapsed ? 'Expand AI instructions' : 'Collapse AI instructions'}
          className="h-8 w-8 flex items-center justify-center rounded text-text-secondary hover:bg-bg-surface hover:text-text-primary transition-colors">
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>
      {collapsed ? <div className="flex flex-col items-center gap-3 py-3">
        <span className="text-xs font-medium text-text-secondary">AI</span>
        <button type="button" aria-label="Import video" title="Import video"
          onClick={() => fileInputRef.current?.click()} disabled={busy || !state.backendOnline}
          className="h-8 w-8 flex items-center justify-center rounded text-text-secondary hover:bg-bg-surface disabled:opacity-40"><Upload size={17} /></button>
      </div> : null}

      <div id="ai-instructions-content" hidden={collapsed} inert={collapsed || undefined}
        className={collapsed ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-5 space-y-2 text-xs text-text-muted">
          <p>Local rules mode · no language model request</p>
          {state.backendStatus !== 'online' ? <button onClick={onRetryBackend} disabled={retryingBackend}
            className="flex min-h-8 items-center gap-2 text-ui text-warning hover:text-text-primary transition-colors">
            <RefreshCw size={14} className={retryingBackend ? 'animate-spin' : ''} />
            {retryingBackend ? 'Connecting…' : 'Reconnect backend'}
          </button> : null}
          {state.backendError ? <p role="status" className="break-words">{state.backendError}</p> : null}
          <details>
            <summary className="min-h-8 cursor-pointer py-1 text-ui text-text-secondary">Import & chat settings</summary>
            <div className="mt-2 space-y-3">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={state.transcribeOnImport} disabled={busy} className="mt-0.5"
                  onChange={(event) => dispatch({ type: 'SET_TRANSCRIBE_ON_IMPORT', enabled: event.target.checked })} />
                <span>Transcribe speech on import (requires Whisper and a model download). Needed for subtitles.</span>
              </label>
              {!state.transcribeOnImport ? <p>Scenes, cuts and preview work without transcription.</p> : null}
              <p>Plans and undo history are saved. Chat messages clear when you reopen or switch projects.</p>
            </div>
          </details>
          {state.videoId && !state.analysis ? <button type="button" onClick={() => { void retryAnalysis(); }}
            disabled={busy || !sourceAvailable || !state.backendOnline}
            className="min-h-8 text-ui text-accent disabled:opacity-40">Retry analysis</button> : null}
        </div>
        {isEmpty ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="text-base font-medium text-text-primary mb-2">{state.videoId ? 'What should change?' : 'Start with a video'}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                {state.videoId ? 'Choose a source range or describe an edit. Review the plan before previewing and exporting.'
                  : 'Import a local video, then describe the edit you want.'}
              </p>
            </div>

            {/* Upload button */}
            {!state.videoId ? <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !state.backendOnline}
              className="flex min-h-9 items-center justify-center gap-2 px-4 py-2 rounded-md bg-accent text-on-accent font-medium text-ui hover:bg-accent-hover transition-colors disabled:opacity-40"
            >
              <Upload size={16} />
              Import Video
            </button> : null}

            {/* Suggestions */}
            <div className="w-full space-y-1 mt-2">
              <p className="text-xs text-text-muted font-medium mb-2">Try an instruction</p>
              {SUGGESTIONS.map(({ icon: Icon, text }) => (
                <button
                  key={text}
                  onClick={() => handleSend(text)}
                  disabled={!state.analysis || busy || !sourceAvailable || !state.backendOnline}
                  className="w-full flex min-h-9 items-center gap-2 px-2 py-2 rounded-md text-ui text-text-secondary hover:bg-bg-surface hover:text-text-primary transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Icon size={14} className="text-accent flex-shrink-0" />
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`min-w-0 max-w-full break-words px-3 py-2 rounded-md text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-bg-elevated text-text-primary rounded-br-sm'
                    : msg.role === 'system'
                    ? 'bg-bg-surface text-text-muted text-xs border border-border'
                    : 'bg-bg-surface text-text-primary border border-border rounded-bl-sm'
                }`}>
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <p role="status" className="px-3 py-2 text-xs text-text-secondary">Building edit plan…</p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 py-3 border-t border-border flex-shrink-0">
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="flex flex-wrap items-center gap-2">
          <label htmlFor="editing-instruction" className="sr-only">Editing instruction</label>
          <input
            id="editing-instruction"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={state.videoId ? 'Describe an edit…' : 'Import a video first…'}
            className="w-full min-w-0 h-9 px-3 rounded-md bg-bg-surface border border-border-strong text-ui text-text-primary placeholder:text-text-muted transition-colors"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || !state.backendOnline}
            className="min-h-8 flex items-center gap-2 rounded px-2 text-ui text-text-secondary hover:bg-bg-surface transition-colors disabled:opacity-40"
            title="Import video"
            aria-label="Import video"
          >
            <Upload size={15} /> Import
          </button>
          <button
            type="submit"
            disabled={!input.trim() || busy || !state.analysis || !state.backendOnline || !sourceAvailable}
            aria-label="Send editing instruction"
            className="ml-auto min-h-8 flex items-center gap-2 px-3 rounded-md bg-accent text-on-accent text-ui hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={14} /> Send
          </button>
        </form>
      </div>
      </div>

      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) handleUpload(file);
      }} />
    </aside>
  );
}
