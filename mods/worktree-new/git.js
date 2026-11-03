// Git side of the worktree mods. It takes `exec` as an argument instead of importing
// "herdr", so node can test it against real repositories.
// The source of truth is mods/worktree-new/git.js; mods/worktrees/git.js is a byte copy
// (the app refuses imports from outside a mod's folder, symlinks included).

// Same as herdr's branch_to_path_slug: lowercase ASCII letters and digits,
// everything else collapses to one dash.
export function slug(name) {
  const out = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "worktree";
}

// The first free name, counting up from a trailing -N the way the TUI plugin does.
// Up to 15 digits stay exact as a JS number; a longer suffix gets -2 appended instead
// of counting (2^53 + 1 rounds back to itself and would loop forever).
export function autoName(name, taken) {
  if (!name) name = "worktree";
  if (!taken.has(name)) return name;
  let stem = name;
  let n = 2;
  const m = /^(.*)-(\d{1,15})$/.exec(name);
  if (m && Number(m[2]) >= 2) [stem, n] = [m[1], Number(m[2]) + 1];
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

export function makeGit(exec, on) {
  return async (cwd, args) => {
    let r;
    try { r = await exec("git", args, { cwd, on }); }
    catch (error) { return { ok: false, code: -1, out: "", err: String(error) }; }
    const out = (r.stdout ?? "").trim();
    return { ok: r.code === 0, code: r.code, out, err: (r.stderr ?? "").trim() || out };
  };
}

// The repo a folder belongs to. null outside git.
export async function repoOf(git, folder) {
  const r = await git(folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!r.ok) return null;
  const [top, common] = r.out.split("\n");
  if (!top || !common) return null;
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  return { top, main, name: main.split("/").pop(), linked: main !== top };
}

// Each remote's fetch refspecs, from `git config --get-regexp`: { name: [{src, dst}] }.
export function remoteSpecs(text) {
  const specs = Object.create(null); // a remote may be called "constructor"
  for (const line of text.split("\n")) {
    const m = /^remote\.(.+)\.(url|fetch) (.*)$/.exec(line);
    if (!m) continue;
    specs[m[1]] ??= [];
    const spec = m[3].replace(/^\+/, "");
    const at = spec.indexOf(":");
    if (m[2] === "fetch" && !spec.startsWith("^") && at > 0) specs[m[1]].push({ src: spec.slice(0, at), dst: spec.slice(at + 1) });
  }
  return specs;
}

// Maps a refspec destination back to its source (one * at most, as git allows).
function substitute(dst, src, ref) {
  const star = dst.indexOf("*");
  if (star < 0) return ref === dst ? src : null;
  const [pre, post] = [dst.slice(0, star), dst.slice(star + 1)];
  if (!ref.startsWith(pre) || !ref.endsWith(post) || ref.length < pre.length + post.length) return null;
  return src.replace("*", ref.slice(pre.length, ref.length - post.length));
}

// Where a remote-tracking ref comes from: { remote, source: refs/heads/... }, read from
// the fetch refspecs like the Go plugin, then the plain refs/remotes/<remote>/ layout.
// Remote names may hold slashes, so the longest one wins the fallback.
export function trackingSource(ref, specs) {
  const remotes = Object.keys(specs).sort((a, b) => b.length - a.length);
  for (const remote of remotes) {
    for (const s of specs[remote]) {
      const source = substitute(s.dst, s.src, ref);
      if (source) return source.startsWith("refs/heads/") ? { remote, source } : null;
    }
  }
  const remote = remotes.find((r) => ref.startsWith(`refs/remotes/${r}/`));
  return remote ? { remote, source: `refs/heads/${ref.slice(`refs/remotes/${remote}/`.length)}` } : null;
}

// Where a remote's branch lands locally, by its fetch refspecs; "" if nowhere.
export function trackingRefFor(remote, source, specs) {
  for (const s of specs[remote] ?? []) {
    const dst = substitute(s.src, s.dst, source);
    if (dst) return dst;
  }
  return "";
}

// [ahead, behind] of a against b, or null.
export async function aheadBehind(git, cwd, a, b) {
  const r = await git(cwd, ["rev-list", "--left-right", "--count", `${a}...${b}`]);
  return r.ok ? r.out.split(/\s+/).map(Number) : null;
}

// Everything the dialog needs from one look at the repo: candidates in the TUI plugin's
// order (current, upstream, default, local, remote), the names already taken, and where
// each local branch is checked out. Three git calls at once, then one for ahead/behind.
export async function loadRepo(git, repo) {
  const [head, conf, refsR] = await Promise.all([
    git(repo.top, ["symbolic-ref", "-q", "--short", "HEAD"]),
    git(repo.top, ["config", "--get-regexp", "^remote\\..*\\.(url|fetch)$"]),
    git(repo.top, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(symref)%09%(committerdate:unix)%09%(worktreepath)%09%(upstream)", "refs/heads", "refs/remotes"]),
  ]);
  const specs = remoteSpecs(conf.ok ? conf.out : "");
  const refs = new Map();
  const symrefs = new Map(); // refs/remotes/<remote>/HEAD -> what it points to
  for (const line of refsR.ok ? refsR.out.split("\n") : []) {
    const [ref, symref, at, worktree, upstream] = line.split("\t");
    if (!ref) continue;
    if (symref) { symrefs.set(ref, symref); continue; }
    refs.set(ref, { at: Number(at) || 0, worktree: worktree || "", upstream: upstream || "" });
  }

  const local = new Map(); // branch -> worktree path ("" when not checked out)
  const taken = new Set();
  const make = (ref, kind) => {
    const info = refs.get(ref);
    if (!info) return null;
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      return { ref, label: name, name, kind, at: info.at, upstream: info.upstream };
    }
    const from = trackingSource(ref, specs);
    if (!from) return null;
    const name = from.source.slice("refs/heads/".length);
    return { ref, label: ref.slice("refs/remotes/".length), name, kind, at: info.at, remote: from.remote, source: from.source };
  };
  for (const [ref, info] of refs) {
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      local.set(name, info.worktree);
      taken.add(name);
    } else {
      const c = make(ref, "remote");
      if (c) taken.add(c.name);
    }
  }

  const list = [];
  const seen = new Set();
  const add = (c) => { if (c && !seen.has(c.ref)) { seen.add(c.ref); list.push(c); } };

  const current = head.ok && head.out ? make(`refs/heads/${head.out}`, "current") : null;
  add(current);
  const upstream = current?.upstream ? make(current.upstream, "upstream") : null;
  add(upstream);
  const remotes = Object.keys(specs);
  const defaultRemote = upstream?.remote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
  if (defaultRemote) {
    const guess = [symrefs.get(`refs/remotes/${defaultRemote}/HEAD`), `refs/remotes/${defaultRemote}/main`, `refs/remotes/${defaultRemote}/master`].find((r) => r && refs.has(r));
    if (guess) add(make(guess, "default"));
  }
  for (const ref of refs.keys()) if (ref.startsWith("refs/heads/")) add(make(ref, "local"));
  for (const ref of refs.keys()) if (ref.startsWith("refs/remotes/")) add(make(ref, "remote"));

  if (current && upstream) {
    const ab = await aheadBehind(git, repo.top, current.ref, upstream.ref);
    if (ab) [current.ahead, current.behind] = ab;
  }
  return { candidates: list, taken, local };
}

