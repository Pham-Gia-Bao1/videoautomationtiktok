import { isAbsolute, resolve } from 'node:path';

export const projectRoot = resolve(__dirname, '../../..');

export function resolveProjectPath(path: string): string {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}
