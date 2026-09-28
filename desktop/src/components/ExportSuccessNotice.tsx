import { CheckCircle2, ExternalLink, FolderOpen, X } from 'lucide-react';

interface ExportSuccessNoticeProps {
  savedPath: string;
  assetLabel: string;
  details?: string | null;
  onOpen: () => void;
  onReveal: () => void;
  onDismiss: () => void;
}

export default function ExportSuccessNotice({
  savedPath,
  assetLabel,
  details,
  onOpen,
  onReveal,
  onDismiss,
}: ExportSuccessNoticeProps) {
  return (
    <div className="shrink-0 rounded-md border border-success/50 bg-bg-panel px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <CheckCircle2 size={15} className="text-success" />
            <span>{assetLabel} saved</span>
          </div>
          {details && (
            <p className="text-xs text-text-secondary">{details}</p>
          )}
          <p className="text-xs text-text-secondary">Saved to</p>
          <p
            className="break-all font-mono text-xs text-text-primary"
            title={savedPath}
          >
            {savedPath}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary"
          aria-label="Dismiss export notice"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReveal}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border-strong px-3 py-2 text-ui font-medium text-text-primary transition-colors hover:bg-bg-surface"
        >
          <FolderOpen size={13} />
          Reveal in folder
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-ui font-medium text-on-accent transition-colors hover:bg-accent-hover"
        >
          <ExternalLink size={13} />
          Open file
        </button>
      </div>
    </div>
  );
}