// What Enter would do with this name and base, from what loadRepo saw.
export function plan(name, base, data) {
  name = name.trim();
  if (!name) return { error: "Type a branch name." };
  if (data.local.has(name)) {
    const at = data.local.get(name);
    return at ? { mode: "open", name, path: at } : { mode: "existing", name };
  }
  if (!base) return { error: "Pick a base." };
  return { mode: "new", name, base };
}

// Brings one remote-tracking candidate up to date from the branch its refspec names.
// GIT_TERMINAL_PROMPT=0 so a remote that wants a password fails at once instead of
// waiting on a prompt nobody sees. No pruning: a narrow fetch has nothing to prune, and
// fetch.pruneTags (when set) makes git compare every tag: 1.5 s with 28k tags. Returns ""
// or why it failed.
export const FETCH = ["env", "GIT_TERMINAL_PROMPT=0", "git", "-c", "fetch.prune=false", "-c", "fetch.pruneTags=false", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head"];
export async function fetchRef(exec, on, cwd, c) {
  try {
    const r = await exec(FETCH[0], [...FETCH.slice(1), c.remote, `+${c.source}:${c.ref}`], { cwd, on });
    return r.code === 0 ? "" : (r.stderr || r.stdout || "git fetch failed").trim();
  } catch (error) {
    return String(error);
  }
}

// The commit a new branch starts from. A current branch that is only behind its
// upstream starts from the upstream instead: nothing is lost, and it matches what
// the TUI plugin's fast-forward did after creation.
export async function startPoint(git, repo, base) {
  if (base.kind !== "current" || !base.upstream) return { ref: base.ref, note: "" };
  const ab = await aheadBehind(git, repo.top, base.ref, base.upstream);
  if (!ab) return { ref: base.ref, note: "" };
  const [ahead, behind] = ab;
  return ahead === 0 && behind > 0 ? { ref: base.upstream, note: `${base.label} was ${behind} behind, so it starts from ${base.upstream.replace(/^refs\/remotes\//, "")}` } : { ref: base.ref, note: "" };
}

// Folders git already has a worktree registered at, even ones deleted since.
export async function worktreePaths(git, main) {
  const r = await git(main, ["worktree", "list", "--porcelain"]);
  return new Set(r.ok ? r.out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)) : []);
}

