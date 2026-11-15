import { app } from 'electron';

export function dataDir(): string {
  return process.env.ASI_DATA_DIR || app.getPath('userData');
}
