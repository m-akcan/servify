import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/canvas.css';
import './styles/app.css';
import './styles/features.css';
import { App } from './App.tsx';
import { applyTheme } from './lib/theme.ts';

applyTheme();
createRoot(document.getElementById('root')!).render(<App />);
