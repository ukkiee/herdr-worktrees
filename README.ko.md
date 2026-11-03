# herdr-worktrees

[English](README.md) | **한국어**

[Herdr](https://herdr.dev) 데스크톱 앱에서 지금 space의 저장소에 git 워크트리를 만들고
정리하는 mod 두 개입니다. herdr TUI 플러그인
[herdr-git-upstream](https://github.com/ukkiee/herdr-git-upstream)의 워크트리 팝업과 정리
화면을 앱으로 옮겼습니다.

- **⌘⇧N New worktree**: 기준 브랜치를 고르고 새 브랜치 이름을 정하면
  `~/.herdr/worktrees/<저장소>/<브랜치>`에 체크아웃하고 그 space를 엽니다. 기준을 먼저
  fetch해서 원격의 최신 커밋에서 시작합니다.
- **⌘⇧O Worktrees**: 저장소의 모든 워크트리를 판정과 함께 보여 주고, 끝난 것만 지웁니다.

| 판정 | 뜻 | ⌘⌫ |
|---|---|---|
| safe | 바뀐 파일이 없고, 병합됐거나 원격에서 브랜치가 지워졌고 안 올린 커밋도 없음 | 지움 |
| review | 커밋 안 한 변경, 지워진 브랜치에 안 올린 커밋, 따라잡으면 충돌 | 거절하고 이유 표시 |
| keep | 작업 중 | 거절 |
| blocked / missing | main 체크아웃, 잠김, 에이전트 작업 중 / 폴더가 이미 없음 | missing: ⌘⌫ 두 번이면 등록만 정리(`git worktree prune`) |

강제로 지우지 않고, 브랜치는 남깁니다.

## 설치

Herdr 안의 에이전트에게 `https://github.com/ukkiee/herdr-worktrees` mod를 추가해 달라고
하거나:

```sh
git clone https://github.com/ukkiee/herdr-worktrees
cd herdr-worktrees && ./install.sh
```

`install.sh`는 두 mod를 `~/.config/herdr-app/mods`(또는 `$HERDR_APP_HOME`)에 복사하고
`keys.json`에 ⌘⇧N·⌘⇧O를 추가합니다. 이미 다른 기능에 쓰는 키는 건드리지 않습니다.
업데이트는 `git pull` 후 다시 실행하면 됩니다.

## 추가하기 전에

이 mod는 저장소에서 `git`과 `sh`를 실행하고, 원격에 `git fetch`·`git ls-remote`를 합니다.
`$TMPDIR/herdr-wt.*`에 임시 폴더를, `~/.local/state/herdr-worktree-new/errors`에
백그라운드 오류를 씁니다. herdr TUI의 `tdi.worktree-setup` 플러그인이 설정돼 있으면
체크아웃마다 실행합니다.

구조와 주의점은 [RECIPE.md](RECIPE.md)에 있습니다.

## 라이선스

MIT
