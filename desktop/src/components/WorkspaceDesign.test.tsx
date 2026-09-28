import { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppMainContent } from '../App';
import { AppContext, appReducer, initialState, type AppState } from '../store';
import { ProjectPersistenceContext, type ProjectControls } from '../useProjectPersistence';
import type { EditPlan } from '../types';
import * as api from '../api';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const plan: EditPlan = {
  instruction: 'Keep opening; remove pause', summary: 'Review source edits', estimated_duration: 8,
  operations: [
    { type: 'cut', action: 'keep', start_time: 0, end_time: 12, description: 'Opening' },
    { type: 'cut', action: 'remove', start_time: 4, end_time: 8, description: 'Pause' },
  ],
};
const controls: ProjectControls = {
  ready: true, transitioning: false, status: 'saved', error: null, listError: null, projects: [],
  recoveryRequired: false, recoveryDrafts: [], recoverDraft: async () => true,
  retry: async () => true, reloadSaved: async () => true, overwriteSaved: async () => true,
  switchProject: async () => true, refreshProjects: async () => {}, importVideo: async () => null,
};

describe('workspace design interaction regressions', () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: AppState;

  beforeEach(() => {
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<AppState> = {}, project: ProjectControls = controls) {
    function Harness() {
      const [current, dispatch] = useReducer(appReducer, {
        ...initialState, backendStatus: 'online', backendOnline: true, videoId: 'workspace-fixture',
        videoInfo: { video_id: 'workspace-fixture', original_name: 'fixture.mp4', duration: 30, width: 960, height: 540, fps: 24, file_size: 1 },
        analysis: {
          file_path: '/fixture.mp4', duration: 30, width: 960, height: 540, fps: 24,
          scenes: [{ id: 0, start_time: 0, end_time: 12, duration: 12, has_speech: false, is_silent: false }],
          transcript: [], quality: { silent_segments: [], audio_energy: [], overall_silence_ratio: 0 },
        },
        editPlan: plan, previewResolution: 360, renderPreset: 'balanced', sidebarTab: 'edit',
        ...overrides,
      });
      state = current;
      return <AppContext.Provider value={{ state: current, dispatch }}>
        <ProjectPersistenceContext.Provider value={project}>
          <AppMainContent onRetryBackend={() => {}} retryingBackend={false} />
        </ProjectPersistenceContext.Provider>
      </AppContext.Provider>;
    }
    await act(async () => root.render(<Harness />));
  }

  function button(label: string, within: ParentNode = container): HTMLButtonElement {
    const match = [...within.querySelectorAll('button')].find((element) =>
      element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
    if (!match) throw new Error(`Missing button: ${label}`);
    return match;
  }

  it('applies an in-flight plan while instructions stay folded, then reveals its response', async () => {
    let complete!: (value: EditPlan) => void;
    const pending = new Promise<EditPlan>((resolve) => { complete = resolve; });
    const request = vi.spyOn(api, 'createPlan').mockReturnValue(pending);
    await render({ editPlan: null });
    const input = container.querySelector('#editing-instruction');
    await act(async () => button('Remove all silent parts').click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Building edit plan…');
    await act(async () => button('Collapse AI instructions').click());
    const hidden = container.querySelector('#ai-instructions-content') as HTMLElement;
    expect(hidden.hidden).toBe(true);
    expect(hidden.hasAttribute('inert')).toBe(true);
    await act(async () => complete(plan));
    expect(state.editPlan?.operations).toEqual(plan.operations);
    expect(state.sidebarTab).toBe('edit');
    expect(hidden.hidden).toBe(true);
    await act(async () => button('Expand AI instructions').click());
    expect(container.querySelector('#editing-instruction')).toBe(input);
    expect(hidden.textContent).toContain('Added to the edit plan:');
    expect(hidden.textContent).not.toContain('Building edit plan…');
    expect((input as HTMLInputElement).disabled).toBe(false);
    await act(async () => {
      const field = input as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Trim the pause');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Send editing instruction').disabled).toBe(false);
  });

  it('keeps saved edits readable when source media is missing while disabling source actions', async () => {
    const request = vi.spyOn(api, 'createPlan');
    await render({ mediaStatus: 'missing' });
    expect(container.textContent).toContain('fixture.mp4 · Source unavailable');
    expect(container.querySelector('[aria-label="Video workspace"]')).toBeNull();
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    expect(button('Preview 360p').matches(':disabled')).toBe(true);
    expect(button('Render Balanced').matches(':disabled')).toBe(true);
    expect(button('Remove all silent parts').disabled).toBe(true);
    expect(container.textContent).toContain('Keep opening; remove pause');
    await act(async () => button('Remove all silent parts').click());
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['recoveryRequired', 'transitioning'] as const)('keeps the whole editing workspace inert during %s', async (guard) => {
    await render({}, { ...controls, [guard]: true });
    const instructions = container.querySelector('[aria-label="AI instructions"]')!;
    expect(instructions.parentElement?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[aria-label="Video workspace"]')?.closest('[inert]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Editing tools"]')?.closest('[inert]')).not.toBeNull();
    expect(state.editPlan).toEqual(plan);
  });

  it('puts overlapping operations on distinct lanes with action, source time and shared selection', async () => {
    await render();
    const keep = button('cut keep: Opening (0:00–0:12)');
    const remove = button('cut remove: Pause (0:04–0:08)');
    expect(keep.style.top).not.toBe(remove.style.top);
    await act(async () => remove.click());
    expect(remove.getAttribute('aria-pressed')).toBe('true');
    expect(keep.getAttribute('aria-pressed')).toBe('false');
    expect(button('Select operation 2').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Source timeline"]')?.textContent).toContain('remove · Pause 0:04–0:08');
    expect((container.querySelector('[aria-label="Range start"]') as HTMLInputElement).value).toBe('4');
    expect((container.querySelector('[aria-label="Range end"]') as HTMLInputElement).value).toBe('8');
    await act(async () => button('Select operation 1').click());
    expect(keep.getAttribute('aria-pressed')).toBe('true');
    expect(remove.getAttribute('aria-pressed')).toBe('false');
  });

  it('exposes independent selected quality settings and names the resulting actions', async () => {
    await render();
    const preview = container.querySelector('[role="group"][aria-label="Preview quality"]')!;
    const renderQuality = container.querySelector('[role="group"][aria-label="Render quality"]')!;
    expect(button('360p', preview).getAttribute('aria-pressed')).toBe('true');
    expect(button('Balanced', renderQuality).getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('720p', preview).click());
    await act(async () => button('Draft', renderQuality).click());
    expect(preview.querySelectorAll('[aria-pressed="true"]').length).toBe(1);
    expect(renderQuality.querySelectorAll('[aria-pressed="true"]').length).toBe(1);
    expect(button('720p', preview).getAttribute('aria-pressed')).toBe('true');
    expect(button('Draft', renderQuality).getAttribute('aria-pressed')).toBe('true');
    expect(button('Preview 720p').disabled).toBe(false);
    expect(button('Render Draft').disabled).toBe(false);
    const renderAction = button('Render Draft');
    expect(renderAction.className).toContain('text-on-accent');
    expect(renderAction.className).toContain('text-ui');
    expect(renderAction.className).toContain('bg-accent');
    const selectedQuality = button('Draft', renderQuality);
    expect(selectedQuality.className).toContain('text-on-accent');
    expect(selectedQuality.className).toContain('text-ui');
  });
});
