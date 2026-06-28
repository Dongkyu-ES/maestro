# maestro

> **AI 코딩 에이전트를 위한 작업 인식형(task-aware) 오케스트레이션.** 작업 하나를 넣으면, 알맞은 멀티 에이전트 패턴이 나옵니다 — 이미 구독 중인 CLI들로 조합해서.

*다른 언어로 보기: [English](README.md) · **한국어***

![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)
![runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)
![footprint](https://img.shields.io/badge/local-single--operator-3b82f6)
![evidence](https://img.shields.io/badge/evidence-opt--in-64748b)

maestro에 작업을 주면, 작업을 분류하고, 어울리는 오케스트레이션 패턴을 고르고, 역할마다 알맞은 CLI(Codex, Claude Code, Antigravity/`agy` — 각자의 로그인으로 헤드리스 구동)를 조합하고, 역할마다 필요한 컨텍스트만 적재한 뒤, 오케스트레이션을 실행해 **하나의 종합된 결과**를 돌려줍니다. 주로 `/maestro "<할일>"` Claude Code 스킬로 씁니다.

## 설치

```text
/plugin marketplace add Dongkyu-ES/maestro
/plugin install maestro@maestro
```

자체완결형: 엔진이 플러그인 *안에* 함께 실리고, 런타임 의존성 0, 빌드 불필요. `node` + `git`, 그리고 실행 엔진 CLI 하나(`codex` / `claude` / `agy`)가 각자 로그인으로 있어야 합니다. 소스에서 직접 빌드 → [소스에서 빌드](#소스에서-빌드).

## 무엇을 얻나

- **작업별로 고르는 4가지 패턴** — build → 독립 리뷰 · 팬아웃 + 선택 · 패널 / 디베이트 · scout → plan → build → verify.
- **구독이 곧 런타임** — Codex / Claude / agy를 각자 로그인으로 구동; per-call API 비용 없음.
- **딱 맞는 격리** — git 워크트리 + 선택적 MCP / 지시 주입은 *파일을 병렬로 바꾸는 단계에만*; 읽기 전용 단계는 인세션, 가벼운 작업은 가볍게.
- **옵트인 증거** — 해시 체인 원장(ledger), 재계산 가능한 검증기(verifier), 내용 주소화된 증거. 재생·감사 가능한 완료 판정이 필요할 때(`--prove` / `--gate`)만. 기본은 꺼짐.
- **로컬·정직** — `.agent/` 아래 파일 기반, 단일 운영자, 호스팅 서비스 없음, SaaS 없음, 자동 push 없음.

---

## 목차

- [배경](#배경)
- [왜 maestro인가](#왜-maestro인가)
- [어떻게 작동하나](#어떻게-작동하나)
  - [4가지 패턴](#4가지-패턴)
  - [역할 → CLI 매핑](#역할--cli-매핑)
  - [maestro magic — 의존성 합성](#maestro-magic--의존성-합성)
- [사용법](#사용법)
  - [Claude Code 스킬로](#claude-code-스킬로)
  - [운영자 플로우](#운영자-플로우)
  - [하네스 런타임](#하네스-런타임)
- [활용 사례](#활용-사례)
- [증거와 안전성](#증거와-안전성)
- [품질 게이트](#품질-게이트)
- [어떻게 만들었나](#어떻게-만들었나)
- [소스에서 빌드](#소스에서-빌드)
- [프로젝트 구조](#프로젝트-구조)
- [라이선스](#라이선스)

---

## 배경

AI 코딩 CLI들은 개별적으론 강하지만 서로를 못 봅니다. Codex, Claude Code, Antigravity는 각자의 로그인, 각자의 샌드박스, 각자의 헤드리스 구동 방식을 갖고 있고 — 서로의 존재를 모릅니다. 작업이 그중 *둘 이상*을 원하는 순간 — 첫 모델을 리뷰할 두 번째 모델, 그중 고를 독립 시도 셋, 결정 전 디베이트 — 다시 수작업으로 돌아갑니다: 터미널 사이 컨텍스트 복붙, 병렬 작성자가 충돌 안 하게 워크트리 저글링, 그리고 각 도구가 뱉는 "된 것처럼 보이는" 산문을 그냥 믿기.

maestro는 그 배선을 대신 해주는 계층입니다 — 그것도 작업이 실제로 필요로 하는 만큼만.

## 왜 maestro인가

maestro는 **새 인프라를 만들지 않고 이미 있는 도구를 조합**합니다: `git worktree`, 네이티브 CLI와 각자의 로그인(구독이 곧 런타임 — per-call API 비용 없음), 그리고 detect → resolve → inject → spawn → cleanup을 담당하는 검증된 엔진.

그 위에 **옵트인** 증거 계층 — 해시 체인 원장, 재계산 가능한 검증기, 내용 주소화된 증거 — 이 얹혀, 재계산·감사 가능한 완료 판정이 필요할 때만 켜집니다. 기본 경로에서는 꺼져 있습니다: 오케스트레이션이 먼저, 증명은 요청할 때만(`--prove` / `--gate`).

스킬 자체에 박힌 지침: **결과를 개선하는 가장 가벼운 기존 경로를 고른다.** 멀티 에이전트 팬아웃은 기본이 아니라 예외입니다 — 독립 시도가 진짜 가치 있거나, 단일 시도의 확신이 낮거나, 작업이 어려울 때만 비용값을 합니다. 아니면 인세션 단일 에이전트가 정답입니다.

## 어떻게 작동하나

maestro는 모든 작업에 5단계 루프를 돕니다: **분류 → 패턴 선택 → 역할↔CLI 매핑 → 역할별 최소 컨텍스트 적재 → 실행·종합.** 무거운 단계(워크트리 분리, 선택 주입, DAG 팬아웃)는 로컬·프로바이더 중립 엔진에서, 읽기 전용 단계(패널·스카우트·리뷰)는 워크트리 없이 인세션에서 돕니다.

### 4가지 패턴

| 신호 | 패턴 | 왜 |
| --- | --- | --- |
| 산출물 1개, 품질이 중요, "제대로 됐는지 확신 필요" | **build → 독립 리뷰 루프** | 만든 모델과 *다른* 모델이 리뷰 → 자기검증의 맹점을 깬다 |
| 같은 목표에 독립 시도 여러 개, "여러 안 중 best" | **팬아웃 + 선택** | N개 병렬 시도 → 심판이 선택/종합 |
| 결정/설계 질문, 파일 변경 없음 | **패널 / 디베이트** | 서로 다른 모델·관점의 조언자 → 종합 |
| 넓고 모호한 빌드, "어디부터 손대야 할지 모름" | **scout → plan → build → verify** | 탐색→계획→구현→검증 파이프라인 |

팬아웃이 *정당할* 때도 최대 3~5개, 그리고 *수*보다 **관점 다양성**(다른 모델/렌즈)을 우선합니다.

### 역할 → CLI 매핑

기본 휴리스틱, 역할별로 덮어쓸 수 있음:

- **build** → workspace-write 워크트리의 `codex`.
- **review** → 빌더와 *다른* 모델(`codex` gpt-5.5 high, 또는 `claude`).
- **scout / 심판** → `claude` 또는 인세션 `Explore` 에이전트.

```bash
# 읽기 전용 조언자/리뷰어, 인세션, 워크트리 없음:
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only "<프롬프트>" </dev/null
```

### maestro magic — 의존성 합성

*Tuist인데 LLM 의존성용*이라고 보면 됩니다. 프로젝트를 분석해 필요한 LLM-의존성 모듈(MCP 서버, 지시 파일)을 해소하고, 주입하고, 실행 — 프로젝트마다 수동 배선이 없습니다.

```bash
maestro magic plan "<goal>"     # 프로젝트 태그 감지 + 모듈 해소 (드라이런; 주입 안 함)
maestro magic catalog           # 모듈 카탈로그 나열 (선언된 것 + 발견된 것)
maestro magic run "<goal>" --executor codex|claude|agy [--prove]   # 주입 후 실행기 구동
maestro magic show <magicRunId> # 원장에서 주입 기록 재계산; 모순 표시
```

- **감지**(결정적, 평면 태그): 매니페스트/락파일(Tuist, SwiftPM, Cargo, npm/pnpm/yarn, go, python…) + AI-표면 마커.
- **카탈로그**: 선언된 `maestro.modules.json`(repo) + `~/.maestro/catalog/*.json`(글로벌) + 발견된 설치 스킬; 모듈 태그 ⊆ 감지된 태그일 때 매칭.
- **`--prove`**: 카나리 MCP 서버를 주입; 소비는 *실제 호출됐을 때* 그게 쓰는 센티넬로 증명 — 모델의 말이 아니라.

## 사용법

### Claude Code 스킬로

평소 경로. 플러그인 설치 후:

```text
/maestro "결제 스위트의 플래키 테스트를 찾아 고치고, 검증까지"
```

maestro가 분류해서 `scout → plan → build → verify`를 고르고, 실행기를 대신 구동합니다.

### 운영자 플로우

스킬 뒤의 CLI 표면(v0–v2 제품):

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

- **역할 / 멀티 워커** — `--mode roles`(manager / worker / reviewer) 와 `--mode multi --max-workers N`(실제 격리 워크트리의 병렬 워커; 충돌·금지 경로·증거 불일치 시 합성 차단).
- **승인 게이트 적용** — `maestro apply propose <run-id>` → `maestro approval approve <id>` → `maestro apply approved <id>`(먼저 `git apply --check`; 절대 자동 push 안 함).
- **변경성 셸**은 `shell_mutation` 승인을 만들고 승인 전엔 실행하지 않음.

### 하네스 런타임

재계산 가능한 판정이 필요할 때의 증거 계층:

```bash
maestro harness run "<goal>" --executor codex|claude|agy|anthropic-direct
maestro skill run <spec.json> --what "<goal>"   # research → execute → review
maestro skill show <runId>                       # 원장에서 완료 재계산; 모순 표시
maestro runtime verify-ledger <runId>            # 해시 체인 변조 검사
maestro verifier run --run <runId>               # 재계산 가능한 수용 판정
maestro orchestrate serve | run --file <graph.json>   # DAG 데몬 (요청의 verifyCmd 거부)
```

표준 실행기는 헤드리스로 구동되는 네이티브 CLI(`codex exec`, `claude -p`, `agy -p`)이며 각자의 로그인을 씁니다 — 구독이 곧 런타임, per-call API 비용 없음. `anthropic-direct`는 같은 증거 계약 뒤의 선택적 직접-API 어댑터. 모든 실행은 `native-harness-assisted`로 라벨되고, 소유하지 않은 표면이 명시됩니다.

`maestro skill run`은 스펙을 `research → execute → review` 그래프로 컴파일합니다. 완료는 `recomputeCompletionFromLedger`: 해시 체인을 검증하고, **저장된 execute 증거가 여전히 해시-체인된 내용 다이제스트와 일치하는지 단언**(스토어 파일을 바꿔치기하면 조용한 재채점이 아니라 `failed`로 재계산)한 뒤, **그 증거 위에서 수용 명령을 깨끗한 체크아웃에서 재실행**하되 운영자 `testFiles`를 맨 마지막에 덮어씌웁니다 — 실행기는 자기가 채점당하는 테스트를 고칠 수 없습니다.

## 활용 사례

**"버그가 있는데 어디부터 손대야 할지 모르겠다."** 넓고 모호함 → scout가 지형을 그리고, plan이 수정을 범위화하고, build가 구현하고, verify가 증명.

```text
/maestro "배포 후 사용자가 간헐적으로 로그아웃됨 — 원인을 찾아 고쳐줘"
```

**"여러 접근 중 베스트를 줘."** 해법 공간이 넓음 → 독립 시도를 경주시키고, 수용 재실행으로 심판, 자기주장으로는 절대 안 함.

```bash
maestro harness run "게이트웨이용 레이트 리미터 설계" --executor codex   # 팬아웃 변주가 수용으로 선택
```

**"A가 맞아 B가 맞아?"** 파일 변경 없는 결정 → 서로 다른 모델/렌즈의 조언자 패널, 종합.

```bash
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only \
  "이 스키마에 낙관적 vs 비관적 잠금 비교. 양쪽 다 논변한 뒤 추천." </dev/null
```

**"만들고, 진짜 제대로 됐는지 확인해줘."** 품질이 중요 → 빌더와 리뷰어가 다른 모델; 무엇도 자기승인 안 함.

```bash
maestro skill run spec.json --what "주문 엔드포인트에 idempotency 키 추가"
maestro skill show <runId>   # 완료는 산문이 아니라 원장에서 재계산
```

## 증거와 안전성

- 프로젝트 상태는 `.agent/` 아래, `.agent/index.json`으로 재구성 가능.
- 해시 체인 `RuntimeEventEnvelope` 원장(`prev_event_sha256`)은 중간 이벤트를 변조하면 재검증에 실패하게 합니다. 체인은 **이벤트 서사**가 미편집임을 증명하고 **채점된 execute 증거를 바인딩** — 그 내용 다이제스트가 체인에 기록되고 완료 재계산 전에 재단언됩니다. 체인은 변조 증거이고, 완료 *권위*는 여전히 그 바인딩된 증거 위에서 수용을 재실행하는 것.
- 프로세스 출력은 `*.process.json` / `*.stdout.log` / `*.stderr.log`로 캡처; 렌더된 산출물은 흔한 API 토큰을 가립니다.
- 메모리 패브릭은 **출처가 있고 갓 검증된** 사실만 받아들입니다; 신선도는 통과한 검증기에서 얻고 자기주장이 아닙니다.
- 주입은 완료를 절대 전진시키지 않음; 게이트가 빨강일 때 웹 UI는 초록을 보이는 대신 CONTRADICTION 패널을 띄웁니다.

## 품질 게이트

```bash
maestro quality gate --write
```

스캐폴드 / MVP / 문서만 / 자기인증 완료를 거부하고 `.agent/product-gates/` 아래에 영속 리포트를 씁니다. **권고용일 뿐** — 실행을 완료로 표시할 수 없고, 완료 권위는 재계산 가능한 원장 / diff 검증기입니다.

정직한 천장은 숨기지 않고 명시합니다: 리뷰 custody가 생기기 전까지 하드 완료는 `completion_ceiling: 60`으로 캡되고, 순수 로컬 솔로 실행은 구조상 ~75에서 포화합니다 — 운영자가 여전히 기계·키·프롬프트·산출물을 소유하기 때문. ≥90을 넘으려면 의도적으로 외부 두 번째 주체(실행의 `head_sha`에 HMAC 서명된 리뷰 번들을 바인딩하는 custody CI)가 필요하고, 이는 순수 로컬-솔로 자세를 벗어나는 것입니다. 이 긴장은 의도적입니다: custody는 위조 저항이지 독립성의 증명이 아닙니다.

## 어떻게 만들었나

설계와 구현은 in-repo **크리틱 패널**이 리뷰합니다 — 격리 워크트리의 이질적 실행기 셋(codex / claude / agy), 각자 다른 적대적 렌즈, "supported"는 검증기가 소유(`docs/milestones/*_panel.mjs`). writer와 reviewer 패스는 분리되고, 무엇도 자기승인 안 함. 여러 기능이 패널 BLOCKER로 실질적으로 재형성·축소됐습니다 — 예: 주입의 보장은 실행기가-워크트리를-소유한다는 사실이 허용하는 선까지 좁혀졌습니다.

## 소스에서 빌드

```bash
npm install
npm run build
npm link            # `maestro`를 PATH에 등록 (상태는 여전히 cwd별 .agent/)
maestro --version
```

링크 없이 실행: `node dist/cli.js --help`. `src/`를 바꾼 뒤에는 `dist/`를 다시 빌드해 커밋하세요 — 그 커밋된 빌드가 플러그인으로 실리는 실물입니다.

## 프로젝트 구조

- `src/harness/` — 원장, 검증기, 오케스트레이터-스킬, 팬아웃, 정제(refinement), 주입 배선
- `src/composition/` — maestro magic: 감지 / 카탈로그 / 해소 / 주입 / 원장-증거 / 카나리
- `src/events/ledger.ts` — 해시 체인 런타임 이벤트 원장
- `src/memory/` — 출처 키 기반 메모리 패브릭
- `src/cli.ts` — `maestro` CLI; `src/view.ts` — 운영자 웹 UI
- `bin/maestro` — 플러그인 런처(PATH 심 → 동봉된 `dist/cli.js`)
- `docs/milestones/` — 표준 문서; 완료된 마일스톤 + 일회성 패널은 `docs/milestones/archive/` 아래
- **여기서 시작:** `docs/milestones/_CURRENT_TRUTH.md` (단일 진실 출처: 방향, 상태, 문서 맵)

## 라이선스

저장소 라이선스 파일 참조.
