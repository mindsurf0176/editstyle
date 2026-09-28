import { Upload, Scissors, Palette, Sparkles, Settings } from 'lucide-react';
import { useApp, type SidebarTab } from '../store';

const TABS: { id: SidebarTab; label: string; icon: typeof Upload }[] = [
  { id: 'upload', label: 'Import', icon: Upload },
  { id: 'edit', label: 'Edit', icon: Scissors },
  { id: 'style', label: 'Style', icon: Palette },
  { id: 'highlights', label: 'Highlights', icon: Sparkles },
];

export default function Sidebar() {
  const { state, dispatch } = useApp();
  const backendDot = state.backendStatus === 'starting' || state.backendStatus === 'checking'
    ? 'bg-warning' : state.backendOnline ? 'bg-success' : 'bg-error';

  return (
    <aside className="w-[72px] flex flex-col items-center bg-bg-panel border-r border-border py-5 flex-shrink-0">
      {/* Logo */}
      <div className="w-10 h-10 mb-8 rounded-lg overflow-hidden flex-shrink-0">
        <img src="/logo.png" alt="CutAI" className="w-full h-full object-cover" />
      </div>

      {/* Nav */}
      <nav className="flex flex-col items-center gap-1 w-full px-2 flex-1">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = state.sidebarTab === id;
          const disabled = id !== 'upload' && !state.videoId;
          return (
            <button
              key={id}
              onClick={() => {
                if (!disabled) {
                  dispatch({ type: 'SET_SIDEBAR_TAB', tab: id });
                  dispatch({ type: 'SET_VIEW', view: id === 'upload' ? 'upload' : 'editor' });
                }
              }}
              disabled={disabled}
              title={label}
              className={`
                w-12 h-12 flex flex-col items-center justify-center gap-1 rounded-lg transition-all duration-150
                ${active
                  ? 'bg-accent text-on-accent'
                  : 'text-text-muted hover:text-text-secondary hover:bg-bg-surface'
                }
                ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
              <span className="text-[10px] font-medium leading-none">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="flex flex-col items-center gap-3">
        <button className="w-10 h-10 flex items-center justify-center rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-surface transition-colors" title="Settings">
          <Settings size={20} strokeWidth={1.8} />
        </button>
        <div className={`w-2 h-2 rounded-full ${backendDot}`} />
      </div>
    </aside>
  );
}
