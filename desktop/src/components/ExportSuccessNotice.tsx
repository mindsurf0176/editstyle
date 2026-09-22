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
    <div className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium text-[#fafafa]">
            <CheckCircle2 size={15} className="text-[var(--success)]" />
            <span>{assetLabel} saved</span>
          </div>
          {details && (
            <p className="text-xs text-[#a1a1aa]">{details}</p>
          )}
          <p className="text-xs text-[#a1a1aa]">Saved to</p>
          <p
            className="truncate font-mono text-[11px] text-[#fafafa]"
            title={savedPath}
          >
            {savedPath}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#fafafa]"
          aria-label="Dismiss export notice"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReveal}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#27272a] px-3 py-2 text-xs font-medium text-[#fafafa] transition-colors hover:bg-[#18181b]"
        >
          <FolderOpen size={13} />
          Reveal in folder
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#ffffff] px-3 py-2 text-xs font-medium text-[#111315] transition-colors hover:bg-[#e4e4e7]"
        >
          <ExternalLink size={13} />
          Open file
        </button>
      </div>
    </div>
  );
}
