import { useCallback, useRef, useState } from 'react';
import { Upload, Film, AlertCircle } from 'lucide-react';
import * as Progress from '@radix-ui/react-progress';
import { useApp } from '../store';
import { uploadVideo, getVideoInfo, analyzeVideo } from '../api';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function DropZone() {
  const { state, dispatch } = useApp();
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('video/')) {
        setUploadError('Please select a video file');
        return;
      }
      setSelectedFile(file);
      setUploadError(null);
      setUploading(true);
      dispatch({ type: 'SET_UPLOAD_PROGRESS', progress: 0 });
      try {
        const { video_id } = await uploadVideo(file, (progress) => {
          dispatch({ type: 'SET_UPLOAD_PROGRESS', progress });
        });
        const videoInfo = await getVideoInfo(video_id);
        dispatch({ type: 'SET_VIDEO', videoId: video_id, videoInfo });
        const { job_id } = await analyzeVideo(video_id, state.transcribeOnImport);
        dispatch({
          type: 'SET_ACTIVE_JOB',
          job: { job_id, type: 'analysis', status: 'running', progress: 0 },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setUploadError(msg);
        dispatch({ type: 'SET_ERROR', error: msg });
      } finally {
        setUploading(false);
      }
    },
    [dispatch, state.transcribeOnImport]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragging(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);
  const handleClick = () => inputRef.current?.click();
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        flex flex-col items-center justify-center w-full h-full cursor-pointer transition-colors duration-200
        ${dragging ? 'bg-accent/5' : ''}
      `}
    >
      <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={handleInputChange} />

      {uploading ? (
        <div className="flex flex-col items-center gap-5 w-72">
          <div className="w-16 h-16 rounded-xl bg-bg-surface flex items-center justify-center">
            <Film size={28} className="text-accent animate-pulse" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-text-primary mb-1">Uploading...</p>
            <p className="text-xs text-text-muted">{selectedFile?.name}</p>
          </div>
          <div className="w-full">
            <Progress.Root className="w-full h-1.5 rounded-full bg-bg-surface overflow-hidden" value={state.uploadProgress}>
              <Progress.Indicator className="h-full bg-accent rounded-full transition-[width] duration-300" style={{ width: `${state.uploadProgress}%` }} />
            </Progress.Root>
            <p className="text-xs text-text-muted text-center mt-2">{state.uploadProgress}%</p>
          </div>
        </div>
      ) : selectedFile ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-xl bg-bg-surface flex items-center justify-center">
            <Film size={28} className="text-accent" />
          </div>
          <p className="text-sm font-semibold text-text-primary">{selectedFile.name}</p>
          <p className="text-xs text-text-muted">{formatFileSize(selectedFile.size)}</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-5">
          <div className="w-20 h-20 rounded-2xl bg-bg-surface border border-border flex items-center justify-center transition-colors group-hover:border-border-strong">
            <Upload size={32} className="text-text-muted" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-text-primary mb-1">Drop your video here</p>
            <p className="text-sm text-text-muted">or click anywhere to browse</p>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-xs text-text-muted px-3 py-1 rounded-md bg-bg-surface border border-border">MP4</span>
            <span className="text-xs text-text-muted px-3 py-1 rounded-md bg-bg-surface border border-border">MOV</span>
            <span className="text-xs text-text-muted px-3 py-1 rounded-md bg-bg-surface border border-border">AVI</span>
            <span className="text-xs text-text-muted px-3 py-1 rounded-md bg-bg-surface border border-border">WEBM</span>
          </div>
        </div>
      )}

      {uploadError && (
        <div className="flex items-center gap-2 mt-6 text-sm text-error">
          <AlertCircle size={14} />
          <span>{uploadError}</span>
        </div>
      )}
    </div>
  );
}
