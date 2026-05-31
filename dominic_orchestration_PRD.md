# PRD: Dominic Orchestration

**문서 상태:** Draft v0.1  
**작성일:** 2026-05-31  
**저장 경로:** `~/Documents/github/dominic_orchestration/dominic_orchestration_PRD.md`  
**제품 가칭:** Dominic Orchestration  
**핵심 한 줄:** 로컬에서 OMX/Codex/MCP/스킬을 내 방식대로 실행·기록·검토·승격시키는 개인용 에이전트 오케스트레이션 시스템.

---

## 0. Executive Summary

Dominic Orchestration은 “에이전트 하나”를 만드는 프로젝트가 아니다. 이것은 로컬 웹서비스 형태의 **에이전트 오케스트레이션 컨트롤 플레인**이다.

현재 사용자는 터미널에서 프로젝트 경로로 이동한 뒤 `omx` 또는 Oh My Codex를 실행하고, 그 위에서 Codex 기반 서드파티 하네스를 사용한다. 이 방식은 간편하고 강력하지만, 다음 문제가 있다.

- 작업이 대화 단위로 흩어진다.
- 무엇을 하려고 했는지, 어떤 run이 실패했는지, 무엇을 배웠는지 축적되지 않는다.
- 지침, 스킬, 워크플로우, 메모리, 평가 기준이 섞인다.
- 리뷰가 감상적으로 끝나고 시스템 개선으로 이어지지 않는다.
- 멀티 워커, 리뷰어, 승인 흐름, task 종료 처리가 구조화되어 있지 않다.

Dominic Orchestration은 이를 해결하기 위해 다음 구조를 갖는다.

```text
Local Web UI
  ↓
Orchestrator Server
  ↓
Task / Run / Worker State Machine
  ↓
Agent Runtime
  ├─ Manager Agent
  ├─ Worker Agent
  └─ Reviewer Agent
  ↓
Executor Adapters
  ├─ OMX Adapter
  ├─ Codex Adapter
  └─ Future: Agents SDK Adapter
  ↓
Tools / Workspaces
  ├─ git worktree
  ├─ filesystem
  ├─ shell
  ├─ MCP
  └─ browser / external tools
  ↓
.agent/ Durable Artifact Store
```

가장 중요한 설계 원칙은 다음이다.

> **LLM은 결정을 제안하고, 서버는 상태를 결정한다.**

LLM Manager는 “이 작업에는 워커 2개가 필요하다”고 제안할 수 있다. 하지만 실제로 워커를 몇 개 생성할지, 어떤 권한을 줄지, 어떤 상태로 전이할지는 Orchestrator Server가 결정한다. 즉 LLM은 reasoning layer이고, Orchestrator는 deterministic control plane이다.

---

## 1. Product Goal

### 1.1 목표

Dominic Orchestration의 목표는 사용자가 로컬에서 에이전트 작업을 다음 방식으로 수행할 수 있게 하는 것이다.

```text
Project 등록
  → Task 작성
  → Run 시작
  → Manager가 작업 계획 작성
  → Worker가 실제 작업 수행
  → Reviewer가 평가
  → Orchestrator가 상태 결정
  → Done / Changes Requested / Blocked 처리
  → 필요한 경우 Skill / Workflow / Memory / Eval로 승격
```

궁극적으로는 사용자가 이런 흐름으로 작업할 수 있어야 한다.

```bash
cd ~/Documents/github/some-project
agent web
# 브라우저에서 프로젝트 선택
# task 생성
# run 시작
# OMX/Codex worker 실행
# diff/review 확인
# 승인 또는 반려
# 학습을 skill/workflow/eval/memory 후보로 승격
```

### 1.2 제품의 정체성

Dominic Orchestration은 다음 중 하나가 아니다.

- 단순 챗봇
- 단순 Codex wrapper
- 단순 workflow runner
- 단순 project management board
- 단순 MCP client
- 단순 multi-agent demo

Dominic Orchestration은 다음에 가깝다.

> **로컬 에이전트 작업을 task, run, worker, review, artifact, promotion 단위로 관리하는 개인용 agent OS.**

---

## 2. Problem Statement

### 2.1 현재 사용자의 실제 문제

현재 사용자는 이미 `omx + skills + MCP` 기반으로 원시적인 에이전트 하네스를 사용하고 있다. 하지만 로컬에서 직접 에이전트/오케스트레이션을 만들려 할 때 다음 문제가 발생한다.

1. **무엇을 만들어야 하는지부터 흐려진다.**
   - 에이전트를 만들려는지, 워크플로우를 만들려는지, 지침을 정리하려는지 구분이 어려워진다.

2. **워크플로우와 지침이 섞인다.**
   - 항상 지켜야 할 rule인지, 특정 작업 절차인지, 재사용 가능한 skill인지 모호해진다.

3. **실행 결과가 축적되지 않는다.**
   - 어떤 작업이 성공/실패했는지, 왜 실패했는지, 다음에 무엇을 고쳐야 하는지 파일로 남지 않는다.

4. **리뷰가 어렵다.**
   - 산출물이 좋은지 나쁜지 판단할 rubric이 없다.
   - “괜찮은 것 같은데?” 수준에서 끝난다.

5. **시스템 개선 루프가 없다.**
   - 실패가 `AGENTS.md`, `skills/`, `workflows/`, `evals/`, `policies/`, `memory/` 중 어디를 고쳐야 하는지로 연결되지 않는다.

6. **멀티에이전트 구상이 너무 빨리 복잡해진다.**
   - 오케스트레이터, 매니저, 워커, 리뷰어를 모두 처음부터 만들려 하면 디버깅이 불가능해진다.

### 2.2 해결해야 할 핵심 문제

Dominic Orchestration은 다음 질문에 답해야 한다.

- 어떤 프로젝트에서 어떤 task가 진행 중인가?
- 이 task는 어떤 run들을 거쳤는가?
- 각 run은 어떤 manager plan, worker output, diff, review를 남겼는가?
- 어떤 기준으로 done, changes requested, blocked가 결정되었는가?
- 어떤 실패가 어떤 system patch로 이어졌는가?
- 어떤 반복 패턴이 skill/workflow/eval/memory로 승격되어야 하는가?
- 어떤 executor가 실제 작업을 수행했는가? OMX인가, Codex인가, 자체 runtime인가?
- 어떤 도구 권한이 허용되었고, 어떤 행동이 승인 대기되었는가?

---

## 3. Non-Goals

초기 버전에서 하지 않을 것들이다. 특히 v0는 “작동하는 run 기록 루프”만 만든다. 웹 UI, 멀티에이전트, promotion 적용은 v0 핵심 경로를 안정화한 뒤 붙인다.

1. **처음부터 완전 자율 에이전트 만들기**
   - v0에서는 사람이 task를 만들고 run을 승인한다.

2. **처음부터 동적 다중 워커 스폰**
   - v0는 single run.
   - v1에서 manager + worker + reviewer.
   - v2에서 bounded multi-worker.

3. **처음부터 OMX/Codex를 대체하기**
   - v0/v1은 OMX/Codex를 executor로 사용한다.
   - 자체 Agents SDK runtime은 v3 이후.

4. **처음부터 자동 merge/push**
   - git commit, push, package install, destructive operation은 승인 필요.
   - v0에서는 commit/push를 실행 기능으로 만들지 않고, diff와 next action 기록까지만 보장한다.

5. **처음부터 장기 메모리 자동 저장**
   - memory promotion은 review와 사용자 승인 이후에만 수행한다.

6. **처음부터 SaaS화**
   - 로컬 웹서비스가 우선이다.
   - 외부 서버 동기화는 비목표다.

7. **처음부터 모든 MCP를 통합**
   - MCP는 권한과 위험도가 큰 도구 집합으로 취급한다.
   - 초반에는 filesystem, shell readonly, git status/diff 정도로 제한한다.

8. **처음부터 웹 UI에서 모든 조작을 끝내기**
   - v0는 CLI-first로 만든다.
   - Web은 처음에는 read-only viewer에 가깝게 시작해도 된다.
   - 생성/수집/리뷰 루프가 안정된 뒤 승인 처리와 promotion 적용 UI를 확장한다.

---

## 4. Key Definitions

### 4.1 Orchestrator Server

로컬에서 실행되는 deterministic control plane이다.

역할:

