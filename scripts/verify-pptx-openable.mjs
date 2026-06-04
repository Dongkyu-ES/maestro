#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';

const pptx = resolve(process.argv[2] || '');
if (!pptx || !pptx.endsWith('.pptx')) fail('expected a .pptx path');
if (!existsSync(pptx)) fail(`missing pptx: ${pptx}`);
const keynoteApp = '/Applications/Keynote.app';

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
function fail(message) {
  console.error(`PPTX_OPENABLE_FAIL ${message}`);
  process.exit(1);
}
function unzipText(entry) {
  const pattern = entry.replaceAll('[', '[[]');
  return run('unzip', ['-p', pptx, pattern]);
}
function decodeXml(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

let entries;
try {
  run('unzip', ['-t', pptx]);
  entries = run('unzip', ['-Z1', pptx])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
} catch (err) {
  fail(`zip integrity failed: ${String(err.stderr || err.message || err)}`);
}

const required = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/core.xml',
  'docProps/app.xml',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
  'ppt/slideMasters/slideMaster1.xml',
  'ppt/slideLayouts/slideLayout1.xml',
  'ppt/theme/theme1.xml',
];
const missing = required.filter((entry) => !entries.includes(entry));
if (missing.length) fail(`missing required OOXML parts: ${missing.join(', ')}`);

const slideEntries = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry)).sort();
if (slideEntries.length === 0) fail('no slides found');

const allXml = entries
  .filter((entry) => entry.endsWith('.xml'))
  .map((entry) => unzipText(entry))
  .join('\n');
const forbiddenFonts = ['Aptos', 'Aptos Display', 'Apple SD Gothic Neo'];
const forbidden = forbiddenFonts.filter((font) => new RegExp(`typeface="${font.replaceAll(' ', '\\s*')}"`, 'i').test(allXml));
if (forbidden.length) fail(`presentation references fragile/missing-prone fonts: ${forbidden.join(', ')}`);

let textRunCount = 0;
let visibleText = '';
let missingRunFonts = 0;
for (const entry of slideEntries) {
  const xml = unzipText(entry);
  const textRuns = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]).trim());
  visibleText += `${textRuns.filter(Boolean).join('\n')}\n`;
  textRunCount += textRuns.filter(Boolean).length;
  for (const runMatch of xml.matchAll(/<a:rPr\b([\s\S]*?)<\/a:rPr>/g)) {
    const rPr = runMatch[0];
    if (!/<a:latin\b[^>]*typeface="Arial"/.test(rPr) || !/<a:ea\b[^>]*typeface="Arial Unicode MS"/.test(rPr))
      missingRunFonts += 1;
  }
}
if (textRunCount < slideEntries.length) fail(`too little visible slide text: text_runs=${textRunCount} slides=${slideEntries.length}`);
if (!/GitHub|프로젝트|결론/.test(visibleText)) fail('expected report text is missing from slide XML');
if (missingRunFonts > 0)
  fail(`text runs lack explicit safe fonts: ${missingRunFonts} runs must include latin=Arial and ea=Arial Unicode MS`);

function keynoteInstalled() {
  return existsSync(join(keynoteApp, 'Contents', 'MacOS', 'Keynote'));
}
const keynoteAvailable = keynoteInstalled();

const qlOut = mkdtempSync(join(tmpdir(), 'pptx-openable-ql-'));
try {
  run('qlmanage', ['-t', '-s', '512', '-o', qlOut, pptx], { timeout: 15000 });
  const png = join(qlOut, `${basename(pptx)}.png`);
  if (!existsSync(png)) fail('QuickLook did not produce a thumbnail');
} catch (err) {
  fail(`QuickLook thumbnail failed: ${String(err.stderr || err.message || err)}`);
} finally {
  rmSync(qlOut, { recursive: true, force: true });
}

if (keynoteAvailable) {
  const openDir = mkdtempSync(join(tmpdir(), 'pptx-keynote-open-'));
  const scriptPath = join(openDir, 'check.applescript');
  const marker = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const parsedName = parse(basename(pptx));
  const keynotePptx = join(openDir, `${marker}-${parsedName.name}${parsedName.ext}`);
  copyFileSync(pptx, keynotePptx);
  writeFileSync(
    scriptPath,
    `on run argv
  set marker to item 1 of argv
  tell application "Keynote"
    activate
    repeat with i from 1 to 30
      repeat with d in documents
        try
          set docName to name of d
          if docName contains marker then
          set slideCount to count of slides of d
          close d saving no
          return "KEYNOTE_REOPEN_PASS slides=" & slideCount
          end if
        end try
      end repeat
      delay 1
    end repeat
    return "KEYNOTE_REOPEN_FAIL documents=" & (count of documents)
  end tell
end run
`,
  );
  let keynoteOutput = '';
  try {
    run('open', ['-a', 'Keynote', keynotePptx], { timeout: 15000 });
    keynoteOutput = run('osascript', [scriptPath, marker], { timeout: 40000 });
  } catch (err) {
    fail(`Keynote reopen failed: ${String(err.stderr || err.message || err)}`);
  } finally {
    rmSync(openDir, { recursive: true, force: true });
  }
  const match = keynoteOutput.match(/KEYNOTE_REOPEN_PASS slides=(\d+)/);
  const keynoteSlides = match ? Number(match[1]) : 0;
  if (!keynoteSlides || keynoteSlides < slideEntries.length)
    fail(`Keynote reopened too few slides: keynote=${keynoteSlides} xml=${slideEntries.length}`);
}

console.log(`PPTX_OPENABLE_PASS path=${pptx} slides=${slideEntries.length} text_runs=${textRunCount} keynote_reopen=${keynoteAvailable ? 'checked' : 'not_available'}`);
