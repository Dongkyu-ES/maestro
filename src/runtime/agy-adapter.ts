import { detectExternalCli, ExternalCliAdapter } from './external-cli-adapter.js';
export class AgyCliAdapter extends ExternalCliAdapter {
  constructor(cwd = process.cwd()) {
    super('agy', cwd);
  }
}
export function detectAgyCli(cwd = process.cwd()) {
  return detectExternalCli('agy', cwd);
}
