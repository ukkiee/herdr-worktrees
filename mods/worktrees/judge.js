// Rules and git work for the Worktrees screen, ported from the git-upstream TUI plugin:
// internal/judge/verdict.go (the verdict table), judge.go (merged), and ADR 0002 (only
// safe worktrees are removed, never forced, branches stay). `exec`/`git` are passed in,
// so node can test it (judge.test.mjs).
import { remoteSpecs, trackingSource, trackingRefFor, aheadBehind, FETCH, ERRORS } from "./git.js";

// Sort order and the screen's words. Anything not known reads as blocked: removal can't
// be undone, so a row whose facts are missing must never look removable.
export const ORDER = { safe: 0, review: 1, keep: 2, blocked: 3 };

// The verdict table, as in verdict.go. f: { isMain, locked, prunable, agent: "working" |
// "waiting" | null, untouched, untouchedKnown, gone, goneKnown, merged, ahead, behind,
// countsKnown, catchup: "clean" | "conflict" | "unknown" }.
export function assess(f) {
  const blocked = [];
  if (f.isMain) blocked.push("main checkout");
  if (f.locked) blocked.push("locked");
  if (f.prunable) blocked.push("missing");
  if (f.agent) blocked.push(`agent ${f.agent}`);
  if (blocked.length) return { verdict: "blocked", pieces: blocked };

  const gone = f.goneKnown && f.gone;
  const dirty = f.untouchedKnown && !f.untouched;
  // Gone is finished work only when no commit is ahead, and that has to be checkable.
  const goneAndPushed = gone && f.countsKnown && f.ahead === 0;
  const goneAndUnsure = gone && (!f.countsKnown || f.ahead > 0);

  const pieces = [];
  if (gone) pieces.push("gone");
  if (f.merged) pieces.push("merged");
  if (dirty) pieces.push("dirty");
  else if (!f.untouchedKnown) pieces.push("dirty?");
  if (f.countsKnown) {
    if (f.behind > 0) pieces.push(`↓${f.behind}`);
    if (f.ahead > 0) pieces.push(`↑${f.ahead}`);
  } else if (gone && !f.merged) pieces.push("unpushed?");
  if (f.catchup === "conflict") pieces.push("conflicts");
  else if (f.catchup === "clean") pieces.push("clean catch-up");
  if (!pieces.length) pieces.push(f.countsKnown ? "up to date" : "no tracking ref");

  if (f.untouchedKnown && f.untouched && (f.merged || goneAndPushed)) return { verdict: "safe", pieces };
  if (dirty || !f.untouchedKnown || f.catchup === "conflict" || goneAndUnsure) return { verdict: "review", pieces };
  return { verdict: "keep", pieces };
}

// The one thing worth saying about a row, in plain words: why it's blocked, or what to
// look at in review. Safe and keep need no explanation. (assess's pieces stay for tests
// and the TUI's wording; the screen shows this.)
export function reason(f, verdict) {
  if (verdict === "blocked") {
    if (f.isMain) return "main checkout";
    if (f.locked) return "locked";
    if (f.prunable) return "folder deleted";
    if (f.agent === "working") return "agent running";
    return f.agent ? "agent waiting" : "";
  }
  if (verdict !== "review") return "";
  if (!f.untouchedKnown) return "couldn't check for changes";
  if (!f.untouched) return "uncommitted changes";
  const gone = f.goneKnown && f.gone;
  if (gone && f.countsKnown && f.ahead > 0) return "unpushed commits";
  if (gone && !f.countsKnown) return "may have unpushed commits";
  return f.catchup === "conflict" ? "conflicts with remote" : "";
}

// What the screen calls a row. A worktree whose folder is gone stays blocked for the
// rules (nothing to remove), but it's shown as "missing": unlike the other blocked rows
// it can be cleared up, by forgetting it (git worktree prune).
export function label(f, verdict) {
  return f.prunable && !f.locked ? "missing" : verdict;
}

// Removing deletes the checkout's files: 10.7 s for one worktree of a 55k-file repo, so
// "remove all" would hold the screen for a minute. Instead the worktree first moves aside
// in an instant (`git worktree move` to a hidden name next to it), and the files go in the
// background with a plain `git worktree remove`: still never forced, so git refuses
// anything that changed. A failure is written to ERRORS for the next dialog to show.
export const isAside = (path) => /\/\.[^/]+\.removing-\d+$/.test(path);

