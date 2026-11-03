// node judge.test.mjs: the verdict table and the git facts, against throwaway repos.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as j from "./judge.js";
import { makeGit } from "./git.js";

const here = dirname(fileURLToPath(import.meta.url));
// git.js here is a copy; the source of truth is worktree-new's.
assert.equal(readFileSync(`${here}/git.js`, "utf8"), readFileSync(`${here}/../worktree-new/git.js`, "utf8"), "worktrees/git.js drifted from worktree-new/git.js: copy it again");

// ---- the verdict table, case for case from verdict_test.go
const clean = { untouched: true, untouchedKnown: true, goneKnown: true, countsKnown: true, ahead: 0, behind: 0, catchup: "unknown" };
const w = (over) => ({ ...clean, ...over });
const table = [
  [w({ isMain: true }), "blocked", ["main checkout"]],
  [w({ locked: true }), "blocked", ["locked"]],
  [w({ prunable: true }), "blocked", ["missing"]],
  [w({ agent: "working" }), "blocked", ["agent working"]],
  [{ isMain: true, locked: true, prunable: true, agent: "working" }, "blocked", ["main checkout", "locked", "missing", "agent working"]],
  [w({ isMain: true, merged: true, gone: true }), "blocked", ["main checkout"]],
  [w({ agent: "working", behind: 12, catchup: "conflict" }), "blocked", ["agent working"]],
  [w({ merged: true }), "safe", ["merged"]],
  [w({ gone: true }), "safe", ["gone"]],
  [w({ gone: true, merged: true }), "safe", ["gone", "merged"]],
  [w({ gone: true, behind: 3 }), "safe", ["gone", "↓3"]],
  [w({ merged: true, behind: 5, catchup: "conflict" }), "safe", ["merged", "↓5", "conflicts"]],
  [w({ merged: true, countsKnown: false }), "safe", ["merged"]],
  [w({ gone: true, merged: true, countsKnown: false }), "safe", ["gone", "merged"]],
  [w({ untouched: false }), "review", ["dirty"]],
  [w({ untouched: false, merged: true }), "review", ["merged", "dirty"]],
  [w({ untouchedKnown: false }), "review", ["dirty?"]],
  [w({ untouchedKnown: false, merged: true }), "review", ["merged", "dirty?"]],
  [w({ behind: 12, catchup: "conflict" }), "review", ["↓12", "conflicts"]],
  [w({ gone: true, ahead: 2 }), "review", ["gone", "↑2"]],
  [w({ gone: true, countsKnown: false }), "review", ["gone", "unpushed?"]],
  [w({ gone: true, merged: true, untouched: false }), "review", ["gone", "merged", "dirty"]],
  [w({ untouched: false, behind: 4, catchup: "conflict" }), "review", ["dirty", "↓4", "conflicts"]],
  [w({ untouched: false, behind: 1, ahead: 2 }), "review", ["dirty", "↓1", "↑2"]],
  [clean, "keep", ["up to date"]],
  [w({ behind: 3, catchup: "clean" }), "keep", ["↓3", "clean catch-up"]],
  [w({ behind: 3 }), "keep", ["↓3"]],
  [w({ ahead: 2 }), "keep", ["↑2"]],
  [w({ ahead: 2, behind: 3, catchup: "clean" }), "keep", ["↓3", "↑2", "clean catch-up"]],
  [w({ countsKnown: false }), "keep", ["no tracking ref"]],
  [w({ goneKnown: false, gone: true }), "keep", ["up to date"]],
  [w({ goneKnown: false, countsKnown: false }), "keep", ["no tracking ref"]],
  [w({ gone: false }), "keep", ["up to date"]],
  // the app adds "waiting" (an agent asking the person) to "working"
  [w({ agent: "waiting", merged: true }), "blocked", ["agent waiting"]],
];
for (const [f, verdict, pieces] of table) assert.deepEqual(j.assess(f), { verdict, pieces }, JSON.stringify(f));
// the screen's one-line reasons
const why = (f) => j.reason(f, j.assess(f).verdict);
assert.equal(why(w({ merged: true })), "");
assert.equal(why(clean), "");
assert.equal(why(w({ prunable: true })), "folder deleted");
assert.equal(j.label(w({ prunable: true }), "blocked"), "missing");
assert.equal(j.label(w({ prunable: true, locked: true }), "blocked"), "blocked");
assert.equal(j.label(w({ merged: true }), "safe"), "safe");
assert.equal(why(w({ agent: "waiting" })), "agent waiting");
assert.equal(why(w({ untouched: false, merged: true })), "uncommitted changes");
assert.equal(why(w({ untouchedKnown: false })), "couldn't check for changes");
assert.equal(why(w({ gone: true, ahead: 2 })), "unpushed commits");
assert.equal(why(w({ gone: true, countsKnown: false })), "may have unpushed commits");
assert.equal(why(w({ behind: 12, catchup: "conflict" })), "conflicts with remote");
// facts missing entirely never read as removable
assert.notEqual(j.assess({}).verdict, "safe");

