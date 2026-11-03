// node git.test.mjs: git.js against throwaway repos (no app needed).
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, realpathSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import * as g from "./git.js";

const root = realpathSync(mkdtempSync(`${tmpdir()}/wtnew-`));
// A fake herdr-app on PATH records what the finisher asks for.
mkdirSync(`${root}/bin`);
// It fails while ${root}/app-down holds a number above 0, counting it down.
writeFileSync(`${root}/bin/herdr-app`, `#!/bin/sh
n=$(cat "${root}/app-down" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${root}/app-down"; exit 1; fi
printf '%s\\n' "$@" > "${root}/herdr-app.args"
`);
chmodSync(`${root}/bin/herdr-app`, 0o755);
const env = { ...process.env, HOME: root, PATH: `${root}/bin:${process.env.PATH}` };
const errors = `${root}/${g.ERRORS}`;

const exec = (cmd, args = [], { cwd } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, env }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});
const sh = (cwd, cmd) => execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = async (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const runLong = async (cwd, argv, timeoutMs) => {
  const dir = await g.jobDir(exec, null);
  await g.startJob(exec, null, dir, cwd, argv);
  const r = await g.waitJob(exec, null, dir, { sleep, read, timeoutMs });
  await g.removeJob(exec, null, dir);
  return r;
};
const until = async (test, ms = 8000) => { for (let t = 0; t < ms && !test(); t += 100) await sleep(100); return test(); };

sh(root, `git init -q --bare -b main origin.git
git clone -q origin.git seed 2>/dev/null
cd seed && git config user.email t@t && git config user.name t
git commit -q --allow-empty -m one && git push -q origin main
git checkout -q -b feature/login && git commit -q --allow-empty -m f && git push -q origin feature/login
git checkout -q -b release main && git commit -q --allow-empty -m r && git push -q origin release
git checkout -q -b published main && git commit -q --allow-empty -m p && git push -q origin published
git checkout -q main
cd .. && git clone -q origin.git app && cd app && git config user.email t@t && git config user.name t
git branch -q local-only
git branch -q feature/HEAD
git remote set-head origin -a >/dev/null
git config --add remote.origin.fetch +refs/heads/release:refs/remotes/team/up/published
git remote add constructor ../origin.git
git fetch -q origin`);
// origin moves ahead after the clone: app's main is now 2 behind once fetched.
sh(`${root}/seed`, "git commit -q --allow-empty -m two && git commit -q --allow-empty -m three && git push -q origin main");

const app = `${root}/app`;
const git = g.makeGit(exec, null);

// slug / autoName match the TUI plugin; a huge suffix doesn't loop (F4).
assert.equal(g.slug("feat/Design Mode"), "feat-design-mode");
assert.equal(g.slug("///"), "worktree");
assert.equal(g.autoName("main", new Set(["main"])), "main-2");
assert.equal(g.autoName("main-2", new Set(["main-2", "main-3"])), "main-4");
assert.equal(g.autoName("x", new Set()), "x");
const huge = "release-9007199254740992";
assert.equal(g.autoName(huge, new Set([huge])), `${huge}-2`);

const repo = await g.repoOf(git, app);
assert.deepEqual([repo.name, repo.linked, repo.top, repo.main], ["app", false, app, app]);
assert.equal(await g.repoOf(git, root), null);

let data = await g.loadRepo(git, repo);
const byLabel = Object.fromEntries(data.candidates.map((c) => [c.label, c]));
console.log(data.candidates.map((c) => `${c.label}:${c.kind}`));
assert.deepEqual(data.candidates.slice(0, 2).map((c) => `${c.label}:${c.kind}`), ["main:current", "origin/main:upstream"]);
assert.equal(byLabel["local-only"].kind, "local");
assert.equal(byLabel["origin/feature/login"].kind, "remote");
assert.ok(!data.candidates.some((c) => c.label === "origin/HEAD"), "symbolic origin/HEAD is not a base");
// F7: a real branch named feature/HEAD stays.
assert.equal(byLabel["feature/HEAD"]?.kind, "local");
assert.ok(data.taken.has("feature/HEAD"));
// F3: a custom refspec maps team/up/published back to release.
assert.equal(byLabel["team/up/published"].source, "refs/heads/release");
assert.equal(byLabel["team/up/published"].name, "release");
assert.ok(data.taken.has("feature/login") && data.taken.has("main") && data.taken.has("local-only"));

// plan
assert.equal(g.plan("  ", data.candidates[0], data).error, "Type a branch name.");
assert.equal(g.plan("local-only", data.candidates[0], data).mode, "existing");
assert.equal(g.plan("feature/HEAD", data.candidates[0], data).mode, "existing");
assert.equal(g.plan("main", data.candidates[0], data).mode, "open");
assert.equal(g.plan("new-thing", data.candidates[0], data).mode, "new");

// F3: fetching the mapped ref takes release's commit, not published's.
sh(`${root}/seed`, "git checkout -q release && git commit -q --allow-empty -m r2 && git push -q origin release && git checkout -q main");
assert.equal(await g.fetchRef(exec, null, app, byLabel["team/up/published"]), "");
assert.equal(sh(app, "git rev-parse refs/remotes/team/up/published"), sh(`${root}/seed`, "git rev-parse release"));

// fetch then start point: current main is behind origin/main with nothing ahead.
assert.equal(await g.fetchRef(exec, null, app, byLabel["origin/main"]), "");
data = await g.loadRepo(git, repo);
const current = data.candidates[0];
assert.equal(current.behind, 2);
assert.deepEqual(await g.aheadBehind(git, app, current.ref, "refs/remotes/origin/main"), [0, 2]);
const sp = await g.startPoint(git, repo, current);
assert.equal(sp.ref, "refs/remotes/origin/main");
// a failing fetch reports instead of throwing
assert.notEqual(await g.fetchRef(exec, null, app, { remote: "nope", source: "refs/heads/main", ref: "refs/remotes/nope/main" }), "");

// create through a detached job, like the mod does
const wtRoot = `${root}/worktrees`;
const p = g.plan("feat/try", current, data);
const path = await g.freePath(exec, null, wtRoot, repo.name, p.name);
assert.equal(path, `${wtRoot}/app/feat-try`);
assert.ok(g.addArgs(p, path, sp.ref).includes("checkout.workers=8"));
const res = await runLong(repo.main, g.addArgs(p, path, sp.ref));
assert.equal(res.code, 0, res.log);
assert.equal(sh(path, "git rev-parse HEAD"), sh(app, "git rev-parse origin/main"));
assert.equal(sh(path, "git branch --show-current"), "feat/try");
assert.equal(sh(path, "git config branch.feat/try.merge || true"), "", "--no-track leaves no upstream");

// the same name again picks the next free folder; git refuses the branch with its own words
const path2 = await g.freePath(exec, null, wtRoot, repo.name, "feat/try", await g.worktreePaths(git, repo.main));
assert.equal(path2, `${wtRoot}/app/feat-try-2`);
const res2 = await runLong(repo.main, g.addArgs(g.plan("feat/try", current, { ...data, local: new Map() }), path2, sp.ref));
assert.notEqual(res2.code, 0);
assert.match(res2.log, /already exists/);

// a dangling symlink and a stale registration both count as taken
symlinkSync(`${root}/nowhere`, `${wtRoot}/app/odd`);
assert.equal(await g.freePath(exec, null, wtRoot, repo.name, "odd"), `${wtRoot}/app/odd-2`);
assert.equal(await g.freePath(exec, null, wtRoot, repo.name, "ghost", new Set([`${wtRoot}/app/ghost`])), `${wtRoot}/app/ghost-2`);

// existing local branch is checked out as is
const p3 = g.plan("local-only", null, data);
const path3 = await g.freePath(exec, null, wtRoot, repo.name, p3.name);
const res3 = await runLong(repo.main, g.addArgs(p3, path3, null));
assert.equal(res3.code, 0, res3.log);
assert.equal(sh(path3, "git branch --show-current"), "local-only");

// remote base: new branch from origin/feature/login, no upstream
const remoteBase = data.candidates.find((c) => c.label === "origin/feature/login");
const p4 = g.plan(g.autoName(remoteBase.name, data.taken), remoteBase, data);
assert.equal(p4.name, "feature/login-2");
const path4 = await g.freePath(exec, null, wtRoot, repo.name, p4.name);
const res4 = await runLong(repo.main, g.addArgs(p4, path4, (await g.startPoint(git, repo, remoteBase)).ref));
assert.equal(res4.code, 0, res4.log);
assert.equal(sh(path4, "git rev-parse HEAD"), sh(app, "git rev-parse origin/feature/login"));

// jobs outlive exec and report failures with the tail of their log
assert.deepEqual(await runLong(root, ["sh", "-c", "sleep 2; echo boom >&2; exit 3"]), { code: 3, log: "boom" });
// the tail is bounded even when the log is not
const big = await runLong(root, ["sh", "-c", "yes x | head -c 3000000; exit 0"]);
assert.equal(big.code, 0);
assert.ok(big.log.length <= 32768);
// a failed start removes its folder and says why
const startDir = await g.jobDir(exec, null);
await assert.rejects(() => g.startJob(exec, null, startDir, `${root}/missing`, ["true"]));
assert.equal(existsSync(startDir), false);

// F5: past the timeout the job keeps its folder; a finisher then opens the space.
const dir = await g.jobDir(exec, null);
await g.startJob(exec, null, dir, root, ["sh", "-c", "sleep 2"]);
await assert.rejects(() => g.waitJob(exec, null, dir, { sleep, read, timeoutMs: 200 }), (e) => e instanceof g.StillRunning && e.dir === dir);
assert.ok(existsSync(dir));
const marker = `${root}/setup-ran`;
const job = (over) => ({ on: null, phase: "checkout", name: "wt", space: { folder: "/x/y" }, setup: null, ...over });
await g.handOff(exec, job({ dir, setup: { cwd: root, argv: ["touch", marker] } }));
assert.ok(await until(() => existsSync(`${root}/herdr-app.args`)));
assert.deepEqual(readFileSync(`${root}/herdr-app.args`, "utf8").trim().split("\n"), ["do", "space.new", '{"folder":"/x/y"}']);
assert.ok(existsSync(marker), "setup ran before the space opened");
assert.equal(existsSync(dir), false, "finisher removed the job folder");
assert.equal(existsSync(errors), false);

// R2-1: a checkout that already finished (dir "") still gets setup and its space.
sh(root, "rm -f herdr-app.args setup-ran");
await g.handOff(exec, job({ dir: "", setup: { cwd: root, argv: ["touch", marker] } }));
assert.ok(await until(() => existsSync(`${root}/herdr-app.args`)));
assert.ok(existsSync(marker));

// R2-2: a failing setup still opens the space and leaves a note for the dialog.
sh(root, "rm -f herdr-app.args");
await g.handOff(exec, job({ dir: "", setup: { cwd: root, argv: ["sh", "-c", "echo nope; exit 7"] } }));
assert.ok(await until(() => existsSync(`${root}/herdr-app.args`) && existsSync(errors)));
assert.match(readFileSync(errors, "utf8"), /^wt: setup failed: nope/);
sh(root, `rm -f herdr-app.args "${errors}"`);

// R2-2: the app refusing at first is retried.
writeFileSync(`${root}/app-down`, "2");
await g.handOff(exec, job({ dir: "", phase: "setup" }));
assert.ok(await until(() => existsSync(`${root}/herdr-app.args`), 12000), "opened after retries");
assert.equal(existsSync(errors), false);

// a failed checkout hands off to nothing: no space, folder removed, failure written down
sh(root, `rm -f herdr-app.args`);
const bad = await g.jobDir(exec, null);
await g.startJob(exec, null, bad, root, ["sh", "-c", "sleep 1; echo broken >&2; exit 128"]);
await g.handOff(exec, job({ dir: bad, name: "badone" }));
assert.ok(await until(() => existsSync(errors)));
assert.match(readFileSync(errors, "utf8"), /^badone: checkout failed \(exit 128\): broken/);
assert.equal(existsSync(bad), false);
assert.equal(existsSync(`${root}/herdr-app.args`), false, "no space for a failed checkout");

// temp folders are cleaned up
assert.equal(sh(root, `ls "\${TMPDIR:-/tmp}" | grep -c herdr-wt || true`), "0");

console.log("ok", root);