- 프로젝트 등록
- task 생성/상태 관리
- run 생성/상태 관리
- work order 생성/상태 관리
- worker lifecycle 관리
- approval 관리
- policy 적용
- artifact 저장
- review 결과에 따른 상태 전이
- promotion 후보 생성

중요한 점:

> Orchestrator Server는 LLM이 아니다. LLM을 호출할 수 있지만, 상태 전이는 서버가 결정한다.

### 4.2 Agent Runtime

Manager, Worker, Reviewer 같은 역할형 LLM agent를 실행하는 계층이다.

역할:

- role prompt 로딩
- task context 구성
- skill/workflow selection 지원
- executor adapter 호출
- worker output 수집
- reviewer 평가 요청

### 4.3 Manager Agent

작업을 이해하고 쪼개는 역할이다.

역할:

- task goal 재진술
- 필요한 context 식별
- work order 작성
- worker 필요 여부 판단
- 결과 종합
- 다음 action 제안

Manager는 실제 파일 수정을 직접 하지 않는 것을 기본 원칙으로 한다. 파일 수정은 worker 또는 executor가 수행한다.

### 4.4 Worker Agent

bounded work order를 받아 실제 작업을 수행하는 역할이다.

역할:

- 지정된 파일/도구 범위 내에서 작업
- 결과물 작성
- diff 생성
- 테스트 실행 또는 테스트 불가 사유 작성
- 위험/후속작업 보고

Worker는 반드시 work order의 scope와 output contract를 따라야 한다.

### 4.5 Reviewer Agent

결과를 rubric에 따라 평가하는 역할이다.

역할:

- task goal 대비 결과 평가
- blocking issue 탐지
- tool discipline 평가
- reviewability 평가
- reusability 평가
- done / changes_requested / blocked 추천

Reviewer는 Manager와 분리된 역할이어야 한다. 같은 모델을 사용하더라도 prompt, context, output contract는 분리한다.

### 4.6 Executor

실제 작업을 수행하는 backend이다.

초기 executor:

- OMX Adapter
- Codex Adapter

미래 executor:

- OpenAI Agents SDK Adapter
- custom shell/fs/MCP runtime

### 4.7 `.agent/` Durable Harness State

각 프로젝트 안에 생성되는 영속 상태 폴더다.

역할:

- tasks 저장
- runs 저장
- artifacts 저장
- reviews 저장
- skills/workflows/evals/memory/policies 저장

중요한 원칙:

> DB는 인덱스이고, `.agent/` 파일은 진실의 원천이다.

### 4.8 Task

해야 할 일의 명세다.

Task는 목표, 범위, 제약, 완료 기준을 포함한다.

### 4.9 Run

Task를 한 번 시도한 실행 인스턴스다.

Task 하나는 여러 run을 가질 수 있다.

```text
Task 001
  ├─ Run 001: 실패. 산출물 형식 부족.
  ├─ Run 002: 개선. 리뷰 통과 실패.
  └─ Run 003: 성공. done 처리.
```

### 4.10 Work Order

Worker에게 주는 구체적인 작업 명령이다.

Work order는 반드시 다음을 포함한다.

- objective
- scope
- allowed files
- denied files
- allowed tools
- output contract
- acceptance criteria
- budget

### 4.11 Promotion

Run에서 나온 학습을 시스템 artifact로 승격하는 행위다.

예:

- 반복 규칙 → `AGENTS.md`
- 반복 작업법 → `skills/`
- 반복 순서 → `workflows/`
- 평가 기준 → `evals/`
- 검증된 사실/선호 → `memory/`
- 도구 위험/권한 → `policies/`

---

## 5. Product Principles

### 5.1 Run 중심 설계

중심 객체는 Agent가 아니라 Run이다.

나쁜 설계:

```text
Manager Agent 만들기
Worker Agent 만들기
Reviewer Agent 만들기
서로 대화시키기
```

좋은 설계:

```text
Task
  → Run
  → Work Orders
  → Worker Runs
  → Artifacts
  → Review
  → Promotion / Done / Retry
```

이유:

- 에이전트 역할은 교체 가능해야 한다.
- 실제로 관리해야 하는 것은 “누가 일했는가”보다 “무슨 task를 어떤 run으로 시도했고 어떤 결과가 남았는가”다.
- 실행 이력이 있어야 개선이 가능하다.

### 5.2 LLM proposes, server disposes

LLM은 제안한다. 서버는 결정한다.

예:

```text
Manager:
  "이 작업은 워커 3개가 필요합니다."

Orchestrator:
  "현재 policy상 최대 worker는 1개입니다. worker 1개만 생성합니다."
```

```text
Worker:
  "파일을 수정하겠습니다."

Orchestrator:
  "해당 파일은 approval_required입니다. 승인 대기 상태로 전환합니다."
```

```text
Reviewer:
  "통과입니다."

Orchestrator:
  "rubric score가 8 미만이므로 changes_requested로 전환합니다."
```

이유:

- LLM에게 상태 전이를 맡기면 예측 가능성이 떨어진다.
- 오케스트레이션은 상태 머신과 policy의 영역이다.
- LLM은 판단 보조로 강하고, deterministic control에는 약하다.

### 5.3 Files as source of truth

SQLite는 빠른 조회와 UI 상태용이다. 중요한 artifact는 파일로 남긴다.

이유:

- 서비스가 망가져도 기록이 남는다.
- git으로 추적할 수 있다.
- 사용자가 직접 읽고 수정할 수 있다.
- 에이전트가 다시 읽어 재사용할 수 있다.

### 5.4 Start single-worker

처음부터 멀티워커로 가지 않는다.

단계:

```text
v0: Single Run + Review
v1: Manager + Worker + Reviewer
v2: Bounded Multi-Worker, 최대 3개
v3: Dynamic Worker Spawn
```

이유:

- 다중 워커는 task 분해, 권한, 충돌, 리뷰, artifact 병합 문제가 복잡하다.
- v0에서 task/run/review 상태 관리가 먼저 안정되어야 한다.

### 5.5 Promotion-driven learning

실패와 성공은 반드시 시스템 artifact 개선으로 이어져야 한다.

```text
실패
  → review
  → 원인 분류
  → AGENTS.md / skill / workflow / eval / policy / memory 중 어디를 고칠지 제안
  → 승인 후 promotion
```

이유:

- 프롬프트를 매번 새로 고치면 학습이 축적되지 않는다.
- promotion이 있어야 시스템이 시간이 지날수록 사용자에게 맞춰진다.

### 5.6 Safety before autonomy

자동화보다 권한 제어가 먼저다.

초기 정책:

- 파일 읽기 허용
- 파일 쓰기 승인 필요
- 삭제 금지 또는 강한 승인 필요
- shell mutating command 승인 필요
- package install 승인 필요
- git commit/push 승인 필요
- secret 접근 금지
- network/MCP 위험도 표시

---

## 6. Target User

### 6.1 Primary User

사용자 본인.

특징:

- 이미 `omx + skills + MCP`를 사용한다.
- Codex/OMX 같은 강력한 executor를 선호한다.
- 터미널 기반 작업에 익숙하다.
- 하지만 작업 이력, 리뷰, 스킬/워크플로우 정리, 프로젝트 관리가 흐지부지된다.
- 로컬 웹서비스 형태의 agent orchestration을 만들고 싶다.
- 운영진/커뮤니티용 겉치레보다 자기 실제 작업에 맞는 시스템을 원한다.

### 6.2 Secondary User

미래에 비슷한 로컬 에이전트 하네스를 만들고 싶은 개발자.

단, v0에서는 multi-user나 collaboration은 비목표다.

---

## 7. Core Use Cases

### 7.1 Project 등록

사용자가 로컬 프로젝트를 등록한다.

```bash
cd ~/Documents/github/some-project
agent init
agent web
```

시스템은 다음을 생성한다.

```text
some-project/
  AGENTS.md
  .agent/
    project.yaml
    tasks/
    runs/
    skills/
    workflows/
    evals/
    memory/
    policies/
```

### 7.2 Task 생성

사용자가 웹 UI 또는 CLI에서 task를 만든다.

예:

```text
기존 old_prompts.md를 읽고 instruction, skill candidate, workflow candidate, tool description, memory, eval criterion, raw idea로 분류하라.
```

Task는 다음 정보로 저장된다.

