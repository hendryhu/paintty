import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Emit relative asset URLs so one build works at either Pages URL form.
export default defineConfig({
  plugins: [svelte({ compilerOptions: { runes: true } })],
  base: '',
  resolve: { conditions: ['browser'] },
});
