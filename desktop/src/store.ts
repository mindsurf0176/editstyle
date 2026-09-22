import { createContext, useContext } from 'react';
import { appendPlan, editSourceRange, getKeepRanges } from './timeline';
import type {
  VideoInfo,
  VideoAnalysis,
  EditPlan,
  Job,
  Preset,
  PreviewResolution,
  RenderPreset,
  SubtitleExportMode,
  PreviewAsset,
  RenderAsset,
  OutputHistoryItem,
  TimelineSelection,
  CommandResultSummary,
} from './types';

export type ViewMode = 'upload' | 'editor' | 'rendering';
export type SidebarTab = 'upload' | 'edit' | 'style' | 'highlights';
export type BackendStatus = 'checking' | 'starting' | 'online' | 'offline';
export const RECENT_OUTPUT_HISTORY_LIMIT = 12;

function mergeRecentOutputs(
  recentOutputs: OutputHistoryItem[],
  item: OutputHistoryItem
): OutputHistoryItem[] {
  return [item, ...recentOutputs.filter((entry) => (
    !(entry.kind === item.kind && entry.job_id === item.job_id)
  ))].slice(0, RECENT_OUTPUT_HISTORY_LIMIT);
}

export interface AppState {
  videoId: string | null;
  videoInfo: VideoInfo | null;
  analysis: VideoAnalysis | null;
  editPlan: EditPlan | null;
  activeJob: Job | null;
  previewResult: PreviewAsset | null;
  previewResolution: PreviewResolution;
  renderPreset: RenderPreset;
  subtitleExportMode: SubtitleExportMode;
  renderResult: RenderAsset | null;
  recentOutputs: OutputHistoryItem[];
  timelineSelection: TimelineSelection;
  lastCommandSummary: CommandResultSummary | null;
  commandUndoStack: Array<EditPlan | null>;
  editRevision: number;
  transcribeOnImport: boolean;
  presets: Preset[];
  planningStylePreset: Preset | null;
  view: ViewMode;
  sidebarTab: SidebarTab;
  uploadProgress: number;
  backendStatus: BackendStatus;
  backendOnline: boolean;
  backendError: string | null;
  error: string | null;
  currentTime: number;
}

export const initialState: AppState = {
  videoId: null,
  videoInfo: null,
  analysis: null,
  editPlan: null,
  activeJob: null,
  previewResult: null,
  previewResolution: 360,
  renderPreset: 'balanced',
  subtitleExportMode: 'burned',
  renderResult: null,
  recentOutputs: [],
  timelineSelection: { type: 'none' },
  lastCommandSummary: null,
  commandUndoStack: [],
  editRevision: 0,
  transcribeOnImport: false,
  presets: [],
  planningStylePreset: null,
  view: 'upload',
  sidebarTab: 'upload',
  uploadProgress: 0,
  backendStatus: 'checking',
  backendOnline: false,
  backendError: null,
  error: null,
  currentTime: 0,
};