- goal
- context
- constraints
- done means
- priority
- status

### 7.3 Run 시작

사용자가 task detail 화면에서 Run 버튼을 누른다.

v0:

- Orchestrator가 run folder 생성
- task.md 복사
- context.md 작성
- OMX/Codex executor 실행
- 실행 결과와 diff 수집
- reviewer 실행 또는 사용자가 review 요청

v1:

- Manager가 plan 생성
- Orchestrator가 work order 생성
- Worker가 executor를 통해 작업
- Reviewer가 평가
- Orchestrator가 상태 결정

### 7.4 Review

Reviewer는 rubric에 따라 run을 평가한다.

기본 rubric:

- Goal Fit
- Artifact Boundary
- Tool Discipline
- Reviewability
- Reusability

결과:

- score
- blocking issues
- required changes
- recommended decision

### 7.5 Task 종료 처리

Orchestrator는 review 결과와 policy를 기반으로 task 상태를 바꾼다.

예:

```text
score >= 8, blocking issue 없음, approval 없음
  → Task done / Run completed

score >= 8, approval 필요
  → Task review 유지 / Run awaiting_approval

score < 8
  → Task changes_requested / Run completed

위험 행동 또는 승인 필요 행동 발생
  → Task review 유지 / Run awaiting_approval

작업 범위 불명확
  → Task blocked 또는 changes_requested / Run completed 또는 failed
```

### 7.6 Promotion

Run에서 나온 학습을 시스템 artifact로 승격한다.

예:

```text
review.md:
  "instruction과 workflow 판별 기준이 부족함"

promotion candidate:
  target: .agent/skills/classify-agent-artifacts/SKILL.md
  patch: classification rules 추가
```

사용자가 승인하면 patch 적용.

---

## 8. Final Architecture

### 8.1 High-Level Architecture

```text
┌───────────────────────────────────────────┐
│ Local Web UI                              │
│ - project dashboard                       │
│ - task board                              │
│ - run detail                              │
│ - worker status                           │
│ - approval queue                          │
│ - diff / review viewer                    │
│ - promotion panel                         │
└─────────────────────┬─────────────────────┘
                      │ HTTP / WebSocket
┌─────────────────────▼─────────────────────┐
│ Orchestrator Server                        │
│ - project registry                         │
│ - task state machine                       │
│ - run state machine                        │
│ - worker scheduler                         │
│ - approval broker                          │
│ - policy engine                            │
│ - artifact index                           │
│ - promotion engine                         │
└─────────────────────┬─────────────────────┘
                      │
┌─────────────────────▼─────────────────────┐
│ Agent Runtime                              │
│ - manager agent                            │
│ - worker agent                             │
│ - reviewer agent                           │
│ - role contracts                           │
│ - prompt/context builder                   │
│ - skill/workflow selector                  │
└─────────────────────┬─────────────────────┘
                      │
┌─────────────────────▼─────────────────────┐
│ Executor Adapters                          │
│ - OMX adapter                              │
│ - Codex adapter                            │
│ - future: Agents SDK adapter               │
└─────────────────────┬─────────────────────┘
                      │
┌─────────────────────▼─────────────────────┐
│ Tools / Workspaces                         │
│ - git worktree                             │
│ - filesystem                               │
│ - shell                                    │
│ - MCP servers                              │
│ - browser / external tools                 │
└─────────────────────┬─────────────────────┘
                      │
┌─────────────────────▼─────────────────────┐
│ Durable Artifact Store                     │
│ project/.agent/                            │
│ ~/.dominic_orchestration/                  │
└───────────────────────────────────────────┘
```

### 8.2 설계 이유

#### Local Web UI를 두는 이유

터미널 세션만으로는 task 상태, run history, diff, review, approval queue를 관리하기 어렵다. 웹 UI는 다음을 시각화한다.

- 현재 어떤 task가 진행 중인지
- 어떤 run이 실패했는지
- 어떤 review가 changes_requested를 냈는지
- 어떤 approval이 대기 중인지
- 어떤 promotion 후보가 있는지

#### Orchestrator Server를 두는 이유

오케스트레이션은 LLM에게 맡기면 안 된다. 상태 머신, 권한, timeout, retry, worker lifecycle은 deterministic server가 관리해야 한다.

#### Agent Runtime을 분리하는 이유

Manager/Worker/Reviewer는 역할별 LLM agent다. 이들은 서로 다른 prompt, context, output contract를 가져야 한다. Runtime은 이 역할 실행을 관리한다.

#### Executor Adapter를 두는 이유

처음부터 OMX/Codex를 대체하지 않는다. 이미 강력한 executor를 adapter로 감싼다. 나중에 필요하면 Agents SDK 또는 custom runtime을 추가한다.

#### `.agent/`를 두는 이유

모든 중요한 결과는 파일로 남아야 한다. 그래야 git 추적, 재현, 수동 수정, 에이전트 재사용이 가능하다.

---

## 9. Component Requirements

### 9.1 Local Web UI

#### 필수 화면

1. **Project Dashboard**
   - 등록된 프로젝트 목록
   - 최근 run
   - open tasks
   - blocked tasks
   - pending approvals

2. **Project Detail**
   - task board
   - run history
   - skills/workflows/evals/memory/policies 목록
   - project settings

3. **Task Detail**
   - goal
   - context
   - constraints
   - done means
   - status transition history
   - runs list

4. **Run Detail**
   - manager plan
   - work orders
   - worker outputs
   - transcript/logs
   - diff.patch
   - result.md
   - review.md
   - next-actions.md

5. **Approval Queue**
   - 파일 수정 승인
   - shell command 승인
   - package install 승인
   - git commit/push 승인
   - memory promotion 승인

6. **Promotion Panel**
   - skill 후보
   - workflow 후보
   - eval 후보
   - memory 후보
   - policy 후보
   - patch preview

#### UI 원칙

- 모든 자동 행동은 추적 가능해야 한다.
- 모든 승인 필요 행동은 한 화면에서 볼 수 있어야 한다.
- task/run/review는 링크 가능한 영속 객체여야 한다.
- 사용자는 언제든 파일 경로를 열어 직접 수정할 수 있어야 한다.

### 9.2 Orchestrator Server

#### 책임

- 프로젝트 등록/삭제/스캔
- task CRUD
- run lifecycle 관리
- worker lifecycle 관리
- approval lifecycle 관리
- policy enforcement
- artifact indexing
- executor adapter 호출
- review 결과 해석
- promotion candidate 생성

#### 비책임

- LLM reasoning 직접 수행
- 파일 내용을 무단 변경
- policy bypass
- worker에게 무제한 권한 부여

### 9.3 Agent Runtime

#### 책임

- role prompt 로딩
- task context bundle 생성
- AGENTS.md / project.yaml / task.md / skill manifest 조합
- manager plan 생성 요청
- worker work order 실행 요청
- reviewer rubric 평가 요청

### 9.4 Executor Adapters

#### OMX Adapter

초기 기본 executor.

책임:

- run workspace 준비
- OMX command 생성
- stdout/stderr/log 저장
- git diff 수집
- exit code 수집
- result summary 저장

초기 버전에서는 완전 자동 TUI 제어보다 **반자동 handoff protocol**을 우선한다. Orchestrator는 run의 시작점과 종료점을 파일로 고정하고, 사용자는 OMX/Codex에서 실제 작업을 수행한다.

```text
agent run create <task-id>
  → run folder 생성
  → run.yaml/task.md/context.md/prompt.md 생성
  → baseline-status.txt 저장
  → baseline-diff.patch 저장
  → 사용자가 실행할 omx/codex command 출력

사용자가 OMX/Codex 세션에서 작업

agent run collect <run-id>
  → collect-status.txt 저장
  → collect-diff.patch 저장
  → diff.patch 생성 또는 갱신
  → result.md 생성/입력
  → review.md 생성
  → next-actions.md 생성
  → run/task status 업데이트
```

반자동 v0에서 중요한 것은 executor 완전 제어가 아니라 **baseline과 collect 시점의 차이를 재현 가능하게 남기는 것**이다. 그래야 기존 dirty diff와 run 결과가 섞이지 않는다.

#### Codex Adapter

OMX를 거치지 않고 Codex CLI를 직접 실행하는 adapter.

#### Future Agents SDK Adapter

