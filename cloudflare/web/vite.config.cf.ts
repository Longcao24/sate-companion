// Vite config for building the EXISTING web app against the Cloudflare backend.
//
// Nothing in react_app_sate-ui_update/src is modified. The plugin below redirects the module
// that `import { supabase } from '.../lib/supabase'` resolves to, so all 19 files and 77
// call sites keep their code and talk to the Worker instead.
//
// Run from anywhere:
//   VITE_CF_URL=https://sate-cf.<subdomain>.workers.dev \
//     npx vite build --config cloudflare/web/vite.config.cf.ts
//
// The normal `npm run build` is untouched and still targets Supabase.

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../react_app_sate-ui_update');
const realClient = path.resolve(webRoot, 'src/lib/supabase.ts');
const shim = path.resolve(here, 'supabaseShim.ts');

/**
 * Swap the Supabase client for the Cloudflare shim.
 *
 * This is a resolveId hook rather than a `resolve.alias` entry on purpose. An alias matches
 * the import SPECIFIER as written, and the app imports the client both ways:
 *
 *   13 files  import { supabase } from '@/lib/supabase'
 *    1 file   import { supabase } from '../../lib/supabase'   <- src/components/Auth/MobileLinkModal.tsx
 *
 * An alias on '@/lib/supabase' silently misses that relative one, so the QR sign-in modal
 * would keep talking to the real Supabase project while the rest of the build talked to the
 * Worker — a half-migrated bundle that mostly works, which is the worst kind. Matching on the
 * RESOLVED path catches every spelling, now and for any import added later.
 */
function useCloudflareBackend(): Plugin {
  return {
    name: 'sate-use-cloudflare-backend',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // Let the shim import whatever it likes without recursing into this hook.
      if (source === shim || importer === shim) return null;

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved && path.normalize(resolved.id.split('?')[0]) === realClient) return shim;
      return null;
    },
  };
}

export default defineConfig({
  root: webRoot,
  plugins: [useCloudflareBackend(), react()],
  resolve: {
    alias: { '@': path.resolve(webRoot, 'src') },
  },
  build: {
    // Keep this build's output away from the Supabase build's dist/, so deploying one can
    // never accidentally ship the other.
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
  },
});
