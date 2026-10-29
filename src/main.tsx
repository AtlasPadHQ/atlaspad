/**
 * Entry point. SHARED file (scaffold / integrator only).
 * CSS order: tokens → MapLibre (fallback map) → global base → shared components → App layout.
 * Module CSS is imported by each module's own components.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/global.css';
import './styles/components.css';
import App from './App';
import RegionBlocked from './compliance/RegionBlocked';
import { installRegionBlockWatch } from './compliance/regionBlock';
import { installChunkReload } from './lib/chunkReload';
import { AppCrash, ErrorBoundary } from './ui/ErrorBoundary';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
// sanctions geo-block: an API answer of 451 region_blocked shows <RegionBlocked/> over the app (worker/geo.ts)
installRegionBlockWatch();
// a tab from before a deploy whose lazy chunk is gone reloads once (src/lib/chunkReload)
installChunkReload();

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary name="app" fallback={<AppCrash />}>
      <App />
    </ErrorBoundary>
    <RegionBlocked />
  </StrictMode>,
);