나중에 자체 tool execution, approval, tracing이 필요할 때 추가.

### 9.5 Policy Engine

정책 파일을 읽어 각 작업의 허용 여부를 판단한다.

예:

- 파일 읽기 허용
- 파일 쓰기 승인 필요
- 삭제 금지
- shell readonly 허용
- shell mutating 승인 필요
- package install 승인 필요
- network 승인 필요
- secret path 접근 금지

### 9.6 Artifact Store

`.agent/runs/<run_id>/` 아래에 모든 run artifact를 저장한다.

Artifact 요구사항은 버전별로 나눈다. v0에서 v1/v2 artifact를 억지로 만들지 않는다.

**v0 required artifacts:**

- `run.yaml`
- `task.md`
- `context.md`
- `prompt.md`
- `baseline-status.txt`
- `baseline-diff.patch`
- `collect-status.txt`
- `collect-diff.patch`
- `diff.patch`
- `result.md`
- `review.md`
- `next-actions.md`

**v1 required additions:**

- `manager-plan.md`
- `work-orders/*.yaml`
- `worker-outputs/*.md`
- `transcript.jsonl` 또는 `transcript.md`
- `tool-calls.jsonl`

**v2 required additions:**

- `synthesis.md`
- `conflict-report.md`
- `promotions/*.patch` 또는 `promotions/*.md`

---

## 10. Project Folder Structure

### 10.1 Per-Project Structure

```text
some-project/
  AGENTS.md

  .agent/
    project.yaml

    tasks/
      inbox/
      scoped/
      ready/
      running/
      review/
      done/
      blocked/
      abandoned/

    runs/
      2026-05-31-001/
        run.yaml
        task.md
        context.md
        manager-plan.md
        work-orders/
          worker-001.yaml
        worker-outputs/
          worker-001.md
        transcript.md
        tool-calls.jsonl
        diff.patch
        result.md
        review.md
        next-actions.md
        promotions/
          skill-classification-rules.patch

    skills/
      classify-agent-artifacts/
        SKILL.md
      review-agent-run/
        SKILL.md
      create-skill-from-run/
        SKILL.md

    workflows/
      mcp-review.md
      skill-review.md

    evals/
      rubric.md
      cases.yaml

    memory/
      decisions.md
      project-facts.md
      user-preferences.md

    policies/
      tool-policy.yaml
      approval-policy.yaml
```

### 10.2 Global Structure

```text
~/.dominic_orchestration/
  config.toml
  registry.sqlite

  profiles/
    default.md
    coding.md
    agent-builder.md
    research.md
    community-ops.md

  skills/
    global/
      classify-agent-artifacts/
        SKILL.md
      review-agent-run/
        SKILL.md
      create-skill-from-run/
        SKILL.md

  executors/
    omx.yaml
    codex.yaml
    agents-sdk.yaml

  mcp/
    servers.json

  logs/
    server.log
```

### 10.3 `AGENTS.md`와 `.agent/`의 구분

`AGENTS.md`:

- 프로젝트에서 실행되는 코딩 에이전트가 읽는 지침
- 프로젝트 개요
- 명령어
- 코딩 규칙
- 테스트 방법
- 금지사항

`.agent/`:

- Orchestrator가 관리하는 내부 운영 상태
- task/run/review/skills/workflows/evals/memory/policies 저장

원칙:

> `AGENTS.md`는 에이전트에게 보여줄 작업 지침이고, `.agent/`는 Orchestrator가 관리하는 운영 기록이다.

### 10.4 File Metadata and Versioning

SQLite는 index이고, 파일이 복구 가능한 source of truth다. 따라서 `.agent/`의 주요 markdown/yaml 파일은 schema version과 id를 가진다.

```yaml
schema_version: 1
id: task-20260531-001
status: ready
created_at: "2026-05-31T00:00:00+09:00"
updated_at: "2026-05-31T00:00:00+09:00"
```

규칙:

- `id`는 canonical object identity다.
- `path`는 현재 저장 위치이며 이동될 수 있다.
- DB index가 깨지면 `.agent/` 파일 frontmatter를 스캔해 재색인한다.
- 파일의 `schema_version`이 현재 runtime보다 높으면 읽기 전용으로 표시한다.
- task/run/status 변경은 파일과 DB를 함께 갱신하고, 실패 시 파일을 우선 복구 기준으로 삼는다.

---

## 11. Data Model

### 11.1 Project

```ts
type Project = {
  id: string
  name: string
  rootPath: string
  agentDir: string
  defaultProfile: string
  defaultExecutor: "omx" | "codex" | "agents-sdk"
  createdAt: string
  updatedAt: string
  lastOpenedAt?: string
}
```

### 11.2 Task

```ts
type Task = {
  id: string
  projectId: string
  title: string
  status:
    | "inbox"
    | "scoped"
    | "ready"
    | "running"
    | "review"
    | "changes_requested"
    | "done"
    | "blocked"
    | "cancelled"
    | "abandoned"
  goal: string
  context: string[]
  constraints: string[]
  doneMeans: string[]
  priority: "low" | "normal" | "high"
  createdAt: string
  updatedAt: string
}
```

### 11.3 Run

```ts
type Run = {
  id: string
  taskId: string
  projectId: string
  status:
    | "created"
    | "planning"
    | "dispatching"
    | "workers_running"
    | "collecting"
    | "reviewing"
    | "awaiting_approval"
    | "applying"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
  executor: "omx" | "codex" | "agents-sdk"
  profile: string
  runDir: string
  workspacePath?: string
  branchName?: string
  score?: number
  startedAt?: string
  endedAt?: string
}
```

### 11.4 WorkOrder

```ts
type WorkOrder = {
  id: string
  runId: string
  role: "worker" | "reviewer" | "manager"
  objective: string
  scope: {
    allowedFiles: string[]
    deniedFiles: string[]
    allowedDirectories: string[]
  }
  allowedTools: string[]
  budget: {
    maxMinutes: number
    maxToolCalls: number
    maxTokens?: number
  }
  outputContract: {
    requiredSections: string[]
    requiredArtifacts: string[]
  }
  acceptanceCriteria: string[]
  status:
    | "queued"
    | "running"
    | "submitted"
    | "accepted"
    | "rejected"
    | "failed"
    | "timed_out"
    | "cancelled"
}
```

### 11.5 WorkerRun

```ts
type WorkerRun = {
  id: string
  workOrderId: string
  runId: string
  executor: "omx" | "codex" | "agents-sdk"
  workspacePath: string
  status: "running" | "submitted" | "failed" | "cancelled" | "timed_out"
  artifacts: string[]
  createdAt: string
  completedAt?: string
}
```

### 11.6 Review

```ts
type Review = {
  id: string
  runId: string
  reviewerRole: "agent" | "human" | "hybrid"
  score: number
  decision: "pass" | "changes_requested" | "blocked" | "fail"
  blockingIssues: string[]
  requiredChanges: string[]
  risks: string[]
  rubricBreakdown: Record<string, number>
  reviewPath: string
  createdAt: string
}
```

### 11.7 Artifact

```ts
type Artifact = {
  id: string
  runId: string
  type:
    | "task"
    | "context"
    | "manager_plan"
    | "work_order"
    | "worker_output"
    | "transcript"
    | "tool_calls"
    | "diff"
    | "result"
    | "review"
    | "next_actions"
    | "promotion"
  path: string
  createdAt: string
}
```

### 11.8 Promotion

```ts
type Promotion = {
  id: string
  runId: string
  targetType: "agent_instruction" | "skill" | "workflow" | "eval" | "memory" | "policy"
  targetPath: string
  proposalPath: string
  status: "proposed" | "approved" | "applied" | "rejected"
  createdAt: string
  appliedAt?: string
}
```

---

## 12. State Machines

### 12.1 Task State Machine

```text
inbox
  → scoped
  → ready
  → running
  → review
  → done

review
  → changes_requested
  → running

any
  → blocked
  → ready

any
  → cancelled

inbox/scoped/ready
  → abandoned
```

#### 상태 설명

- `inbox`: 아이디어만 있음
- `scoped`: goal/context/constraints/done means가 정의됨
- `ready`: 실행 가능
- `running`: run 진행 중
- `review`: 결과 검토 중
- `changes_requested`: 수정 필요
- `done`: 완료
- `blocked`: 외부 조건 또는 정보 부족
- `cancelled`: 사용자가 취소
- `abandoned`: 더 이상 진행하지 않음

