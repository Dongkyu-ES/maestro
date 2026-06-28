# 역할 → CLI 매핑 + 헤드리스 호출법

각 역할에 어떤 CLI를 붙일지의 기본값과, 정확한 헤드리스 호출 스니펫. 사용자가 지정하면 항상 그걸 우선한다.

## 기본 휴리스틱

| 역할 | 기본 CLI | 이유 |
|------|---------|------|
| builder (파일 변경) | `codex` (workspace-write) | 코드 구현에 강함, 워크트리 쓰기 |
| reviewer (독립 리뷰) | builder와 **다른** 것: codex `gpt-5.5` high, 또는 `claude` | 자기검증 맹점 회피 — 모델 다양성이 핵심 |
| scout (탐색) | 인세션 `Task(Explore)` 또는 `codex --sandbox read-only` | 읽기 전용, 빠름 |
| judge / 종합자 | `claude`(=너, 인세션) | 비교·종합은 메인 컨텍스트에서 |
| advisor (패널) | codex와 claude를 섞어서 | 모델 다양성 |

**리뷰어는 빌더와 다른 모델로.** 같은 모델/operator가 자기 작업을 리뷰하면 같은 맹점을 공유한다. maestro의 build→review 루프 가치의 절반이 이 "독립성"에서 나온다.

## codex 헤드리스 (가장 중요한 함정 포함)

```bash
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only "<프롬프트>" </dev/null
```

- **`</dev/null` 필수.** 없으면 codex가 stdin을 기다리며 "Reading additional input from stdin..."에서 멈춘다(행). 무조건 붙여라.
- **모델명은 `gpt-5.5`** (ChatGPT 계정에선 `gpt-5.5-codex`가 거부됨: "not supported when using Codex with a ChatGPT account").
- 리뷰/패널 등 read-only → `--sandbox read-only`. 파일을 바꿔야 하면 maestro가 `maestro magic run --executor codex`로 워크트리에서 돌린다 (직접 `--sandbox workspace-write`로 현재 트리를 건드리지 말 것 — 격리가 안전).
- reasoning effort: 어려운 리뷰/판단은 `high`, 가벼운 기계적 작업은 생략(기본).
- 행에 걸리면: `pkill -f "codex exec"` 후 `</dev/null` 붙여 재실행.

## claude 헤드리스

```bash
claude -p "<프롬프트>"
```

- `-p`(print/비대화) 모드로 한 번 실행하고 결과를 받는다.
- 인세션에서 읽기 전용 조언자가 필요하면 외부 CLI 대신 `Task(subagent_type="Explore" 또는 "general-purpose")`가 더 가볍다 — 같은 세션 컨텍스트를 공유.

## agy (Antigravity) 헤드리스

```bash
agy <args>   # 설치 여부는 `maestro magic` 경로가 detectAgyCli로 확인
```

- 가용성이 불확실하면 maestro가 먼저 감지하고, 없으면 codex/claude로 폴백한다 (한 executor가 죽어도 오케스트레이션 전체를 멈추지 말 것).

## 인세션 vs 외부 프로세스

- **인세션**(`Task` 서브에이전트): 같은 대화 컨텍스트 공유, 빠름, 워크트리 없음. 패널·스카우트·종합에 적합.
- **외부 프로세스**(codex/claude/agy CLI): 진짜 다른 모델/격리가 필요할 때. 독립 리뷰(다른 모델)·격리 빌드에 적합.

규칙: **모델 다양성이나 파일 격리가 목적이면 외부 프로세스, 그 외엔 인세션.** 외부 프로세스는 비싸니 이유가 있을 때만.

## executor가 죽었을 때

1회 재시도 후 또 실패하면 그 결과 없이 진행하고 보고서에 누락을 명시한다. 상충하는 결과는 삭제하지 말고 출처와 함께 병기한다. 한 역할의 실패가 오케스트레이션 전체를 멈추게 하지 마라.