export async function moveAside(git, main, path) {
  const at = path.lastIndexOf("/");
  const aside = `${path.slice(0, at)}/.${path.slice(at + 1)}.removing-${Date.now()}`;
  const r = await git(main, ["worktree", "move", path, aside]);
  if (!r.ok) throw new Error(r.err.split("\n").pop() || "git worktree move failed.");
  return aside;
}

const REMOVE = `m=$1 t=$2 n=$3
e="$HOME/${ERRORS}"
cd "$m" || exit 1
out=$(git worktree remove "$t" 2>&1) || { mkdir -p "$(dirname "$e")"; printf '%s: %s\\n' "$n" "couldn't finish removing it, it waits at $t ($(printf '%s' "$out" | tail -n 1))" >>"$e"; }`;

export async function removeInBackground(exec, on, main, aside, label) {
  const r = await exec("sh", ["-c", 'sh -c "$0" remove "$@" </dev/null >/dev/null 2>&1 &', REMOVE, main, aside, label], { on });
  if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || "Could not start the removal.");
}

// `git worktree list --porcelain`: { path, head, branch, locked, prunable }, main first.
export function parseWorktrees(text) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.includes("bare")) continue;
    out.push({
      path,
      head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "",
      branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? "",
      locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
    });
  }
  return out;
}

// One local look at the repo: its worktrees and the refs the verdicts need. Fast (four
// git calls at once); judging each worktree is separate.
export async function survey(git, main) {
  const [list, conf, refsR, targetsR] = await Promise.all([
    git(main, ["worktree", "list", "--porcelain"]),
    git(main, ["config", "--get-regexp", "^remote\\..*\\.(url|fetch)$"]),
    git(main, ["for-each-ref", "--format=%(refname)%09%(symref)%09%(upstream)%09%(committerdate:unix)%09%(objectname)", "refs/heads", "refs/remotes"]),
    git(main, ["config", "--get-all", "git-upstream.mergeTarget"]),
  ]);
  if (!list.ok) throw new Error(list.err || "git worktree list failed.");
  const specs = remoteSpecs(conf.ok ? conf.out : "");
  const refs = new Map(); // ref -> { upstream, at, sha }
  const symrefs = new Map();
  for (const line of refsR.ok ? refsR.out.split("\n") : []) {
    const [ref, symref, upstream, at, sha] = line.split("\t");
    if (!ref) continue;
    if (symref) symrefs.set(ref, symref);
    else refs.set(ref, { upstream: upstream || "", at: Number(at) || 0, sha: sha || "" });
  }
  const sources = new Map(); // tracking ref -> { remote, source }
  for (const ref of refs.keys()) {
    if (!ref.startsWith("refs/remotes/")) continue;
    const from = trackingSource(ref, specs);
    if (from) sources.set(ref, from);
  }
  const rows = parseWorktrees(list.out).map((w, i) => {
    const local = w.branch ? refs.get(`refs/heads/${w.branch}`) : null;
    return { ...w, isMain: i === 0, upstream: local?.upstream ?? "", at: local?.at ?? 0 };
  });
  const remotes = Object.keys(specs);
  const defaultRemote = remotes.includes("origin") ? "origin" : (remotes[0] ?? "");
  const defaultRef = symrefs.get(`refs/remotes/${defaultRemote}/HEAD`) ?? "";
  const mergeTargets = targetsR.ok ? targetsR.out.split("\n").filter(Boolean) : [];
  return { main, specs, refs, symrefs, sources, rows, remotes, defaultRemote, defaultRef, mergeTargets };
}

// Tracking refs fetched from `source` (refs/heads/x), on one remote or any.
function copies(s, remote, source) {
  const out = [];
  for (const [ref, from] of s.sources) if (from.source === source && (!remote || from.remote === remote)) out.push(ref);
  return out;
}

// The integration branches: the remote's default branch, then git-upstream.mergeTarget
// values ("origin/dev", "dev" or a full ref). Without a known default branch the TUI
// doesn't judge merged at all: it couldn't tell main-on-main from finished work.
export function integration(s) {
  if (!s.defaultRef) return [];
  const resolve = (v) => (v.startsWith("refs/") ? v : s.refs.has(`refs/remotes/${v}`) ? `refs/remotes/${v}` : `refs/remotes/${s.defaultRemote}/${v}`);
  return [...new Set([s.defaultRef, ...s.mergeTargets.map(resolve)])].filter((r) => s.refs.has(r));
}

// Past this many changed files the squash check gives up (a miss, never a false merged):
// the paths go on one command line.
const MAX_PATHS = 1000;
// A trial merge to see whether catching up conflicts costs seconds when the branch is
// thousands of commits behind; past this it stays unknown.
const MAX_CATCHUP = 1000;