### 12.2 Run State Machine

```text
created
  → planning
  → dispatching
  → workers_running
  → collecting
  → reviewing
  → awaiting_approval
  → applying
  → completed

reviewing
  → completed

any
  → failed
  → cancelled
  → timed_out
```

#### 전이 규칙

- `planning`: manager plan 생성 중
- `dispatching`: work order 생성/배포 중
- `workers_running`: worker 실행 중
- `collecting`: output/diff/log 수집 중
- `reviewing`: reviewer 평가 중
- `awaiting_approval`: 승인 대기
- `applying`: 승인된 patch 적용 중
- `completed`: 종료

### 12.3 Worker State Machine

```text
queued
  → running
  → submitted
  → accepted

submitted
  → rejected
  → running

any
  → failed
  → timed_out
  → cancelled
```

### 12.4 Approval State Machine

```text
requested
  → approved
  → applied

requested
  → rejected

requested
  → expired

approved
  → failed_to_apply
```

### 12.5 State Ownership Rule

상태 책임은 다음처럼 분리한다.

- **Task 상태**는 사용자가 보는 작업의 큰 상태다: `ready`, `running`, `review`, `changes_requested`, `done`, `blocked`.
- **Run 상태**는 특정 실행 시도의 lifecycle이다: `created`, `reviewing`, `awaiting_approval`, `completed`, `failed`.
- **Approval 상태**는 위험 행동 또는 patch 적용의 승인 lifecycle이다.

원칙:

- `awaiting_approval`은 Run/Approval 상태이지 Task 상태가 아니다.
- Run이 approval을 기다리는 동안 Task는 보통 `review`에 머문다.
- 승인 적용 후 Run이 `completed`가 되면 Orchestrator가 Task를 `done` 또는 `changes_requested`로 전이한다.
- LLM reviewer의 decision은 recommendation이고, 최종 상태 전이는 Orchestrator가 policy와 state machine으로 결정한다.

---

## 13. Execution Flows

### 13.1 v0 Flow: CLI-first Single Run + Review

v0 목표는 멀티에이전트가 아니다. task/run/review를 안정화하는 것이다. v0는 CLI-first이고, Web은 처음에는 read-only viewer여도 된다.

```text
agent init
  ↓
agent task add "..."
  ↓
agent run create <task-id>
  ↓
Orchestrator creates run folder and prompt.md
  ↓
Orchestrator captures baseline git status/diff
  ↓
User runs the printed OMX/Codex command
  ↓
agent run collect <run-id>
  ↓
Orchestrator captures collect git status/diff
  ↓
Orchestrator writes result.md/review.md/next-actions.md
  ↓
Orchestrator updates run/task status
  ↓
Web viewer shows task/run/diff/review
```

v0에서 manager/worker/reviewer가 모두 LLM role로 완전히 분리되지 않아도 된다. 다만 artifact 구조는 v1/v2로 확장 가능해야 한다. Promotion은 v0에서 “제안 파일 생성”까지만 하며, 자동 적용은 제외한다.

### 13.2 v1 Flow: Manager + Worker + Reviewer

```text
Task ready
  ↓
Manager Agent creates manager-plan.md
  ↓
Orchestrator validates plan against policy
  ↓
Orchestrator creates one WorkOrder
  ↓
Worker Agent executes via OMX/Codex
  ↓
Orchestrator collects worker output and diff
  ↓
Reviewer Agent evaluates via rubric
  ↓
Orchestrator decides task status
  ↓
Promotion Engine proposes system patches
```

v1에서는 worker를 하나만 둔다.

### 13.3 v2 Flow: Bounded Multi-Worker

```text
Task ready
  ↓
Manager proposes multiple work orders
  ↓
Orchestrator limits workers by policy, max 3
  ↓
Each worker gets isolated scope/worktree
  ↓
Workers execute independently
  ↓
Orchestrator collects outputs
  ↓
Manager synthesizes results
  ↓
Reviewer evaluates synthesized result
  ↓
Orchestrator decides status
```

Multi-worker 조건:

- 각 worker의 파일 범위가 분리되어야 한다.
- output contract가 명확해야 한다.
- budget이 있어야 한다.
- 충돌 발생 시 Orchestrator가 merge하지 않고 review 상태로 둔다.

---

## 14. Role Contracts

### 14.1 Manager Contract

#### Input

- task.md
- project.yaml
- AGENTS.md
- relevant skills/workflows manifest
- policy summary
- previous run summaries

#### Responsibilities

- goal 재진술
- 작업 분해
- 필요한 context 목록화
- worker 필요 여부 판단
- work order 초안 작성
- 위험/불확실성 표시

#### Output: `manager-plan.md`

```md
# Manager Plan

## Restated Goal

## Context Needed

## Proposed Strategy

## Work Orders

## Risks

## Acceptance Criteria

## Recommendation
```

#### 금지

- 직접 파일 수정
- 승인 없이 도구 실행
- task status 직접 변경

### 14.2 Worker Contract

#### Input

- work_order.yaml
- task.md
- allowed context bundle
- relevant skill/workflow
- policy summary

#### Responsibilities

- 제한된 scope에서 작업
- output contract 준수
- 변경 파일과 diff 명확히 기록
- 테스트 실행 또는 실행 불가 사유 작성
- 위험/후속작업 보고

#### Output: `worker-outputs/<worker-id>.md`

```md
# Worker Output

## Objective

## Summary

## Actions Taken

## Files Read

## Files Changed

## Diff Summary

## Tests Run

## Risks

## Follow-ups

## Completion Against Acceptance Criteria
```

### 14.3 Reviewer Contract

#### Input

- task.md
- manager-plan.md
- work orders
- worker outputs
- diff.patch
- result.md
- rubric.md

#### Responsibilities

- 목표 적합성 평가
- 산출물 검토 가능성 평가
- tool discipline 평가
- 재사용 가능성 평가
- blocking issue 탐지
- decision 추천

#### Output: `review.md`

```md
# Review

## Score

0-10

## Rubric Breakdown

- Goal Fit: 0-2
- Artifact Boundary: 0-2
- Tool Discipline: 0-2
- Reviewability: 0-2
- Reusability: 0-2

## Blocking Issues

## Required Changes

## Risks

## Decision

pass | changes_requested | blocked | fail

## System Patch Suggestions
```

---

## 15. Work Order Specification

### 15.1 Example

```yaml
id: worker-001
role: artifact-classification-worker
objective: "old_prompts.md를 instruction, skill candidate, workflow candidate, tool description, memory, eval criterion, raw idea로 분류한다."

scope:
  allowed_files:
    - "inbox/old_prompts.md"
    - ".agent/skills/classify-agent-artifacts/SKILL.md"
    - ".agent/evals/rubric.md"
  denied_files:
    - ".env"
    - ".git/"
    - "~/.ssh"
  allowed_directories:
    - "inbox/"
    - ".agent/runs/${RUN_ID}/"

tools:
  - "filesystem.read"
  - "filesystem.write_with_approval"
  - "git.diff"

budget:
  max_minutes: 15
  max_tool_calls: 30
  max_tokens: 20000

output_contract:
  required_sections:
    - "Summary"
    - "Classification Table"
    - "Move Proposal"
    - "Ambiguous Items"
    - "Risks"
    - "Follow-ups"
  required_artifacts:
    - "worker-outputs/worker-001.md"

acceptance_criteria:
  - "모든 주요 블록이 하나 이상의 artifact type으로 분류되어야 한다."
  - "직접 파일 수정 대신 이동 제안 중심이어야 한다."
  - "애매한 항목은 ambiguous로 분리해야 한다."
```

### 15.2 Work Order 설계 이유

Multi-worker가 실패하는 이유는 대부분 work order가 흐리기 때문이다. Work order는 worker를 작은 계약 단위로 묶는다.

좋은 work order:

- 목표가 작다.
- 파일 범위가 제한되어 있다.
- 도구 권한이 제한되어 있다.
- 산출물 형식이 고정되어 있다.
- acceptance criteria가 있다.

나쁜 work order:

```text
"이 프로젝트 정리해줘"
```

좋은 work order:

```text
"inbox/old_prompts.md만 읽고, 각 블록을 artifact type으로 분류하고, 파일 수정 없이 이동 제안만 작성하라."
```

