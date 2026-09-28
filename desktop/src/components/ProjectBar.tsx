import { useApp } from '../store';
import { useProjectControls } from '../useProjectPersistence';

export default function ProjectBar() {
  const { state } = useApp();
  const project = useProjectControls();
  if (!project) return null;
  const label = project.status === 'restoring' ? 'Restoring…'
    : project.status === 'saving' ? 'Saving…'
    : project.status === 'saved' ? state.videoId ? 'Saved' : 'No project open' : 'Not saved';
  const jobBusy = state.activeJob?.status === 'running' || state.activeJob?.status === 'pending';
  const busy = project.transitioning || jobBusy;
  return (
    <div className="border-b border-border bg-bg-panel px-4 py-2 text-xs flex-shrink-0">
      <div className="flex items-center gap-3">
        <label className="text-text-secondary" htmlFor="project-picker">Project</label>
        <select id="project-picker" aria-label="Project selector" value={state.videoId ?? ''}
          disabled={!project.ready || busy}
          onFocus={() => { void project.refreshProjects(); }}
          onChange={(event) => { if (event.target.value) void project.switchProject(event.target.value); }}
          className="min-w-0 max-w-80 rounded-md bg-bg-surface border border-border px-2 py-1 text-text-primary disabled:opacity-40">
          <option value="" disabled>Import a video to start</option>
          {state.videoId && !project.projects.some((item) => item.video_id === state.videoId)
            ? <option value={state.videoId}>{state.videoInfo?.original_name}</option> : null}
          {project.projects.map((item) => <option key={item.video_id} value={item.video_id}>
            {item.original_name}{item.media_status === 'missing' ? ' (source missing)' : ''}
          </option>)}
        </select>
        <span role="status" aria-label="Save status" className={project.error ? 'text-warning' : 'text-text-muted'}>{label}</span>
        {(project.status === 'error' || project.status === 'conflict') && !project.recoveryRequired ? (
          <button type="button" disabled={busy || !state.backendOnline} onClick={() => { void project.retry(); }}
            className="text-accent disabled:opacity-40">{project.ready ? 'Retry save' : 'Retry restore'}</button>
        ) : null}
      </div>
      {project.error ? <p role="alert" className="mt-2 text-warning">{project.error}</p> : null}
      {project.status === 'conflict' && !project.recoveryRequired ? <div className="flex flex-wrap items-center gap-3 mt-2 text-text-secondary">
        <button type="button" disabled={busy || !state.backendOnline} onClick={() => { void project.reloadSaved(); }}
          className="text-accent disabled:opacity-40">Reload saved version</button>
        <span>discards these local edits</span>
        <button type="button" disabled={busy || !state.backendOnline} onClick={() => { void project.overwriteSaved(); }}
          className="text-accent disabled:opacity-40">Replace saved version with my edits</button>
      </div> : null}
      {project.recoveryDrafts.length > 0 ? <div className="mt-2 space-y-2 text-text-secondary" aria-label="Recovery copies">
        <p>Recovery copies are kept separately for each window. Opening the saved version leaves these copies intact.</p>
        {project.recoveryDrafts.map((copy, index) => <div key={copy.key} className="flex items-center gap-3">
          <button type="button" disabled={busy || !state.backendOnline}
            onClick={() => { void project.recoverDraft(copy.key); }} className="text-accent disabled:opacity-40">
            Recover copy {index + 1}
          </button>
          <span className="truncate">{copy.description}{copy.updatedAt ? ` · ${new Date(copy.updatedAt).toLocaleString()}` : ''}</span>
        </div>)}
        {project.recoveryRequired ? <button type="button" disabled={busy || !state.backendOnline}
          onClick={() => { void project.reloadSaved(); }} className="text-accent disabled:opacity-40">Open saved version</button> : null}
      </div> : null}
      {project.listError ? <p className="mt-2 text-warning">{project.listError}
        <button type="button" onClick={() => { void project.refreshProjects(); }} className="ml-2 text-accent">Refresh projects</button>
      </p> : null}
      {state.mediaStatus === 'missing' ? <p role="alert" className="mt-2 text-warning">
        Source video is missing. Your plan and undo history are preserved. Restore the source file, then check again to use analysis, preview and export.
        <button type="button" disabled={busy || !state.backendOnline} className="ml-2 text-accent disabled:opacity-40"
          onClick={() => { if (state.videoId) void project.switchProject(state.videoId); }}>Check source again</button>
      </p> : null}
    </div>
  );
}
