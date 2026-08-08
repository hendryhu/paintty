<script>
  import { tick } from 'svelte';
  import ProjectParameterFields from './ProjectParameterFields.svelte';
  import { dirty } from '../lib/stores.js';
  import { notifyError } from '../lib/notifications.js';
  import { replaceWithBlankProject } from '../lib/newProjectLifecycle.js';
  import { popupFocus } from '../lib/popupFocus.js';
  import {
    BUILT_IN_PROJECT_PRESETS,
    allProjectPresets,
    deleteUserProjectPreset,
    loadProjectPresetSettings,
    persistProjectPresetSettings,
    projectPresetById,
    rememberProjectDraft,
    renameUserProjectPreset,
    resetProjectDraftToDefault,
    saveUserProjectPreset,
    selectProjectPreset,
    setDefaultProjectPreset,
    validateProjectDraft,
  } from '../lib/projectPresets.js';

  /**
   * @typedef {Object} Props
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { onClose = () => {} } = $props();
  const initialSettings = loadProjectPresetSettings();
  const initialPresetId = initialSettings.lastUsed.presetId;
  let settings = $state(initialSettings);
  let selectedPresetId = $state(initialPresetId);
  let columns = $state(initialSettings.lastUsed.draft.columns);
  let rows = $state(initialSettings.lastUsed.draft.rows);
  let baseFps = $state(initialSettings.lastUsed.draft.baseFps);
  const initialPreset = projectPresetById(initialSettings, initialPresetId);
  let presetName = $state(initialPreset && !initialPreset.builtIn ? initialPreset.name : '');
  let presetError = $state('');
  let confirmingCreate = $state(false);
  let pendingPresetDeletion = $state(null);
  let busy = $state(false);
  let dialog = $state();
  let cancelConfirmationButton = $state();
  let deletePresetButton = $state();

  let presets = $derived(allProjectPresets(settings));
  let userPresets = $derived(presets.filter((preset) => !preset.builtIn));
  let selectedPreset = $derived(projectPresetById(settings, selectedPresetId));
  let selectedIsUser = $derived(!!selectedPreset && !selectedPreset.builtIn);

  function close() {
    if (!busy) onClose();
  }
  function currentDraft() {
    return { columns, rows, baseFps };
  }
  function applySettings(next) {
    settings = next;
    try {
      settings = persistProjectPresetSettings(settings);
    } catch (error) {
      notifyError(`Could not save project presets: ${error.message}`);
    }
  }
  function applyLastUsed(next) {
    applySettings(next);
    selectedPresetId = settings.lastUsed.presetId;
    columns = settings.lastUsed.draft.columns;
    rows = settings.lastUsed.draft.rows;
    baseFps = settings.lastUsed.draft.baseFps;
    const selected = projectPresetById(settings, selectedPresetId);
    presetName = selected && !selected.builtIn ? selected.name : '';
    presetError = '';
  }
  function rememberDraft() {
    try {
      applySettings(rememberProjectDraft(settings, currentDraft(), selectedPresetId));
      presetError = '';
    } catch (error) {
      presetError = error.message;
    }
  }
  function choosePreset() {
    try {
      applyLastUsed(selectProjectPreset(settings, selectedPresetId));
    } catch (error) {
      presetError = error.message;
    }
  }
  function savePreset() {
    try {
      applyLastUsed(saveUserProjectPreset(settings, presetName, currentDraft()));
    } catch (error) {
      presetError = error.message;
    }
  }
  function renamePreset() {
    try {
      applySettings(renameUserProjectPreset(settings, selectedPresetId, presetName));
      presetName = projectPresetById(settings, selectedPresetId)?.name || '';
      presetError = '';
    } catch (error) {
      presetError = error.message;
    }
  }
  function requestPresetDeletion() {
    if (!selectedIsUser || !selectedPreset) return;
    pendingPresetDeletion = {
      id: selectedPreset.id,
      name: selectedPreset.name,
    };
    presetError = '';
  }
  function confirmPresetDeletion() {
    if (!pendingPresetDeletion) return;
    try {
      const next = deleteUserProjectPreset(settings, pendingPresetDeletion.id);
      pendingPresetDeletion = null;
      applyLastUsed(next);
      tick().then(() => dialog?.querySelector('#new-project-preset')?.focus({ preventScroll: true }));
    } catch (error) {
      presetError = error.message;
    }
  }
  function makeDefault() {
    try {
      applySettings(setDefaultProjectPreset(settings, selectedPresetId));
      presetError = '';
    } catch (error) {
      presetError = error.message;
    }
  }
  function resetDefault() {
    applyLastUsed(resetProjectDraftToDefault(settings));
  }
  function requestCreate() {
    try {
      validateProjectDraft(currentDraft());
      rememberDraft();
      if (presetError) return;
    } catch (error) {
      notifyError(`Could not create project: ${error.message}`);
      return;
    }
    if ($dirty) {
      confirmingCreate = true;
      return;
    }
    createProject();
  }
  async function createProject() {
    busy = true;
    try {
      await replaceWithBlankProject(currentDraft());
      onClose();
    } catch (error) {
      notifyError(`Could not create project: ${error.message}`);
      confirmingCreate = false;
    } finally {
      busy = false;
    }
  }
  function cancelConfirmation() {
    if (busy) return;
    const returnToDelete = !!pendingPresetDeletion;
    confirmingCreate = false;
    pendingPresetDeletion = null;
    tick().then(() => {
      const target = returnToDelete
        ? deletePresetButton
        : dialog?.querySelector('input, select, button:not([disabled])');
      target?.focus({ preventScroll: true });
    });
  }
  $effect(() => {
    if (confirmingCreate || pendingPresetDeletion) {
      tick().then(() => cancelConfirmationButton?.focus({ preventScroll: true }));
    }
  });
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }
  function onKey(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key !== 'Escape' || busy) return;
    if (!confirmingCreate && !pendingPresetDeletion &&
      event.target.closest?.('.number-field[data-dirty="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (confirmingCreate || pendingPresetDeletion) cancelConfirmation();
    else close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" onclick={backdropClick} role="presentation">
  <section class="modal-dialog new-project-dialog" role="dialog" aria-modal="true"
    aria-labelledby="new-project-title" tabindex="-1" bind:this={dialog}
    use:popupFocus={{ initialFocus: 'input, select, button:not([disabled])' }}>
    <header class="modal-head">
      <span id="new-project-title">{pendingPresetDeletion ? 'Delete preset?' : confirmingCreate ? 'Discard changes?' : 'New Project'}</span>
      <button class="modal-close" type="button" aria-label="Close" disabled={busy} onclick={close}>&times;</button>
    </header>

    {#if pendingPresetDeletion}
      <div class="confirmation">
        <p><strong>{pendingPresetDeletion.name}</strong> will be removed.</p>
      </div>
      <footer>
        <button class="secondary-button" type="button" bind:this={cancelConfirmationButton}
          onclick={cancelConfirmation}>Cancel</button>
        <button class="danger-button" type="button" onclick={confirmPresetDeletion}>Delete</button>
      </footer>
    {:else if confirmingCreate}
      <div class="confirmation">
        <p>The current project has unsaved changes. A recovery checkpoint will be created before it is replaced.</p>
      </div>
      <footer>
        <button class="secondary-button" type="button" disabled={busy} bind:this={cancelConfirmationButton}
          onclick={cancelConfirmation}>Cancel</button>
        <button class="danger-button" type="button" disabled={busy} onclick={createProject}>
          {busy ? 'Creating…' : 'Discard and Create'}
        </button>
      </footer>
    {:else}
      <div class="body scroll">
        <section class="section">
          <label class="field-label" for="new-project-preset">Preset</label>
          <select id="new-project-preset" bind:value={selectedPresetId} onchange={choosePreset}>
            <optgroup label="Built-in">
              {#each BUILT_IN_PROJECT_PRESETS as preset}
                <option value={preset.id}>{preset.name}{settings.defaultPresetId === preset.id ? ' (default)' : ''}</option>
              {/each}
            </optgroup>
            {#if userPresets.length}
              <optgroup label="Saved">
                {#each userPresets as preset (preset.id)}
                  <option value={preset.id}>{preset.name}{settings.defaultPresetId === preset.id ? ' (default)' : ''}</option>
                {/each}
              </optgroup>
            {/if}
          </select>
          <div class="preset-defaults">
            <button class="secondary-button" type="button"
              disabled={settings.defaultPresetId === selectedPresetId} onclick={makeDefault}>Set as default</button>
            <button class="secondary-button" type="button" onclick={resetDefault}>Reset to default</button>
          </div>
        </section>

        <section class="section">
          <ProjectParameterFields bind:columns bind:rows bind:baseFps onCommit={rememberDraft} />
        </section>

        <section class="section preset-editor">
          <label class="field-label" for="preset-name">Preset name</label>
          <input id="preset-name" type="text" maxlength="64" bind:value={presetName}
            placeholder="My terminal" oninput={() => (presetError = '')} />
          <div class="preset-actions">
            <button class="secondary-button" type="button" onclick={savePreset}>Save as new</button>
            <button class="secondary-button" type="button" disabled={!selectedIsUser} onclick={renamePreset}>Rename</button>
            <button class="danger-button" type="button" disabled={!selectedIsUser}
              bind:this={deletePresetButton} onclick={requestPresetDeletion}>Delete</button>
          </div>
          {#if presetError}<p class="error" role="alert">{presetError}</p>{/if}
          {#if !selectedIsUser}<p class="hint">Built-in presets cannot be renamed or deleted.</p>{/if}
        </section>
      </div>
      <footer>
        <button class="secondary-button" type="button" onclick={close}>Cancel</button>
        <button class="primary-button" type="button" onclick={requestCreate}>Create</button>
      </footer>
    {/if}
  </section>
</div>

<style>
  .new-project-dialog {
    display: flex; flex-direction: column; width: min(520px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
  }
  .body { min-height: 0; overflow-y: auto; }
  .section { padding: 14px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: 0; }
  .field-label { display: block; margin-bottom: 5px; color: var(--text-dim); font-size: 11px; }
  select, input[type='text'] { width: 100%; }
  .preset-defaults, .preset-actions {
    display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px;
  }
  .preset-editor .danger-button { padding: 7px 12px; font-size: 12px; }
  .hint, .error { margin: 7px 0 0; font-size: 10px; line-height: 1.4; }
  .hint { color: var(--text-faint); }
  .error { color: var(--danger); }
  .confirmation { padding: 18px 16px; color: var(--text); font-size: 12px; line-height: 1.55; }
  footer {
    display: flex; flex: 0 0 auto; justify-content: flex-end; gap: 8px; padding: 10px 12px;
    border-top: 1px solid var(--border);
  }
  footer .danger-button { padding: 7px 12px; font-size: 12px; }
  @media (max-width: 440px) {
    .new-project-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
    .preset-defaults > button, .preset-actions > button { flex: 1; }
  }
</style>