---

## 16. Review Rubric

초기 기본 rubric은 10점 만점이다.

```md
# Agent Run Review Rubric

각 항목 0~2점.

## 1. Goal Fit

0: 사용자의 목표와 다른 일을 했다.  
1: 일부 맞지만 핵심 결과가 부족하다.  
2: 목표에 맞는 결과를 냈다.

## 2. Artifact Boundary

0: 지침/스킬/워크플로우/도구/메모리/eval을 섞었다.  
1: 대체로 구분했지만 애매한 부분이 있다.  
2: 각 내용을 적절한 위치에 분리했다.

## 3. Tool Discipline

0: 불필요하거나 위험한 도구를 썼다.  
1: 도구 사용은 맞지만 설명이 부족했다.  
2: 필요한 도구만 쓰고 이유를 남겼다.

## 4. Reviewability

0: 결과를 검토하기 어렵다.  
1: 설명은 있으나 diff/근거/기준이 부족하다.  
2: 변경 이유, 근거, 위험, 다음 액션이 명확하다.

## 5. Reusability

0: 다음 실행에 남는 학습이 없다.  
1: 일부 재사용 가능하다.  
2: skill/workflow/eval/memory/policy 중 하나로 반영 가능하다.
```

### Decision Rule

```text
score >= 8 and no blocking issue
  → pass

score < 8 and fixable
  → changes_requested

critical info missing or approval needed
  → blocked

unsafe behavior or wrong objective
  → fail
```

---

## 17. Promotion Engine

### 17.1 Promotion Types

```text
agent_instruction
  → AGENTS.md 또는 profile instruction

skill
  → .agent/skills/<skill-name>/SKILL.md

workflow
  → .agent/workflows/<workflow-name>.md

eval
  → .agent/evals/rubric.md 또는 cases.yaml

memory
  → .agent/memory/*.md

policy
  → .agent/policies/*.yaml
```

### 17.2 Promotion Rules

- 검증되지 않은 사실은 memory로 승격하지 않는다.
- 한 번만 발생한 절차는 workflow로 승격하지 않는다.
- 3번 이상 반복된 순서가 있으면 workflow 후보로 본다.
- 2번 이상 반복된 작업법은 skill 후보로 본다.
- 항상 지켜야 할 규칙은 instruction 후보로 본다.
- 성공/실패 판단에 쓰이는 기준은 eval 후보로 본다.

### 17.3 Promotion Flow

```text
review.md 생성
  ↓
System Patch Suggestions 추출
  ↓
Promotion Candidate 생성
  ↓
사용자 확인
  ↓
patch 적용 또는 reject
  ↓
promotion status 업데이트
```

---

## 18. Policy and Security

### 18.1 Tool Policy Example

```yaml
# .agent/policies/tool-policy.yaml

defaults:
  max_workers: 1
  require_approval_for_writes: true
  require_approval_for_network: true
  require_approval_for_shell_mutation: true

tools:
  filesystem.read:
    default: allow
    risk: low

  filesystem.write:
    default: require_approval
    risk: medium
    allowed_paths:
      - "."
    denied_paths:
      - ".env"
      - ".git/"
      - "~/.ssh"
      - "~/.config"

  filesystem.delete:
    default: deny
    risk: high

  git.status:
    default: allow
    risk: low

  git.diff:
    default: allow
    risk: low

  git.commit:
    default: require_approval
    risk: medium

  git.push:
    default: require_approval
    risk: high

  shell.readonly:
    default: allow
    risk: low
    commands:
      - "ls"
      - "cat"
      - "grep"
      - "rg"
      - "pwd"
      - "git status"
      - "git diff"

  shell.mutating:
    default: require_approval
    risk: high
    commands:
      - "npm install"
      - "pnpm add"
      - "rm"
      - "mv"
      - "chmod"
      - "git commit"
      - "git push"

  network:
    default: require_approval
    risk: medium

  mcp:
    default: require_approval
    risk: variable
```

### 18.2 Approval Policy Example

```yaml
# .agent/policies/approval-policy.yaml

approvals:
  file_write:
    required: true
    auto_approve_paths:
      - ".agent/runs/"
    require_manual_paths:
      - "src/"
      - "docs/"

  memory_write:
    required: true

  skill_update:
    required: true

  workflow_update:
    required: true

  eval_update:
    required: true

  package_install:
    required: true

  shell_mutation:
    required: true

  git_commit:
    required: true

  git_push:
    required: true
```

### 18.3 v0 Security Baseline

v0는 로컬 개인용 서비스지만, 기본 보안선은 명시한다.

- Web/server bind 기본값은 `127.0.0.1`이다. 외부 interface bind는 명시 설정이 있을 때만 허용한다.
- 모든 path는 접근 전 `realpath`/canonical path로 normalize한다.
- project root 밖 파일 접근은 기본 deny다.
- symlink가 project root 밖을 가리키면 deny한다.
- secret deny glob을 기본 제공한다: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `secrets.*`, `.ssh/**`, `.config/**`.
- shell command는 문자열 allowlist가 아니라 command + argv 단위로 분해해 판단한다.
- stdout/stderr/log 저장 전에 secret-looking token redaction을 적용한다.
- destructive command는 v0에서 실행하지 않고 approval request artifact만 생성한다.

### 18.4 Security Principles

- worker별 allowed tools를 명시한다.
- worker별 allowed paths를 명시한다.
- secret path는 denylist로 막는다.
- shell command는 allowlist 기반으로 시작한다.
- destructive operation은 기본 deny다.
- MCP server는 risk level을 부여한다.
- network 접근은 승인 필요로 시작한다.
- 모든 approval은 artifact로 기록한다.

---

## 19. Executor Strategy

### 19.1 OMX First

v0/v1에서는 OMX를 기본 executor로 사용한다.

이유:

- 이미 사용자가 익숙하다.
- Codex wrapper로서 강력하다.
- terminal-first 작업 흐름과 잘 맞는다.
- 초기 목표는 executor 대체가 아니라 orchestration이다.

### 19.2 Codex Direct

OMX를 거치지 않고 Codex CLI를 직접 제어하는 adapter를 추가한다.

목적:

- 단순 작업에서 의존성 줄이기
- OMX 기능이 필요 없는 run 처리
- 자동화 가능성 확대

### 19.3 Future Agents SDK

추후 자체 tool execution, approval, tracing, MCP client를 완전히 관리하고 싶을 때 추가한다.

v3 이후 목표다.

### 19.4 Worktree Isolation

가능하면 모든 run은 별도 git worktree에서 실행한다.

```text
main project
  ↓
agent run 생성
  ↓
git worktree add ../project-agent-001 -b agent/001-task-slug
  ↓
worker 실행
  ↓
diff 수집
  ↓
review 통과 후 merge/patch 제안
```

초기 정책:

- main working tree 직접 수정 금지 권장
- worktree 생성 실패 시 사용자에게 알림
- commit/push는 승인 필요

---

## 20. API Requirements

초기 API는 REST + WebSocket 조합으로 충분하다.

### 20.1 Project API

```http
GET /api/projects
POST /api/projects
GET /api/projects/:projectId
PATCH /api/projects/:projectId
DELETE /api/projects/:projectId
```

### 20.2 Task API

```http
GET /api/projects/:projectId/tasks
POST /api/projects/:projectId/tasks
GET /api/tasks/:taskId
PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/scope
POST /api/tasks/:taskId/mark-ready
POST /api/tasks/:taskId/cancel
```

### 20.3 Run API

```http
GET /api/tasks/:taskId/runs
POST /api/tasks/:taskId/runs
GET /api/runs/:runId
POST /api/runs/:runId/start
POST /api/runs/:runId/cancel
POST /api/runs/:runId/review
GET /api/runs/:runId/artifacts
```

### 20.4 Work Order API

```http
GET /api/runs/:runId/work-orders
POST /api/runs/:runId/work-orders
GET /api/work-orders/:workOrderId
PATCH /api/work-orders/:workOrderId
POST /api/work-orders/:workOrderId/start
POST /api/work-orders/:workOrderId/cancel
```

### 20.5 Approval API

```http
GET /api/approvals
GET /api/approvals/:approvalId
POST /api/approvals/:approvalId/approve
POST /api/approvals/:approvalId/reject
```

