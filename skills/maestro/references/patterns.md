# maestro 패턴 레시피

4가지 패턴의 구체 실행법. 각 레시피: **언제 → 역할 → 실행 → 종합 → 워크트리 여부**. 패턴은 섞지 말고 하나만 골라라 (작업이 진짜로 다단계면 scout→plan→build→verify가 이미 그 조합이다).

## 워크드 예시 (작업 → 패턴, 왜)

- "이 인증 모듈 리팩터하고 제대로 됐는지 확신하고 싶어" → **build→독립리뷰루프**. 산출물 1개·품질 중요·검증 필요. (단순 한 줄 수정이면 패턴 없이 직접.)
- "이 카피 5가지 톤으로 뽑아서 제일 나은 걸로" / "이 함수 구현 접근 3개 비교" → **팬아웃+선택**. 같은 목표·독립 시도 다수·best 선택.
- "Redis vs in-memory, 우리 케이스에 뭐가 맞아?" / "이 PR 머지해도 돼?" → **패널/디베이트**. 결정 질문·파일 변경 없음. (단, 다중화는 예외 — SKILL의 escalation 신호 충족할 때만.)
- "이 레포에 X 기능 넣고 싶은데 어디부터 손대야 할지 모르겠어" → **scout→plan→build→verify**. 넓고 모호·탐색 선행 필요.

---

## 1. build → 독립 리뷰 루프

**언제.** 산출물 1개(코드 변경, 설계 문서, 마이그레이션)인데 "제대로 됐는지" 확신이 필요할 때. 같은 모델이 자기 작업을 리뷰하면 맹점을 못 본다 — *다른* 모델/operator로 리뷰하는 게 핵심 가치다.

**역할.** builder (1) + reviewer (1, builder와 다른 모델) + (선택) 종합자(=너).

**실행.**
1. builder가 작업 수행. 파일을 바꾸면 → `maestro magic run "<goal>" --executor codex` (격리 워크트리 + 주입 + 스폰 + 정리). 파일을 안 바꾸는 산출물(문서)이면 인세션으로도 가능.
2. reviewer가 결과를 읽고 결함을 낸다. builder와 **다른** 모델로:
   `codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only "<diff/산출물 요약 + '결함을 severity와 함께 내라. 마지막 줄에 VERDICT: APPROVE 또는 VERDICT: REQUEST CHANGES'>" </dev/null`
3. REQUEST CHANGES면 결함을 builder에게 돌려 수정 → 다시 리뷰. **APPROVE 또는 최대 N라운드(기본 5)** 까지 루프.

**종합.** 최종 산출물 + 리뷰가 잡은 결함 목록 + 최종 verdict을 보고.

**워크트리.** builder가 파일을 바꿀 때만. 리뷰는 항상 read-only(워크트리 없음).

> 이 패턴은 실측으로 가치가 증명됐다: 이 repo의 localcrab 통합에서 7라운드 codex(다른 모델) 리뷰가 같은-operator 리뷰어가 놓친 실제 버그 9개를 잡았다.

---

## 2. 팬아웃 + 선택

**언제.** 같은 목표에 독립적인 시도가 여러 개 가능하고, "여러 안을 만들어 best를 고르거나 종합"하고 싶을 때 (구현 후보 3개, 카피 변형 5개, 리팩터 접근 여러 개).

**역할.** N명의 executor(병렬, 서로 안 봄) + judge (1).

**실행.**
1. `graph.json`을 쓴다 — 노드는 독립(서로 deps 없음), 같은 goal에 다른 각도:
   ```json
   { "nodes": [
     { "id": "attempt-a", "goal": "<goal> — MVP-first 접근" },
     { "id": "attempt-b", "goal": "<goal> — 안정성-first 접근" },
     { "id": "attempt-c", "goal": "<goal> — 단순함-first 접근" }
   ] }
   ```
   (`executor` 미지정이면 결정적 라우터가 기본 배정. 지정하려면 `"executor":"codex|claude|agy"`.)
2. `maestro orchestrate run --file graph.json --concurrency 3` — 각 노드는 격리 워크트리에서 병렬 실행.
3. judge가 산출물들을 읽고 선택/종합 (read-only, 인세션): "이 N개를 비교해 best를 고르고, 나머지의 좋은 아이디어를 흡수해라."
4. `maestro worktrees cleanup` 으로 잔여 정리.

**종합.** 선택된 안 + 왜 + 흡수한 아이디어.

**워크트리.** 예 — 병렬 파일 변경이라 격리 필수 (orchestrate가 알아서 함).

---

## 3. 패널 / 디베이트

**언제.** 결정/설계 질문. **파일을 안 바꾼다.** "Redis냐 in-memory냐", "이 아키텍처 맞아?", "이 PR 머지해도 돼?".

**역할.** N명의 조언자(서로 다른 모델 또는 다른 *렌즈*) + 종합자(=너).

**실행.** 전부 read-only, **워크트리 없음**:
- 모델 다양성: 같은 질문을 codex(gpt-5.5)와 claude에 각각.
- 렌즈 다양성(같은 모델이라도): 조언자마다 다른 관점 부여 — correctness / security / 유지보수성 / "이게 왜 틀렸나"(악마의 변호인).
  ```
  codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only \
    "<질문>. <렌즈> 관점에서만 평가하라. 결론과 근거를 줘." </dev/null
  ```
- 디베이트가 필요하면 1라운드: 각자 의견 → 서로의 의견을 보여주고 1회 반박 → 종합.

**종합.** 합의점 / 이견 / 너의 권고(1개). 이견은 삭제하지 말고 출처와 함께 병기.

**워크트리.** 아니오. 인세션 read-only만.

---

## 4. scout → plan → build → verify

**언제.** 넓고 모호한 빌드. "어디부터 손대야 할지 모르겠는" 작업. 탐색이 선행돼야 계획이 선다.

**역할.** scout(read-only 탐색) → planner → builder → verifier. 순차 파이프라인.

**실행.**
1. **scout** — `Task(subagent_type="Explore")` 또는 `codex exec --sandbox read-only`로 코드베이스/제약 파악. 산출: `_workspace/01_scout_findings.md`.
2. **plan** — scout 결과로 계획 수립(=너 또는 `Task(planner)`). 산출: `_workspace/02_plan.md`.
3. **build** — 계획대로 구현. 파일 변경이므로 `maestro magic run "<plan에서 뽑은 goal>" --executor codex`.
4. **verify** — read-only로 결과가 계획을 충족하는지 검증(다른 모델 권장). 필요 시 `--gate <test cmd>`로 게이트.

**종합.** 무엇을 발견→계획→구현→검증했는지 + 남은 리스크.

**워크트리.** build 단계만. scout·plan·verify는 read-only.

---

## 라운드/팬아웃 수 정하기

요청 규모에 맞춰라. "빠르게 확인" → 조언자 2, 리뷰 1라운드. "철저히/comprehensive/audit" → 조언자/시도 3~5, 리뷰 다라운드. 오버헤드(워크트리·CLI 스폰)가 이득을 넘으면 줄여라.
