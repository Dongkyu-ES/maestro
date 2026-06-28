# maestro

*다른 언어로 보기: [English](README.md) · **한국어***

**AI 코딩 에이전트를 위한 작업 인식형(task-aware) 오케스트레이션.** maestro에 작업을 주면, 알맞은 오케스트레이션 패턴을 고르고, 역할마다 어울리는 CLI(Codex, Claude Code, Antigravity/agy — 각자의 로그인으로 헤드리스 구동)를 조합하고, **역할마다 필요한 컨텍스트만 적재**(격리 git 워크트리 + 선택적 MCP/지시 주입)한 뒤, 오케스트레이션을 실행해 하나의 결과로 종합합니다. 주로 `/maestro "<할일>"` Claude Code 스킬로 씁니다.

> 로컬, 파일 기반, 단일 운영자(single-operator). 상태는 `.agent/` 아래에 저장됩니다. 호스팅 서비스 없음, SaaS 없음, 자동 push 없음, 런타임 의존성 0.

**작업별로 고르는 4가지 패턴:** build → 독립 리뷰 루프 · 팬아웃 + 선택 · 패널 / 디베이트 · scout → plan → build → verify. 무거운 단계(워크트리 분리, 선택 주입, DAG 팬아웃)는 로컬·프로바이더 중립 엔진에서, 읽기 전용 단계(패널·스카우트·리뷰)는 인세션에서 돌립니다. 워크트리와 주입은 *파일을 병렬로 바꾸는 단계에만* 씁니다 — 가벼운 작업은 가볍게 끝납니다.

## 왜(Why)

maestro는 **새 인프라를 만들지 않고 이미 있는 도구를 조합**합니다: `git worktree`, 네이티브 CLI와 각자의 로그인(구독이 곧 런타임 — per-call API 비용 없음), 그리고 detect → resolve → inject → spawn → cleanup을 담당하는 검증된 엔진. 그 위에 **옵트인** 증거 계층 — 해시 체인 원장(ledger), 재계산 가능한 검증기(verifier), 내용 주소화된 증거 — 이 얹혀, 재계산·감사 가능한 완료 판정이 필요할 때(`--prove` / `--gate`)만 켜집니다. 기본 경로에서는 꺼져 있습니다: 오케스트레이션이 먼저, 증명은 요청할 때만.

## 설치 / 로컬 실행

```bash
npm install
npm run build
npm link            # `maestro`를 PATH에 등록 (상태는 여전히 cwd별 .agent/)
maestro --version
```

링크 없이 실행: `node dist/cli.js --help`.

## 핵심 운영자 플로우 (v0–v2 제품)

```bash
maestro init
maestro project add "$PWD"
maestro task add "경계가 분명한 이슈를 조사하고 수정"
maestro run create <task-id> --mode basic --command "npm test"
maestro run start <run-id>
maestro run collect <run-id>
maestro review latest
maestro web --port 4317      # 운영자 UI: 원장에서 진실을 재계산하고, 모순을 표시
```

- **역할 / 멀티 워커:** `--mode roles` (manager/worker/reviewer) 와 `--mode multi --max-workers N` (실제 격리 워크트리에서 경계가 있는 병렬 워커; 충돌·금지 경로·증거 불일치 시 합성(synthesis)을 차단).
- **승인 게이트 적용:** `maestro apply propose <run-id>` → `maestro approval approve <id>` → `maestro apply approved <id>` (먼저 `git apply --check`; 절대 자동 push 안 함).
- **변경성 셸(Mutating shell)** 은 `shell_mutation` 승인을 생성하고, 승인 전까지 실행하지 않습니다.

## 하네스 런타임 (증거 계층)

```bash
maestro harness run "<목표>" --executor codex|claude|agy|anthropic-direct
maestro skill run <spec.json> --what "<목표>"   # 리서치 → 실행 → 리뷰
maestro skill show <runId>                       # 원장에서 완료를 재계산; 모순 표시
maestro runtime verify-ledger <runId>            # 해시 체인 변조 검사
maestro verifier run --run <runId>               # 재계산 가능한 합격 판정
maestro orchestrate serve | run --file <graph.json>   # DAG 데몬 (요청에 담긴 verifyCmd는 거부)
```

표준(canonical) 실행기는 자신의 로그인으로 헤드리스로 구동되는 네이티브 CLI(`codex exec`, `claude -p`, `agy -p`)입니다 — 당신의 구독이 곧 런타임이고, 호출당 API 비용이 없습니다. `anthropic-direct`는 동일한 증거 계약(evidence contract) 뒤에 있는 선택적 직접-API 어댑터입니다. 모든 실행은 `native-harness-assisted`로 라벨링되며, 소유하지 않는 표면(unowned surfaces)이 명시됩니다.

### orchestrator-as-skill

