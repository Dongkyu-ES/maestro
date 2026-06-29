# 조건부 프로비저닝 — "필요한 것만 적재"

maestro의 차별점은 *모든 역할에 모든 걸 싣지 않는* 것이다. 역할마다 필요한 컨텍스트(워크트리·MCP·지시)만 적재한다. 핵심은 **언제 워크트리를 쪼개고 언제 인세션으로 가는가**의 판단이다.

## 결정 규칙 (이거 하나면 됨)

**그 단계가 파일을 바꾸나?**
- **예 + 병렬** → 격리 워크트리 필수 (서로 충돌 방지). `magic run` 또는 `orchestrate run`.
- **예 + 단독** → 워크트리 1개. `magic run`. (또는 위험이 낮고 빠르면 현재 트리에서 직접도 가능하지만, 격리가 기본 안전.)
- **아니오 (read-only)** → **워크트리 만들지 마라.** 인세션 Task 서브에이전트 또는 `codex exec --sandbox read-only`. 패널·스카우트·리뷰·검증이 전부 여기.

워크트리는 공짜가 아니다 (디스크 + 셋업 ~수백 ms + 정리). read-only 단계까지 워크트리를 쓰면 가벼운 작업이 무거워진다 — 그게 우리가 피하려는 바로 그 함정이다.

## 실행기별 격리 (claude는 네이티브에 위임)

워크트리 격리를 **모두 maestro 엔진으로 할 필요는 없다.** Claude Code가 git worktree를 네이티브 내장한다 — `claude --worktree`(-w), 서브에이전트 frontmatter `isolation: worktree`(무변경 시 자동정리). 그러니:

- **claude executor / 인세션 서브에이전트** → Claude Code 네이티브 격리(`isolation: worktree`)를 우선 쓴다. maestro가 워크트리를 직접 팔 필요 없음.
- **codex / agy** → 네이티브 격리가 없으므로 maestro 엔진(`magic run` / `orchestrate run`)으로 격리한다.
- **폴백**: 네이티브 경로가 불확실하거나 균일한 정리·MCP 주입·executor 처리가 필요하면 maestro TS 엔진을 그대로 쓴다 (엔진은 삭제 대상이 아니라 codex/agy + 폴백용으로 유지).

## 워크트리 의존성 셋업 (gitignore된 것)

워크트리는 git 추적 파일만 복사한다 → `node_modules`·`.env` 등은 빠져서 빌드가 혼란스럽게 실패할 수 있다. maestro 엔진은 이미 executor 실행 직전 훅(`runIsolatedWorker`의 `beforeExecute`)이 있으니 **새 인프라 없이** 거기서 셋업하면 된다:

- 빌드가 실제로 의존성을 필요로 할 때만(측정된 마찰) `npm ci` 또는 `node_modules` 심볼릭링크를 `beforeExecute`에서 수행. read-only/문서 작업엔 불필요(YAGNI).
- **`.env`·시크릿은 절대 기본 복사하지 않는다.** 시크릿을 워크트리에 흘리는 건 잘못된 본능 — 필요한 비밀은 명시적·최소로만.

## 선택적 MCP 주입은 어떻게 일어나나

`magic run`은 내부적으로:
1. `detectProjectSignals(root)` — 프로젝트 태그 감지 (src/composition/detect.ts).
2. `resolveMagicPlan` — 태그가 ⊆ 인 카탈로그 모듈만 선택 (src/composition/magic.ts). **그 작업에 무관한 MCP는 안 실림.**
3. `applyCompositionToWorktree` — 선택된 모듈의 `.mcp.json`만 워크트리에 주입 (src/composition/inject.ts).
4. executor 스폰 → 끝나면 워크트리 정리.

즉 "필요한 것만"은 maestro가 새로 구현하는 게 아니라 이미 이 엔진이 하는 일이다. maestro는 *언제 이걸 부를지*만 결정한다.

먼저 무엇이 실릴지 보고 싶으면 (주입 없이):
```
maestro magic plan "<goal>"
```

## 명령 치트시트

```
# dry-run: 감지된 태그 + 실릴 모듈 (아무것도 주입 안 함)
maestro magic plan "<goal>"

# 카탈로그 보기 (declared maestro.modules.json + ~/.maestro/catalog + 발견된 스킬)
maestro magic catalog

# 워크트리 분리 + 선택 주입 + executor 스폰 + 정리 (한 방)
maestro magic run "<goal>" --executor codex|claude|agy [--approve-secrets] [--prove]

# 여러 노드를 한 그래프로 (팬아웃/파이프라인)
maestro orchestrate run --file graph.json [--concurrency N]

# 팬아웃 후 잔여 워크트리 정리
maestro worktrees cleanup
```

## graph.json 형식 (orchestrate run)

노드는 `{ id, goal, deps?, executor? }`. `deps`로 순서를, 없으면 병렬. `executor` 미지정이면 결정적 purpose→executor 라우터가 배정.

```json
{
  "nodes": [
    { "id": "scout",  "goal": "탐색: 관련 모듈/제약 파악" },
    { "id": "build",  "goal": "구현: ...", "deps": ["scout"], "executor": "codex" },
    { "id": "verify", "goal": "검증: build가 계획 충족하는지", "deps": ["build"], "executor": "claude" }
  ]
}
```

병렬 팬아웃이면 노드들 사이에 `deps`를 두지 않는다 (전부 독립 → 동시 실행).

## 증거/게이트 (옵트인)

기본은 증거 없음. 사용자가 명시할 때만:
- `--prove` → 카나리 MCP를 같이 주입하고, 그 사이드이펙트(센티넬 파일)로 *주입된 MCP가 실제 로드됐는지* 증명.
- `--gate <cmd>` → 지정한 검증 명령을 깨끗한 체크아웃에서 재실행하는 완료 게이트.

이건 "이 작업은 audit이 필요해", "검증된 완료를 원해" 같은 요구일 때만. 평상시엔 켜지 마라 — maestro를 다시 무겁게 만드는 길이다.

## 내부 경로 메모

상태는 `.agent/` (워크트리는 `.agent/worktrees/`, 매직런은 `.agent/magic-runs/`), 전역 설정/카탈로그는 `~/.maestro/catalog/`, repo 카탈로그는 `maestro.modules.json` — 코드(src/composition/catalog.ts)와 일치한다. 다만 일부 **내부 wire/sentinel 이름**(주입 마커 `warden-injected`, 백업 접미사 `.warden-bak`, 카나리 파일 `.warden-canary`, MCP 카나리 툴 `warden_canary_ping`)은 기존 상태/포맷 호환을 위해 옛 접두사를 그대로 둔다 — 사용자에게 보이는 표면만 maestro다.
