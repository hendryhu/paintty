import './styles/theme.css';
import './styles/global.css';
import './styles/components.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startStartupAssets } from './lib/startupAssets.js';
import { installUniversalTabBlock } from './lib/inputPolicy.js';

installUniversalTabBlock();
const target = document.getElementById('app');
if (!target) throw new Error('Paintty root element is missing.');
const app = mount(App, { target });
startStartupAssets();

export default app;