`maestro skill run`은 스펙을 네이티브 실행기 위의 `research → execute → review` 그래프로 컴파일합니다. 완료는 `recomputeCompletionFromLedger`로 판정됩니다: 해시 체인을 검증하고, **저장된 실행 증거가 여전히 그 해시 체인 내용 다이제스트와 일치하는지 단언**하며(저장 파일이 바꿔치기되면 조용한 재채점이 아니라 `failed`로 재계산), 그런 다음 **깨끗한 체크아웃에서 그 증거 위로 합격 명령을 다시 실행**합니다 — 이때 운영자의 `testFiles`가 마지막에 덮어씌워집니다(실행기는 자신이 채점받는 테스트를 편집할 수 없음).

- **증거 입도(granularity)** — 실행 단계는 자기완결적 산출물 하나(`evidence: 'artifact'`, 기본값) 또는 **전체 워크트리 diff**(`evidence: 'diff'`)를 기록합니다. diff 모드는 실제 멀티파일 저장소 작업을 채점합니다: 합격 판정은 `base@고정-커밋 + git apply(diff) + 마지막에 덮은 testFiles`를 결정론적으로 재구성하고 저장소의 `node_modules`를 링크하므로, 자기완결 파일 하나가 아니라 멀티파일 변경에 대한 진짜 `npm test`가 채점 가능합니다.
- **실행 팬아웃(fan-out)** — 같은 작업에 N개의 실행기를 경쟁시키고, 승자는 순위/자기 주장이 아니라 합격 기준 재실행으로 결정합니다.
- **정련 루프(refinement loop)** (`maxRefineIterations`) — 경계가 있는 draft→verify→fix 루프; 계속/중단 신호는 오직 재계산 가능한 합격 기준이며, 절대 비평가(critic) 점수가 아닙니다.

## maestro magic — 프로젝트별 의존성 합성 (LLM 의존성을 위한 Tuist)

프로젝트를 분석해 필요한 LLM-의존성 모듈(MCP 서버, 지시문 파일)을 해결하고, 주입한 뒤 실행합니다 — 프로젝트마다 손으로 배선할 필요가 없습니다.

```bash
maestro magic plan "<목표>"        # 프로젝트 태그 탐지 + 모듈 해결 (드라이런; 아무것도 주입 안 함)
maestro magic catalog              # 모듈 카탈로그 나열 (선언 + 발견)
maestro magic apply [--into <dir>] [--executor ...] [--approve-secrets]   # 주입 + 해시 체인 기록
maestro magic show <magicRunId>    # 원장에서 주입 기록을 재계산; 모순 표시
maestro magic run "<목표>" [--executor ...] [--prove]                     # 주입 후 실행기 실행
```

- **탐지(Detect)** (결정론적, 평면 태그): 매니페스트/락파일(Tuist, SwiftPM, Cargo, npm/pnpm/yarn, go, python…) + AI-표면 마커. 술어(predicate) DSL 없음.
- **카탈로그(Catalog)**: 선언된 `warden.modules.json`(저장소) + `~/.warden/catalog/*.json`(전역) + 발견된 설치 스킬; 모듈의 태그가 탐지된 태그의 부분집합(⊆)일 때 매칭됩니다.
- **주입(Inject)**: 해결된 집합을 실행 워크트리에 기록; 변조 감지·재현 가능한 `composition.injected` 원장 이벤트로 남깁니다.
- **`--prove`**: 카나리(canary) MCP 서버를 주입; 소비(consumption)는 *실제로 호출되었을 때만* 그것이 쓰는 센티넬(sentinel)로 증명됩니다 — 모델의 말로는 절대 증명되지 않습니다.

**정직한 천장(설계상).** 실행기가 워크트리를 소유하므로(R-native-ownership), maestro은 *주입한 것의 무결성 + 재현성*을 보장하지, 실행기가 그것으로 무엇을 하는지는 보장하지 않습니다. 소비 증명은 비적대적(non-adversarial)입니다. MCP(역량)는 자유롭게 주입되지만, **지시문 주입(CLAUDE.md/soul)은 승인 게이트가 걸려 있고, 또한 고정된 테스트 합격 기준으로 기계적으로 제한**됩니다 — 채점 테스트가 운영자에게 고정(pinned)된 채로 남으므로, 판정을 세탁할 수 없는 "테스트 맞춤 교육(teaching-to-the-test)" 채널입니다.

## 증거 & 안전 모델

