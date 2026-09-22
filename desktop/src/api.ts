import { invoke } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import type {
  VideoInfo,
  VideoAnalysis,
  EditPlan,
  Job,
  ExportArtifact,
  Preset,
  PreviewResolution,
  RenderPreset,
  SubtitleExportMode,
  MediaJobResult,
} from './types';

const API_BASE = 'http://127.0.0.1:18910';
const DEFAULT_EXPORT_BASENAME = 'cutai-video';

interface CreatePlanOptions {
  useLlm?: boolean;
  stylePreset?: string | null;
}

export type MediaAssetKind = 'preview' | 'render';

interface BackendStartResponse {
  started: boolean;
  already_running: boolean;
  port: number;
}

interface ExportBundleSaveResult {
  savedPrimaryPath: string;
  savedCompanionPaths: string[];
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;

  try {
    res = await fetch(`${API_BASE}${path}`, options);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Unable to reach the CutAI backend'
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new ApiError(res.status, text);
  }
  return res.json() as Promise<T>;
}

export function canAutoStartBackend(): boolean {
  const runtimeWindow = globalThis.window as
    | (Window & { __TAURI_INTERNALS__?: unknown })
    | undefined;

  return Boolean(runtimeWindow?.__TAURI_INTERNALS__);
}

export function isNativeDesktop(): boolean {
  return canAutoStartBackend();
}

function getPathExtension(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0] ?? '';
  const lastSegment = cleanPath.split(/[\\/]/).pop() ?? '';
  const extension = lastSegment.match(/(\.[A-Za-z0-9]+)$/)?.[1];
  return extension ? extension.toLowerCase() : '.mp4';
}

function getBaseNameWithoutExtension(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return DEFAULT_EXPORT_BASENAME;

  const fileName = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const withoutExtension = fileName.replace(/\.[^.]+$/, '').trim();
  const sanitized = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return sanitized || DEFAULT_EXPORT_BASENAME;
}

export function getSuggestedExportFilename(
  originalName: string | null | undefined,
  kind: MediaAssetKind,
  outputPath: string,
  resolution?: number
): string {
  const baseName = getBaseNameWithoutExtension(originalName);
  const suffix = kind === 'preview'
    ? resolution
      ? `-preview-${resolution}p`
      : '-preview'
    : '-render';

  return `${baseName}${suffix}${getPathExtension(outputPath)}`;
}

export async function openNativePath(target: string): Promise<void> {
  if (!target) return;

  if (/^https?:\/\//.test(target)) {
    await openUrl(target);
    return;
  }

  await openPath(target);
}

export async function revealNativePath(target: string): Promise<void> {
  if (!target) return;

  await invoke('reveal_path', { path: target });
}

export async function exportNativePath(
  sourcePath: string,
  defaultFileName: string
): Promise<string | null> {
  if (!sourcePath) return null;

  return invoke<string | null>('save_exported_file', {
    request: { sourcePath, defaultFileName },
  });
}

export function getExportArtifacts(media: MediaJobResult): ExportArtifact[] {
  if (Array.isArray(media.export_artifacts) && media.export_artifacts.length > 0) {
    return media.export_artifacts;
  }

  const artifacts: ExportArtifact[] = [{ kind: 'video', path: media.output_path }];
  if (media.subtitle_path) {
    artifacts.push({ kind: 'subtitle', path: media.subtitle_path });
  }
  return artifacts;
}

export async function exportNativeBundle(
  media: MediaJobResult,
  defaultFileName: string
): Promise<ExportBundleSaveResult | null> {
  const [primaryArtifact, ...companionArtifacts] = getExportArtifacts(media);
  if (!primaryArtifact?.path) {
    return null;
  }

  return invoke<ExportBundleSaveResult | null>('save_export_bundle', {
    request: {
      primarySourcePath: primaryArtifact.path,
      companionSourcePaths: companionArtifacts.map((artifact) => artifact.path),
      defaultFileName,
    },
  });
}

export async function startBackend(): Promise<BackendStartResponse> {
  return invoke<BackendStartResponse>('start_backend');
}

