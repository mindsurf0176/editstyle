import type { AppState } from './store';
import type { EditPlan, ProjectEditingState, ProjectSnapshot, RecentProject } from './types';

export type SaveStatus = 'restoring' | 'saving' | 'saved' | 'error' | 'conflict';
export interface PersistenceView {
  status: SaveStatus;
  error: string | null;
  ready: boolean;
  transitioning: boolean;
  projects: RecentProject[];
  listError: string | null;
  recoveryRequired: boolean;
  recoveryDrafts: Array<{ key: string; description: string; updatedAt: string | null }>;
}

export interface ProjectApi {
  current(): Promise<ProjectSnapshot | null>;
  list(): Promise<RecentProject[]>;
  get(id: string): Promise<ProjectSnapshot>;
  open(id: string): Promise<ProjectSnapshot>;
  save(id: string, revision: number, state: ProjectEditingState): Promise<ProjectSnapshot>;
}

export interface DraftJournal {
  schema_version: 1;
  video_id: string;
  base_revision: number;
  base_state: ProjectEditingState;
  state: ProjectEditingState;
  // Retain the exact sent state across a lost response, even if editing continued.
  attempted_state?: ProjectEditingState;
  owner_id?: string;
  generation?: string;
  updated_at?: string;
  recovered_from?: { key: string; generation: string };
  fence_pending?: boolean;
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
interface RecoveryCopy { key: string; draft: DraftJournal; generation: string }
export const draftKey = (id: string, owner?: string) => `cutai.project-draft.v1.${encodeURIComponent(id)}${owner ? `.${owner}` : ''}`;
// One independent marker per immutable source generation: no shared registry updates.
const consumedKey = (key: string, generation: string) => `cutai.project-draft-consumed.v1.${encodeURIComponent(key)}.${encodeURIComponent(generation)}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Project storage failed.';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function validPlan(plan: unknown): plan is EditPlan | null {
  return plan === null || (record(plan) && typeof plan.instruction === 'string'
    && typeof plan.summary === 'string' && finite(plan.estimated_duration) && plan.estimated_duration >= 0
    && Array.isArray(plan.operations) && plan.operations.every((op: unknown) => record(op)
      && ['cut', 'subtitle', 'bgm', 'colorgrade', 'transition', 'speed'].includes(String(op.type))
      && (op.start_time === undefined || finite(op.start_time))
      && (op.end_time === undefined || finite(op.end_time))));
}

export function validateEditingState(value: unknown): asserts value is ProjectEditingState {
  if (!record(value) || !validPlan(value.edit_plan) || !Array.isArray(value.undo_stack)
    || value.undo_stack.length > 20 || !value.undo_stack.every(validPlan)
    || ![360, 480, 720].includes(Number(value.preview_resolution))
    || typeof value.preview_resolution !== 'number'
    || !['draft', 'balanced', 'high'].includes(String(value.render_preset))
    || !['burned', 'sidecar'].includes(String(value.subtitle_export_mode))
    || typeof value.transcribe_on_import !== 'boolean'
    || !(value.planning_style_preset === null || (record(value.planning_style_preset)
      && typeof value.planning_style_preset.name === 'string'
      && typeof value.planning_style_preset.description === 'string'))) {
    throw new Error('Unsupported or damaged project editing data. The saved data was preserved.');
  }
}

export function validateProject(value: unknown, id?: string): asserts value is ProjectSnapshot {
  if (!record(value) || value.schema_version !== 1 || typeof value.video_id !== 'string'
    || (id !== undefined && value.video_id !== id) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0 || !record(value.video_info)
    || value.video_info.video_id !== value.video_id || !finite(value.video_info.duration)
    || value.video_info.duration <= 0 || typeof value.video_info.original_name !== 'string'
    || !['available', 'missing'].includes(String(value.media_status))
    || !(value.analysis === null || (record(value.analysis) && Array.isArray(value.analysis.scenes)
      && Array.isArray(value.analysis.transcript) && record(value.analysis.quality)))) {
    throw new Error('Unsupported or damaged project. The saved data was preserved.');
  }
  validateEditingState(value.state);
}

// Python may reorder object keys or fill optional preset fields with null.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => [key, canonical(value[key])]));
}
export function sameEditingState(a: ProjectEditingState, b: ProjectEditingState): boolean {
  const normalize = (state: ProjectEditingState) => ({ ...state,
    planning_style_preset: state.planning_style_preset
      ? { file: null, style: null, ...state.planning_style_preset } : null,
  });
  return JSON.stringify(canonical(normalize(a))) === JSON.stringify(canonical(normalize(b)));
}

export function editingState(state: AppState): ProjectEditingState {
  return {
    edit_plan: state.editPlan, undo_stack: state.commandUndoStack.slice(0, 20),
    preview_resolution: state.previewResolution, render_preset: state.renderPreset,
    subtitle_export_mode: state.subtitleExportMode, planning_style_preset: state.planningStylePreset,
    transcribe_on_import: state.transcribeOnImport,
  };
}

export class ProjectPersistence {
  view: PersistenceView = { status: 'restoring', error: null, ready: false, transitioning: false, projects: [], listError: null,
    recoveryRequired: false, recoveryDrafts: [] };
  private listeners = new Set<() => void>();
  private project: ProjectSnapshot | null = null;
  private current: ProjectEditingState | null = null;
  private attempted: ProjectEditingState | undefined;
  private recoveredFrom: RecoveryCopy | undefined;
  private needsFence = false;
  private epoch = 0;
  private online = false;
  private bootAttempted = false;
  private bootWork: Promise<void> | null = null;
  private saveWork: Promise<boolean> | null = null;
  private retryWork: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private api: ProjectApi,
    private storage: () => DraftStorage,
    private hydrate: (project: ProjectSnapshot) => void,
    private acknowledge: (id: string, revision: number) => void = () => {},
    private debounceMs = 350,
    readonly ownerId: string = crypto.randomUUID(),
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<PersistenceView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  get dirty() { return Boolean(this.project && this.current && (this.needsFence || !sameEditingState(this.project.state, this.current))); }
  get videoId() { return this.project?.video_id ?? null; }

  private readDraft(id: string, key = draftKey(id, this.ownerId)): RecoveryCopy | null {
    try {
      const raw = this.storage().getItem(key);
      if (raw === null) return null;
      const draft: unknown = JSON.parse(raw);
      if (!record(draft) || draft.schema_version !== 1 || draft.video_id !== id
        || !Number.isSafeInteger(draft.base_revision) || Number(draft.base_revision) < 0) {
        throw new Error('Unsupported recovery record');
      }
      validateEditingState(draft.state);
      validateEditingState(draft.base_state);
      if (draft.attempted_state !== undefined) validateEditingState(draft.attempted_state);
      if (draft.fence_pending !== undefined && typeof draft.fence_pending !== 'boolean') throw new Error('Invalid pending save fence');
      if (draft.owner_id !== undefined && (typeof draft.owner_id !== 'string'
        || key !== draftKey(id, draft.owner_id) || typeof draft.generation !== 'string'
        || !draft.generation)) throw new Error('Invalid recovery ownership');
      if (draft.recovered_from !== undefined && (!record(draft.recovered_from)
        || typeof draft.recovered_from.key !== 'string' || typeof draft.recovered_from.generation !== 'string'
        || !(draft.recovered_from.key === draftKey(id) || draft.recovered_from.key.startsWith(`${draftKey(id)}.`)))) {
        throw new Error('Invalid recovery source');
      }
      // Legacy records have no generation. Their exact bytes identify their version.
      return { key, draft: draft as unknown as DraftJournal,
        generation: typeof draft.generation === 'string' ? draft.generation : raw };
    } catch (error) {
      throw new Error(`Cannot read local recovery data. ${message(error)} Nothing was discarded.`);
    }
  }

  private recoveryCopies(snapshot: ProjectSnapshot): RecoveryCopy[] {
    const storage = this.storage();
    const prefix = draftKey(snapshot.video_id);
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && (key === prefix || key.startsWith(`${prefix}.`)));
    return keys.flatMap((key) => {
      if (key === draftKey(snapshot.video_id, this.ownerId)) return [];
      const copy = this.readDraft(snapshot.video_id, key);
      if (!copy || storage.getItem(consumedKey(key, copy.generation)) !== null) return [];
      // Matching remote contents are already durable. Mark exactly that version only.
      if (sameEditingState(copy.draft.state, snapshot.state)
        && (!(copy.draft.attempted_state || copy.draft.fence_pending) || snapshot.revision > copy.draft.base_revision)) {
        storage.setItem(consumedKey(key, copy.generation), 'saved');
        return [];
      }
      return [copy];
    });
  }
  private recoveryList(copies: RecoveryCopy[]) {
    return copies.map((copy) => ({ key: copy.key,
      description: `${copy.draft.state.edit_plan?.instruction || 'Untitled edit'} · based on revision ${copy.draft.base_revision}`,
      updatedAt: copy.draft.updated_at ?? null,
    }));
  }
  private journal() {
    if (!this.project || !this.current) return;
    try {
      if (!this.dirty && !this.attempted) {
        if (this.recoveredFrom && sameEditingState(this.project.state, this.recoveredFrom.draft.state)) {
          this.storage().setItem(consumedKey(this.recoveredFrom.key, this.recoveredFrom.generation), 'saved');
          this.recoveredFrom = undefined;
        }
        this.storage().removeItem(draftKey(this.project.video_id, this.ownerId));
      } else {
        const draft: DraftJournal = {
          schema_version: 1, video_id: this.project.video_id,
          owner_id: this.ownerId, generation: crypto.randomUUID(), updated_at: new Date().toISOString(),
          base_revision: this.project.revision, base_state: this.project.state,
          state: this.current, attempted_state: this.attempted,
          fence_pending: this.needsFence || undefined,
          recovered_from: this.recoveredFrom ? { key: this.recoveredFrom.key, generation: this.recoveredFrom.generation } : undefined,
        };
        this.storage().setItem(draftKey(this.project.video_id, this.ownerId), JSON.stringify(draft));
      }
    } catch (error) {
      throw new Error(`Local recovery storage is unavailable or full. Keep this window open and retry saving. ${message(error)}`);
    }
  }

  private install(snapshot: ProjectSnapshot, discard = false, selected?: RecoveryCopy) {
    validateProject(snapshot);
    const copies = this.recoveryCopies(snapshot);
    const owned = discard ? null : this.readDraft(snapshot.video_id);
    const draft = discard ? null : selected?.draft ?? owned?.draft ?? null;
    const needsChoice = !discard && !draft && copies.length > 0;
    if (discard) this.storage().removeItem(draftKey(snapshot.video_id, this.ownerId));
    const previous = { project: this.project, current: this.current, attempted: this.attempted,
      recoveredFrom: this.recoveredFrom, needsFence: this.needsFence };
    this.project = snapshot;
    this.current = draft?.state ?? snapshot.state;
    this.attempted = draft?.attempted_state;
    this.recoveredFrom = selected ?? undefined;
    // An unacknowledged earlier save may still commit after this GET. Persist the
    // undo with CAS even when it currently equals the server, fencing that request.
    this.needsFence = Boolean(draft && snapshot.revision === draft.base_revision
      && sameEditingState(snapshot.state, draft.state) && (draft.fence_pending
        || (draft.attempted_state && !sameEditingState(draft.attempted_state, draft.state))));
    let conflict = Boolean(draft && snapshot.revision < draft.base_revision);
    if (draft && !sameEditingState(snapshot.state, draft.state)) {
      conflict = snapshot.revision < draft.base_revision || (!sameEditingState(snapshot.state, draft.base_state)
        && !(draft.attempted_state && sameEditingState(snapshot.state, draft.attempted_state)));
      // In a true conflict, keep the original base in the journal until explicit resolution.
      if (conflict) this.project = { ...snapshot, revision: draft.base_revision, state: draft.base_state };
    }
    if (!this.dirty) this.attempted = undefined;
    try { this.journal(); }
    catch (error) { Object.assign(this, previous); throw error; }
    ++this.epoch;
    this.hydrate({ ...snapshot, state: this.current });
    this.update({ ready: true, status: conflict || needsChoice ? 'conflict' : this.dirty ? 'saving' : 'saved',
      recoveryRequired: needsChoice, recoveryDrafts: this.recoveryList(copies),
      error: needsChoice ? 'Recovery copies from another window or an earlier session are available. Choose a copy or open the saved version.'
        : conflict ? 'Another saved version differs from your local edits. Your edits are still here.' : null });
    if (!conflict && !needsChoice && this.dirty) this.schedule();
  }

  async start(): Promise<void> {
    if (this.bootWork) return this.bootWork;
    if (this.bootAttempted || !this.online) return;
    this.bootAttempted = true;
    this.update({ status: 'restoring', error: null });
    this.bootWork = (async () => {
      try {
        const snapshot = await this.api.current();
        if (snapshot) this.install(snapshot);
        else this.update({ ready: true, status: 'saved' });
      } catch (error) {
        this.update({ ready: false, status: 'error', error: message(error) });
      } finally { this.bootWork = null; }
      void this.refreshProjects();
    })();
    return this.bootWork;
  }

  setOnline(online: boolean) {
    const reconnected = online && !this.online;
    this.online = online;
    if (!this.bootAttempted && online) void this.start();
    else if (reconnected && this.view.ready && this.dirty && this.view.status !== 'conflict') void this.retry();
  }

  observe(videoId: string | null, state: ProjectEditingState) {
    if (!this.view.ready || !this.project || videoId !== this.project.video_id
      || (this.current && sameEditingState(this.current, state))) return;
    this.current = state;
    try { this.journal(); }
    catch (error) { this.update({ status: 'error', error: message(error) }); return; }
    if (this.view.status === 'conflict' || this.view.status === 'error') return;
    this.update({ status: this.dirty || this.saveWork ? 'saving' : 'saved', error: null });
    if (this.dirty) this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.debounceMs);
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.retryWork) return this.retryWork;
    if (this.saveWork) return this.saveWork;
    if (!this.view.ready || this.view.status === 'conflict' || this.view.status === 'error') return false;
    if (!this.dirty) return true;
    if (!this.online) {
      this.update({ status: 'error', error: 'Not saved to the project. Your local recovery copy is kept; reconnect and retry.' });
      return false;
    }
    const epoch = this.epoch;
    this.saveWork = this.drain(epoch).finally(() => { this.saveWork = null; });
    return this.saveWork;
  }
  private async drain(epoch: number): Promise<boolean> {
    try {
      while (this.dirty && this.project && this.current && epoch === this.epoch) {
        const id = this.project.video_id;
        const sent = this.current;
        this.attempted = sent;
        this.journal(); // Never send edits that have no recovery copy.
        this.update({ status: 'saving', error: null });
        const saved = await this.api.save(id, this.project.revision, sent);
        if (epoch !== this.epoch) return false;
        validateProject(saved, id);
        if (saved.revision <= this.project.revision || !sameEditingState(saved.state, sent)) {
          throw new Error('The save response did not confirm this edit. Retry to check the stored version.');
        }
        this.project = saved;
        this.needsFence = false;
        this.attempted = undefined;
        this.acknowledge(id, saved.revision);
        this.journal(); // New edits remain dirty and are written with the acknowledged base.
      }
      if (epoch !== this.epoch) return false;
      this.update({ status: 'saved', error: null, recoveryRequired: false,
        recoveryDrafts: this.project ? this.recoveryList(this.recoveryCopies(this.project)) : [] });
      void this.refreshProjects();
      return true;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      const conflict = record(error) && error.status === 409;
      this.update({ status: conflict ? 'conflict' : 'error', error: conflict
        ? 'Another saved version exists. Your edits are kept. Retry to check the saved version, or choose a version below.' : message(error) });
      return false;
    }
  }

  retry(): Promise<boolean> {
    if (this.view.recoveryRequired) return Promise.resolve(false);
    if (!this.view.ready) {
      this.bootAttempted = false;
      return this.start().then(() => this.view.ready);
    }
    if (this.retryWork) return this.retryWork;
    this.retryWork = this.reconcile(false).finally(() => { this.retryWork = null; });
    return this.retryWork;
  }
  private async reconcile(overwrite: boolean): Promise<boolean> {
    if (this.saveWork) await this.saveWork;
    if (!this.project || !this.current) {
      this.update({ status: 'saved', error: null });
      return true;
    }
    const epoch = this.epoch;
    try {
      this.update({ status: 'saving', error: null });
      const remote = await this.api.get(this.project.video_id);
      if (epoch !== this.epoch) return false;
      validateProject(remote, this.project.video_id);
      const related = remote.revision >= this.project.revision && (
        sameEditingState(remote.state, this.current) || sameEditingState(remote.state, this.project.state)
        || (this.attempted && sameEditingState(remote.state, this.attempted)));
      if (!related && !overwrite) {
        this.update({ status: 'conflict', error: 'The saved version has different edits. Choose which version to keep.' });
        return false;
      }
      this.needsFence = Boolean(remote.revision === this.project.revision && sameEditingState(remote.state, this.current)
        && (this.needsFence || (this.attempted && !sameEditingState(this.attempted, this.current))));
      this.project = remote;
      this.attempted = undefined;
      this.acknowledge(remote.video_id, remote.revision);
      this.journal();
      return await this.drain(epoch);
    } catch (error) {
      if (epoch === this.epoch) this.update({ status: 'error', error: message(error) });
      return false;
    }
  }

  async overwriteSaved(): Promise<boolean> {
    if (this.view.recoveryRequired || this.view.transitioning || this.saveWork || this.retryWork) return false;
    this.retryWork = this.reconcile(true).finally(() => { this.retryWork = null; });
    return this.retryWork;
  }

  async reloadSaved(): Promise<boolean> {
    if (!this.project || this.view.transitioning || this.saveWork || this.retryWork) return false;
    this.update({ transitioning: true });
    try {
      const snapshot = await this.api.get(this.project.video_id);
      validateProject(snapshot, this.project.video_id);
      this.install(snapshot, true);
      return true;
    } catch (error) {
      this.update({ status: 'error', error: message(error) });
      return false;
    } finally { this.update({ transitioning: false }); }
  }

  async recoverDraft(key: string): Promise<boolean> {
    if (!this.project || this.view.transitioning || this.saveWork || this.retryWork) return false;
    if (this.dirty) {
      this.update({ error: 'Save or resolve your current edits before choosing another recovery copy.' });
      return false;
    }
    if (!this.view.recoveryDrafts.some((copy) => copy.key === key)) return false;
    this.update({ transitioning: true });
    try {
      const snapshot = await this.api.get(this.project.video_id);
      validateProject(snapshot, this.project.video_id);
      const copy = this.readDraft(snapshot.video_id, key);
      if (!copy) throw new Error('That recovery copy is no longer available. Refresh the project to check again.');
      this.install(snapshot, false, copy);
      return true;
    } catch (error) {
      this.update({ status: 'error', error: message(error) });
      return false;
    } finally { this.update({ transitioning: false }); }
  }

  async switchProject(id: string): Promise<boolean> {
    return this.transition(async () => {
      const candidate = await this.api.get(id);
      validateProject(candidate, id);
      this.readDraft(id);
      this.recoveryCopies(candidate); // Do not activate unreadable recovery data.
      const opened = await this.api.open(id);
      validateProject(opened, id);
      return opened;
    });
  }

  async transition(load: () => Promise<ProjectSnapshot>): Promise<boolean> {
    if (!this.view.ready || this.view.transitioning) return false;
    this.update({ transitioning: true });
    try {
      if (!await this.flush()) return false;
      let next = await load();
      // A pending planning response can finish while the new project is being read.
      // Drain that edit as well before replacing the current editor state.
      if (!await this.flush()) return false;
      if (next.video_id === this.project?.video_id && next.revision < this.project.revision) {
        next = { ...next, revision: this.project.revision, state: this.project.state };
      }
      this.install(next);
      void this.refreshProjects();
      return true;
    } catch (error) {
      this.update({ status: 'error', error: message(error) });
      return false;
    } finally { this.update({ transitioning: false }); }
  }

  async refreshProjects() {
    try { this.update({ projects: await this.api.list(), listError: null }); }
    catch (error) { this.update({ listError: `Cannot list projects. ${message(error)}` }); }
  }
}
