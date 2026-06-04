#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
};
const expandHome = (p) => (p?.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const githubDir = resolve(expandHome(arg('--github-dir', '~/Documents/github')));
const reportsRoot = resolve(arg('--reports-root', join(process.cwd(), 'reports')));
const outDir = resolve(arg('--out-dir', join(reportsRoot, 'github-projects', stamp())));
const maxProjects = Number(arg('--max-projects', '40'));

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}
function runGit(cwd, gitArgs) {
  try {
    return execFileSync('git', ['-C', cwd, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}
function safeDateMs(value, fallback = 0) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : fallback;
}
function listProjects(root) {
  if (!existsSync(root)) throw new Error(`github folder not found: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, '.git')))
    .map((entry) => {
      const path = join(root, entry.name);
      const status = runGit(path, ['status', '--short']);
      const statusLines = status ? status.split('\n').filter(Boolean) : [];
      const lastCommitIso = runGit(path, ['log', '-1', '--format=%cI']);
      const branch = runGit(path, ['branch', '--show-current']) || '(detached/unknown)';
      const mtimeMs = statSync(path).mtimeMs;
      const lastCommitMs = safeDateMs(lastCommitIso, 0);
      const recencyMs = Math.max(lastCommitMs, mtimeMs);
      const dirtyScore = Math.min(statusLines.length, 20) * 60 * 60 * 1000;
      const activeScore = recencyMs + dirtyScore;
      return {
        name: entry.name,
        path,
        branch,
        last_commit_at: lastCommitIso || null,
        folder_mtime_at: new Date(mtimeMs).toISOString(),
        dirty_files: statusLines.length,
        status_preview: statusLines.slice(0, 8),
        active_score: activeScore,
      };
    })
    .sort((a, b) => b.active_score - a.active_score)
    .slice(0, maxProjects);
}
function lineDate(project) {
  return project.last_commit_at || project.folder_mtime_at;
}
function daysSince(value) {
  const ms = safeDateMs(value);
  if (!ms) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000)));
}
function statusClass(project) {
  if (project.dirty_files >= 20) return 'dirty-critical';
  if (project.dirty_files >= 8) return 'dirty-high';
  if (project.dirty_files > 0) return 'dirty-low';
  const age = daysSince(lineDate(project));
  if (age !== null && age >= 30) return 'stale-clean';
  return 'recent-clean';
}
function riskLabel(project) {
  const klass = statusClass(project);
  if (klass === 'dirty-critical') return '주의: 변경량 큼';
  if (klass === 'dirty-high') return '점검: 변경 다수';
  if (klass === 'dirty-low') return '미정리 변경 있음';
  if (klass === 'stale-clean') return '오래된 clean repo';
  return '최근 clean repo';
}
function shortDate(value) {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}
function truncateText(value, max = 92) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function projectReason(project, rank) {
  const age = daysSince(lineDate(project));
  const when = age === null ? '시점 불명' : age === 0 ? '오늘 변경' : `${age}일 전 기준`;
  return `${rank}. ${project.name} | ${riskLabel(project)} | ${when} | dirty ${project.dirty_files} | ${project.branch}`;
}
function buildNarrative(projects) {
  const active = projects[0] || null;
  const recent = [...projects].sort((a, b) => safeDateMs(lineDate(b)) - safeDateMs(lineDate(a))).slice(0, 8);
  const dirtyWatch = projects
    .filter((p) => p.dirty_files > 0)
    .sort((a, b) => b.dirty_files - a.dirty_files || b.active_score - a.active_score)
    .slice(0, 8);
  const staleWatch = projects
    .filter((p) => p.dirty_files === 0 && (daysSince(lineDate(p)) ?? 0) >= 14)
    .sort((a, b) => (daysSince(lineDate(b)) ?? 0) - (daysSince(lineDate(a)) ?? 0))
    .slice(0, 8);
  const conclusion = active
    ? `${active.name}가 현재 작업 중심입니다. 최근성보다 미정리 변경량과 보고서/런타임 산출물 움직임이 활동 신호를 끌어올렸습니다.`
    : '스캔 가능한 git 프로젝트가 없습니다.';
  const proofPoints = active
    ? [
        `활성 점수 1위: dirty ${active.dirty_files}개, 브랜치 ${active.branch}, 기준 ${shortDate(lineDate(active))}`,
        `최근 진행 1위: ${recent[0]?.name || '없음'} (${shortDate(lineDate(recent[0]))})`,
        `watchlist: dirty repo ${dirtyWatch.length}개, stale clean repo ${staleWatch.length}개`,
      ]
    : ['프로젝트 없음', '최근 진행 없음', 'watchlist 없음'];
  const nextActions = active
    ? [
        `1. ${active.name}에서 현재 변경을 생성기/보고서/런타임 산출물로 분리해 diff를 먼저 확인`,
        '2. 이번 보고서 산출물은 PPTX openable PASS와 quality-response까지 묶어 하나의 완료 단위로 고정',
        '3. 다음 작업은 dirty 상위 repo를 정리하거나 stale clean repo를 archive/보류로 분류',
      ]
    : ['1. GitHub 폴더 경로와 권한을 확인'];
  return { active, recent, dirtyWatch, staleWatch, conclusion, proofPoints, nextActions };
}
function markdownReport(projects) {
  const { active, recent, dirtyWatch, staleWatch, conclusion, proofPoints, nextActions } = buildNarrative(projects);
  const lines = [
    '# GitHub 프로젝트 활동 요약',
    '',
    `결론: **${conclusion}**`,
    '',
    '## 근거 3개',
    ...proofPoints.map((point) => `- ${point}`),
    '',
    '## 두괄식 요약',
    `- 스캔 폴더: \`${githubDir}\``,
    `- 발견 프로젝트: ${projects.length}개`,
    `- 최근 진행 프로젝트: ${recent[0]?.name || '없음'}`,
    `- 제일 활성화된 프로젝트: ${active?.name || '없음'}`,
    `- 해석: dirty count는 "작업 중/산출물 미정리" 신호이고, 오래된 clean repo는 보류/아카이브 후보입니다.`,
    '',
    '## 상위 활성 프로젝트 비교',
    '| 순위 | 프로젝트 | 브랜치 | 최근 기준 | 변경 파일 | 판정 |',
    '| ---: | --- | --- | --- | ---: | --- |',
    ...projects
      .slice(0, 20)
      .map((p, i) => `| ${i + 1} | ${p.name} | ${p.branch} | ${lineDate(p)} | ${p.dirty_files} | ${riskLabel(p)} |`),
    '',
    '## 최근 진행 후보',
    ...recent.map((p, i) => `${i + 1}. **${p.name}** — ${lineDate(p)} / dirty ${p.dirty_files}`),
    '',
    '## Watchlist: dirty 프로젝트',
    ...(dirtyWatch.length
      ? dirtyWatch.map((p, i) => `${i + 1}. **${p.name}** — dirty ${p.dirty_files}; 우선 diff/산출물 분리가 필요`)
      : ['- dirty 프로젝트 없음']),
    '',
    '## Watchlist: 오래된 clean 프로젝트',
    ...(staleWatch.length
      ? staleWatch.map((p, i) => `${i + 1}. **${p.name}** — ${daysSince(lineDate(p))}일 전 기준; 보류/아카이브 판단 후보`)
      : ['- 오래된 clean 프로젝트 없음']),
    '',
    '## 활성 프로젝트 상세',
    active
      ? [
          `- 이름: ${active.name}`,
          `- 경로: \`${active.path}\``,
          `- 브랜치: ${active.branch}`,
          `- 최근 커밋: ${active.last_commit_at || '커밋 정보 없음'}`,
          `- 폴더 수정시각: ${active.folder_mtime_at}`,
          `- 변경 파일 수: ${active.dirty_files}`,
          '- 상태 미리보기:',
          ...(active.status_preview.length ? active.status_preview.map((s) => `  - \`${s}\``) : ['  - 깨끗함']),
        ].join('\n')
      : '활성 프로젝트 없음',
    '',
    '## 다음 실행 액션',
    ...nextActions.map((action) => `- ${action}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
function pptSlides(projects) {
  const { active, recent, dirtyWatch, staleWatch, conclusion, proofPoints, nextActions } = buildNarrative(projects);
  const top = projects.slice(0, 6);
  return [
    {
      title: `결론: 현재 작업 중심은 ${active?.name || '없음'}`,
      eyebrow: 'GitHub folder scan',
      claim: conclusion,
      metrics: [
        { value: String(projects.length), label: 'git projects' },
        { value: String(active?.dirty_files ?? 0), label: `${active?.name || 'active'} dirty files` },
        { value: String(dirtyWatch.length), label: 'dirty watchlist' },
      ],
      proofs: proofPoints,
      footer: `${githubDir} | projects=${projects.length}`,
    },
    {
      title: '상위 활성 프로젝트 비교',
      eyebrow: 'scorecard',
      claim: '최근성만 보지 않고 dirty count와 폴더 활동을 함께 보아 작업 중인 repo를 분리했습니다.',
      metrics: top.slice(0, 3).map((p, i) => ({ value: `#${i + 1}`, label: `${p.name} · dirty ${p.dirty_files}` })),
      rows: top.map((p, i) => projectReason(p, i + 1)),
      footer: 'dirty count는 미정리 작업/산출물 누적 신호로 해석',
    },
    {
      title: 'Watchlist: 리스크를 둘로 나눠 봐야 함',
      eyebrow: 'triage',
      claim: 'dirty가 큰 프로젝트는 즉시 diff 확인 대상이고, 오래된 clean 프로젝트는 보류/아카이브 후보입니다.',
      columns: [
        {
          heading: 'Dirty 우선 점검',
          items: dirtyWatch.slice(0, 5).map((p) => `${p.name} · dirty ${p.dirty_files}`),
        },
        {
          heading: '오래된 clean 후보',
          items: staleWatch.slice(0, 5).map((p) => `${p.name} · ${daysSince(lineDate(p))}일 전`),
        },
      ],
    },
    {
      title: 'Active repo deep dive',
      eyebrow: active?.name || 'none',
      claim: active
        ? `${active.name}는 보고서 생성기와 산출물 변화가 같이 보이는 실행 중 프로젝트입니다.`
        : '활성 프로젝트가 없습니다.',
      metrics: active
        ? [
            { value: String(active.dirty_files), label: 'dirty files' },
            { value: shortDate(lineDate(active)), label: 'recency basis' },
            { value: active.branch, label: 'branch' },
          ]
        : [{ value: '0', label: 'active evidence' }],
      proofs: active
        ? [
            `branch=${active.branch}`,
            `basis=${shortDate(lineDate(active))}`,
            `dirty=${active.dirty_files}`,
          ]
        : ['no active repository'],
      rows: active?.status_preview?.length
        ? active.status_preview.slice(0, 5).map((line) => `status: ${truncateText(line)}`)
        : ['status: clean'],
    },
    {
      title: '다음 실행 액션',
      eyebrow: 'operator handoff',
      claim: '다음 단계는 더 조사하기보다 현재 active repo의 변경을 완료 단위로 닫는 것입니다.',
      actions: nextActions,
      rows: recent.slice(0, 4).map((p, i) => `최근 후보 ${i + 1}: ${p.name} · ${shortDate(lineDate(p))} · dirty ${p.dirty_files}`),
    },
  ];
}
function appleString(value) {
  return `"${String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/\r?\n/g, '" & linefeed & "')}"`;
}
function slideText(slide) {
  const lines = [];
  if (slide.eyebrow) lines.push(String(slide.eyebrow).toUpperCase());
  if (slide.claim) lines.push(slide.claim);
  if (slide.proofs?.length) lines.push(...slide.proofs.map((item) => `• ${item}`));
  if (slide.rows?.length) lines.push(...slide.rows.map((item) => `• ${item}`));
  if (slide.columns?.length) {
    for (const col of slide.columns) {
      lines.push(col.heading);
      lines.push(...(col.items?.length ? col.items.map((item) => `• ${item}`) : ['• 해당 없음']));
    }
  }
  if (slide.actions?.length) lines.push(...slide.actions.map((item) => `• ${item}`));
  if (slide.bullets?.length) lines.push(...slide.bullets.map((item) => `• ${item}`));
  if (slide.footer) lines.push(slide.footer);
  return lines.join('\n');
}
function slideBlocks(slide, idx) {
  const palette = [
    { accent: [7600, 22000, 65535], muted: [43000, 46000, 50000] },
    { accent: [0, 39000, 23000], muted: [42000, 47000, 43000] },
    { accent: [45500, 18000, 2500], muted: [50000, 45000, 40000] },
    { accent: [47000, 9000, 7000], muted: [50000, 42000, 42000] },
    { accent: [10000, 10000, 10000], muted: [45500, 45500, 45500] },
  ][idx] || { accent: [12000, 12000, 12000], muted: [45500, 45500, 45500] };
  const blocks = [
    { text: String(idx + 1).padStart(2, '0'), x: 1560, y: 42, w: 280, h: 110, size: 72, bold: true, color: palette.muted },
    { text: slide.eyebrow || `slide ${idx + 1}`, x: 90, y: 48, w: 780, h: 44, size: 18, bold: true, color: palette.accent },
    { text: slide.title || '', x: 90, y: 96, w: 1420, h: 120, size: 44, bold: true },
    { text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', x: 90, y: 200, w: 920, h: 34, size: 16, bold: false, color: palette.accent },
  ];
  if (slide.claim) blocks.push({ text: slide.claim, x: 90, y: 240, w: 1500, h: 105, size: idx === 0 ? 34 : 27, bold: idx === 0 });
  if (slide.metrics?.length) {
    slide.metrics.slice(0, 3).forEach((metric, metricIdx) => {
      blocks.push({
        text: `${metric.value}\n${metric.label}`,
        x: 110 + metricIdx * 560,
        y: idx === 0 ? 372 : 338,
        w: 500,
        h: 128,
        size: metricIdx === 0 ? 36 : 30,
        bold: true,
        color: metricIdx === 0 ? palette.accent : undefined,
      });
    });
  }
  if (slide.proofs?.length) {
    slide.proofs.slice(0, 3).forEach((proof, proofIdx) => {
      blocks.push({
        text: `${proofIdx + 1}. ${proof}`,
        x: 120 + proofIdx * 555,
        y: slide.metrics?.length ? (idx === 0 ? 560 : 520) : idx === 0 ? 390 : 355,
        w: 500,
        h: 150,
        size: 23,
        bold: proofIdx === 0,
        color: proofIdx === 0 ? palette.accent : undefined,
      });
    });
  }
  if (slide.rows?.length && !slide.actions?.length) {
    const rowStartY = slide.proofs?.length
      ? slide.metrics?.length
        ? 720
        : 560
      : slide.metrics?.length
        ? 520
        : 355;
    slide.rows.slice(0, 8).forEach((row, rowIdx) => {
      blocks.push({
        text: row,
        x: 115,
        y: rowStartY + rowIdx * 58,
        w: 1600,
        h: 52,
        size: rowIdx < 3 ? 21 : 18,
        bold: rowIdx < 2,
        color: rowIdx === 0 ? palette.accent : undefined,
      });
    });
  }
  if (slide.columns?.length) {
    slide.columns.slice(0, 2).forEach((col, colIdx) => {
      const x = colIdx === 0 ? 115 : 1000;
      blocks.push({ text: col.heading, x, y: 365, w: 760, h: 60, size: 28, bold: true, color: palette.accent });
      (col.items?.length ? col.items : ['해당 없음']).slice(0, 5).forEach((item, itemIdx) => {
        blocks.push({ text: `• ${item}`, x, y: 445 + itemIdx * 62, w: 770, h: 55, size: 23, bold: itemIdx === 0 });
      });
    });
  }
  if (slide.actions?.length) {
    slide.actions.slice(0, 4).forEach((action, actionIdx) => {
      blocks.push({
        text: action,
        x: 120,
        y: 360 + actionIdx * 112,
        w: 1510,
        h: 92,
        size: actionIdx === 0 ? 27 : 24,
        bold: actionIdx === 0,
        color: actionIdx === 0 ? palette.accent : undefined,
      });
    });
  }
  if (slide.footer) blocks.push({ text: slide.footer, x: 90, y: 1015, w: 1600, h: 36, size: 15, bold: false });
  if (blocks.length <= 2) blocks.push({ text: slideText(slide), x: 120, y: 260, w: 1600, h: 720, size: 25, bold: false });
  return blocks.filter((block) => String(block.text || '').trim());
}
function svgAsset(workDir, name, width, height, body) {
  const path = join(workDir, `${name}.svg`);
  writeFileSync(
    path,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );
  return path;
}
function slideVisualAssets(workDir, idx) {
  const palettes = [
    { accent: '#1F5EFF', soft: '#EAF0FF', warm: '#FFF7E8', line: '#C7D2FE' },
    { accent: '#027A48', soft: '#EAF8F1', warm: '#F3F5F7', line: '#A7F3D0' },
    { accent: '#B54708', soft: '#FFF4E5', warm: '#FEEEEE', line: '#FDBA74' },
    { accent: '#B42318', soft: '#FFF1F0', warm: '#F5F7FA', line: '#FDA29B' },
    { accent: '#111827', soft: '#F3F4F6', warm: '#EAF0FF', line: '#9CA3AF' },
  ];
  const p = palettes[idx] || palettes[0];
  const common = [
    { path: svgAsset(workDir, `slide-${idx + 1}-top-rule`, 1720, 10, `<rect width="1720" height="10" fill="${p.accent}"/>`), x: 90, y: 222, w: 940, h: 8 },
    { path: svgAsset(workDir, `slide-${idx + 1}-side-rule`, 18, 780, `<rect width="18" height="780" rx="9" fill="${p.accent}"/>`), x: 42, y: 88, w: 18, h: 780 },
  ];
  if (idx === 0) {
    return [
      { path: svgAsset(workDir, 'slide-1-hero-band', 900, 1080, `<rect width="900" height="1080" fill="${p.soft}"/><circle cx="740" cy="160" r="220" fill="${p.line}" opacity="0.55"/><rect x="90" y="640" width="690" height="210" rx="34" fill="${p.warm}"/>`), x: 1020, y: 0, w: 900, h: 1080 },
      ...common,
      { path: svgAsset(workDir, 'slide-1-metric-cards', 1700, 180, `<rect x="0" y="0" width="500" height="180" rx="24" fill="#FFFFFF" stroke="${p.line}" stroke-width="4"/><rect x="560" y="0" width="500" height="180" rx="24" fill="#FFFFFF" stroke="${p.line}" stroke-width="4"/><rect x="1120" y="0" width="500" height="180" rx="24" fill="#FFFFFF" stroke="${p.line}" stroke-width="4"/>`), x: 90, y: 350, w: 1700, h: 180 },
    ];
  }
  if (idx === 2) {
    return [
      ...common,
      { path: svgAsset(workDir, 'slide-3-dirty-panel', 780, 520, `<rect width="780" height="520" rx="28" fill="${p.warm}" stroke="#F97316" stroke-width="4"/><rect width="780" height="72" rx="28" fill="#FFE1C2"/>`), x: 95, y: 350, w: 800, h: 535 },
      { path: svgAsset(workDir, 'slide-3-stale-panel', 780, 520, `<rect width="780" height="520" rx="28" fill="#EEF8F3" stroke="#10B981" stroke-width="4"/><rect width="780" height="72" rx="28" fill="#CFFAEA"/>`), x: 980, y: 350, w: 800, h: 535 },
    ];
  }
  if (idx === 3) {
    return [
      ...common,
      { path: svgAsset(workDir, 'slide-4-status-strip', 1600, 420, `<rect width="1600" height="420" rx="26" fill="${p.soft}" stroke="${p.line}" stroke-width="4"/><rect x="0" y="0" width="1600" height="88" rx="26" fill="${p.warm}"/>`), x: 90, y: 500, w: 1620, h: 430 },
    ];
  }
  return [
    ...common,
    { path: svgAsset(workDir, `slide-${idx + 1}-proof-panel`, 1640, 620, `<rect width="1640" height="620" rx="30" fill="${p.soft}" stroke="${p.line}" stroke-width="4"/><path d="M0 120 H1640" stroke="${p.line}" stroke-width="4"/><circle cx="1480" cy="120" r="150" fill="${p.warm}"/>`), x: 85, y: 330, w: 1650, h: 630 },
  ];
}
function writePptxWithKeynote(outPath, slides) {
  if (!existsSync('/Applications/Keynote.app/Contents/MacOS/Keynote')) return false;

  const workDir = mkdtempSync(join(tmpdir(), 'github-projects-keynote-'));
  const scriptPath = join(workDir, 'export.applescript');
  const keyPath = join(workDir, 'github-projects-report.key');
  const slideScripts = slides
    .map((slide, idx) => {
      const slideRef =
        idx === 0
          ? 'set s to slide 1'
          : 'set s to make new slide with properties {base slide:master slide "빈 페이지"}';
      const visualScripts = slideVisualAssets(workDir, idx)
        .map(
          (asset, assetIdx) => `
        set img${idx}_${assetIdx} to make new image with properties {file:POSIX file ${appleString(asset.path)}, position:{${Math.round(asset.x)}, ${Math.round(asset.y)}}, width:${Math.round(asset.w)}, height:${Math.round(asset.h)}}`,
        )
        .join('\n');
      const blockScripts = slideBlocks(slide, idx)
        .map((block, blockIdx) => {
          const fontSize = Number(block.size || 24);
          return `
        set box${idx}_${blockIdx} to make new text item with properties {object text:${appleString(block.text)}, position:{${Math.round(block.x)}, ${Math.round(block.y)}}, width:${Math.round(block.w)}, height:${Math.round(block.h)}}
        tell object text of box${idx}_${blockIdx}
          set font to "Arial Unicode MS"
          set size to ${fontSize}
        end tell`;
        })
        .join('\n');
      return `
      ${slideRef}
      try
        set base slide of s to master slide "빈 페이지" of doc
      end try
      tell s
        try
          delete every text item
        end try
        try
          delete every image
        end try
${visualScripts}
${blockScripts}
      end tell`;
    })
    .join('\n');
  writeFileSync(
    scriptPath,
    `on run argv
  set keyPath to item 1 of argv
  set pptxPath to item 2 of argv
  tell application "Keynote"
    activate
    set doc to make new document with properties {document theme:theme "흰색", width:1920, height:1080}
    tell doc
${slideScripts}
      save in POSIX file keyPath
      export to POSIX file pptxPath as Microsoft PowerPoint
      close saving no
    end tell
  end tell
  return "KEYNOTE_EXPORT_PASS"
end run
`,
  );

  const result = spawnSync('osascript', [scriptPath, keyPath, outPath], {
    encoding: 'utf8',
    timeout: 60000,
  });
  rmSync(workDir, { recursive: true, force: true });
  if (result.status !== 0 || !existsSync(outPath))
    throw new Error(`Keynote PPTX export failed: ${result.stderr || result.stdout || 'missing output'}`);
  return true;
}

function writePptx(outPath, slides) {
  const keynoteAvailable = existsSync('/Applications/Keynote.app/Contents/MacOS/Keynote');
  try {
    if (writePptxWithKeynote(outPath, slides)) return;
  } catch (err) {
    if (keynoteAvailable) throw err;
    console.warn(`KEYNOTE_EXPORT_WARN ${String(err.message || err).replace(/\s+/g, ' ').trim()}`);
  }

  const payload = JSON.stringify({ outPath, slides });
  const py = String.raw`
import datetime, html, json, sys, zipfile
data=json.load(sys.stdin)
out=data["outPath"]
slides=data["slides"]
def esc(x): return html.escape(str(x))
def slide_xml(slide):
    title=esc(slide.get("title",""))
    bullets=slide.get("bullets",[])
    bullet_runs="".join([
      f'<a:p><a:pPr marL="457200" indent="-228600"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="2000"><a:latin typeface="Arial"/><a:ea typeface="Arial Unicode MS"/></a:rPr><a:t>{esc(b)}</a:t></a:r></a:p>'
      for b in bullets
    ])
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:spTree>
  <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
  <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274320"/><a:ext cx="8229600" cy="914400"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="3200" b="1"><a:latin typeface="Arial"/><a:ea typeface="Arial Unicode MS"/></a:rPr><a:t>{title}</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1371600"/><a:ext cx="7772400" cy="4114800"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{bullet_runs}</p:txBody></p:sp>
 </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>'''
def slide_rels():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>'''
content_types='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
 <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
 <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
 <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
 <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
 <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
 <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
 <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
 <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
''' + ''.join([f' <Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n' for i in range(1,len(slides)+1)]) + '</Types>'
rels='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>'''
presentation='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
 <p:sldIdLst>
''' + ''.join([f'  <p:sldId id="{255+i}" r:id="rId{i+1}"/>\n' for i in range(1,len(slides)+1)]) + ''' </p:sldIdLst>
 <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
 <p:notesSz cx="6858000" cy="9144000"/>
 <p:defaultTextStyle><a:defPPr><a:defRPr lang="ko-KR"/></a:defPPr></p:defaultTextStyle>
</p:presentation>'''
prels='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
''' + ''.join([f' <Relationship Id="rId{i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>\n' for i in range(1,len(slides)+1)]) + f''' <Relationship Id="rId{len(slides)+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
 <Relationship Id="rId{len(slides)+3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
 <Relationship Id="rId{len(slides)+4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>'''
slide_layout='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
 <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
 <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>'''
slide_layout_rels='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>'''
slide_master='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
 <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
 <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
 <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
 <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>'''
slide_master_rels='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>'''
theme='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Dominic">
 <a:themeElements>
  <a:clrScheme name="Dominic"><a:dk1><a:srgbClr val="171511"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F6F4EF"/></a:lt2><a:accent1><a:srgbClr val="1F5EFF"/></a:accent1><a:accent2><a:srgbClr val="027A48"/></a:accent2><a:accent3><a:srgbClr val="B54708"/></a:accent3><a:accent4><a:srgbClr val="6F6A60"/></a:accent4><a:accent5><a:srgbClr val="111827"/></a:accent5><a:accent6><a:srgbClr val="B42318"/></a:accent6><a:hlink><a:srgbClr val="1F5EFF"/></a:hlink><a:folHlink><a:srgbClr val="6F6A60"/></a:folHlink></a:clrScheme>
  <a:fontScheme name="Dominic"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Arial Unicode MS"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Arial Unicode MS"/></a:minorFont></a:fontScheme>
  <a:fmtScheme name="Dominic"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle/></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
 </a:themeElements>
 <a:objectDefaults/><a:extraClrSchemeLst/>
</a:theme>'''
now=datetime.datetime.utcnow().replace(microsecond=0).isoformat()+"Z"
core=f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <dc:title>GitHub 프로젝트 활동 요약</dc:title><dc:creator>Dominic Orchestration</dc:creator><cp:lastModifiedBy>Dominic Orchestration</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>'''
app=f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
 <Application>Dominic Orchestration</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>{len(slides)}</Slides><Company>Dominic</Company>
</Properties>'''
pres_props='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'''
view_props='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'''
table_styles='''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>'''
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("docProps/core.xml", core)
    z.writestr("docProps/app.xml", app)
    z.writestr("ppt/presentation.xml", presentation)
    z.writestr("ppt/_rels/presentation.xml.rels", prels)
    z.writestr("ppt/slideMasters/slideMaster1.xml", slide_master)
    z.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", slide_master_rels)
    z.writestr("ppt/slideLayouts/slideLayout1.xml", slide_layout)
    z.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slide_layout_rels)
    z.writestr("ppt/theme/theme1.xml", theme)
    z.writestr("ppt/presProps.xml", pres_props)
    z.writestr("ppt/viewProps.xml", view_props)
    z.writestr("ppt/tableStyles.xml", table_styles)
    for idx, slide in enumerate(slides, 1):
        z.writestr(f"ppt/slides/slide{idx}.xml", slide_xml(slide))
        z.writestr(f"ppt/slides/_rels/slide{idx}.xml.rels", slide_rels())
`;
  const result = spawnSync('python3', ['-c', py], { input: payload, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pptx writer failed: ${result.stderr || result.stdout}`);
}
function relToCwd(path) {
  const rel = relative(process.cwd(), path).replaceAll('\\', '/');
  return rel.startsWith('../') ? path : rel;
}
function readManifest(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.reports) ? parsed : { schema_version: 1, reports: [] };
  } catch {
    return { schema_version: 1, reports: [] };
  }
}
function reportFilesExist(report) {
  return Boolean(report?.files?.markdown && report?.files?.pptx && report?.files?.json) &&
    [report.files.markdown, report.files.pptx, report.files.json].every((file) => existsSync(resolve(file)));
}
function writeCentralReportIndex(entry) {
  mkdirSync(reportsRoot, { recursive: true });
  const manifestPath = join(reportsRoot, 'manifest.json');
  const manifest = readManifest(manifestPath);
  const reports = [entry, ...manifest.reports.filter((item) => item.id !== entry.id)].filter(reportFilesExist).slice(0, 100);
  const next = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    reports_root: relToCwd(reportsRoot),
    reports,
  };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(
    join(reportsRoot, 'INDEX.md'),
    [
      '# Reports',
      '',
      '사람이 보는 산출물은 이 루트 폴더에서 중앙 관리한다. `.agent/`는 내부 실행 증거/감사용이다.',
      '',
      '| 생성시각 | 타입 | 요약 | Markdown | PPTX | JSON |',
      '| --- | --- | --- | --- | --- | --- |',
      ...reports.map(
        (report) =>
          `| ${report.generated_at} | ${report.type} | ${report.summary} | [md](${report.files.markdown}) | [pptx](${report.files.pptx}) | [json](${report.files.json}) |`,
      ),
      '',
    ].join('\n'),
  );
}
mkdirSync(outDir, { recursive: true });
const projects = listProjects(githubDir);
const markdown = markdownReport(projects);
const jsonPath = join(outDir, 'github-projects-report.json');
const mdPath = join(outDir, 'github-projects-report.md');
const pptxPath = join(outDir, 'github-projects-report.pptx');
writeFileSync(mdPath, markdown);
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      github_dir: githubDir,
      project_count: projects.length,
      active_project: projects[0] || null,
      projects,
      markdown_sha256: createHash('sha256').update(markdown).digest('hex'),
    },
    null,
    2,
  ),
);
writePptx(pptxPath, pptSlides(projects));
writeCentralReportIndex({
  id: `github-projects-${stamp()}`,
  type: 'github-projects',
  generated_at: new Date().toISOString(),
  summary: `active=${projects[0]?.name || 'none'} count=${projects.length}`,
  files: {
    markdown: relToCwd(mdPath),
    json: relToCwd(jsonPath),
    pptx: relToCwd(pptxPath),
  },
});
console.log(`GITHUB_PROJECTS_REPORT_PASS active=${projects[0]?.name || 'none'} count=${projects.length}`);
console.log(`markdown=${mdPath}`);
console.log(`json=${jsonPath}`);
console.log(`pptx=${pptxPath}`);