// A free folder for the checkout: <root>/<repo>/<slug>, then -2, -3... A dangling
// symlink or a stale registration counts as taken: git would refuse it.
export async function freePath(exec, on, root, repoName, name, registered = new Set()) {
  const stem = `${root}/${repoName}/${slug(name)}`;
  for (let n = 1; n < 100; n++) {
    const path = n === 1 ? stem : `${stem}-${n}`;
    if (registered.has(path)) continue;
    const r = await exec("sh", ["-c", 'test -e "$1" || test -L "$1"', "sh", path], { on });
    if (r.code !== 0) return path;
  }
  throw new Error(`No free folder next to ${stem}.`);
}

// git worktree add for a plan. --no-track: a branch made from origin/main must not
// push to main. checkout.workers=8: a 55k-file repo checks out in 6 s instead of 14 s.
export function addArgs(p, path, start) {
  const add = ["git", "-c", "checkout.workers=8", "worktree", "add"];
  return p.mode === "existing" ? [...add, path, p.name] : [...add, "--no-track", "-b", p.name, path, start];
}

// Long commands run detached from exec's 30 s limit (a big checkout takes longer),
// leaving their exit code, log, and a bounded log tail in a temp folder.
const JOB = 'd=$1; c=$2; shift 2; cd "$c" || exit 1; ( "$@" >"$d/log" 2>&1; s=$?; tail -c 32768 "$d/log" >"$d/tail"; echo $s >"$d/code.tmp"; mv "$d/code.tmp" "$d/code" ) </dev/null >/dev/null 2>&1 &';

export class StillRunning extends Error {
  constructor(dir) {
    super("Still running.");
    this.dir = dir;
  }
}

export async function jobDir(exec, on) {
  const r = await exec("sh", ["-c", 'mktemp -d "${TMPDIR:-/tmp}/herdr-wt.XXXXXX"'], { on });
  const dir = r.stdout.trim();
  if (r.code !== 0 || !dir) throw new Error(r.stderr.trim() || "mktemp failed.");
  return dir;
}

