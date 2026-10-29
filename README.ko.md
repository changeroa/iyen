[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex 런타임

`iyen` 스킬을 설치한 뒤 현재 Codex 대화에서 **“이연 모드 시작”**이라고 요청하면 그 대화가 이연 리드가 됩니다. 별도 리드는 띄우지 않습니다. 이연은 메신저 요청을 받고, 필요한 작업만 독립된 Codex 작업자 세션에 맡깁니다.

기존 시스템 구조는 유지합니다. 메신저 스레드와 작업 레인 연결, 진행 보고, 5분 완료 이의 제기, 실제 Done 증거 확인, 자원 제한과 heavy 슬롯은 그대로입니다. `dori serve`가 감시와 상태 저장을 담당하고, Codex가 추론·도구·turn·goal을 실행합니다. 작업자는 레인별 stdio MCP를, 현재 세션의 리드는 등록 시 받은 전용 실행 파일을 사용합니다. 기존 세션의 모델과 권한은 유지합니다.

## 설치와 시작

Bun 1.3+, Codex CLI, Herdr, git이 필요합니다. 현재 세션 리드는 CLI와 데몬 버전의 일치 여부와 필요한 메시지 기능을 검사하며, 릴리스별 허용 목록을 요구하지 않습니다. 관리형 워커는 설정된 버전 고정값(기본 **0.163.0**)을 사용합니다. GitHub 완료 조건에는 gh, 패키지 발행 확인에는 npm을 사용합니다.

Herdr가 pane·세션 식별과 실행 상태의 기준이며, Codex 어댑터는 실제 세션과 메시지 전달 기록을 검증합니다. 호환되는 업데이트 뒤에는 `runtime.externalBinary`를 다시 찾아 같은 세션에 자동 재연결합니다. 다른 세션으로 옮길 때는 메시지를 선택하는 명시적 인계가 필요합니다. `dori health`로 시작 시 복구 진행, 수신 활동과 전달 보류를 구분할 수 있습니다. 수신 확인 응답은 이연 대화에 전달됐다는 뜻이 아닙니다. [복구와 인계 안내](skills/dori-mode/references/setup.md)를 참고하세요.

```sh
cd skills/dori-mode/scripts
bun install --frozen-lockfile
bun link
```

신규 설치만 `references/config.example.json`을 `~/.dori-codex/config.json`으로 복사하세요. `defaultCwd`, `laneWorkspace`, 메신저 hook과 owner ID를 설정합니다. 기존 설정은 덮어쓰지 않고 마이그레이션합니다.

```sh
export DORI_CONFIG="$HOME/.dori-codex/config.json"
dori doctor
dori serve
# 현재 Codex 세션의 검증된 UUID와 Herdr pane으로 연결
python3 /path/to/iyen/skills/iyen/scripts/activate.py start --session UUID --pane PANE
```

`skills/iyen` 폴더를 `~/.codex/skills/iyen`에 연결하면 시작 스킬을 사용할 수 있습니다. 리드 제어에는 시작 결과의 `bridge` 실행 경로를 사용합니다. `stop --session UUID`는 이연 연결만 해제하고 현재 대화는 유지합니다. 대화가 작업 중이면 메시지는 대기하며, 세션을 닫으면 전달이 보류됩니다.

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

이연 리드가 연결된 동안 서비스는 리드와 등록된 작업자의 Herdr 상태 변화를 확인해 해당 메신저 스레드에 진행·대기·응답 종료 상태를 알립니다. 리드의 직접 작업은 실제로 전달된 요청의 Codex turn과 스레드가 일치할 때만 알립니다. 리드 연결이 해제되면 진행 상태용 Herdr 조회와 알림을 멈춥니다. 상태 알림은 작업 완료 증거가 아니며, 구체적인 단계와 결과는 작업자가 `dori report`로 보냅니다.

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
cd skills/dori-mode/scripts
bun test
bun run typecheck
```

테스트는 fake RPC와 별도 daemon/session-host 프로세스를 사용합니다. 실제 모델·메신저 API는 호출하지 않습니다. 로컬 실제 Codex에서는 초기화, thread 생성, paused goal 조회, 필수 MCP 도구 등록까지 추론 없이 확인했습니다. 실제 모델·메신저·호스트 sandbox를 연결한 운영 전 검증은 별도로 필요합니다. journal 자동 회전은 아직 제공하지 않습니다.

MIT. 설치 스크립트의 upstream URL 이름은 역사적 경로이며 런타임 의존성과 무관합니다.
