import { detectExternalCli, ExternalCliAdapter } from './external-cli-adapter.js';
export class OmxCliAdapter extends ExternalCliAdapter {
    constructor(cwd = process.cwd()) {
        super('omx', cwd);
    }
}
export function detectOmxCli(cwd = process.cwd()) {
    return detectExternalCli('omx', cwd);
}