### 20.6 Promotion API

```http
GET /api/runs/:runId/promotions
POST /api/promotions/:promotionId/approve
POST /api/promotions/:promotionId/reject
POST /api/promotions/:promotionId/apply
```

### 20.7 WebSocket Events

```text
run.created
run.status_changed
worker.started
worker.output
worker.completed
approval.requested
approval.resolved
review.completed
promotion.proposed
```

---

## 21. Storage Strategy

### 21.1 SQLite as Index

SQLite는 다음을 저장한다.

- project index
- task metadata
- run metadata
- worker status
- artifact path index
- approval status
- promotion status

### 21.2 Files as Artifacts

실제 내용은 파일로 저장한다.

- task.md
- manager-plan.md
- work_order.yaml
- worker output
- diff.patch
- review.md
- promotion patch

### 21.3 Minimal SQLite Schema

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  agent_dir TEXT NOT NULL,
  default_profile TEXT,
  default_executor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  task_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  executor TEXT NOT NULL,
  profile TEXT,
  run_dir TEXT NOT NULL,
  workspace_path TEXT,
  branch_name TEXT,
  score INTEGER,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  work_order_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  score INTEGER,
  decision TEXT NOT NULL,
  review_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  request_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_path TEXT NOT NULL,
  proposal_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
```

---

## 22. CLI Requirements

웹서비스가 중심이지만 CLI도 있어야 한다.

### 22.1 Commands

```bash
agent init
agent web
agent projects
agent task add "..."
agent task list
agent task show <id>
agent run <task-id>
agent run latest
agent review latest
agent promote latest
agent approvals
agent open <artifact>
```

### 22.2 CLI + Web 역할 분리

CLI:

- 빠른 생성/실행
- terminal workflow 유지
- automation scripting

Web UI:

- 상태 시각화
- diff/review 확인
- 승인 처리
- promotion 검토

---

## 23. MVP Scope

### 23.1 v0 MVP

목표:

> OMX/Codex를 계속 쓰되, 모든 작업이 task/run/review로 남게 만든다.

v0는 **CLI-first, Web-read-only viewer**로 시작한다.

필수 기능:

- `agent init`
- 프로젝트 등록 또는 현재 프로젝트 init
- `.agent/` template 생성
- `agent task add/list/show`
- `agent run create <task-id>`
- run folder 생성
- `prompt.md` 생성
- baseline `git status`/`git diff` 저장
- 사용자가 실행할 OMX/Codex command 출력
- `agent run collect <run-id>`
- collect `git status`/`git diff` 저장
- `diff.patch` 저장
- `result.md` 생성/입력
- `review.md` 생성
- `next-actions.md` 생성
- review score에 따른 task/run status 업데이트
- 기본 rubric 제공
- UI에서 task/run/review/diff 읽기

v0에서 제외:

- manager/worker 다중스폰
- 자동 skill promotion 적용
- approval patch apply UI
- dashboard 고도화
- 자체 Agents SDK runtime
- complex MCP integration
- 자동 commit/push
- 완전 자동 TUI 제어

### 23.2 v0 Acceptance Criteria

v0는 다음이 되면 성공이다.

1. 사용자가 프로젝트를 등록할 수 있다.
2. `.agent/` 구조가 생성된다.
3. task를 만들 수 있다.
4. task에서 run을 시작할 수 있다.
5. run마다 고유 폴더가 생긴다.
6. run 폴더에 최소한 다음 파일이 생긴다.
   - `run.yaml`
   - `task.md`
   - `context.md`
   - `prompt.md`
   - `baseline-status.txt`
   - `baseline-diff.patch`
   - `collect-status.txt`
   - `collect-diff.patch`
   - `diff.patch`
   - `result.md`
   - `review.md`
   - `next-actions.md`
7. review score에 따라 task 상태가 바뀐다.
8. UI에서 task/run/review/diff를 볼 수 있다.
9. 작업 실패 시 다음 action이 남는다.
10. 모든 기록은 파일로 남는다.
11. 기존 dirty diff와 run 결과 diff를 구분할 수 있다.

---

## 24. Roadmap

### v0: File-backed Local Run Manager

기간 목표: 가장 작게 동작하는 오케스트레이션 껍데기.

기능:

- project registry
- `.agent/` 생성
- task CRUD
- run CRUD
- OMX adapter
- diff/result/review artifact 저장
- basic UI
- basic rubric

### v1: Manager + Worker + Reviewer Runtime

목표: 역할 기반 agent runtime 도입.

기능:

- manager-plan.md 생성
- work_order.yaml 생성
- worker 1개 실행
- reviewer role 실행
- review decision 기반 상태 전이
- promotion candidate 생성

### v2: Bounded Multi-Worker

목표: 안전한 제한형 멀티워커.

기능:

- 최대 worker 수 설정
- worker별 scope/path/tool restriction
- parallel worker execution
- synthesis step
- conflict detection
- worktree isolation 강화

### v3: Custom Agent Runtime

목표: OMX/Codex 의존을 줄이고 직접 orchestration 소유.

기능:

- Agents SDK adapter
- MCP client integration
- custom filesystem/shell/git tools
- tool approval pause/resume
- tracing viewer
- richer policy engine

### v4: Personal Agent OS

목표: 장기 운영 가능한 개인용 agent OS.

기능:

- cross-project memory
- profile별 skill/workflow sharing
- project health dashboard
- recurring task automation
- local notification
- richer eval suite
- plugin/executor marketplace 가능성 검토

---

## 25. UI Detail

### 25.1 Project Dashboard

표시 항목:

- 프로젝트명
- path
- open task 수
- blocked task 수
- 최근 run score
- pending approval 수
- default executor

### 25.2 Task Board

컬럼:

- Inbox
- Scoped
- Ready
- Running
- Review
- Changes Requested
- Done
- Blocked

Task card:

- title
- priority
- last run score
- last status
- updated at

### 25.3 Run Detail

섹션:

- Overview
- Task
- Manager Plan
- Work Orders
- Worker Outputs
- Diff
- Review
- Approvals
- Promotions
- Logs

### 25.4 Approval Queue

Approval card:

- type
- risk
- requested by
- affected files/commands
- diff preview
- approve/reject buttons

### 25.5 Promotion Panel

Promotion card:

- target type
- target path
- reason
- patch preview
- apply/reject buttons

---

## 26. Implementation Notes

### 26.1 Suggested Tech Stack

옵션 A: TypeScript 중심

```text
Frontend: Next.js 또는 Vite + React
Backend: Node.js/Fastify 또는 Next API routes
DB: SQLite
Process: child_process/spawn
File IO: Node fs/promises
Diff: git CLI
```

옵션 B: Python 중심

```text
Frontend: Vite + React
Backend: FastAPI
DB: SQLite
Process: subprocess
File IO: pathlib
Diff: git CLI
```

결정:

> v0 구현은 TypeScript 중심으로 간다.

권장 stack:

```text
Package manager: pnpm
CLI: cac 또는 commander
Server: Fastify
Frontend: Vite + React
DB: SQLite
Process: Node child_process/spawn
File IO: Node fs/promises
Diff: git CLI
WebSocket: Fastify websocket 또는 ws
```

이유:

- 로컬 control plane이라 child process, file IO, websocket, long-running process 관리가 중요하다.
- Next.js API routes보다 Fastify + Vite가 server/runtime 경계를 명확히 한다.
- v0의 핵심은 framework가 아니라 artifact format과 run lifecycle 안정화다.

Python/FastAPI는 v3 이후 Agents SDK adapter나 Python 중심 runtime을 붙일 때 재검토한다.

### 26.2 Suggested Package Layout

```text
dominic_orchestration/
  README.md
  PRD.md
  apps/
    web/
    server/
  packages/
    core/
    executors/
    agent-runtime/
    policies/
    artifacts/
  templates/
    project/
      AGENTS.md
      project.yaml
      tool-policy.yaml
      approval-policy.yaml
      rubric.md
  examples/
    sample-project/
```

간단하게 시작하려면:

```text
dominic_orchestration/
  src/
    server/
    ui/
    core/
    executors/
  templates/
  PRD.md
```

---

## 27. Templates

### 27.1 `project.yaml`

```yaml
id: "project-slug"
name: "Project Name"
root_path: "/absolute/path/to/project"
agent_dir: ".agent"
default_profile: "agent-builder"
default_executor: "omx"

