# Worktrees

Two dialogs for the git worktrees of the repo in the focused space. **New worktree**
(`cmd-shift-n`) picks a base branch, names the new branch, checks it out under
`~/.herdr/worktrees/<repo>/<branch>` and opens a space there. **Worktrees**
(`cmd-shift-o`) lists every worktree of the repo with a verdict (safe, review, keep,
blocked or missing) and removes only the safe ones: never forced, branches kept. Both are
the app versions of the worktree popup and cleanup screen of
[herdr-git-upstream](https://github.com/ukkiee/herdr-git-upstream), a herdr TUI plugin.

## What you see

### New worktree

A modal dialog, 560×540 px, on the `popover` background, 16px padding, 6px between
blocks, base type 13px. Top to bottom:

- **Header**: `New worktree · <repo>` semibold in `foreground` (plus ` (<machine>)` for a
  space on another machine).
- **Background errors**, only when a creation finished after its dialog closed and
  failed: `Earlier, in the background: <the last three>` at 12px in `blocked`.
- **Base**: a label row, `Base` left and the count right (`24`, or `3/24` while
  filtered), 11px `dim`. Under it the filter input (placeholder `filter bases`), then
  the list.
- **The list**: exactly 9 rows of 30px (270px), radius 6, 10px side padding. Each row:
  the branch (`main`, `origin/feat/x`) in `foreground`, truncated; on the right at 11px
  its kind and facts joined by ` · `: `current · ↓3 · ↑1`, `upstream`, `default`,
  `local · 2d`, `remote · 5h`, plus `checked out` for a local branch some worktree
  has. The detail is `blocked` when the current branch is behind, `accent` for
  default and upstream, `dim` otherwise. The selected row has the `selected`
  background, others `hover` under the pointer. A 3px `border`-colored thumb on the
  right edge when there are more than 9. `No branch matches.` when the filter hides
  everything.
- **Name**: a label and the name input (placeholder `new branch name`).
- **Where it goes**: the folder at 11.5px `dim` (`~/.herdr/worktrees/acme-web/feat-x`).
  Only when Enter does something other than make a new branch, a `muted` line above it:
  `Checks out the existing branch x (the base isn't used).`; or, instead of the folder,
  `x is already checked out at <path>. ↵ goes there.`
- **Error**, when there is one, in `blocked`.
- **Footer**, 6px above it: on the right, key hints 14px apart, each a key chip (5px by
  1px padding, radius 4, 1px `border` outline, `raised` fill, 11px `muted`) and its word
  at 11.5px `dim`: `↑↓ base`, `tab filter ↔ name`, `↵ create`, `esc close`. While
  creating: on the left a braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 90 ms a frame) in `accent`
  and the step at 12px `muted`, truncating first (`Fetching origin/main…`,
  `Checking out into ~/.herdr/worktrees/…`, `Running worktree setup…`); the hints become
  one, `esc finish in background`, and the body above drops to 55% opacity.

Both inputs are 32px tall, radius 6, 10px side padding, `background` fill, a 1px
border in `accent` when focused and `input` otherwise.

### Worktrees

A modal dialog 680px wide and 72% of the window tall, `popover` background, 20px side
and 18px vertical padding, 12px between blocks, base type 13px. Top to bottom:

- **Header**: `Worktrees · <repo>` semibold in `foreground`; on the right, 14px apart at
  12px, the counts that aren't zero: `2 safe` (`ansi2`), `1 review` (`ansi3`),
  `3 keep` (`muted`), `1 missing` (`dim`).
- **Background errors**, as in New worktree.
- **Filter input**, 34px, radius 8, 12px side padding, `accent` border, placeholder
  `filter: branch, safe, review…`.
- **The list** takes all the height left. Rows are 38px with 2px between them, radius 8,
  12px side padding, 12px gaps. Each row, left to right: the branch (`detached 1a2b3c4`
  without one) in `foreground`, truncated; the reason, only for review and blocked rows,
  12px `muted`, at most 220px; `open` in `accent` (11.5px) when a space shows the
  worktree, else its last commit's age in a 30px `dim` column (`5m`, `3h`, `2d`,
  `4mo`); the verdict right-aligned in a 58px column at 12px, colored like the header
  counts (`…` until known). Selected row: `selected` background; others `hover` under
  the pointer. A 3px thumb on the right when rows overflow.
- **Path** of the selected worktree, 11.5px `dim`, one 16px line under the list.
- **Message** (12px; `accent` while a second press is awaited, `muted` otherwise) and
  **error** (12px, `blocked`), when there are any.
