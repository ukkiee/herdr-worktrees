# herdr-worktrees

**English** | [한국어](README.ko.md)

Two mods for the [Herdr](https://herdr.dev) desktop app that create and clean up git
worktrees, for the repo of the space you're in. They bring the worktree popup and cleanup
screen of [herdr-git-upstream](https://github.com/ukkiee/herdr-git-upstream) (a herdr TUI
plugin) to the app.

- **⌘⇧N New worktree**: pick a base branch, name the new branch, and a space opens on the
  checkout in `~/.herdr/worktrees/<repo>/<branch>`. The base is fetched first, so the
  branch starts from what the remote has now.
- **⌘⇧O Worktrees**: every worktree of the repo with a verdict, and removal of the
  finished ones.

| Verdict | Means | ⌘⌫ |
|---|---|---|
| safe | no changes, and merged or its branch is gone from the remote with nothing unpushed | removes it |
| review | uncommitted changes, unpushed commits on a gone branch, or a conflicting catch-up | refuses, says why |
| keep | work in progress | refuses |
| blocked / missing | main checkout, locked, an agent working in it / folder already deleted | missing: ⌘⌫ twice forgets it (`git worktree prune`) |

Removal is never forced and branches are kept.

## Install

Ask the agent in Herdr to add the mod at `https://github.com/ukkiee/herdr-worktrees`, or:

```sh
git clone https://github.com/ukkiee/herdr-worktrees
cd herdr-worktrees && ./install.sh
```

`install.sh` copies both mods into `~/.config/herdr-app/mods` (or `$HERDR_APP_HOME`) and
adds ⌘⇧N and ⌘⇧O to `keys.json`, leaving keys you already use alone. Run it again after
`git pull` to update.

## Before you add it

These mods run `git` and `sh` in your repos, including `git fetch` and `git ls-remote`
against your remotes. They write temp folders under `$TMPDIR/herdr-wt.*` and background
errors to `~/.local/state/herdr-worktree-new/errors`. If the herdr TUI's
`tdi.worktree-setup` plugin is configured, New worktree runs it after each checkout.

How they're built and what to watch for: [RECIPE.md](RECIPE.md).

## License

MIT
