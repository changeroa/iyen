[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Iyen — Codex·OMP 런타임

Iyen은 메신저 리드와 작업 레인을 관리하는 상위 시스템입니다. **Codex와 OMP(oh-my-pi)는 이 저장소의 하위 런타임 구성 요소**이며, 별도 Iyen 제품이 아닙니다. `iyen` 스킬은 검증된 현재 대화를 리드로 연결하고 별도 리드를 띄우지 않습니다.

| 구성 요소 | 코드 | 역할 |
|---|---|---|
| Iyen 코어 | `src/` | 소유자 메시지 라우팅, scoped 제어, 전달 기록, 레인 생명주기와 완료 판정 |
| Codex 런타임 | `src/runtime/codex/` | Codex RPC·생성 프로토콜 타입·읽기 전용 관찰·현재 세션 연결 |
| OMP 런타임 | `src/runtime/omp/` | OMP 확장·전달 영수증·scoped 도구·세션 연결·관리형 작업자 통합 |
| 공통 런타임 호스트 | `src/runtime/` | 호스트 생명주기, Herdr 연동, 런타임 상태 계약 |
| 에이전트 스킬 | `skills/` | 리드 운영 지침, 활성화 도우미, 설정 예시 |

`runtime.kind`로 `codex`(기존 기본값) 또는 `omp`를 선택합니다. 두 런타임 모두 같은 Iyen 서비스와 메신저·레인 생명주기를 사용합니다. OMP는 [격리 프로필 설정](skills/dori-mode/references/setup.md#opt-in-omp-profile-alongside-codex)을 따르며, 관리형 일시정지·복구에는 문서에 안내된 `executionHold` 지원 포크가 필요합니다. 런타임별 모델·권한·신원 검증은 유지합니다.

설치·타입 검사·테스트는 저장소 루트에서 실행합니다. `dori` 명령과 기존 설정·persona 저장 위치는 유지합니다. 이전 스킬 내부 패키지에서 업그레이드할 때는 운영 절차에 따라 소스 경로가 고정된 실행기·attachment·watchdog 설정을 재생성하고, OMP 프로필의 `extensionPath`를 `/absolute/iyen/src/runtime/omp/extension.ts`로 갱신해야 합니다. 실행 중인 리드 아래에서 소스 경로를 옮기거나 미확정 전송을 재실행하지 마세요. 이 소스 구조 변경은 운영 배포를 수행하지 않습니다.

## 설치와 시작

Bun 1.3+, Herdr, git과 선택한 런타임(Codex CLI 또는 설정된 OMP 바이너리·확장)이 필요합니다. Codex 리드는 CLI·데몬 호환성을, Codex 관리형 작업자는 설정된 버전 고정값(기본 **0.163.0**)을 검사합니다. OMP는 설정된 버전과 정확한 네이티브 신원을 검사합니다. GitHub 완료 조건에는 gh, 패키지 발행 확인에는 npm을 사용합니다.

Herdr가 pane·세션 식별과 실행 상태의 기준이며, Codex 어댑터는 실제 세션과 메시지 전달 기록을 검증합니다. 호환되는 업데이트 뒤에는 `runtime.externalBinary`를 다시 찾아 같은 세션에 자동 재연결합니다. 다른 세션으로 옮길 때는 메시지를 선택하는 명시적 인계가 필요합니다. `dori health`로 시작 시 복구 진행, 수신 활동과 전달 보류를 구분할 수 있습니다. 수신 어댑터의 저장 ACK는 이연이 메시지를 읽었다는 뜻이 아닙니다. [복구와 인계 안내](skills/dori-mode/references/setup.md)를 참고하세요.

```sh
cd /path/to/iyen
bun install --frozen-lockfile
bun link
```

신규 설치만 `skills/dori-mode/references/config.example.json`을 `~/.dori-codex/config.json`으로 복사하세요. `defaultCwd`, `laneWorkspace`, 메신저 hook과 owner ID를 설정합니다. 기존 설정은 덮어쓰지 않고 마이그레이션합니다.

```sh
export DORI_CONFIG="$HOME/.dori-codex/config.json"
dori doctor
dori serve
# 현재 Codex 세션의 검증된 UUID와 Herdr pane으로 연결
python3 /path/to/iyen/skills/iyen/scripts/activate.py start --session UUID --pane PANE
```

`skills/iyen` 폴더를 `~/.codex/skills/iyen`에 연결하면 시작 스킬을 사용할 수 있습니다. 리드 제어에는 시작 결과의 `bridge` 실행 경로를 사용합니다. `stop --session UUID`는 이연 연결만 해제하고 현재 대화는 유지합니다. 작업 중에도 전달 가능한 메시지는 신원이 확인된 Herdr TUI를 통해 현재 응답이 끝나기 전에 입력됩니다. 세션에 연결할 수 없거나 승인·사용자 입력을 기다리는 상태, 명시적으로 보류한 상태에서는 전달을 보류합니다.

`doctor`는 버전·프로토콜·인증 상태·모델을 확인하며 모델 추론을 호출하지 않습니다. Codex의 기존 로그인을 사용하고, 토큰을 설정 파일에 저장하지 않습니다.

## 작업 흐름

```sh
dori launch fix-login --title "로그인 수정" --brief /path/to/brief.md \
  --cwd /path/to/repo --worktree --thread "telegram:chat/topic" \
  --done "merged acme/app#412" --operation-id fix-login-1

dori pause fix-login
dori resume fix-login
dori claim-done fix-login --evidence "PR과 merge SHA"
```

병렬 코드 작업에는 `--worktree`를 사용합니다. 진행 보고는 `dori report`, 사용자 답변은 `dori reply`, 후속 입력은 `dori input --text-file`로 전달합니다. 완료 요청 후 5분이 지나도 변경 파일·미추적 파일·미푸시 커밋이 있거나 실행 중단이 확인되지 않으면 닫지 않습니다. `dori reopen`은 같은 Codex thread와 기존 메신저 스레드를 이어갑니다.

읽음 확인과 답변 방식은 `iyen` 스킬이 안내합니다. 이연이 메시지를 읽으면 설정된 이연 계정으로 해당 원문 메시지에 `eyes` 반응을 달고, 실제 답변은 원래 스레드에 보냅니다. 서비스는 진행·응답 종료·재연결 대기 확인 문구나 반응을 자동으로 보내지 않습니다. 정해진 간격의 상태 메시지, 스레드 이름 변경, 완료 시 반응 제거도 요구하지 않습니다.

화면을 읽어 세션 상태를 추측하거나 Enter/Escape로 제어하지 않습니다. 중단 실패 시에도 새 입력은 차단합니다. 결과를 모르는 전송은 `dori mail list`에 남기고 자동 재실행하지 않습니다. 승인은 `dori approval list/respond`로 정확한 요청에 연결합니다.

Telegram·Discord·Slack 클라이언트, 입력 표시, draft, presence, 음성 변환, thread 추적을 유지합니다. 봇 이름, 말투, 사용자·봇 Slack 토큰 선택, 연동별 온보딩 동의도 유지합니다. 실제 수신은 ACK 후 cursor를 전진시키는 ingress 어댑터를 설정해야 합니다. 사람이 읽는 messenger watch 출력을 그대로 연결하면 안 됩니다.

요청을 분류하기 전에 `dori work similar --title "작업"` 또는 `--tag`로 이력을 확인합니다. 비슷한 작업이 `workThresholdSec`(기본 120초) 이상 걸렸다면 레인에 위임합니다. 작은 직접 작업은 `dori work start --title "작업"` / `dori work stop ID`로 측정하고 최종 보고에 시작·종료 시각과 소요 초를 포함합니다. 복잡한 작업은 범위와 완료 조건이 분명한 레인에 나누고 통합 검증합니다. 리드는 전용 bridge의 `work similar`, `work start`, `work stop`을 사용하며 운영자 CLI도 같은 서비스를 호출합니다.


## 이전과 복구

```sh
dori migrate --dry-run
dori migrate --apply --handoff-file /path/to/handoff.json
```

기존 리드·레인·monitor를 먼저 중지합니다. 진행 중 레인은 정지 확인과 인계 문서가 필요합니다. 설정과 상태를 백업하며 메신저 연결·완료 시각·history를 보존합니다. 기존 OMO 세션 ID는 이력으로 남기고 새 Codex thread와 혼용하지 않습니다. 마이그레이션은 메시지 전송이나 작업 시작을 수행하지 않습니다. `recover` 후 확인하고 명시적으로 `resume`합니다.

- [설치·마이그레이션](skills/dori-mode/references/setup.md)
- [세션과 완료 조건](skills/dori-mode/references/sessions.md)
- [명령·설정·수신 어댑터·복구](skills/dori-mode/references/scripts.md)
- [온보딩](skills/dori-mode/references/onboarding.md)
- [Tech Spec](docs/specs/codex-runtime-migration.md)

## 검증

```sh
cd /path/to/iyen
bun test
bun run typecheck
```

테스트는 fake RPC와 별도 daemon/session-host 프로세스를 사용합니다. 실제 모델·메신저 API는 호출하지 않습니다. 로컬 실제 Codex에서는 초기화, thread 생성, paused goal 조회, 필수 MCP 도구 등록까지 추론 없이 확인했습니다. 실제 모델·메신저·호스트 sandbox를 연결한 운영 전 검증은 별도로 필요합니다. journal 자동 회전은 아직 제공하지 않습니다.

MIT. 설치 스크립트는 `changeroa/iyen` 저장소를 사용합니다.