- **Footer**: on the left a spinner and the step at 12px `muted`, truncating first:
  `Reading worktrees`, `Checking 3/8`, `Asking the remote`, `Checking again`,
  `Removing 2/5 · feat/x`, `Forgetting missing worktrees`. On the right four key hints,
  14px apart, hidden while removing: a key chip (5px by 1px padding, radius 4, 1px
  `border` outline, `raised` fill, 11px `muted`) and its word at 11.5px `dim`:
  `↵ open`, `⌘⌫ remove`, `⌘⇧⌫ remove all`, `⌘R refresh`.

Reasons are short and plain: `main checkout`, `locked`, `folder deleted`,
`agent running`, `agent waiting` (blocked); `uncommitted changes`,
`couldn't check for changes`, `unpushed commits`, `may have unpushed commits`,
`conflicts with remote` (review).

## How it behaves

### New worktree

- Opens on the focused space's repo: its first terminal's live folder, else the space's
  folder. Outside git it says `<folder> is not in a git repository.`
- Bases, in this order: the current branch, its upstream, the remote's default branch
  (`refs/remotes/origin/HEAD`, else `origin/main`, else `origin/master`), local branches,
  then remote branches, each group newest commit first. The filter keeps rows whose
  name contains every typed word.
- The name follows the selected base: the base's branch name, or the next free one
  (`feat-2`; a name ending in `-N` counts up from N), selected so typing replaces it.
  Once the person types their own name it stops following.
- On open it fetches the current branch's upstream and updates its ↓/↑. 400 ms after
  the selection rests on a remote base it fetches that one, so Enter seldom waits. A
  fetch counts as fresh for 2 minutes.
- Enter: a name that is an existing local branch already checked out goes to that
  worktree's space (or opens one there); an existing branch not checked out is checked
  out as it is. Otherwise a new branch: the base's remote ref is fetched first (for the
  current branch, its upstream). If that fetch fails on a remote base, it stops and says
  `↵ again starts it from the last fetched <sha>`; the second Enter uses exactly that
  commit. A current branch that is only behind its upstream starts from the upstream.
- The new branch has no upstream (`--no-track`), so a branch made from `origin/main`
  never pushes to main.
- The checkout goes to `~/.herdr/worktrees/<repo>/<slug>` (`-2`, `-3`… when taken), runs
  detached and is polled, then a space opens there, unnamed so it follows its folder.
- If the herdr TUI's `tdi.worktree-setup` plugin is installed and configured, it runs
  after the checkout, as the TUI runs it on `worktree.created` (this computer only).
- Esc during a creation closes the dialog; a detached finisher waits for the checkout,
  runs the setup and opens the space. Failures land in
  `~/.local/state/herdr-worktree-new/errors` and show at the top next time either dialog
  opens.
- Keys: ↑↓ and PageUp/PageDown (8 rows) move the base, Tab switches between the
  filter and the name, Enter creates, Esc closes.

### Worktrees

- The verdict comes from the TUI plugin's table:
  - **blocked**: the main checkout, a locked worktree, a missing folder, or a space showing
    it whose agent is working or waiting. Never removed. A missing folder shows as
    **missing** instead.
  - **safe**: no change at all (not even untracked files) and the work is finished:
    merged, or its branch is gone from the remote with nothing unpushed.
  - **review**: changed files, a check that failed, gone with unpushed (or uncountable)
    commits, or catching up with the upstream would conflict.
  - **keep**: everything else, work in progress.
- Merged means HEAD is already in the remote's default branch (or a `git-upstream.mergeTarget`
  value from git config): an ancestor of it, contained in another remote branch, or a
  squash whose changed files read the same in the target. The branch's own pushed
  copies don't count.
- Gone comes from `git ls-remote`. Until the remote answers, gone is unknown, and
  unknown is never safe.
- Order: the main checkout first, then the newest branch commit first.
- Checking: the list appears at once; verdicts fill in from the top, local facts first.
  When the remote answers, tracked refs the remote moved are fetched and only the rows
  that could change are checked again. Rows show their last verdict dimmed until
  checked. Reopening shows the last verdicts at once, dimmed, while they're checked.
- Clicking a header count filters to it; clicking it again clears the filter. The filter
  matches the branch, the path, the verdict and the reason.
- Click selects, double-click or Enter opens the worktree's space (or a new one).
- ⌘⌫ removes the selected worktree if it's safe; otherwise it says why not. On a
  missing row, the first ⌘⌫ explains and the second runs `git worktree prune` (forgets
  every missing one; nothing on disk changes).
