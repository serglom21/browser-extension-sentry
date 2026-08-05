import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve bare package imports against this folder's own node_modules.
 *
 * Without this, esbuild walks up the filesystem looking for a Yarn Plug'n'Play
 * manifest and will happily find an unrelated one (e.g. a stray ~/.pnp.cjs from
 * some other project), then refuse to resolve @sentry/* because it isn't listed as
 * a dependency there. Resolving explicitly keeps the build reproducible regardless
 * of what lives in the parent directories.
 *
 * Prefers each package's ESM entry (`module` field) so esbuild can tree-shake,
 * falling back to `main` / plain require.resolve.
 */
const localNodeModules = {
  name: 'local-node-modules',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      try {
        const pkgJsonPath = require.resolve(`${args.path}/package.json`);
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const esmEntry = pkgJson.module ?? pkgJson.main;
        if (esmEntry) {
          return { path: path.join(path.dirname(pkgJsonPath), esmEntry) };
        }
      } catch {
        /* not a package root export; fall through */
      }
      try {
        return { path: require.resolve(args.path) };
      } catch {
        return null;
      }
    });
  },
};

const shared = {
  bundle: true,
  format: 'iife',
  target: 'chrome114',
  platform: 'browser',
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [localNodeModules],
};

const builds = [
  // Output the worker at the extension root so its pathname is `/service-worker.js`,
  // matching the upstream `pageload /service-worker.js` transaction name.
  {
    entryPoints: ['app/scripts/background.js'],
    outfile: 'service-worker.js',
    ...shared,
  },
  { entryPoints: ['app/popup.js'], outfile: 'popup.bundle.js', ...shared },
];

if (process.argv.includes('--watch')) {
  for (const config of builds) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log('watching…');
} else {
  await Promise.all(builds.map((config) => esbuild.build(config)));
  console.log('build complete -> extension/service-worker.js + popup.bundle.js');
}
