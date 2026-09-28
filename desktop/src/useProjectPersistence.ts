import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { getCurrentProject, getProject, getProjects, openProject, saveProject, uploadVideo } from './api';
import { editingState, ProjectPersistence } from './projectPersistence';
import type { PersistenceView, ProjectApi } from './projectPersistence';
import type { AppAction, AppState } from './store';
import type { ProjectSnapshot } from './types';

const projectApi: ProjectApi = {
  current: getCurrentProject, get: getProject, list: getProjects, open: openProject, save: saveProject,
};

export interface ProjectControls extends PersistenceView {
  retry(): Promise<boolean>;
  reloadSaved(): Promise<boolean>;
  overwriteSaved(): Promise<boolean>;
  switchProject(id: string): Promise<boolean>;
  refreshProjects(): Promise<void>;
  recoverDraft(key: string): Promise<boolean>;
  importVideo(file: File, onProgress: (progress: number) => void): Promise<ProjectSnapshot | null>;
}

export const ProjectPersistenceContext = createContext<ProjectControls | null>(null);
export const useProjectControls = () => useContext(ProjectPersistenceContext);

export function useProjectPersistence(state: AppState, dispatch: Dispatch<AppAction>, api = projectApi) {
  const mounted = useRef(false);
  const [manager] = useState(() => new ProjectPersistence(api, () => window.localStorage,
    (project) => { if (mounted.current) dispatch({ type: 'HYDRATE_PROJECT', project }); },
    (videoId, revision) => { if (mounted.current) dispatch({ type: 'SET_PROJECT_REVISION', videoId, revision }); },
  ));
  const [view, setView] = useState(manager.view);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = manager.subscribe(() => setView(manager.view));
    setView(manager.view);
    return () => { mounted.current = false; unsubscribe(); };
  }, [manager]);
  useEffect(() => { manager.setOnline(state.backendOnline); }, [manager, state.backendOnline]);

  // Commit the recovery journal before the browser can paint a new edit or close.
  useLayoutEffect(() => {
    manager.observe(state.videoId, editingState(state));
  }, [manager, state.videoId, state.editPlan, state.commandUndoStack, state.previewResolution,
    state.renderPreset, state.subtitleExportMode, state.planningStylePreset, state.transcribeOnImport]);

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (manager.dirty || manager.view.status === 'error' || manager.view.status === 'conflict') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [manager]);

  const controls: ProjectControls = {
    ...view,
    retry: () => manager.retry(),
    reloadSaved: () => manager.reloadSaved(),
    overwriteSaved: () => manager.overwriteSaved(),
    switchProject: (id) => manager.switchProject(id),
    refreshProjects: () => manager.refreshProjects(),
    recoverDraft: (key) => manager.recoverDraft(key),
    importVideo: async (file, onProgress) => {
      let imported: ProjectSnapshot | null = null;
      const ok = await manager.transition(async () => {
        const { video_id } = await uploadVideo(file, onProgress);
        imported = await api.get(video_id);
        return imported;
      });
      return ok ? imported : null;
    },
  };
  return controls;
}