export async function startJob(exec, on, dir, cwd, argv) {
  let r;
  try { r = await exec("sh", ["-c", JOB, "sh", dir, cwd, ...argv], { on }); }
  catch (error) { r = { code: 1, stderr: String(error) }; }
  if (r.code === 0) return;
  await exec("rm", ["-rf", dir], { on }).catch(() => {});
  throw new Error((r.stderr ?? "").trim() || "Could not start the command.");
}

// Waits for a job. `sleep(ms)` and `read(path)` come from the caller so the mod can use
// its timer and node its own. A read that fails (a machine out of reach) counts as
// not done yet. Past the timeout it throws StillRunning: the job may still finish, and
// a finisher can take over from there. The folder stays until removeJob, so whoever
// owns the job can record the result before its evidence goes.
export async function waitJob(exec, on, dir, { sleep, read, timeoutMs = 10 * 60 * 1000 }) {
  const get = async (path) => { try { return await read(path); } catch { return null; } };
  const deadline = Date.now() + timeoutMs;
  for (let wait = 150; ; wait = Math.min(wait * 1.5, 1000)) {
    const code = await get(`${dir}/code`);
    if (code !== null && code.trim() !== "") {
      const log = ((await get(`${dir}/tail`)) ?? "").trim();
      return { code: Number(code.trim()), log };
    }
    if (Date.now() > deadline) throw new StillRunning(dir);
    await sleep(wait);
  }
}

export async function removeJob(exec, on, dir) {
  await exec("rm", ["-rf", dir], { on }).catch(() => {});
}

// Finishes a creation whose dialog went away (closed, or timed out waiting): waits for
// the job (dir "" when its phase already succeeded), runs setup after a checkout, opens
// the space, removes the temp folder. Runs detached on this computer; a job on another
// machine is read through hc. Anything that goes wrong is appended to ERRORS, which the
// dialog shows the next time it opens: nobody is watching when this runs.
export const ERRORS = ".local/state/herdr-worktree-new/errors";
const FINISH = `d=$1 m=$2 phase=$3 space=$4 name=$5 scwd=$6; shift 6
on() { if [ -n "$m" ]; then hc exec --on "$m" "$@"; else "$@"; fi; }
fail() { mkdir -p "$(dirname "$HOME/${ERRORS}")"; printf '%s: %s\\n' "$name" "$1" >>"$HOME/${ERRORS}"; exit 1; }
c=0 w=
if [ -n "$d" ]; then
  i=0
  until c=$(on cat "$d/code" 2>/dev/null) && [ -n "$c" ]; do
    i=$((i + 1)); [ "$i" -ge 1800 ] && fail "still not done after 30 min, see $d/log"
    sleep 1
  done
  t=$(on tail -n 3 "$d/tail" 2>/dev/null | tr '\\n' ' ')
  on rm -rf "$d"
  [ "$c" = 0 ] || [ "$phase" = setup ] || fail "checkout failed (exit $c): $t"
  [ "$c" = 0 ] || w="setup failed (exit $c): $t"
fi
if [ "$phase" = checkout ] && [ -n "$scwd" ]; then
  out=$( (cd "$scwd" && "$@") </dev/null 2>&1 ) || w="setup failed: $(printf '%s' "$out" | tail -n 3 | tr '\\n' ' ')"
fi
i=0
until herdr-app do space.new "$space" >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -ge 20 ] && fail "the checkout is ready but its space didn't open; use Open worktree"
  sleep 3
done
[ -z "$w" ] || fail "$w"`;

// job: { dir, on, phase: "checkout" | "setup", name, space, setup: { cwd, argv } | null },
// where space is space.new's args.
export async function handOff(exec, job) {
  const args = [job.dir ?? "", job.on ?? "", job.phase, JSON.stringify(job.space), job.name, job.setup?.cwd ?? "", ...(job.setup?.argv ?? [])];
  const r = await exec("sh", ["-c", 'sh -c "$0" finish "$@" </dev/null >/dev/null 2>&1 &', FINISH, ...args]);
  if (r.code !== 0) throw new Error((r.stderr ?? "").trim() || "Could not hand off.");
}