export type AppAction =
  | { type: 'SET_VIDEO'; videoId: string; videoInfo: VideoInfo }
  | { type: 'SET_ANALYSIS'; analysis: VideoAnalysis }
  | { type: 'SET_EDIT_PLAN'; plan: EditPlan; revision?: number }
  | { type: 'APPLY_PLAN_PROPOSAL'; plan: EditPlan; revision: number }
  | { type: 'EDIT_SOURCE_RANGE'; action: 'keep' | 'remove'; start: number; end: number }
  | { type: 'CLEAR_EDIT_PLAN' }
  | { type: 'REMOVE_OPERATION'; index: number }
  | { type: 'SET_ACTIVE_JOB'; job: Job; revision?: number }
  | { type: 'SYNC_ACTIVE_JOB'; job: Job }
  | { type: 'UPDATE_JOB_PROGRESS'; progress: number; status: Job['status']; jobId?: string }
  | { type: 'SET_PREVIEW_RESULT'; preview: PreviewAsset | null }
  | { type: 'SET_PREVIEW_RESOLUTION'; resolution: PreviewResolution }
  | { type: 'SET_RENDER_PRESET'; renderPreset: RenderPreset }
  | { type: 'SET_SUBTITLE_EXPORT_MODE'; subtitleExportMode: SubtitleExportMode }
  | { type: 'SET_RENDER_RESULT'; render: RenderAsset | null }
  | { type: 'SET_RECENT_OUTPUTS'; items: OutputHistoryItem[] }
  | { type: 'ADD_RECENT_OUTPUT'; item: OutputHistoryItem }
  | { type: 'SET_TIMELINE_SELECTION'; selection: TimelineSelection }
  | { type: 'SET_TRANSCRIBE_ON_IMPORT'; enabled: boolean }
  | { type: 'SET_COMMAND_RESULT_SUMMARY'; summary: CommandResultSummary }
  | { type: 'PUSH_COMMAND_UNDO'; plan: EditPlan }
  | { type: 'UNDO_LAST_COMMAND' }
  | { type: 'CLEAR_JOB' }
  | { type: 'SET_PRESETS'; presets: Preset[] }
  | { type: 'SET_PLANNING_STYLE_PRESET'; preset: Preset | null }
  | { type: 'SET_VIEW'; view: ViewMode }
  | { type: 'SET_SIDEBAR_TAB'; tab: SidebarTab }
  | { type: 'SET_UPLOAD_PROGRESS'; progress: number }
  | { type: 'SET_BACKEND_STATE'; status: BackendStatus; error?: string | null }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_CURRENT_TIME'; time: number }
  | { type: 'RESET' };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIDEO':
      return {
        ...state,
        videoId: action.videoId,
        videoInfo: action.videoInfo,
        view: 'editor',
        sidebarTab: 'edit',
        uploadProgress: 0,
        analysis: null,
        editPlan: null,
        activeJob: null,
        currentTime: 0,
        timelineSelection: { type: 'none' },
        commandUndoStack: [],
        lastCommandSummary: null,
        editRevision: state.editRevision + 1,
        previewResult: null,
        renderResult: null,
        error: null,
      };
    case 'SET_ANALYSIS':
      return { ...state, analysis: action.analysis };
    case 'SET_EDIT_PLAN':
      if (action.revision !== undefined && action.revision !== state.editRevision) return state;
      return updatePlan(state, action.plan);
    case 'APPLY_PLAN_PROPOSAL': {
      if (action.revision !== state.editRevision) return state;
      try {
        const plan = appendPlan(state.editPlan, action.plan, state.videoInfo?.duration ?? 0);
        return updatePlan(state, plan);
      } catch (error) {
        return { ...state, error: error instanceof Error ? error.message : 'Unable to combine cuts.' };
      }
    }
    case 'EDIT_SOURCE_RANGE': {
      if (!state.videoInfo) return state;
      try {
        const plan = editSourceRange(state.editPlan, state.videoInfo.duration, action.action, {
          start_time: action.start,
          end_time: action.end,
        });
        return updatePlan(state, plan);
      } catch (error) {
        return { ...state, error: error instanceof Error ? error.message : 'Unable to edit this range.' };
      }
    }
    case 'CLEAR_EDIT_PLAN':
      return updatePlan(state, null);
    case 'REMOVE_OPERATION': {
      if (!state.editPlan || !state.editPlan.operations[action.index]) return state;
      const operations = state.editPlan.operations.filter((_, i) => i !== action.index);
      const duration = state.videoInfo?.duration ?? state.editPlan.estimated_duration;
      let estimatedDuration = duration;
      try {
        estimatedDuration = getKeepRanges(operations, duration)
          .reduce((total, range) => total + range.end_time - range.start_time, 0);
      } catch { /* Existing non-cut plans retain the source-duration estimate. */ }
      return updatePlan(state, { ...state.editPlan, operations, estimated_duration: estimatedDuration });
    }
    case 'SET_ACTIVE_JOB':
      if (action.revision !== undefined && action.revision !== state.editRevision) return state;
      if (state.activeJob && state.activeJob.job_id !== action.job.job_id
        && (state.activeJob.status === 'pending' || state.activeJob.status === 'running')) return state;
      return {
        ...state,
        activeJob: {
          ...(state.activeJob?.job_id === action.job.job_id ? state.activeJob : {}),
          ...action.job,
          type: action.job.type ?? state.activeJob?.type,
        },
      };
    case 'SYNC_ACTIVE_JOB':
      if (state.activeJob?.job_id !== action.job.job_id) return state;
      return { ...state, activeJob: { ...state.activeJob, ...action.job } };
    case 'UPDATE_JOB_PROGRESS':
      if (!state.activeJob) return state;
      if (action.jobId !== undefined && action.jobId !== state.activeJob.job_id) return state;
      return {
        ...state,
        activeJob: {
          ...state.activeJob,
          progress: action.progress,
          status: action.status,
        },
      };
    case 'SET_PREVIEW_RESULT':
      return { ...state, previewResult: action.preview };
    case 'SET_PREVIEW_RESOLUTION':
      return {
        ...state,
        previewResolution: action.resolution,
        previewResult: null,
        activeJob: state.activeJob?.type === 'preview' ? null : state.activeJob,
      };
    case 'SET_RENDER_PRESET':
      return {
        ...state,
        renderPreset: action.renderPreset,
        renderResult: null,
        activeJob: state.activeJob?.type === 'render' ? null : state.activeJob,
      };
    case 'SET_SUBTITLE_EXPORT_MODE':
      return {
        ...state,
        subtitleExportMode: action.subtitleExportMode,
        renderResult: null,
        activeJob: state.activeJob?.type === 'render' ? null : state.activeJob,
      };
    case 'SET_RENDER_RESULT':
      return { ...state, renderResult: action.render };
    case 'SET_RECENT_OUTPUTS':
      return { ...state, recentOutputs: action.items.slice(0, RECENT_OUTPUT_HISTORY_LIMIT) };
    case 'ADD_RECENT_OUTPUT':
      return { ...state, recentOutputs: mergeRecentOutputs(state.recentOutputs, action.item) };
    case 'SET_TIMELINE_SELECTION':
      return { ...state, timelineSelection: action.selection };
    case 'SET_TRANSCRIBE_ON_IMPORT':
      return { ...state, transcribeOnImport: action.enabled };
    case 'SET_COMMAND_RESULT_SUMMARY':
      return { ...state, lastCommandSummary: action.summary };
    case 'PUSH_COMMAND_UNDO':
      return { ...state, commandUndoStack: [action.plan, ...state.commandUndoStack].slice(0, 20) };
    case 'UNDO_LAST_COMMAND': {
      const previousPlan = state.commandUndoStack[0];
      if (previousPlan === undefined) return state;

      return {
        ...state,
        editPlan: previousPlan,
        commandUndoStack: state.commandUndoStack.slice(1),
        previewResult: null,
        renderResult: null,
        activeJob: null,
        editRevision: state.editRevision + 1,
        timelineSelection: { type: 'none' },
        lastCommandSummary: {
          command_id: 'undo',
          instruction: 'undo',
          changed_operations: previousPlan?.operations.length ?? 0,
          messages: ['Last edit undone.'],
        },
      };
    }
    case 'CLEAR_JOB':
      return { ...state, activeJob: null };
    case 'SET_PRESETS':
      return { ...state, presets: action.presets };
    case 'SET_PLANNING_STYLE_PRESET':
      return { ...state, planningStylePreset: action.preset };
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_SIDEBAR_TAB':
      return { ...state, sidebarTab: action.tab };
    case 'SET_UPLOAD_PROGRESS':
      return { ...state, uploadProgress: action.progress };
    case 'SET_BACKEND_STATE':
      return {
        ...state,
        backendStatus: action.status,
        backendOnline: action.status === 'online',
        backendError: action.error ?? null,
      };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_CURRENT_TIME':
      return { ...state, currentTime: action.time };
    case 'RESET':
      return {
        ...initialState,
        backendStatus: state.backendStatus,
        backendOnline: state.backendOnline,
        backendError: state.backendError,
        previewResolution: state.previewResolution,
        renderPreset: state.renderPreset,
        subtitleExportMode: state.subtitleExportMode,
        recentOutputs: state.recentOutputs,
        presets: state.presets,
        planningStylePreset: state.planningStylePreset,
        editRevision: state.editRevision + 1,
        transcribeOnImport: state.transcribeOnImport,
      };
    default:
      return state;
  }
}

function updatePlan(state: AppState, plan: EditPlan | null): AppState {
  if (plan?.operations.some((operation) => operation.type === 'subtitle')
    && !state.analysis?.transcript.length) {
    return { ...state, error: 'Subtitles need a transcript. Enable speech transcription and import the video again.' };
  }
  return {
    ...state,
    editPlan: plan,
    commandUndoStack: [state.editPlan, ...state.commandUndoStack].slice(0, 20),
    editRevision: state.editRevision + 1,
    previewResult: null,
    renderResult: null,
    activeJob: state.activeJob?.type === 'analysis' ? state.activeJob : null,
    timelineSelection: { type: 'none' },
    error: null,
    lastCommandSummary: {
      command_id: `edit-${state.editRevision + 1}`,
      instruction: plan?.instruction ?? 'Clear plan',
      changed_operations: plan?.operations.length ?? 0,
      messages: [plan ? 'Edit plan updated. Generate a new preview to review it.' : 'Edit plan cleared.'],
    },
  };
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
}

export const AppContext = createContext<AppContextType>({
  state: initialState,
  dispatch: () => undefined,
});

export function useApp() {
  return useContext(AppContext);
}