- ⌘⇧⌫ names every safe worktree in the filtered list; pressing it again removes them.
- Removing checks each worktree again from a fresh look (same branch, same commit, still
  safe), moves it aside to `.<folder>.removing-<ms>` next to it, closes the spaces
  showing it, and deletes the files in the background with `git worktree remove`
  (never `--force`, so git refuses anything that changed). Branches stay. While it runs,
  every key and click waits, Esc included, and the list is at 60% opacity.
- ⌘R checks again.

## Built from

- `mods/worktree-new/`: `main.js` (the dialog, one `View`), `git.js` (git work, no
  herdr import, so node tests it), `git.test.mjs`. `mod.json`:
  `{ "place": "none", "title": "New worktree", "overlay": { "kind": "dialog", "modal": true, "width": 560, "height": 540 } }`.
- `mods/worktrees/`: `main.js`, `judge.js` (the verdict table and the checks),
  `judge.test.mjs`, and `git.js`, a byte copy of `mods/worktree-new/git.js`.
  `mod.json`: `{ "place": "none", "title": "Worktrees", "overlay": { "kind": "dialog", "modal": true, "width": 680, "height": 0.72 } }`.
- `keys.json`: `cmd-shift-n` → `mod.open:worktree-new`, `cmd-shift-o` →
  `mod.open:worktrees` in `global`.
- `herdr` functions: `exec`, `run` (`space.new`, `space.select`, `space.close`),
  `spaces`, `panes`, `focused`, `props`, `closeOverlay`, `theme`, `home`,
  `readTextFile`, `notify`, `nextCommand`, and the `View.close` hook. `gpui-kit`:
  `View`, `div`; `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`.
- Commands for scripts: `worktree-new.create|up|down`, `worktrees.up|down|refresh`.
- Programs run: `git` (rev-parse, for-each-ref, config, worktree add/list/move/remove/
  prune, status, rev-list, merge-base, diff, merge-tree, check-ref-format), `git fetch`
  and `git ls-remote` against the repo's remotes (network), `sh`, `env`, `mktemp`,
  `test`, `rm`; the finisher runs `herdr-app do space.new` and, for another machine,
  `hc exec --on`.
- Files outside the mod folders: `~/.config/herdr/plugins.json` and the setup plugin's
  config (read), `~/.local/state/herdr-worktree-new/errors` (written), temp folders
  `$TMPDIR/herdr-wt.*` for running jobs.

## Watch out

- `exec` stops a command after 30 s and big checkouts take longer, so `git worktree add`
  runs detached and the dialog polls its exit-code file.
- The app refuses imports from outside a mod's folder, symlinks included: that's why
  `git.js` is copied. `judge.test.mjs` fails when the copies differ.
- `v_virtual_list` drew nothing inside a dialog; both lists draw only the rows in view,
  like the command palette, with their own wheel handling and thumb.
- A global `fetch.prune` or `fetch.pruneTags` makes even an empty fetch slow (seconds with
  tens of thousands of tags) and removes tracking refs that "gone" relies on. Every fetch
  passes `-c fetch.prune=false -c fetch.pruneTags=false --no-tags`.
- `git status` costs about 0.3 s per worktree in a 55k-file repo and already uses every
  core: two run at once, four verdicts at a time. A trial merge (`merge-tree`) to detect
  squashes took 4 s per worktree there; the changed-files comparison replaced it.
- Deleting a 55k-file checkout takes about 10 s, hence the move aside first.
- Without a known default branch (no `refs/remotes/origin/HEAD` and a silent remote),
  merged isn't judged: nothing reads safe by being merged.
- The dialog takes the keyboard a moment after opening; the name input is focused again
  after 600 ms.
- `View.close` has 250 ms: it only starts the detached finisher.
- Spaces on another machine run git there (`exec`'s `on`). This was built and tested on
  one computer; other machines are untested.

## Done when

- `cmd-shift-n` in a repo's space lists the current branch first; Enter with a new name
  creates `~/.herdr/worktrees/<repo>/<name>` on a branch without upstream and opens a
  space there.
- Esc during a checkout still ends with the space open.
- `cmd-shift-o` shows the main checkout as blocked (`main checkout`), a merged and clean
  worktree as safe, one with an edited file as review (`uncommitted changes`), and a
  worktree whose folder was deleted as missing.
- ⌘⌫ on the safe one removes its folder and keeps its branch; on the review one it
  refuses and says why.
- `node git.test.mjs` in `mods/worktree-new` and `node judge.test.mjs` in
  `mods/worktrees` both print `ok`.
