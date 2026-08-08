import './styles/theme.css';
import './styles/global.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startStartupAssets } from './lib/startupAssets.js';
import { installUniversalTabBlock } from './lib/inputPolicy.js';

installUniversalTabBlock();
const app = mount(App, { target: document.getElementById('app') });
startStartupAssets();

export default app;
