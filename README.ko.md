# maestro

> **AI 코딩 에이전트를 위한 작업 인식형(task-aware) 오케스트레이션.** 작업 하나를 던지면 거기에 맞는 멀티 에이전트 패턴이 돌아갑니다. 이미 쓰고 있는 CLI들을 엮어서요.

*다른 언어로 보기: [English](README.md) · **한국어***

![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)
![runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)
![footprint](https://img.shields.io/badge/local-single--operator-3b82f6)
![evidence](https://img.shields.io/badge/evidence-opt--in-64748b)

maestro에 작업을 맡기면 이렇게 돕니다. 작업을 분류하고, 어울리는 오케스트레이션 패턴을 고르고, 역할마다 알맞은 CLI(Codex, Claude Code, Antigravity/`agy` — 각자의 로그인으로 헤드리스 실행)를 배정하고, 역할에 필요한 만큼만 컨텍스트를 주고, 오케스트레이션을 돌려 **결과 하나로 묶어** 돌려줍니다. 보통은 `/maestro "<할일>"` Claude Code 스킬로 씁니다.

## 설치

```text
/plugin marketplace add Dongkyu-ES/maestro
/plugin install maestro@maestro
```

플러그인 안에 엔진까지 들어 있어 따로 받을 게 없습니다. 런타임 의존성도 없고 빌드도 필요 없어요. `node`와 `git`, 그리고 실행 엔진 CLI 하나(`codex` / `claude` / `agy`)만 각자 로그인으로 준비돼 있으면 됩니다. 소스에서 직접 빌드하려면 → [소스에서 빌드](#소스에서-빌드).

## 무엇을 얻나

- **작업별로 골라 쓰는 4가지 패턴** — build → 독립 리뷰 · 팬아웃 후 선택 · 패널 / 디베이트 · scout → plan → build → verify.
- **구독이 곧 런타임** — Codex / Claude / agy를 각자 로그인으로 돌리니 호출당 API 비용이 없습니다.
- **딱 필요한 만큼만 격리** — git 워크트리와 MCP / 지시 주입은 여러 파일을 동시에 건드리는 단계에서만. 읽기 전용 단계는 인세션에서 가볍게 끝냅니다.
- **증거는 옵트인** — 해시 체인 원장, 다시 계산할 수 있는 검증기, 내용 주소화된 증거. 다시 돌려보고 감사할 수 있는 완료 판정이 필요할 때(`--prove` / `--gate`)만 켜지고, 평소엔 꺼져 있습니다.
- **작업이 반복되면 하네스를 구성** — 매번 역할→CLI를 즉석 매핑하는 대신, 역할 에이전트 + 스킬 + 얇은 오케스트레이터(who/how 분리)를 파일로 박제해 재사용.
- **로컬, 그리고 정직** — 상태는 `.agent/` 아래 파일로. 단일 운영자, 호스팅 서비스 없음, SaaS 없음, 자동 push 없음.

---

## 목차

- [배경](#배경)
- [왜 maestro인가](#왜-maestro인가)
- [어떻게 작동하나](#어떻게-작동하나)
  - [4가지 패턴](#4가지-패턴)
  - [역할 → CLI 매핑](#역할--cli-매핑)
  - [원하는 실행기를 직접](#원하는-실행기를-직접)
  - [maestro magic — 의존성 합성](#maestro-magic--의존성-합성)
  - [하네스를 구성](#하네스를-구성)
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

AI 코딩 CLI들은 하나하나는 강한데 서로를 못 봅니다. Codex, Claude Code, Antigravity는 저마다 로그인도, 샌드박스도, 헤드리스로 돌리는 방식도 다른데, 정작 서로의 존재는 모르죠. 그러다 작업이 이 중 둘 이상을 동시에 원하기 시작하면 — 첫 모델의 결과를 검수할 두 번째 모델, 그중 하나를 고를 독립 시도 셋, 결정을 내리기 전의 디베이트 — 결국 손으로 엮는 신세가 됩니다. 터미널을 오가며 컨텍스트를 복붙하고, 병렬로 도는 작성자들이 서로 안 부딪치게 워크트리를 곡예하듯 굴리고, 각 도구가 내놓는 "다 된 것 같은" 설명을 그냥 믿는 식이죠.

maestro는 그 엮는 일을 대신 해줍니다. 그것도 작업에 정말 필요한 만큼만요.

## 왜 maestro인가

maestro는 새 인프라를 짓는 대신 **이미 있는 도구를 엮습니다.** `git worktree`, 네이티브 CLI와 그 자체 로그인(구독이 곧 런타임이라 호출당 API 비용이 없습니다), 그리고 detect → resolve → inject → spawn → cleanup을 처리하는 검증된 엔진을요.

그 위에 **옵트인** 증거 계층 — 해시 체인 원장, 다시 계산 가능한 검증기, 내용 주소화된 증거 — 이 얹힙니다. 다시 돌려보고 감사할 수 있는 완료 판정이 필요할 때만 켜지고요. 기본값은 꺼짐입니다. 오케스트레이션이 먼저고, 증명은 달라고 할 때만(`--prove` / `--gate`).

스킬 자체에 박아 둔 원칙이 하나 있습니다. **결과를 더 낫게 만드는, 가장 가벼운 기존 경로를 고른다.** 그래서 멀티 에이전트 팬아웃은 기본이 아니라 예외입니다. 독립적인 시도가 진짜로 값어치를 하거나, 한 번의 시도로는 확신이 안 서거나, 작업 자체가 어려울 때만 그 비용을 치르죠. 아니면 인세션 단일 에이전트가 정답입니다.

## 어떻게 작동하나

maestro는 작업마다 다섯 단계를 돕니다. **분류 → 패턴 선택 → 역할에 CLI 배정 → 역할마다 필요한 컨텍스트만 적재 → 실행하고 종합.** 무거운 단계(워크트리 분리, 선택 주입, DAG 팬아웃)는 로컬의 프로바이더 중립 엔진이 맡고, 읽기 전용 단계(패널, 스카우트, 리뷰)는 워크트리 없이 인세션에서 처리합니다.

### 4가지 패턴

| 신호 | 패턴 | 왜 |
| --- | --- | --- |
| 산출물 하나, 품질이 중요, "제대로 됐는지 확신이 필요" | **build → 독립 리뷰 루프** | 만든 모델이 아니라 다른 모델이 검수해 자기검증의 사각을 없앤다 |
| 같은 목표를 여러 번 독립으로 시도, "여러 안 중 최고를" | **팬아웃 후 선택** | N개를 병렬로 돌리고 심판이 고르거나 종합한다 |
| 결정이나 설계 질문, 파일은 안 바뀜 | **패널 / 디베이트** | 모델·관점이 다른 조언자들을 모아 종합한다 |
| 넓고 막연한 빌드, "어디서 시작할지 모름" | **scout → plan → build → verify** | 탐색·계획·구현·검증으로 이어지는 파이프라인 |

팬아웃이 정당한 경우에도 최대 3~5개까지만, 그리고 개수보다 **관점의 다양성**(다른 모델·렌즈)을 우선합니다.

### 역할 → CLI 매핑

기본 휴리스틱이고, 역할마다 바꿀 수 있습니다.

- **build** → workspace-write 워크트리의 `codex`.
- **review** → 만든 쪽과 다른 모델(`codex` gpt-5.5 high, 또는 `claude`).
- **scout / 심판** → `claude`, 또는 인세션 `Explore` 에이전트.

```bash
# 읽기 전용 조언자/리뷰어, 인세션, 워크트리 없음:
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only "<프롬프트>" </dev/null
```

### 원하는 실행기를 직접

maestro는 실행기 셋을 기본으로 싣고, 네 번째는 뭐든 받습니다. 이렇게 열어도 안전한 비결은 **완료를 채점하는 방식이 모두 같다**는 데 있습니다. 만들어 낸 diff 위에서 acceptance를 깨끗한 체크아웃에 다시 돌리거든요. 그래서 실행기는 "무엇을 했는가"로 평가되지, "무엇을 했다고 말하는가"로 평가되지 않습니다.

```bash
# `<bin> -p "<프롬프트>"` 로 불리는 헤드리스 CLI라면 무엇이든:
maestro harness run "<goal>" --executor opencode --executor-bin "$(command -v opencode)"
```

| 실행기 | 쓰는 법 | 라이프사이클 증명 | 완료 권위 |
| --- | --- | --- | --- |
| `codex` | 기본 내장 | 완전 — resume / fork / interrupt / launch-proof | acceptance 재계산 |
| `claude`, `agy` | 내장 | 없음 (범용 헤드리스) | acceptance 재계산 |
| **그 외 모든 CLI** | `--executor <이름> --executor-bin <경로>` | 없음, `native-harness-assisted`로 표기 | acceptance 재계산 |

직접 붙이는 실행기는 `<bin> -p "<프롬프트>"` 규칙을 따른다고 가정합니다(`claude` / `agy`가 쓰는 방식이죠). 다르면 한 줄짜리 셸 래퍼로 감싸면 됩니다. 직접 붙인 실행기가 못 받는 건 codex의 더 깊은 라이프사이클 증명 하나뿐인데, 그 빈틈도 숨기지 않고 표시해 둡니다.

### maestro magic — 의존성 합성

*Tuist인데 대상이 LLM 의존성*이라고 생각하면 됩니다. 프로젝트를 분석해 필요한 LLM 의존성 모듈(MCP 서버, 지시 파일)을 찾아내고, 주입하고, 실행합니다. 프로젝트마다 손으로 배선할 일이 없죠.

```bash
maestro magic plan "<goal>"     # 프로젝트 태그 감지 + 모듈 해소 (드라이런; 주입 안 함)
maestro magic catalog           # 모듈 카탈로그 나열 (선언된 것 + 발견된 것)
maestro magic run "<goal>" --executor codex|claude|agy [--prove]   # 주입 후 실행기 구동
maestro magic show <magicRunId> # 원장에서 주입 기록 다시 계산; 모순 표시
```

- **감지**(결정적, 평면 태그): 매니페스트·락파일(Tuist, SwiftPM, Cargo, npm/pnpm/yarn, go, python…)과 AI 표면 마커.
- **카탈로그**: repo의 `maestro.modules.json` + 글로벌 `~/.maestro/catalog/*.json` + 설치된 스킬에서 발견한 것. 모듈의 태그가 감지된 태그의 부분집합이면 매칭됩니다.
- **`--prove`**: 카나리 MCP 서버를 주입하고, 그게 **실제로 호출됐을 때** 남기는 센티넬로 소비를 증명합니다. 모델의 말이 아니라요.

### 하네스를 구성

4가지 패턴은 *한 번 돌고 사라집니다*. 같은 종류의 작업이 반복되거나 한 패턴으로 안 끝날 만큼 넓을 땐, maestro가 대신 **재사용 가능한 하네스를 박제**합니다 — 역할 에이전트(*who*), 스킬(*how*), 얇은 오케스트레이터를 파일로 적어, 다음 실행이 매핑을 다시 도출하지 않고 그대로 재사용하게.

아이디어는 하네스 저작 메타-스킬에서 빌렸지만 maestro식으로 유지합니다: 역할은 opus 전용 Claude Code 에이전트가 아니라 **무엇이든**(`codex` / `claude` / `agy` / 인세션 서브에이전트), 실행은 새 런타임이 아니라 기존 엔진(`magic` / `orchestrate`)과 Claude Code 네이티브 `agents/` + `skills/` 포맷을 재사용, 증거는 옵트인. 재사용이 값을 할 때만 박제하세요 — 아니면 1회성 패턴이 맞습니다. 레시피와 체크리스트는 스킬의 `references/compose.md`에 있습니다.

## 사용법

### Claude Code 스킬로

평소 쓰는 경로입니다. 플러그인을 설치하고 나면:

```text
/maestro "결제 스위트에서 플래키한 테스트를 찾아 고치고 검증까지"
```

maestro가 알아서 분류해 `scout → plan → build → verify`를 고르고 실행기를 대신 굴립니다.

### 운영자 플로우

스킬 밑에 깔린 CLI 표면입니다(v0–v2 제품).

```bash
maestro init
maestro project add "$PWD"
maestro task add "경계가 분명한 이슈를 조사하고 수정"
maestro run create <task-id> --mode basic --command "npm test"
maestro run start <run-id>
maestro run collect <run-id>
maestro review latest
maestro web --port 4317      # 운영자 UI: 원장에서 진실을 다시 계산하고, 모순을 표시
```

- **역할 / 멀티 워커** — `--mode roles`(manager / worker / reviewer), `--mode multi --max-workers N`(진짜 격리된 워크트리에서 도는 병렬 워커. 충돌·금지 경로·증거 불일치가 있으면 종합을 막습니다).
- **승인 게이트 적용** — `maestro apply propose <run-id>` → `maestro approval approve <id>` → `maestro apply approved <id>`(먼저 `git apply --check`를 돌리고, 자동 push는 절대 안 합니다).
- **변경을 일으키는 셸**은 `shell_mutation` 승인을 만들고, 승인 전엔 실행하지 않습니다.

### 하네스 런타임

다시 계산할 수 있는 판정이 필요할 때 쓰는 증거 계층입니다.

```bash
maestro harness run "<goal>" --executor codex|claude|agy|anthropic-direct
maestro skill run <spec.json> --what "<goal>"   # research → execute → review
maestro skill show <runId>                       # 원장에서 완료 다시 계산; 모순 표시
maestro runtime verify-ledger <runId>            # 해시 체인 변조 검사
maestro verifier run --run <runId>               # 다시 계산할 수 있는 수용 판정
maestro orchestrate serve | run --file <graph.json>   # DAG 데몬 (요청의 verifyCmd 거부)
```

표준 실행기는 헤드리스로 도는 네이티브 CLI(`codex exec`, `claude -p`, `agy -p`)이고 각자의 로그인을 씁니다. 구독이 곧 런타임이라 호출당 API 비용이 없죠. `anthropic-direct`는 같은 증거 계약 뒤에 둔 선택형 직접-API 어댑터입니다. 모든 실행에는 `native-harness-assisted` 라벨이 붙고, 책임지지 못하는 표면은 이름으로 명시됩니다.

`maestro skill run`은 스펙을 `research → execute → review` 그래프로 컴파일합니다. 완료 판정은 `recomputeCompletionFromLedger`가 맡습니다. 해시 체인을 검증하고, **저장된 execute 증거가 체인에 박힌 내용 다이제스트와 여전히 일치하는지 확인한 뒤**(스토어 파일을 바꿔치기하면 슬그머니 재채점되는 게 아니라 `failed`로 다시 계산됩니다), **그 증거 위에서 acceptance 명령을 깨끗한 체크아웃에 다시 돌립니다.** 이때 운영자의 `testFiles`를 맨 마지막에 덮어쓰고요 — 실행기는 자기를 채점하는 테스트를 손댈 수 없습니다.

## 활용 사례

**"버그는 있는데 어디서 손대야 할지 모르겠다."** 넓고 막연하죠. scout가 지형을 그리고, plan이 고칠 범위를 잡고, build가 구현하고, verify가 증명합니다.

```text
/maestro "배포 후에 사용자가 간헐적으로 로그아웃돼. 원인 찾아서 고쳐줘"
```

**"여러 접근 중에 제일 나은 걸로."** 해법 공간이 넓을 때. 독립 시도들을 경주시키고, acceptance를 다시 돌려서 고릅니다. 자기주장으로 고르는 게 아니라요.

```bash
maestro harness run "게이트웨이용 레이트 리미터 설계" --executor codex   # 팬아웃 변주가 acceptance로 선택
```

**"A가 맞아, B가 맞아?"** 파일은 안 바뀌는 결정. 모델·렌즈가 다른 조언자 패널을 돌려 종합합니다.

```bash
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only \
  "이 스키마에 낙관적 잠금과 비관적 잠금 중 뭐가 나은지. 양쪽 다 논거를 세운 다음 추천해줘" </dev/null
```

**"만들고, 진짜 제대로 됐는지까지 봐줘."** 품질이 중요할 때. 만드는 모델과 검수하는 모델이 다르고, 무엇도 자기 자신을 승인하지 못합니다.

```bash
maestro skill run spec.json --what "주문 엔드포인트에 idempotency 키 추가"
maestro skill show <runId>   # 완료는 설명이 아니라 원장에서 다시 계산
```

## 증거와 안전성

- 프로젝트 상태는 `.agent/` 아래에 있고, `.agent/index.json`으로 다시 만들 수 있습니다.
- 해시 체인 `RuntimeEventEnvelope` 원장(`prev_event_sha256`)은 중간 이벤트를 건드리면 재검증에서 걸립니다. 체인은 **이벤트 서사**가 손대지 않았음을 증명하고, 채점 대상인 execute 증거를 묶어 둡니다. 그 내용 다이제스트를 체인에 기록해 두고, 완료를 다시 계산하기 전에 한 번 더 대조하죠. 체인은 변조를 드러내는 장치고, 완료를 결정하는 **권위**는 어디까지나 그 묶인 증거 위에서 acceptance를 다시 돌리는 데 있습니다.
- 프로세스 출력은 `*.process.json` / `*.stdout.log` / `*.stderr.log`로 잡고, 렌더된 산출물은 흔한 API 토큰을 가립니다.
- 메모리 패브릭은 **출처가 있고 방금 검증된** 사실만 받습니다. 신선도는 검증기를 통과해서 얻는 거지 스스로 주장하는 게 아닙니다.
- 주입은 완료를 절대 앞당기지 않습니다. 게이트가 빨간데 초록을 보여주는 일은 없고, 대신 웹 UI에 CONTRADICTION 패널이 뜹니다.

## 품질 게이트

```bash
maestro quality gate --write
```

스캐폴드, MVP, 문서만, 자기 인증식 완료를 걸러내고 `.agent/product-gates/` 아래에 영구 리포트를 남깁니다. **어디까지나 권고**라서 실행을 완료로 표시하진 못합니다. 완료를 결정하는 권위는 다시 계산할 수 있는 원장·diff 검증기예요.

정직한 한계는 숨기지 않고 적어 둡니다. 리뷰 custody가 생기기 전까지 하드 완료는 `completion_ceiling: 60`에 묶이고, 순수 로컬 솔로 실행은 구조상 ~75에서 멈춥니다. 운영자가 기계도, 키도, 프롬프트도, 산출물도 다 쥐고 있으니까요. ≥90을 넘으려면 외부의 두 번째 주체가 필요합니다(실행의 `head_sha`에 HMAC 서명된 리뷰 번들을 묶는 custody CI). 그건 순수 로컬-솔로 자세에서 한 발 벗어나는 셈이죠. 이 긴장은 일부러 둔 겁니다. custody는 위조를 어렵게 만들 뿐, 독립성을 증명하진 않으니까요.

## 어떻게 만들었나

설계와 구현은 repo 안의 **크리틱 패널**이 검수합니다. 격리된 워크트리에서 도는 이질적인 실행기 셋(codex / claude / agy)이 각자 다른 적대적 렌즈를 쓰고, "supported"는 검증기가 쥡니다(`docs/milestones/*_panel.mjs`). 작성과 검수는 별도 패스로 나뉘고, 무엇도 스스로를 승인하지 않습니다. 패널의 BLOCKER 때문에 실질적으로 모양이 바뀌거나 좁아진 기능도 여럿입니다. 예를 들어 주입의 보장 범위는 "실행기가 워크트리를 소유한다"는 사실이 허용하는 선까지 좁혔습니다.

## 소스에서 빌드

```bash
npm install
npm run build
npm link            # `maestro`를 PATH에 등록 (상태는 여전히 cwd별 .agent/)
maestro --version
```

링크 없이 실행하려면 `node dist/cli.js --help`. `src/`를 고친 뒤에는 `dist/`를 다시 빌드해서 커밋하세요. 플러그인으로 실제 나가는 게 그 커밋된 빌드입니다.

## 프로젝트 구조

- `src/harness/` — 원장, 검증기, 오케스트레이터 스킬, 팬아웃, 정제(refinement), 주입 배선
- `src/composition/` — maestro magic: 감지 / 카탈로그 / 해소 / 주입 / 원장 증거 / 카나리
- `src/events/ledger.ts` — 해시 체인 런타임 이벤트 원장
- `src/memory/` — 출처 기반 메모리 패브릭
- `src/cli.ts` — `maestro` CLI; `src/view.ts` — 운영자 웹 UI
- `bin/maestro` — 플러그인 런처(PATH 심 → 동봉된 `dist/cli.js`)
- `docs/milestones/` — 표준 문서. 끝난 마일스톤과 일회용 패널은 `docs/milestones/archive/` 아래에.
- **여기서 시작:** `docs/milestones/_CURRENT_TRUTH.md`(방향·상태·문서 지도를 담은 단일 진실 출처)

## 라이선스

저장소의 라이선스 파일을 참고하세요.