limits:
  max_workers: 1
  max_run_minutes: 30
  max_tool_calls_per_worker: 50

features:
  worktree_isolation: true
  auto_review: true
  auto_promotion_proposal: true
  auto_apply_promotion: false
```

### 27.2 `task.md`

```md
# Task: <title>

## Goal

## Context

## Constraints

## Done Means

## Preferred Executor

## Notes
```

### 27.3 `run.yaml`

```yaml
id: "2026-05-31-001"
task_id: "task-001"
status: "created"
executor: "omx"
profile: "agent-builder"
run_dir: ".agent/runs/2026-05-31-001"
workspace_path: null
branch_name: null
started_at: null
ended_at: null
score: null
```

### 27.4 `review.md`

```md
# Review

## Score

## Rubric Breakdown

## Blocking Issues

## Required Changes

## Risks

## Decision

## System Patch Suggestions
```

### 27.5 `next-actions.md`

```md
# Next Actions

## Immediate

## Suggested System Patches

## Promotion Candidates

## Blockers
```

---

## 28. Risks and Mitigations

### Risk 1: 처음부터 너무 복잡한 멀티에이전트로 시작

Mitigation:

- v0는 single run + review만 구현한다.
- v1에서 worker 1개만 허용한다.
- v2부터 max 3 bounded workers.

### Risk 2: LLM이 상태 전이를 자의적으로 결정

Mitigation:

- LLM decision은 recommendation으로만 저장한다.
- Orchestrator가 policy와 state machine으로 최종 결정한다.

### Risk 3: artifact가 DB에만 있고 파일로 남지 않음

Mitigation:

- 모든 핵심 산출물을 `.agent/runs/`에 파일로 저장한다.
- DB는 index로만 사용한다.

### Risk 4: 리뷰가 형식적으로 끝남

Mitigation:

- rubric 고정.
- score와 blocking issue 기반으로 상태 전이.
- review 없이는 done 처리 금지.

### Risk 5: MCP/shell 권한 위험

Mitigation:

- policy engine 먼저 구현.
- 파일쓰기/shell mutation/network/MCP는 승인 필요.
- denied paths 기본 제공.

### Risk 6: promotion이 너무 쉽게 memory/skill에 반영됨

Mitigation:

- promotion은 proposed → approved → applied 상태를 거친다.
- memory write는 항상 승인 필요.
- workflow 승격은 반복 근거 필요.

### Risk 7: OMX 자동화가 어렵다

Mitigation:

- v0는 반자동 모드를 허용한다.
- Orchestrator가 task/run artifact를 만들고, 사용자가 OMX를 조작한 뒤, 결과 수집만 자동화해도 충분하다.

---

## 29. Open Questions

1. v0 executor 기본값은 OMX adapter이며, Codex direct는 command template만 열어둔다.
2. Web UI는 Vite + React, server는 Fastify로 간다.
3. 서버 언어는 TypeScript로 간다.
4. v0 run transcript는 완전 수집하지 않는다. baseline/collect status와 diff, result/review를 우선한다.
5. OMX 세션은 v0에서 반자동으로 시작한다. 완전 자동 TUI 제어는 v1+ 후보로 둔다.
6. worktree isolation은 v0에서 강제하지 않는다. v0.1 optional, v2 multi-worker에서는 필수로 한다.
7. `.agent/` 폴더 중 templates/policies/rubric/tasks/runs는 프로젝트 설정에 따라 git 포함 가능하게 하되, logs/cache는 gitignore 기본값으로 둔다.
8. global skills와 project skills는 project override 우선으로 한다. 충돌 시 UI/CLI에 source를 표시한다.
9. review agent는 v0에서 Codex/OMX executor를 재사용하거나 deterministic rubric stub으로 시작한다.
10. approval UI 없이 CLI approval artifact 확인은 지원한다. 실제 patch apply UI는 v0 이후로 미룬다.

---

## 30. First Build Plan

### Day 1: Skeleton + CLI Init

- pnpm/TypeScript repository skeleton
- `agent` CLI entrypoint
- `.agent/` template 생성
- project.yaml/tool-policy/approval-policy/rubric template
- SQLite init 또는 file index stub

### Day 2: Task Files

- `agent task add/list/show`
- task markdown frontmatter schema
- task status update helper
- DB 재색인 또는 file index scan

### Day 3: Run Create

- `agent run create <task-id>`
- run folder 생성
- run.yaml/task.md/context.md/prompt.md 저장
- baseline-status.txt/baseline-diff.patch 저장
- OMX/Codex handoff command 출력

### Day 4: Run Collect

- `agent run collect <run-id>`
- collect-status.txt/collect-diff.patch 저장
- diff.patch 생성
- result.md 생성/입력 flow
- dirty diff와 run diff 구분 검증

### Day 5: Review v0

- rubric.md template
- review.md 생성
- score/decision 저장
- task/run status update
- next-actions.md 생성

### Day 6: Web Viewer v0

- Fastify server
- Vite + React viewer
- task list / run detail / diff / review read-only 화면
- WebSocket 또는 polling으로 status 표시

### Day 7: Dogfood

- Dominic Orchestration 프로젝트 자체를 등록
- 이 PRD를 첫 task로 쪼개기
- v0 구현 작업을 run으로 기록
- 실패/리뷰/promotion 루프 검증

---

## 31. Success Criteria

이 프로젝트가 성공했다고 볼 수 있는 기준은 다음이다.

### v0 성공 기준

- 사용자가 실제 프로젝트를 등록 또는 init한다.
- CLI로 task를 생성한다.
- CLI로 run folder와 prompt를 생성한다.
- baseline git 상태가 기록된다.
- 사용자가 OMX/Codex 작업을 수행한 뒤 CLI로 collect한다.
- collect git 상태와 diff가 기록된다.
- OMX/Codex 작업 결과가 `.agent/runs/`에 남는다.
- diff와 review가 UI에서 보인다.
- review score에 따라 task 상태가 바뀐다.
- 다음 action이 기록된다.
- 기존 dirty diff와 run 결과 diff를 구분할 수 있다.

### v1 성공 기준

- Manager가 plan을 만든다.
- Orchestrator가 work order를 만든다.
- Worker가 제한된 scope에서 작업한다.
- Reviewer가 rubric으로 평가한다.
- Orchestrator가 상태를 결정한다.

### v2 성공 기준

- Manager가 복수 work order를 제안한다.
- Orchestrator가 policy에 따라 worker 수를 제한한다.
- 각 worker가 독립 scope에서 작업한다.
- 결과가 synthesis/review를 거쳐 합쳐진다.

### Long-term 성공 기준

- 사용자의 반복 작업이 skill/workflow/eval/memory로 누적된다.
- 실패가 시스템 개선으로 이어진다.
- 사용자가 “그때 뭐 했지?”를 UI와 파일로 추적할 수 있다.
- OMX/Codex를 쓰되, 작업 운영은 Dominic Orchestration이 소유한다.

---

## 32. Final Summary

Dominic Orchestration의 핵심은 모델을 더 똑똑하게 만드는 것이 아니다. 이미 OMX/Codex는 강력하다. 이 프로젝트의 핵심은 그 강력한 executor를 사용자의 방식에 맞게 **시작하고, 제한하고, 기록하고, 리뷰하고, 학습시키는 오케스트레이션 계층**을 만드는 것이다.

가장 중요한 설계 문장:

> **웹서비스는 살아 있는 컨트롤 플레인이고, `.agent/`는 그 컨트롤 플레인이 남기는 영속 기록이다.**

또 하나의 핵심 문장:

> **에이전트 수를 늘리기 전에 task/run/review/promotion 루프를 먼저 완성한다.**

최초 구현은 작게 시작한다.

```text
Project
  → Task
  → Run
  → Diff
  → Review
  → Status Update
  → Promotion Candidate
```

이 루프가 안정되면 그 다음에 Manager, Worker, Reviewer를 분리한다. 그 이후에 bounded multi-worker로 확장한다. 마지막으로 필요할 때 자체 Agents SDK runtime과 MCP tool orchestration으로 간다.

이 순서로 가야 “복잡한 로컬 챗봇 관리자”가 아니라, 실제로 오래 쓸 수 있는 **개인용 로컬 에이전트 오케스트레이션 시스템**이 된다.
