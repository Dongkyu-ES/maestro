import { appendRuntimeEvent, readRuntimeEvents, validateRuntimeLedger } from '../events/ledger.js';
import type { CatalogModule } from './catalog.js';
import {
  type InjectedFile,
  type InjectionAdapter,
  type InjectionManifest,
  type McpInjectionStatus,
  recomputeInjectionFiles,
} from './inject.js';

/**
 * Slice 3 — make injection part of Warden's RECOMPUTABLE evidence layer, not just a side-file.
 * `composition.injected` is appended to the hash-chained runtime ledger (refs/hashes only, no
 * free-form decision field), and `recomputeInjectionFromLedger` re-derives the injected file set
 * from the CALLER-SUPPLIED current catalog inputs (NOT recovered from the ledger — the inputs are
 * not stored in the event) and compares it to the recorded event. So a `reproduced:false` means
 * "the recorded injection does not match a fresh derivation from today's catalog" — catching both a
 * forged record and legitimate catalog drift. Two complementary guards:
 *   - the hash chain (validateRuntimeLedger) makes any tampered MIDDLE event fail closed;
 *   - the re-derivation catches a forged HEAD event (a record the chain alone can't refute) — the
 *     recorded injection must equal what re-resolving the same catalog+inputs produces.
 * This module does NOT touch the orchestrator hot path; it is wired into `warden magic apply`.
 */

export function recordInjectionEvent(runDir: string, runId: string, manifest: InjectionManifest): void {
  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: 'composition.injected',
    payload: {
      executor: manifest.executor,
      mcp_injection: manifest.mcp_injection,
      files: manifest.files,
      skipped_secret_servers: manifest.skipped_secret_servers,
      backed_up: manifest.backed_up,
    },
  });
}

export interface InjectionLedgerCheck {
  ledgerValid: true; // validateRuntimeLedger threw if not — reaching here means the chain is intact
  found: boolean;
  /** The recorded event's mcp_injection status, so a reader can tell an empty `none`/`unsupported`
   *  reproduction (nothing injected, trivially reproduced) from a real `applied-unproven` match. */
  status: McpInjectionStatus | null;
  reproduced: boolean;
  recorded: InjectedFile[];
  expected: InjectedFile[];
  reason: string;
}

function sameFiles(a: InjectedFile[], b: InjectedFile[]): boolean {
  if (a.length !== b.length) return false;
  const byPath = new Map(b.map((f) => [f.path, f.sha256]));
  return a.every((f) => byPath.get(f.path) === f.sha256);
}

/**
 * Validate the ledger chain (fail closed on tamper), find the latest `composition.injected` event,
 * and prove its recorded file set equals a pure re-derivation from the same catalog inputs. A forged
 * head event (different recorded files) yields `reproduced: false` even though the chain is intact.
 */
export function recomputeInjectionFromLedger(
  runDir: string,
  opts: { mcpModules: CatalogModule[]; adapter: InjectionAdapter; approveSecrets?: boolean },
): InjectionLedgerCheck {
  const events = readRuntimeEvents(runDir);
  validateRuntimeLedger(events); // throws on any chain break — fail closed
  const last = events.filter((e) => e.type === 'composition.injected').at(-1);
  if (!last) {
    return { ledgerValid: true, found: false, status: null, reproduced: false, recorded: [], expected: [], reason: 'no composition.injected event in ledger' };
  }
  const recorded = ((last.payload.files as InjectedFile[] | undefined) ?? []).map((f) => ({ path: f.path, sha256: f.sha256 }));
  const expected = recomputeInjectionFiles(opts);
  const reproduced = sameFiles(recorded, expected);
  return {
    ledgerValid: true,
    found: true,
    status: (last.payload.mcp_injection as McpInjectionStatus | undefined) ?? null,
    reproduced,
    recorded,
    expected,
    reason: reproduced
      ? 'recorded injection reproduced from the same catalog inputs'
      : 'recorded injection does NOT match re-derivation — forged/stale head event',
  };
}