// Is HEAD's content already in some remote branch? Ancestor check first, then the squash
// and rebase case. The TUI did that with a trial merge into each integration branch
// (merge-tree), which took 4 s on average in a monorepo whose main ran 7,000-12,000 commits
// ahead of most worktrees. Instead: the files the branch changed since it left the
// target must read the same in the target. Then merging would change nothing. It agreed
// with merge-tree on all 42 of its worktrees at a seventh of the cost; it misses a merge the
// target has since edited further, and never claims a false one.
// The branch's own copies don't count: pushing isn't finishing.
async function judgeMerged(git, s, row, from) {
  const targets = integration(s);
  if (!row.head || !targets.length) return false;
  const self = row.branch ? copies(s, null, `refs/heads/${row.branch}`) : [];
  if (self.some((r) => targets.includes(r))) return false; // the integration branch itself
  const skip = new Set([...self, ...(from ? copies(s, from.remote, from.source) : []), row.upstream]);
  // The integration branches first: one cheap ancestry check each catches the usual
  // merge commit. Asking every remote ref (other people's branches too) costs up to 0.9 s.
  for (const target of targets) if ((await git(s.main, ["merge-base", "--is-ancestor", row.head, target])).code === 0) return true;
  const contains = await git(s.main, ["for-each-ref", "--contains", row.head, "--format=%(refname)%09%(symref)", "refs/remotes"]);
  if (contains.ok && contains.out.split("\n").some((l) => { const [ref, sym] = l.split("\t"); return ref && !sym && !skip.has(ref); })) return true;
  for (const target of targets) {
    const base = await git(s.main, ["merge-base", row.head, target]);
    if (!base.ok) continue;
    const names = await git(s.main, ["diff", "--name-only", "-z", "--no-renames", base.out, row.head]);
    const paths = names.ok ? names.out.split("\0").filter(Boolean) : null;
    if (!paths?.length || paths.length > MAX_PATHS) continue; // nothing changed means an ancestor, caught above
    const same = await git(s.main, ["diff", "--quiet", "--no-renames", row.head, target, "--", ...paths.map((p) => `:(literal)${p}`)]);
    if (same.code === 0) return true;
  }
  return false;
}

// Untouched: not even an untracked file (what git worktree remove needs without --force).
// No fsmonitor: in a big repo it would start a watcher daemon per worktree just to answer this.
// The slowest fact (0.3 s for 55k files, more when several run at once), so callers start it
// early and pass it in.
export async function untouched(git, path) {
  const status = await git(path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"]);
  return { known: status.ok, value: status.ok && status.out === "" };
}

// The facts for one worktree. `remote`: what lsRemote learned (gone needs it; without it
// gone stays unknown). `agent`: "working" | "waiting" | null, from the app's spaces.
// `clean`: untouched()'s answer if already known.
export async function facts(git, s, row, { remote = null, agent = null, clean = null } = {}) {
  const f = {
    isMain: row.isMain, locked: row.locked, prunable: row.prunable, agent,
    untouched: false, untouchedKnown: false, gone: false, goneKnown: false, merged: false,
    ahead: 0, behind: 0, countsKnown: false, catchup: "unknown",
  };
  if (assess(f).verdict === "blocked") return f; // nothing else can change it

  const u = clean ?? (await untouched(git, row.path));
  f.untouchedKnown = u.known;
  f.untouched = u.value;
  // Changed (or not checkable) is review whatever else is true, and the screen only says
  // why: the branch checks below are the expensive part (up to 0.9 s in a big repo), so skip them.
  if (!f.untouched) return f;

  const from = row.upstream ? (s.sources.get(row.upstream) ?? trackingSource(row.upstream, s.specs)) : null;
  if (row.upstream && s.refs.has(row.upstream) && row.head) {
    const ab = await aheadBehind(git, s.main, row.head, row.upstream);
    if (ab) [f.ahead, f.behind, f.countsKnown] = [ab[0], ab[1], true];
  }
  if (from && remote?.has(from.remote)) {
    f.goneKnown = true;
    f.gone = !remote.get(from.remote).heads.has(from.source);
  }
  f.merged = await judgeMerged(git, s, row, from);
  // Catching up can only turn keep into review; safe and review rows don't need it.
  if (f.countsKnown && f.behind > 0 && f.behind <= MAX_CATCHUP && assess(f).verdict === "keep") {
    const mt = await git(s.main, ["merge-tree", "--write-tree", row.upstream, row.head]);
    f.catchup = mt.code === 0 ? "clean" : mt.code === 1 ? "conflict" : "unknown";
  }
  return f;
}

// Asks remotes what branches they have, and their HEAD: Map remote -> { heads: Map of
// refs/heads/... -> sha, head }. A remote that doesn't answer is left out, so its gone
// stays unknown.
export async function lsRemote(exec, on, cwd, remotes) {
  const out = new Map();
  await Promise.all(remotes.map(async (remote) => {
    let r;
    try { r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "git", "ls-remote", "--symref", remote, "HEAD", "refs/heads/*"], { cwd, on }); }
    catch { return; }
    if (r.code !== 0) return;
    const heads = new Map();
    let head = "";
    for (const line of r.stdout.split("\n")) {
      const sym = /^ref: (\S+)\tHEAD$/.exec(line);
      if (sym) { head = sym[1]; continue; }
      const [sha, ref] = line.split("\t");
      if (ref?.startsWith("refs/heads/")) heads.set(ref, sha);
    }
    out.set(remote, { heads, head });
  }));
  return out;
}

