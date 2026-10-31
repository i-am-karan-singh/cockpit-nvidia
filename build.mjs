import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.jsx'],
  bundle: true,
  outfile: 'dist/index.js',
  target: 'es2020',
  loader: { '.css': 'css', '.woff2': 'file', '.py': 'text' },
  sourcemap: true,
  legalComments: 'external',
});
await Promise.all([
  copyFile('src/index.html', 'dist/index.html'),
  copyFile('src/manifest.json', 'dist/manifest.json'),
]);