export async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function uploadVideo(
  file: File,
  onProgress?: (progress: number) => void
): Promise<{ video_id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/api/videos/upload`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new ApiError(xhr.status, xhr.responseText));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

export async function getVideoInfo(videoId: string): Promise<VideoInfo> {
  return request<VideoInfo>(`/api/videos/${videoId}`);
}

export function getThumbnailUrl(videoId: string, time: number = 5.0): string {
  return `${API_BASE}/api/videos/${videoId}/thumbnail?time=${time}`;
}

export async function analyzeVideo(videoId: string, transcribe = false): Promise<{ job_id: string }> {
  return request<{ job_id: string }>(`/api/videos/${videoId}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip_transcription: !transcribe }),
  });
}

export async function pollJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${jobId}`);
}

export async function createPlan(
  videoId: string,
  instruction: string,
  options: CreatePlanOptions = {}
): Promise<EditPlan> {
  const { useLlm = false, stylePreset = null } = options;

  return request<EditPlan>('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_id: videoId,
      instruction,
      use_llm: useLlm,
      style_preset: stylePreset,
    }),
  });
}

export async function startRender(
  videoId: string,
  plan: EditPlan,
  renderPreset: RenderPreset = 'balanced',
  subtitleExportMode: SubtitleExportMode = 'burned'
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>('/api/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_id: videoId,
      plan,
      render_preset: renderPreset,
      subtitle_export_mode: plan.operations.some((operation) => operation.type === 'subtitle')
        ? subtitleExportMode : 'burned',
    }),
  });
}

export async function startPreview(
  videoId: string,
  plan: EditPlan,
  resolution: PreviewResolution = 360
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>('/api/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, plan, resolution }),
  });
}

export function getDownloadUrl(jobId: string): string {
  return `${API_BASE}/api/render/${jobId}/download`;
}

export function getRenderVideoUrl(jobId: string): string {
  return `${API_BASE}/api/render/${jobId}/video`;
}

export function getPreviewDownloadUrl(jobId: string): string {
  return `${API_BASE}/api/preview/${jobId}/download`;
}

export function getPreviewVideoUrl(jobId: string): string {
  return `${API_BASE}/api/preview/${jobId}/video`;
}

export async function openPathOrUrl(target: string, fallbackUrl?: string): Promise<void> {
  if (!target) return;

  if (isNativeDesktop()) {
    await openNativePath(target);
    return;
  }

  window.open(fallbackUrl ?? target, '_blank', 'noopener,noreferrer');
}

export async function revealPathOrUrl(target: string, fallbackUrl?: string): Promise<void> {
  if (!target) return;

  if (isNativeDesktop()) {
    await revealNativePath(target);
    return;
  }

  window.open(fallbackUrl ?? target, '_blank', 'noopener,noreferrer');
}

export async function exportPathOrUrl(
  sourcePath: string,
  defaultFileName: string,
  fallbackUrl?: string
): Promise<string | null | void> {
  if (!sourcePath) return null;

  if (isNativeDesktop()) {
    return exportNativePath(sourcePath, defaultFileName);
  }

  window.open(fallbackUrl ?? sourcePath, '_blank', 'noopener,noreferrer');
}

export async function exportBundleOrUrl(
  media: MediaJobResult,
  defaultFileName: string,
  fallbackUrl?: string
): Promise<ExportBundleSaveResult | null | void> {
  if (!media.output_path) return null;

  if (isNativeDesktop()) {
    return exportNativeBundle(media, defaultFileName);
  }

  window.open(fallbackUrl ?? media.output_path, '_blank', 'noopener,noreferrer');
}

export async function getPresets(): Promise<Preset[]> {
  return request<Preset[]>('/api/styles/presets');
}

export async function getPreset(name: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/api/styles/presets/${encodeURIComponent(name)}`);
}

export async function applyStyle(
  videoId: string,
  style: Record<string, unknown>
): Promise<EditPlan> {
  return request<EditPlan>('/api/styles/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, style }),
  });
}

export async function generateHighlights(
  videoId: string,
  targetDuration: number,
  style: string
): Promise<{ job_id: string }> {
  return request<{ job_id: string }>('/api/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, target_duration: targetDuration, style }),
  });
}

export function connectProgressWs(
  jobId: string,
  onProgress: (data: { progress: number; status: string }) => void,
  onClose?: () => void
): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:18910/ws/progress/${jobId}`);
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onProgress(data);
    } catch {
      // ignore parse errors
    }
  };
  ws.onclose = () => onClose?.();
  ws.onerror = () => onClose?.();
  return ws;
}

export async function getAnalysis(videoId: string): Promise<VideoAnalysis> {
  return request<VideoAnalysis>(`/api/videos/${videoId}/analysis`);
}
