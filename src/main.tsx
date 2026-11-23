import {createRoot} from 'react-dom/client';
import App from './App.tsx';
// Fonts ship inside the app (woff2 bundled by Vite): same look on every machine, offline, no CDN
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/jetbrains-mono';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
