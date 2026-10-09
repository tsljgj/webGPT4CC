// Shared loader for the bin scripts. Inside node_modules (npm install -g / npx)
// Node refuses to strip TypeScript types, so the compiled dist/ build is used
// there; in a git checkout the TypeScript sources run directly (Node >= 22.18),
// so edits take effect without a rebuild.
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function loadCli() {
  const dist = new URL('../dist/cli.js', import.meta.url);
  const src = new URL('../bridge/src/cli.ts', import.meta.url);
  const here = realpathSync(fileURLToPath(import.meta.url));
  const inNodeModules = /[\\/]node_modules[\\/]/.test(here);
  if (inNodeModules || !existsSync(src)) {
    if (!existsSync(dist)) {
      console.error('webgpt4cc: dist/ is missing. Run `npm run build` in the package directory.');
      process.exit(1);
    }
    return import(dist.href);
  }
  return import(src.href);
}