// The remotes worth asking: those the worktrees track, and the default one.
export function remotesToAsk(s) {
  const set = new Set(s.defaultRemote ? [s.defaultRemote] : []);
  for (const row of s.rows) {
    const from = row.upstream ? s.sources.get(row.upstream) ?? trackingSource(row.upstream, s.specs) : null;
    if (from) set.add(from.remote);
  }
  return [...set];
}

// Fetches, per remote in one call, the default branch and every upstream the remote has
// moved past our copy, so behind counts and merged see today's remote. Refs already at the
// remote's commit are skipped, and usually that's all of them: even a fetch with nothing
// to get costs 3 s with 28k tags. Returns { failed: why each failed remote failed, fetched: the
// tracking refs that moved }.
export async function fetchTracked(exec, on, s, remote) {
  const want = new Map(); // remote -> Set of "+src:dst"
  const add = (r, src, dst) => {
    if (!r || !src || !dst || s.refs.get(dst)?.sha === remote.get(r)?.heads.get(src)) return;
    (want.get(r) ?? want.set(r, new Set()).get(r)).add(`+${src}:${dst}`);
  };
  for (const [name, info] of remote) if (info.head) add(name, info.head, trackingRefFor(name, info.head, s.specs));
  for (const row of s.rows) {
    const from = row.upstream ? s.sources.get(row.upstream) ?? trackingSource(row.upstream, s.specs) : null;
    if (from && remote.get(from.remote)?.heads.has(from.source)) add(from.remote, from.source, row.upstream);
  }
  const failed = [];
  const fetched = new Set();
  await Promise.all([...want].map(async ([name, specs]) => {
    try {
      const r = await exec(FETCH[0], [...FETCH.slice(1), name, ...specs], { cwd: s.main, on });
      if (r.code !== 0) failed.push(`${name}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
      else for (const spec of specs) fetched.add(spec.slice(spec.indexOf(":") + 1));
    } catch (error) {
      failed.push(`${name}: ${error}`);
    }
  }));
  return { failed, fetched };
}

// After the remote answered, which rows can judge differently than they did without it:
// all of them when the default branch moved (merged compares against it), else only those
// whose branch is gone from the remote or whose upstream was just fetched. Others keep
// their verdict: knowing a branch still exists changes nothing.
export function changedByRemote(s, rows, remote, fetched) {
  const targets = new Set(integration(s));
  if ([...fetched].some((ref) => targets.has(ref))) return rows;
  return rows.filter((row) => {
    if (fetched.has(row.upstream)) return true;
    const from = row.upstream ? s.sources.get(row.upstream) ?? trackingSource(row.upstream, s.specs) : null;
    return Boolean(from && remote.get(from.remote) && !remote.get(from.remote).heads.has(from.source));
  });
}

// With what lsRemote learned, the default branch is known even when the local
// refs/remotes/<remote>/HEAD was never set.
export function withRemoteDefault(s, remote) {
  if (s.defaultRef) return s;
  const head = remote.get(s.defaultRemote)?.head;
  const ref = head ? trackingRefFor(s.defaultRemote, head, s.specs) : "";
  return ref && s.refs.has(ref) ? { ...s, defaultRef: ref } : s;
}

// A queue that runs at most n tasks at once: limit(() => work()) resolves with work()'s answer.
export function limiter(n) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

// Runs fn over items, n at a time, keeping order.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
