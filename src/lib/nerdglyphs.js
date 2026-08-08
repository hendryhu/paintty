import { writable } from 'svelte/store';

const BASE_URL = import.meta.env?.BASE_URL || './';
const GLYPHNAMES_URL = `${BASE_URL}vendor/nerd-fonts/v3.2.1/glyphnames.json`;

const GROUPS = [
  ['pl',      'Powerline'],
  ['ple',     'Powerline+'],
  ['dev',     'Devicons'],
  ['fa',      'Font Awesome'],
  ['fae',     'FA Extra'],
  ['weather', 'Weather'],
  ['seti',    'Seti'],
  ['custom',  'Custom'],
  ['oct',     'Octicons'],
  ['cod',     'Codicons'],
  ['md',      'Material'],
  ['linux',   'Logos'],
  ['iec',     'Power'],
  ['pom',     'Pomicons'],
];
const GROUP_LABELS = new Map(GROUPS);

export const nerdGlyphs = writable({ ready: false, groups: [], all: [] });

let loadPromise = null;
export async function loadNerdGlyphs() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const response = await fetch(GLYPHNAMES_URL);
      if (!response.ok) throw new Error(`Glyph catalog request failed (${response.status})`);
      const data = await response.json();

      const byCode = new Map();
      for (const [name, entry] of Object.entries(data)) {
        if (name === 'METADATA' || !entry?.char) continue;
        const prefix = name.replace(/^nf-/, '').split('-')[0];
        const known = GROUP_LABELS.has(prefix);
        const g = byCode.get(entry.code);
        if (!g) byCode.set(entry.code, { char: entry.char, code: entry.code, name, group: known ? prefix : null, names: [name] });
        else { g.names.push(name); if (!g.group && known) { g.group = prefix; g.name = name; } }
      }

      const all = [...byCode.values()];
      const byGroup = new Map();
      for (const g of all) {
        const id = g.group || 'other';
        if (!byGroup.has(id)) byGroup.set(id, []);
        byGroup.get(id).push(g);
      }
      const groups = GROUPS.filter(([id]) => byGroup.has(id)).map(([id, label]) => ({ id, label, glyphs: byGroup.get(id) }));
      if (byGroup.has('other')) groups.push({ id: 'other', label: 'Other', glyphs: byGroup.get('other') });

      nerdGlyphs.set({ ready: true, groups, all });
    } catch (error) {
      loadPromise = null;
      nerdGlyphs.set({ ready: false, groups: [], all: [], error: true });
      throw error;
    }
  })();
  return loadPromise;
}
