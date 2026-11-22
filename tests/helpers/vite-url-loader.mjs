// Lets node import files written for Vite: `import x from './file?url'` resolves to the path.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?url')) return { url: 'kscreen-url:' + specifier.slice(0, -4), shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('kscreen-url:')) return { format: 'module', source: 'export default ' + JSON.stringify(url.slice(12)), shortCircuit: true };
  return next(url, context);
}
`));
