export interface VideoInfo {
  video_id: string;
  original_name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  file_size: number;
}

export interface SceneInfo {
  id: number;
  start_time: number;
  end_time: number;
  duration: number;
  has_speech: boolean;
  is_silent: boolean;
  engagement_score?: number;
}

export interface VideoAnalysis {
  file_path: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  scenes: SceneInfo[];
  transcript: Array<Record<string, unknown>>;
  quality: {
    silent_segments: Array<Record<string, unknown>>;
    audio_energy: number[];
    overall_silence_ratio: number;
  };
}

export type TimelineSelection =
  | { type: 'none' }
  | { type: 'playhead'; time: number }
  | { type: 'range'; start_time: number; end_time: number }
  | { type: 'operation'; operation_index: number };

export interface CommandResultSummary {
  command_id: string;
  instruction: string;
  changed_operations: number;
  duration_before?: number;
  duration_after?: number;
  messages: string[];
}

export interface EditOperation {
  type:
    | 'cut'
    | 'subtitle'
    | 'bgm'
    | 'colorgrade'
    | 'transition'
    | 'speed';
  start_time?: number;
  end_time?: number;
  description?: string;
  reason?: string;
  editable?: boolean;
  confidence?: number;
  [key: string]: unknown;
}

export interface EditPlan {
  instruction: string;
  operations: EditOperation[];
  estimated_duration: number;
  summary: string;
}

export const PREVIEW_RESOLUTIONS = [360, 480, 720] as const;
export type PreviewResolution = (typeof PREVIEW_RESOLUTIONS)[number];

export const RENDER_PRESET_OPTIONS = [
  { value: 'draft', label: 'Draft', description: '720p export, faster render' },
  { value: 'balanced', label: 'Balanced', description: '1080p export, recommended' },
  { value: 'high', label: 'High', description: 'Source resolution, slower render' },
] as const;
export type RenderPreset = (typeof RENDER_PRESET_OPTIONS)[number]['value'];

export const SUBTITLE_EXPORT_MODE_OPTIONS = [
  {
    value: 'burned',
    label: 'Burn into video',
    description: 'Subtitles are always visible in the exported video.',
  },
  {
    value: 'sidecar',
    label: 'Save subtitle file',
    description: 'Keep subtitles as a separate .ass file next to the video export.',
  },
] as const;
export type SubtitleExportMode = (typeof SUBTITLE_EXPORT_MODE_OPTIONS)[number]['value'];
export type ExportArtifactKind = 'video' | 'subtitle';

export interface ExportArtifact {
  kind: ExportArtifactKind;
  path: string;
}

export type JobType =
  | 'analysis'
  | 'preview'
  | 'render'
  | 'highlights'
  | 'engagement'
  | 'style_extract'
  | 'unknown';

export interface MediaJobResult {
  output_path: string;
  resolution?: number;
  render_preset?: RenderPreset;
  subtitle_export_mode?: SubtitleExportMode;
  subtitle_path?: string;
  export_artifacts?: ExportArtifact[];
}

export type OutputKind = 'preview' | 'render';

export interface OutputHistoryItem extends MediaJobResult {
  job_id: string;
  kind: OutputKind;
  video_id?: string | null;
  original_name?: string | null;
  completed_at: string;
}

export interface Job {
  job_id: string;
  type: JobType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  result?: unknown;
  error?: string;
}

export interface PreviewAsset extends MediaJobResult {
  job_id: string;
}

export interface RenderAsset extends MediaJobResult {
  job_id: string;
}

export interface Preset {
  name: string;
  description: string;
  file?: string;
  style?: Record<string, unknown>;
}

export interface EditDNA {
  rhythm: number;
  visual: number;
  audio: number;
}