- 프로젝트 상태는 `.agent/` 아래에 있으며, `.agent/index.json`으로 재구성 가능합니다.
- 해시 체인 `RuntimeEventEnvelope` 원장(`prev_event_sha256`); 중간 이벤트가 변조되면 재검증에 실패합니다. 체인은 **이벤트 서사(narrative)가 편집되지 않았음**을 증명하고 — 스킬 경로에서는 **채점되는 실행 증거를 바인딩**합니다: 그 내용 다이제스트가 체인에 기록되고, 완료 재계산 전에 다시 단언됩니다. 체인은 변조 감지 + 증거 바인딩이며, 완료 *권한*은 여전히 그 바인딩된 증거 위로 합격 기준을 다시 실행하는 것이지 체인 자체가 아닙니다.
- 프로세스 출력은 `*.process.json` / `*.stdout.log` / `*.stderr.log`로 캡처되고, 렌더된 산출물은 일반적인 API 토큰을 마스킹합니다.
- 메모리 패브릭(memory fabric)은 **출처가 명시되고(provenanced) 갓 검증된(freshly-verified)** 사실만 받아들입니다(게이트 #4); 신선도(freshness)는 통과한 검증기로부터 얻으며, 자기 주장으로는 안 됩니다.
- 주입은 절대 완료를 진전시키지 않으며, 웹 UI는 게이트가 빨강일 때 초록을 보여주는 대신 CONTRADICTION 패널을 표시합니다.

## 품질 게이트 (참고용/advisory)

```bash
maestro quality gate --write
```

스캐폴드/MVP/문서만 있는/자기 인증 완료를 거부하고, `.agent/product-gates/` 아래에 영구 리포트를 씁니다. **참고용일 뿐** — 실행을 완료로 표시할 수 없습니다; 완료 권한은 재계산 가능한 원장/diff 검증기입니다. PRD 범위의 로컬 v0–v2 게이트는 통과하지만, 하드 완료는 리뷰 커스터디(custody)가 존재할 때까지 정직하게 상한이 걸려 있고(`completion_ceiling: 60`), 정직한 단일 운영자 천장은 구조상 약 75입니다.

**커스터디 기준은 위조 저항(forgery-resistance)이지 입증된 독립성(proven independence)이 아니며 — 이는 "로컬, 단일 운영자"와 의도적 긴장 관계에 있습니다.** 커스터디(`≥90` 경로)는 리뷰 번들을 실행의 `head_sha`에 바인딩하고 HMAC 서명하는 CI 워크플로우입니다: 위조되거나 사후에 만들어진 리뷰를 *변조 감지 가능하고 출처에 바인딩되게* 만들어, 자기 인증의 비용을 높입니다. 진짜로 독립적인 주체가 작업을 판정했음을 *증명*하지는 **않습니다** — 운영자가 여전히 CI 정의, 서명 키, 리뷰어 에이전트를 소유합니다. 그래서 순수 로컬 단일 실행은 **설계상** 상한(약 75)이 걸리고, ≥90을 넘으려면 의도적으로 외부 두 번째 주체(커스터디 CI)가 필요합니다 — 즉, 헤드라인이 묘사하는 순수 로컬-단일 자세 밖으로 나가는 것입니다. 그 긴장은 숨겨진 게 아니라 의도적이고 명시된 것이며, `60` 상한은 커스터디가 독립성이 아니라 위조 저항임을 정직하게 인정하는 것입니다.

## 이건 어떻게 만들어졌나

설계와 구현은 저장소 내부의 **비평가 패널(critic panel)** 로 리뷰됩니다 — 세 개의 이질적인 실행기(codex/claude/agy)가 격리된 워크트리에서, 각자 별개의 적대적 렌즈 아래, 검증기가 "supported(뒷받침됨)"를 소유합니다(`docs/milestones/*_panel.mjs`). 작성(writer) 패스와 리뷰어(reviewer) 패스는 분리되어 있고, 어떤 것도 자기 승인하지 않습니다. 여러 기능이 패널 BLOCKER에 의해 실질적으로 재구성되거나 좁혀졌습니다(예: 주입의 보장은 R-native-ownership이 실제로 허용하는 범위로 좁혀짐).

## 레이아웃

- `src/harness/` — 원장, 검증기, orchestrator-skill, 팬아웃, 정련, 주입 배선
- `src/composition/` — maestro magic: 탐지 / 카탈로그 / 해결 / 주입 / 원장-증거 / 카나리
- `src/events/ledger.ts` — 해시 체인 런타임 이벤트 원장
- `src/memory/` — 출처-키 기반 메모리 패브릭
- `src/cli.ts` — `maestro` CLI; `src/view.ts` — 운영자 웹 UI
- `docs/milestones/` — 현재 표준 문서; 완료된 마일스톤 + 일회성 패널은 `docs/milestones/archive/` 아래
- **여기서 시작:** `docs/milestones/_CURRENT_TRUTH.md` (단일 진실 원천: 방향, 상태, 문서 맵)
- 업스트림/범위: `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md` (구속력 있음); `dominic_orchestration_PRD.md` (역사적/대체됨)

## 라이선스

저장소의 라이선스 파일을 참고하세요.
