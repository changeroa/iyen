[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

# Dori — Codex 런타임

`iyen` 스킬을 설치한 뒤 현재 Codex 대화에서 **“이연 모드 시작”**이라고 요청하면 그 대화가 이연 리드가 됩니다. 별도 리드는 띄우지 않습니다. 이연은 메신저 요청을 받고, 필요한 작업만 독립된 Codex 작업자 세션에 맡깁니다.

OMP(oh-my-pi)도 [별도의 선택형 런타임 프로필](skills/dori-mode/references/setup.md#opt-in-omp-profile-alongside-codex)로 사용할 수 있습니다. 기본값은 Codex입니다. 확장을 준비한 OMP 대화를 리드로 연결하거나 관리형 작업자를 띄울 수 있으며, 관리형 일시정지와 복구에는 안내된 `executionHold` 지원 OMP 포크가 필요합니다.

기존 시스템 구조는 유지합니다. 메신저 스레드와 작업 레인 연결, 진행 보고, 5분 완료 이의 제기, 실제 Done 증거 확인, 자원 제한과 heavy 슬롯은 그대로입니다. `dori serve`가 감시와 상태 저장을 담당하고, Codex가 추론·도구·turn·goal을 실행합니다. 작업자는 레인별 stdio MCP를, 현재 세션의 리드는 등록 시 받은 전용 실행 파일을 사용합니다. 기존 세션의 모델과 권한은 유지합니다.

## 설치와 시작

Bun 1.3+, Codex CLI, Herdr, git이 필요합니다. 현재 세션 리드는 CLI와 데몬 버전의 일치 여부와 필요한 메시지 기능을 검사하며, 릴리스별 허용 목록을 요구하지 않습니다. 관리형 워커는 설정된 버전 고정값(기본 **0.163.0**)을 사용합니다. GitHub 완료 조건에는 gh, 패키지 발행 확인에는 npm을 사용합니다.

Herdr가 pane·세션 식별과 실행 상태의 기준이며, Codex 어댑터는 실제 세션과 메시지 전달 기록을 검증합니다. 호환되는 업데이트 뒤에는 `runtime.externalBinary`를 다시 찾아 같은 세션에 자동 재연결합니다. 다른 세션으로 옮길 때는 메시지를 선택하는 명시적 인계가 필요합니다. `dori health`로 시작 시 복구 진행, 수신 활동과 전달 보류를 구분할 수 있습니다. 수신 어댑터의 저장 ACK는 이연이 메시지를 읽었다는 뜻이 아닙니다. [복구와 인계 안내](skills/dori-mode/references/setup.md)를 참고하세요.

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

일반 owner 대화는 작업자의 보고 스레드에 쓴 후속 메시지라도 항상 lead가 받습니다. lead가 필요한 지시만 작업자에게 명시적으로 전달하며, 레인과 스레드를 연결해도 대화 수신 대상은 바뀌지 않습니다. 명시적 owner UI 제어는 기존 레인·스레드 검증을 유지합니다. 이전에 접수된 queued·unknown 항목은 자동 이동·재전송하지 않고 조정 대상으로 보존합니다.

네이티브 `ask`를 금지하지 않습니다. 메신저 연결 세션의 실제 질문·선택·입력·승인 요청을 원래 owner 스레드로 전달하고, owner 답변을 요청 ID와 네이티브 세션에 결합해 원래 대기 중인 UI 요청에 적용합니다. 일반 대화를 작업자에게 보내 답으로 취급하지 않습니다. 여러 요청이 열려 있거나 승인이 필요한 경우 안내된 요청 토큰으로 답하며, 로컬 처리·만료·세션 변경 뒤의 오래된 답변은 거부합니다. 비밀 입력은 Slack을 통한 자격 증명 수집으로 전환하지 않습니다.

이 경로에는 실제 대기 UI를 조회·응답하는 네이티브 SDK 지원이 필요합니다. 이미 실행 중인 구버전 프로세스에는 Iyen 서비스 재시작만으로 추가되지 않습니다. 네이티브 코드를 갱신할 때는 같은 세션을 보존하고, controller epoch가 바뀌면 명시적 활성화로 새 scoped binding을 확인해야 합니다. 버전 문자열이나 프로필 설정만으로 질문 왕복이 준비됐다고 판단하지 않습니다.

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

### 네이티브 한 명령 실행

설치 후 `iyen codex` 또는 `iyen omp`로 해당 네이티브 리드 세션을 열거나
정확한 기존 UUID로 재개하고 Iyen 브리지를 연결합니다. `dori` CLI는 그대로
유지됩니다. `${XDG_CONFIG_HOME:-~/.config}/iyen/launchers.json`에 다음처럼
**이미 존재하는** 설정 파일을 등록하세요.

```json
{
  "version": 1,
  "profiles": {
    "codex": { "configPath": "~/.dori-codex/config.json" },
    "omp": { "configPath": "~/.config/iyen/omp/config.json" }
  }
}
```

두 설정의 `runtime.kind`는 이름과 일치해야 하며 상태 디렉터리는 분리해야
합니다. Codex는 실행 중인 공유 데몬, OMP는 격리된 설정·확장·명시적 모델과
추론 강도가 필요합니다. Herdr가 실행하는 `codex`/`omp`는 설정된 네이티브
실행 파일과 같아야 합니다. 레거시 LEAD 파일이 있으면 프로필의 선택 항목
`leadInstructionsPath`에 지정할 수 있습니다. 생략하면 Iyen 스킬과 설정된
페르소나 경로를 사용합니다.

같은 메신저 ingress ID와 소유자가 겹치면 기본적으로 수신 서비스만
전환하고 기존 TUI는 보존합니다. 양방향 자동 전환을 쓰려면 각 프로필에
`service.start`와 `service.stop`을 **argv 배열**로 지정하세요. stop 명령은
자동 재시작까지 해제하고 종료를 확인해야 합니다. 선택 항목
`service.stopped`는 감독 작업이 내려갔는지 추가 검증합니다. 구체적인 JSON
예제와 감독 명령 계약은 [영문 설정 설명](README.md#native-one-command-launcher)을
참고하세요. 훅이 없으면 서비스를 시작할 수 있지만 안전한 종료 방법이
없는 다른 서비스로의 전환은 거부됩니다.

- `iyen codex`: Codex 리드 실행/정확한 세션 재개
- `iyen omp --no-switch`: 다른 수신 서비스가 있으면 전환하지 않고 거부
- `--config PATH`, `--registry PATH`: 기존 설정 또는 레지스트리 명시
- `--model ID --effort LEVEL`: 저장된 리드 값보다 우선하는 명시적 선택
- `--json`: 브리지와 검증된 세션 정보를 자동화용으로 출력

반복 실행은 정상 연결된 세션에 초기화 프롬프트를 다시 보내지 않습니다.
종료된 TUI는 정확한 세션을 재개하며, 이전 pane이 사라졌으면 소유권 부재를
확인한 뒤 포커스를 바꾸지 않는 새 탭에서 재연결합니다. 사용자 일시정지나
완료 보류를 해제하지 않고, 점유·모호한 pane은 거부합니다. 다른 작업자의
미확인 메일이나 과거 attachment 기록은 변경하지 않습니다. 불확실한 네이티브
실행/입력 결과는 같은 명령으로 영수증을 확인하며 재전송하지 않습니다.
초기화 영수증은 입력 전달 확인이며 모델의 지침 독해 완료를 뜻하지 않습니다.
실행만으로 메신저에 활성화 알림을 보내지 않습니다.
