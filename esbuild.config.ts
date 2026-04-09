import { buildSync } from 'esbuild';

buildSync({
  entryPoints: ['src/client/app.ts'],
  bundle: true,
  outfile: 'public/bundle.js',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
});
