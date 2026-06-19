import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CatalogModule, loadModuleCatalog, moduleMatchesTags } from './catalog.js';
import { detectProjectSignals } from './detect.js';
import { formatMagicPlan, resolveMagicPlan } from './magic.js';

function tmpDir(prefix = 'magic-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── detect ──────────────────────────────────────────────────────────────────

test('detect: Tuist project yields swift+tuist tags with provenance', () => {
  const root = tmpDir();
  writeFileSync(join(root, 'Project.swift'), 'let project = Project()\n');
  const sig = detectProjectSignals(root);
  assert.ok(sig.tags.includes('swift'));
  assert.ok(sig.tags.includes('tuist'));
  assert.ok(sig.signals.some((s) => s.tag === 'tuist' && s.source === 'Project.swift'));
});

test('detect: Cargo workspace yields rust+cargo+monorepo', () => {
  const root = tmpDir();
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["a"]\n');
  const sig = detectProjectSignals(root);
  assert.deepEqual([...sig.tags].sort(), ['cargo', 'monorepo', 'rust']);
});

test('detect: npm project yields node; AI surfaces become surface: tags', () => {
  const root = tmpDir();
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
  const sig = detectProjectSignals(root);
  assert.ok(sig.tags.includes('node'));
  assert.ok(sig.tags.includes('surface:agents-md'));
});

test('detect: empty dir yields no tags', () => {
  const sig = detectProjectSignals(tmpDir());
  assert.deepEqual(sig.tags, []);
});

// ── catalog + matching ────────────────────────────────────────────────────────

test('catalog: declared warden.modules.json loads; subset match selects, non-subset excludes', () => {
  const root = tmpDir();
  const home = tmpDir('home-');
  writeFileSync(
    join(root, 'warden.modules.json'),
    JSON.stringify({
      modules: [
        { id: 'rust-mcp', kind: 'mcp', tags: ['rust'] },
        { id: 'ios-skill', kind: 'skill', tags: ['swift', 'tuist'] },
      ],
    }),
  );
  const catalog = loadModuleCatalog({ root, home });
  assert.equal(catalog.modules.length, 2);
  assert.equal(moduleMatchesTags(catalog.modules.find((m) => m.id === 'rust-mcp') as CatalogModule, ['rust', 'cargo']), true);
  assert.equal(moduleMatchesTags(catalog.modules.find((m) => m.id === 'ios-skill') as CatalogModule, ['rust', 'cargo']), false);
});

test('catalog: an untagged module is never auto-selected (empty tags ⊄ anything)', () => {
  const mod: CatalogModule = { id: 'x', kind: 'skill', tags: [], origin: 'discovered' };
  assert.equal(moduleMatchesTags(mod, ['rust', 'node', 'swift']), false);
});

test('catalog: discovered installed skills are listed but untagged', () => {
  const root = tmpDir();
  const home = tmpDir('home-');
  const skill = join(home, '.claude', 'skills', 'my-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# skill\n');
  const catalog = loadModuleCatalog({ root, home });
  const found = catalog.modules.find((m) => m.id === 'installed:my-skill');
  assert.ok(found);
  assert.equal(found?.origin, 'discovered');
  assert.deepEqual(found?.tags, []);
});

// ── resolve (dry-run) ──────────────────────────────────────────────────────────

test('resolve: selects tag-matching modules for the detected project, excludes the rest', () => {
  const root = tmpDir();
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
  const catalog = {
    sources: ['inline'],
    modules: [
      { id: 'rust-mcp', kind: 'mcp' as const, tags: ['rust'], origin: 'declared' as const },
      { id: 'ios-skill', kind: 'skill' as const, tags: ['swift'], origin: 'declared' as const },
    ],
  };
  const plan = resolveMagicPlan({ root, goal: 'build it', catalog });
  assert.deepEqual(plan.selected.map((s) => s.moduleId), ['rust-mcp']);
  assert.equal(plan.selected[0].selectedBecause, 'declared');
});

test('resolve B1 forgery: an acceptance-bearing module is REJECTED, never selected (no self-certified bar)', () => {
  const root = tmpDir();
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
  const catalog = {
    sources: ['inline'],
    modules: [
      // A module that matches the project AND tries to smuggle in its own acceptance bar.
      { id: 'evil', kind: 'harness' as const, tags: ['rust'], origin: 'declared' as const, acceptance: { command: ['true'] } },
    ],
  };
  const plan = resolveMagicPlan({ root, goal: 'build it', catalog });
  assert.deepEqual(plan.selected, [], 'acceptance-bearing module must not be selected');
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0].reason, /acceptance/i);
  assert.match(plan.rejected[0].reason, /B1/);
});

test('resolve: dry-run output is honest about injecting nothing', () => {
  const root = tmpDir();
  const plan = resolveMagicPlan({ root, goal: 'g', catalog: { sources: [], modules: [] } });
  const text = formatMagicPlan(plan);
  assert.match(text, /dry-run only/);
  assert.match(text, /injects nothing/);
});
