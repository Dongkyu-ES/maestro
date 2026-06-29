# maestro — 하네스 구성 (compose: agent + skill + harness)

작업이 *반복되거나 넓어* 즉석 패턴 1회로 안 끝날 때, 역할팀(who) + 스킬(how) + 얇은 오케스트레이터를 **파일로 박제**해 재사용한다. `/harness:harness`에서 **영감만** 빌렸다 — 다 따라하지 않는다. maestro는 프로바이더 중립이고, 가볍고, 역할이 CLI든 서브에이전트든 상관없고, 증거는 옵트인이다.

## harness:harness에서 빌린 것 / 안 빌린 것

| 빌린 것 (good idea) | 안 빌린 것 (maestro식 대체) |
|---|---|
| 에이전트(who) ↔ 스킬(how) 분리 | opus 전용 강제 → 역할마다 CLI/모델 자유 |
| generate → verify(트리거·구조) 규율 | 6-phase 무거운 방법론 → 4단계 |
| progressive disclosure (SKILL 본문 lean, 상세는 references/) | 에이전트 팀 기본 강제 → 즉석 4패턴이 기본, compose는 예외 |
| 파일로 박제해 재사용 | 항상 박제 → 재사용 가치 있을 때만 |

## 언제 compose하나 (아니면 즉석 4패턴)

다음 중 하나 이상일 때만 박제한다:

- (a) 같은 종류의 작업이 반복될 조짐 (1회성 아님)
- (b) 역할이 4개+이고 그 조합이 재사용될 가치
- (c) 팀/스킬을 다음 세션·다른 프로젝트에서도 쓸 것

아니면 박제하지 마라. 박제는 공짜가 아니다(파일·유지보수 비용). 1회성이면 `patterns.md`의 4패턴으로 끝내는 게 옳다.

## 4단계 레시피

### 1. 역할 분해 (who)

작업을 전문 영역으로 쪼개고, 역할마다 정한다: 이름 · 책임 · **실행기**(codex / claude / agy / 인세션 서브에이전트) · 필요한 컨텍스트. 매핑은 새로 정하지 말고 `cli-map.md`/`patterns.md`의 휴리스틱을 그대로 — 빌드=codex(workspace-write), 리뷰=*다른* 모델, 스카우트/심판=claude·Explore.

### 2. agent + skill 파일 작성 (Claude Code 네이티브 포맷; 새 포맷 만들지 마라)

- **에이전트(who)** → `프로젝트/.claude/agents/{name}.md` — 역할·원칙·입출력·핸드오프(목표 / 입력ref / 제약 / 산출물경로 4필드). 역할이 CLI 실행기면 그 헤드리스 호출법(`cli-map.md`, 특히 codex `</dev/null`)을, 인세션 서브에이전트면 `subagent_type`을 명시.
- **스킬(how)** → `프로젝트/.claude/skills/{name}/SKILL.md` — 반복 가능한 *절차*. frontmatter `name`+`description`(description은 트리거를 적극적으로 — 하는 일 + 구체 트리거 상황). 본문은 lean(<500줄), 상세는 `references/`로. 강압적 ALWAYS/NEVER 대신 **why**를 설명(이유를 알면 엣지에서도 옳게 판단한다).

> who(누가) vs how(어떻게)를 분리하는 게 핵심이다 — 이게 박제를 재사용 가능하게 만든다.

### 3. 얇은 오케스트레이터 배선 (기존 엔진에 위임; 새 런타임 만들지 마라)

누가 언제 어떤 순서로 협업하는지는 maestro 엔진이 이미 한다:

- 순차/의존 → `graph.json`(노드 `deps`) → `maestro orchestrate run --file graph.json`
- 병렬 독립 → `deps` 없는 graph → `--concurrency N`
- 파일을 바꾸는 단계만 워크트리(`provisioning.md`의 결정 규칙). read-only 역할은 인세션.

### 4. verify-and-run

- **구조 검증**: 에이전트 파일 위치, 스킬 frontmatter(name+description), 참조 정합(dead link 없음), `.claude/commands/` 안 만듦.
- **트리거 검증**: 스킬 description에 should-trigger 몇 개 + should-NOT-trigger(키워드 비슷한 near-miss) 몇 개로 점검. 기존 스킬과 트리거 충돌도 확인.
- 그다음 실제 1회 실행 → 종합. 증거가 필요하면(`--prove` / `--gate`) **그때만** 켠다.

## 산출물 체크리스트

- [ ] `.claude/agents/{role}.md` — 역할마다 (실행기/모델 명시)
- [ ] `.claude/skills/{name}/SKILL.md` — how (pushy description, lean 본문, 상세는 references/)
- [ ] `graph.json` 또는 `orchestrate` 호출 — who-when-order
- [ ] `.claude/commands/` — 아무것도 안 만듦
- [ ] 즉석 4패턴으로 충분했는지 한 번 더 자문 — 충분했으면 박제하지 말 것