// ---- git facts on real repos
const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
const root = realpathSync(mkdtempSync(`${tmpdir()}/wtjudge-`));
const git = makeGit(exec, null);
sh(root, `git init -q --bare -b main origin.git
git clone -q origin.git app 2>/dev/null && cd app && git config user.email t@t && git config user.name t
echo a > a && git add a && git commit -qm one && git push -q origin main
git remote set-head origin -a >/dev/null
for b in merged squashed gone gone-ahead pruned dirty ahead conflict locked missing clean; do git branch -q $b; done
# merged: its commit is pushed and merged into main
git checkout -q merged && echo m > m && git add m && git commit -qm m && git push -q origin merged
git checkout -q main && git merge -q --no-ff merged -m "merge merged" && git push -q origin main
# squashed: same change lands on main as a different commit (no ancestry)
git checkout -q squashed && echo s > s && git add s && git commit -qm s1 && echo s2 >> s && git commit -qam s2 && git push -q -u origin squashed
git checkout -q main && git merge -q --squash squashed && git commit -qm "squash" && git push -q origin main
# gone: pushed with upstream, then deleted on the remote
git checkout -q gone && echo g > g && git add g && git commit -qm g && git push -q -u origin gone
git checkout -q gone-ahead && echo h > h && git add h && git commit -qm h && git push -q -u origin gone-ahead && echo h2 >> h && git commit -qam h2
# pruned: deleted from this clone, which drops its tracking ref too: ahead can't be counted
git checkout -q pruned && echo p > p && git add p && git commit -qm p && git push -q -u origin pruned && git push -q origin --delete pruned
# ahead: unpushed work on a live upstream
git checkout -q ahead && git push -q -u origin ahead && echo x > x && git add x && git commit -qm x
# conflict: behind its upstream and the two sides collide
git checkout -q conflict && echo 1 > a && git commit -qam c1 && git push -q -u origin conflict && echo 2 > a && git commit -qam c2
git checkout -q main`);
// the remote's copy of "conflict" moves on with a clashing change
sh(root, `git clone -q origin.git other 2>/dev/null && cd other && git config user.email t@t && git config user.name t && git checkout -q conflict && echo 3 > a && git commit -qam c3 && git push -q origin conflict && git push -q origin --delete gone gone-ahead`);
// fetch without pruning: the deleted branches' tracking refs stay. (With fetch.prune on,
// as on this machine, they go, and gone rows land in review unless merged catches them:
// see "pruned".)
sh(`${root}/app`, "git -c fetch.prune=false fetch -q origin");
const wt = (b) => `${root}/wt/${b}`;
for (const b of ["merged", "squashed", "gone", "gone-ahead", "pruned", "dirty", "ahead", "conflict", "locked", "missing", "clean"]) sh(`${root}/app`, `git worktree add -q "${wt(b)}" ${b}`);
writeFileSync(`${wt("dirty")}/new-file`, "x");
sh(`${root}/app`, `git worktree lock "${wt("locked")}"`);
rmSync(wt("missing"), { recursive: true });

let s = await j.survey(git, `${root}/app`);
assert.equal(s.rows[0].isMain, true);
assert.equal(s.defaultRef, "refs/remotes/origin/main");
assert.deepEqual(j.integration(s), ["refs/remotes/origin/main"]);
const remote = await j.lsRemote(exec, null, s.main, j.remotesToAsk(s));
assert.ok(remote.get("origin").heads.has("refs/heads/main"));
assert.equal(remote.get("origin").head, "refs/heads/main");
assert.match(remote.get("origin").heads.get("refs/heads/main"), /^[0-9a-f]{40}$/);
assert.deepEqual((await j.fetchTracked(exec, null, s, remote)).failed, []);
s = await j.survey(git, `${root}/app`);
// everything is at the remote's commit now: no fetch at all
let fetches = 0;
const spy = (cmd, args, opts) => { if (args.includes("fetch")) fetches++; return exec(cmd, args, opts); };
const again = await j.fetchTracked(spy, null, s, await j.lsRemote(exec, null, s.main, j.remotesToAsk(s)));
assert.deepEqual([again.failed, [...again.fetched]], [[], []]);
assert.equal(fetches, 0, "unchanged refs are not fetched");
// with nothing fetched, only gone branches need judging again
assert.deepEqual(j.changedByRemote(s, s.rows, remote, new Set()).map((r) => r.branch).sort(), ["gone", "gone-ahead", "pruned"]);
// a moved default branch can change merged anywhere
assert.equal(j.changedByRemote(s, s.rows, remote, new Set(["refs/remotes/origin/main"])).length, s.rows.length);

const verdicts = {};
for (const row of s.rows) {
  const { verdict, pieces } = j.assess(await j.facts(git, s, row, { remote }));
  verdicts[row.isMain ? "(main)" : row.branch] = `${verdict}: ${pieces.join(", ")}`;
}
console.log(verdicts);
assert.deepEqual(verdicts, {
  "(main)": "blocked: main checkout",
  merged: "safe: merged",
  squashed: "safe: merged",
  gone: "safe: gone",
  "gone-ahead": "review: gone, ↑1",
  pruned: "review: gone, unpushed?",
  dirty: "review: dirty", // changed: review, and the branch checks are skipped
  ahead: "keep: ↑1",
  conflict: "review: ↓1, ↑1, conflicts",
  locked: "blocked: locked",
  missing: "blocked: missing",
  clean: "safe: merged",
});

// without the remote's answer, gone stays unknown: never safe on a guess
const gone = s.rows.find((r) => r.branch === "gone");
assert.equal(j.assess(await j.facts(git, s, gone)).verdict, "keep");
// an agent in its space blocks it
assert.equal(j.assess(await j.facts(git, s, gone, { remote, agent: "working" })).verdict, "blocked");

// the default branch itself is never "merged", even though other branches contain it
sh(`${root}/app`, `git worktree add -q "${wt("main2")}" -b main2 origin/main && git push -q origin main2 && git checkout -q -b grown main && git commit -q --allow-empty -m grown && git push -q origin grown && git checkout -q main`);
s = await j.survey(git, `${root}/app`);
const onDefault = { ...s.rows.find((r) => r.branch === "main2"), branch: "main" };
assert.equal((await j.facts(git, s, onDefault, { remote })).merged, false);

// removal: moved aside at once, deleted in the background, branch kept
const victim = s.rows.find((r) => r.branch === "merged");
const aside = await j.moveAside(git, s.main, victim.path);
assert.ok(j.isAside(aside) && !j.isAside(victim.path));
assert.ok(!existsSync(victim.path) && existsSync(aside));
await j.removeInBackground(exec, null, s.main, aside, "merged");
for (let i = 0; i < 50 && existsSync(aside); i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(existsSync(aside), false);
assert.ok(!sh(`${root}/app`, "git worktree list").includes(".removing-"));
assert.equal(sh(`${root}/app`, "git rev-parse --verify -q refs/heads/merged >/dev/null && echo kept"), "kept");

// pool keeps order and limits concurrency
let live = 0, peak = 0;
const got = await j.pool([5, 1, 4, 2, 3], 2, async (n) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, n * 5)); live--; return n * 10; });
assert.deepEqual(got, [50, 10, 40, 20, 30]);
assert.equal(peak, 2);

rmSync(root, { recursive: true, force: true });
console.log("ok");
