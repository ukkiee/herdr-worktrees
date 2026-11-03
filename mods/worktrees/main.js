// Worktrees: the app's "Open worktree" list with the git-upstream TUI plugin's verdicts
// (safe / review / keep / blocked) and its removal rule: only safe ones go, never forced,
// branches stay (ADR 0002). Opened by `mod.open:worktrees` (keys.json) for the focused
// space's repo.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, nextCommand, readTextFile } from "herdr";
import { makeGit, repoOf, ERRORS } from "./git.js";
import * as J from "./judge.js";

// Only the rows in view are drawn, like the app's command palette. One line per row,
// two pixels apart. The list takes whatever height the dialog leaves it (this.fit rows,
// from its measured size); SHOWN until the first layout reports it.
const ROW = 38;
const PITCH = ROW + 2;
const SHOWN = 9;
// git status already spreads one worktree over every core, so running several at once
// barely helps (55k files: ~0.3 s each, ~1 s each when four compete) and only delays the rows
// in view. Two statuses and four judgements at a time measured best: first screen ~4.7 s,
// all 41 worktrees ~7.8 s.
const STATUSES = 2;
const PARALLEL = 4;
// The last verdicts per repo, shown at once (dimmed) when the screen opens again, while
// they're checked anew. Lives as long as this build of the mod.
const memory = new Map();

const tilde = (path, userHome) => (userHome && path.startsWith(userHome) ? `~${path.slice(userHome.length)}` : path);
const ago = (s) => {
  if (!s) return "";
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

export default class Worktrees extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const f = focused();
    this.space = spaces().find((s) => s.id === (p.space ?? f?.space)) ?? spaces().find((s) => s.active) ?? null;
    this.on = this.space?.machine ?? null;
    this.git = makeGit(exec, this.on);
    this.repo = undefined; // undefined: looking, null: not in git
    this.rows = []; // survey rows + { facts, verdict, pieces, pending }
    this.remote = null; // what the remotes said (lsRemote), once they answered
    this.phase = ""; // what's being checked now, for the header
    this.gen = 0; // a refresh bumps it; older passes stop writing
    this.selected = null; // path
    this.top = 0;
    this.wheel = 0;
    this.fit = SHOWN; // rows that fit in the list
    this.message = "";
    this.error = "";
    this.confirm = 0; // how many "remove all safe" would remove, after its first press
    this.confirmPrune = false; // "forget missing" asked once already
    this.busy = false; // removing: keys and clicks wait, the footer shows progress
    this.progress = ""; // "Removing 2/5 · feat/x"
    this.notice = ""; // background removals or creations that failed earlier
    this.removed = new Set(); // paths removed here: a check already running must not bring them back

    this.input = InputState.new({ placeholder: "filter: branch, safe, review…" });
    this.input.on("change", (_e, cx) => { if (!this.busy) { this.top = 0; this.keepSelection(); } cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => this.load(cx, p.folder ?? f?.cwd));
    // `herdr-app do worktrees.down|up|refresh` for scripts and tests. Removal stays on the
    // keyboard on purpose.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "up" || c === "down") this.move(c === "down" ? 1 : -1);
        else if (c === "refresh" && !this.busy && this.repo) cx.spawn(async (cx) => this.refresh(cx));
        cx.notify();
      }
    });
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  async load(cx, folder) {
    const errors = `${home()}/${ERRORS}`;
    const missed = ((await readTextFile(errors).catch(() => null)) ?? "").trim();
    if (missed) {
      this.notice = missed.split("\n").slice(-3).join("\n");
      await exec("rm", ["-f", errors]).catch(() => {});
    }
    try {
      if (this.on) {
        const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on });
        if (r.code !== 0 || !r.stdout.trim()) throw new Error(`Could not find the home folder on ${this.on}.`);
        this.userHome = r.stdout.trim();
      } else this.userHome = home();
      this.folder = folder || (this.space && place(this.space)) || this.userHome;
      const repo = await repoOf(this.git, this.folder);
      this.repo = repo;
      this.memoryKey = repo ? `${this.on ?? ""}|${repo.main}` : "";
      const seen = memory.get(this.memoryKey);
      if (seen) { this.rows = seen.map((r) => ({ ...r, pending: true })); this.keepSelection(); }
      cx.notify();
      if (repo) await this.refresh(cx);
    } catch (error) {
      if (this.repo === undefined) this.repo = null;
      this.phase = "";
      this.error = String(error?.message ?? error);
      cx.notify();
    }
  }

  // Verdicts come from local facts first, without waiting for the remote: without it
  // "gone" is unknown, and an unknown never reads as safe, so nothing is offered for removal
  // too early. git status (the slow part, 0.3 s per worktree that slows down when several
  // run) goes in screen order, so the rows in view fill in first, while the remote is asked
  // alongside. When it answers, only the rows it can change are judged again (changedByRemote).
  // A newer refresh makes this one stop.
  async refresh(cx) {
    const gen = ++this.gen;
    const stale = () => gen !== this.gen;
    this.confirm = 0;
    this.phase = "Reading worktrees";
    cx.notify();
    const s = await J.survey(this.git, this.repo.main);
    if (stale()) return;
    this.setRows(s);

    const status = J.limiter(STATUSES);
    const clean = new Map();
    for (const row of this.rows) if (!row.isMain && !row.locked && !row.prunable) clean.set(row.path, status(() => J.untouched(this.git, row.path)));
    let answered = null;
    const network = (async () => {
      const remote = await J.lsRemote(exec, this.on, s.main, J.remotesToAsk(s));
      return { remote, ...(await J.fetchTracked(exec, this.on, s, remote)) };
    })().then((net) => (answered = net));

    this.phase = "Checking";
    cx.notify();
    await this.judgeAll(cx, gen, s, this.rows, clean);
    if (stale()) return;
    if (!answered) { this.phase = "Asking the remote"; cx.notify(); }
    const net = await network;
    if (stale()) return;

    this.remote = net.remote;
    const fresh = J.withRemoteDefault(net.fetched.size ? await J.survey(this.git, this.repo.main) : s, net.remote);
    if (stale()) return;
    const again = new Set(J.changedByRemote(fresh, this.rows, net.remote, net.fetched).map((r) => r.path));
    if (fresh !== s) this.setRows(fresh); // marks every row pending; the unchanged ones settle below
    // A row whose commit moved since the first look has no verdict left: judge it too.
    const redo = this.rows.filter((r) => again.has(r.path) || !r.verdict);
    for (const r of this.rows) if (!redo.includes(r)) r.pending = false;
    if (redo.length) {
      this.phase = "Checking";
      await this.judgeAll(cx, gen, fresh, redo, clean);
      if (stale()) return;
    }

    const silent = J.remotesToAsk(fresh).filter((r) => !net.remote.has(r));
    const notes = [];
    if (silent.length) notes.push(`${silent.join(", ")} didn't answer, so "gone" isn't known for branches there.`);
    if (net.failed.length) notes.push(`Fetch failed (${net.failed.join("; ")}): counts use the last fetch.`);
    this.phase = "";
    this.message = notes.join(" ");
    memory.set(this.memoryKey, this.rows);
    cx.notify();
  }

  // Judges the given rows (the screen's own objects), six at a time, in screen order.
  async judgeAll(cx, gen, s, rows, clean) {
    for (const row of rows) row.pending = true;
    this.judging = rows.length;
    cx.notify();
    await J.pool(rows, PARALLEL, async (row) => {
      const facts = await J.facts(this.git, s, row, { remote: this.remote, agent: this.agentOf(row.path), clean: await clean.get(row.path) });
      if (gen !== this.gen) return;
      const verdict = J.assess(facts);
      Object.assign(row, verdict, { why: J.reason(facts, verdict.verdict), label: J.label(facts, verdict.verdict), facts, pending: false });
      cx.notify();
    });
  }

  // New survey rows, keeping each one's last verdict (marked pending) until it's judged again.
  setRows(s) {
    this.s = s;
    const old = new Map(this.rows.map((r) => [r.path, r]));
    this.rows = s.rows
      .filter((row) => !this.removed.has(row.path) && !J.isAside(row.path))
      .map((row) => {
        const was = old.get(row.path);
        const same = was && was.head === row.head && was.branch === row.branch;
        return { ...row, facts: same ? was.facts : null, verdict: same ? was.verdict : null, pieces: same ? was.pieces : [], why: same ? was.why : "", label: same ? was.label : null, pending: true };
      })
      .sort((a, b) => b.isMain - a.isMain || b.at - a.at);
    this.keepSelection();
  }

  // The spaces showing a checkout: their first terminal is in it, and in no deeper
  // checkout of the same repo (a worktree inside the main one).
  spacesShowing(path) {
    const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);
    return spaces().filter((s) => {
      if ((s.machine ?? null) !== this.on) return false;
      const at = place(s);
      if (!at || !inside(at, path)) return false;
      return !this.rows.some((r) => r.path !== path && r.path.length > path.length && inside(at, r.path));
    });
  }

  // An agent busy in a space showing it blocks removal: closing the space would end it.
  agentOf(path) {
    const status = this.spacesShowing(path).map((s) => s.status);
    return status.includes("working") ? "working" : status.includes("blocked") ? "waiting" : null;
  }

  shown() {
    const words = this.input.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.rows;
    return this.rows.filter((r) => {
      // Every word the screen shows for a row is searchable, the header's counts included.
      const text = `${r.branch || "detached"} ${tilde(r.path, this.userHome)} ${r.label ?? ""} ${r.why ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }

  keepSelection() {
    const rows = this.shown();
    if (!rows.some((r) => r.path === this.selected)) this.selected = rows[0]?.path ?? null;
    this.reveal(rows.findIndex((r) => r.path === this.selected));
  }

  current() {
    return this.rows.find((r) => r.path === this.selected) ?? null;
  }

  move(step) {
    const rows = this.shown();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.path === this.selected);
    const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + step));
    this.selected = rows[next].path;
    this.reveal(next);
  }

  reveal(i) {
    if (i < 0) return;
    if (i < this.top) this.top = i;
    if (i >= this.top + this.fit) this.top = i - this.fit + 1;
  }

  wheelBy(e, cx) {
    // Wheels report lines, touchpads pixels.
    this.wheel -= Math.abs(e.delta.y) < 4 ? e.delta.y * PITCH : e.delta.y;
    const steps = Math.trunc(this.wheel / PITCH);
    if (!steps) return;
    this.wheel -= steps * PITCH;
    this.top = Math.max(0, Math.min(this.top + steps, this.shown().length - this.fit));
    cx.notify();
  }

  open(row) {
    if (!row) return;
    this.dismiss();
    const there = this.spacesShowing(row.path)[0];
    if (there) run("space.select", { id: there.id });
    else run("space.new", { folder: row.path, ...(this.on ? { machine: this.on } : {}) });
  }

  // Worktrees whose folder is already gone: git only remembers them. `git worktree prune`
  // forgets all of those at once (never locked ones); nothing on disk changes.
  async prune(cx) {
    this.busy = true;
    this.confirmPrune = false;
    this.progress = "Forgetting missing worktrees";
    this.message = "";
    this.error = "";
    cx.notify();
    const before = this.rows.filter((r) => r.prunable && !r.locked).length;
    const r = await this.git(this.repo.main, ["worktree", "prune"]);
    this.busy = false;
    this.progress = "";
    if (!r.ok) { this.error = r.err || "git worktree prune failed."; return cx.notify(); }
    for (const x of this.rows) if (x.prunable && !x.locked) this.removed.add(x.path);
    this.rows = this.rows.filter((x) => !x.prunable || x.locked);
    this.keepSelection();
    this.message = `Forgot ${plural(before, "missing worktree")}. Branches are kept.`;
    cx.notify();
  }

  // Why a row can't be removed right now, or "" when it can.
  refusal(row) {
    if (!row) return "Nothing selected.";
    if (row.pending || !row.verdict) return `${row.branch || "This worktree"} is still being checked.`;
    if (row.verdict !== "safe") return `${row.branch || "This worktree"} is ${row.verdict}${row.why ? ` (${row.why})` : ""}. Only safe worktrees are removed here.`;
    return "";
  }

  // Removes rows one by one. Each is judged again first, from a fresh look: it must still
  // be safe on the same branch and commit. Then it moves aside at once and its files are
  // deleted in the background (J.moveAside), so this takes about a second per worktree.
  // Its spaces close after the move, so a refusal costs nothing. Keys and clicks wait
  // meanwhile: the list is changing under them.
  async remove(cx, rows) {
    this.busy = true;
    this.confirm = 0;
    this.message = "";
    this.error = "";
    const problems = [];
    let done = 0;
    try {
      this.progress = "Checking again";
      cx.notify();
      const s = J.withRemoteDefault(await J.survey(this.git, this.repo.main), this.remote ?? new Map());
      for (const [i, row] of rows.entries()) {
        const label = row.branch || tilde(row.path, this.userHome);
        this.progress = `Removing ${rows.length > 1 ? `${i + 1}/${rows.length} · ` : ""}${label}`;
        cx.notify();
        const now = s.rows.find((r) => r.path === row.path);
        if (!now || now.head !== row.head || now.branch !== row.branch) { problems.push(`${label}: it changed; ⌘R checks again.`); continue; }
        const facts = await J.facts(this.git, s, now, { remote: this.remote, agent: this.agentOf(row.path) });
        const { verdict } = J.assess(facts);
        if (verdict !== "safe") { problems.push(`${label}: now ${verdict}${J.reason(facts, verdict) ? ` (${J.reason(facts, verdict)})` : ""}.`); continue; }
        let aside;
        try { aside = await J.moveAside(this.git, this.repo.main, row.path); }
        catch (error) { problems.push(`${label}: ${error?.message ?? error}`); continue; }
        this.removed.add(row.path).add(aside);
        for (const space of this.spacesShowing(row.path)) run("space.close", { id: space.id, confirmed: true });
        this.rows = this.rows.filter((x) => x.path !== row.path);
        this.keepSelection();
        done++;
        cx.notify();
        await J.removeInBackground(exec, this.on, this.repo.main, aside, label).catch((error) => problems.push(`${label}: moved to ${aside}, but deleting it didn't start: ${error?.message ?? error}`));
      }
    } catch (error) {
      problems.push(String(error?.message ?? error));
    }
    this.busy = false;
    this.progress = "";
    this.message = done ? `Removed ${plural(done, "worktree")}. Branches are kept.` : "";
    this.error = problems.join("\n");
    cx.notify();
  }

  key(e, cx) {
    if (this.busy) return cx.stop_propagation(); // Esc too: a half-done removal is worse than a second's wait
    const cmd = e.modifiers.platform;
    const removeAll = cmd && e.modifiers.shift && e.key === "backspace";
    const removeOne = cmd && !e.modifiers.shift && e.key === "backspace";
    if (!removeAll) this.confirm = 0;
    if (!removeOne) this.confirmPrune = false;
    if (e.key === "escape") { this.dismiss(); return cx.stop_propagation(); }
    if (e.key === "up" || e.key === "down") { this.move(e.key === "down" ? 1 : -1); cx.stop_propagation(); return cx.notify(); }
    if (e.key === "pageup" || e.key === "pagedown") { this.move(e.key === "pagedown" ? this.fit : -this.fit); cx.stop_propagation(); return cx.notify(); }
    if (e.key === "enter") { this.open(this.current()); return cx.stop_propagation(); }
    if (cmd && e.key === "r") { if (!this.busy && this.repo) cx.spawn(async (cx) => this.refresh(cx)); return cx.stop_propagation(); }
    if (cmd && e.key === "backspace") {
      cx.stop_propagation();
      if (this.busy || !this.repo) return;
      if (removeAll) {
        const safe = this.shown().filter((r) => r.verdict === "safe" && !r.pending);
        if (!safe.length) { this.error = ""; this.message = "No safe worktree in this list."; return cx.notify(); }
        if (this.confirm !== safe.length) {
          this.confirm = safe.length;
          this.error = "";
          this.message = `⌘⇧⌫ again removes ${plural(safe.length, "safe worktree")}: ${safe.map((r) => r.branch || "detached").join(", ")}.`;
          return cx.notify();
        }
        return cx.spawn(async (cx) => this.remove(cx, safe));
      }
      const row = this.current();
      if (row?.prunable && !row.locked) {
        if (!this.confirmPrune) {
          const n = this.rows.filter((r) => r.prunable && !r.locked).length;
          this.confirmPrune = true;
          this.error = "";
          this.message = `Its folder is already gone. ⌘⌫ again forgets ${n === 1 ? "it" : `all ${n} missing worktrees`} (git worktree prune). Branches stay.`;
          return cx.notify();
        }
        return cx.spawn(async (cx) => this.prune(cx));
      }
      const why = this.refusal(row);
      if (why) { this.message = ""; this.error = why; return cx.notify(); }
      return cx.spawn(async (cx) => this.remove(cx, [row]));
    }
  }

  row(r, t) {
    const on = r.path === this.selected;
    const there = this.spacesShowing(r.path).length > 0;
    const color = { safe: t.ansi2, review: t.ansi3, keep: t.muted }[r.label] ?? t.dim;
    return h_flex()
      .id(`wt-${r.path}`)
      .flex_none()
      .h(ROW)
      .px(12)
      .gap(12)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      // One click selects (removal acts on the selection), a double click opens.
      .on_click((e, cx) => { if (this.busy) return; this.selected = r.path; this.confirm = 0; this.confirmPrune = false; if (e.click_count >= 2) this.open(r); cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.branch || `detached ${r.head.slice(0, 7)}`))
      .when(Boolean(r.why), (el) => el.child(div().flex_none().max_w(220).truncate().text_size(12).text_color(t.muted).when(r.pending, (el) => el.opacity(0.5)).child(r.why)))
      .when(there, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.accent).child("open")))
      .when(!there && r.at > 0, (el) => el.child(div().flex_none().w(30).text_size(11.5).text_color(t.dim).child(ago(r.at))))
      .child(h_flex().flex_none().w(58).justify_end().text_size(12).text_color(color).when(r.pending, (el) => el.opacity(0.5)).child(r.label ?? "…"));
  }

  list(t) {
    const rows = this.shown();
    const n = rows.length;
    const height = this.fit * PITCH;
    const thumb = n > this.fit ? Math.max(16, (height * this.fit) / n) : 0;
    return div()
      .id("wt-rows")
      .relative()
      .flex_1()
      .min_h(PITCH * 3)
      .overflow_hidden()
      // The list fills the dialog; how many rows fit follows its height.
      .on_size_change((size, cx) => {
        const fit = Math.max(3, Math.floor((size.height + 2) / PITCH));
        if (fit === this.fit) return;
        this.fit = fit;
        this.top = Math.max(0, Math.min(this.top, n - fit));
        this.reveal(rows.findIndex((r) => r.path === this.selected));
        cx.notify();
      })
      .when(this.busy, (el) => el.opacity(0.6))
      .on_scroll_wheel((e, cx) => this.wheelBy(e, cx))
      .child(v_flex().gap(2).children(rows.slice(this.top, this.top + this.fit).map((r) => this.row(r, t))))
      .when(n === 0, (el) => el.child(div().p(12).text_color(t.dim).child(this.rows.length ? "No matching worktrees." : "")))
      .when(thumb > 0, (el) => el.child(div().absolute().right(0).w(3).rounded(2).bg(t.border).h(thumb).top(((height - thumb) * this.top) / Math.max(1, n - this.fit))));
  }

  // A key and what it does, spaced so the row reads as separate hints.
  hint(t, key, label) {
    return h_flex()
      .flex_none()
      .gap(6)
      .items_center()
      .child(div().px(5).py(1).rounded(4).border(1).border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted).child(key))
      .child(div().text_size(11.5).text_color(t.dim).child(label));
  }

  render() {
    const t = theme();
    const r = this.repo;
    const count = (v) => this.rows.filter((x) => x.verdict === v).length;
    const missing = this.rows.filter((x) => x.label === "missing").length;
    const summary = [...["safe", "review", "keep"].map((v) => [v, count(v)]), ["missing", missing]].filter(([, n]) => n > 0);
    const color = { safe: t.ansi2, review: t.ansi3, keep: t.muted, missing: t.dim };
    const left = this.rows.filter((x) => x.pending).length;
    const status = this.progress || (this.phase === "Checking" ? `Checking ${Math.max(0, (this.judging ?? 0) - left)}/${this.judging ?? 0}` : this.phase);
    const selected = this.current();

    return v_flex()
      .id("worktrees")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .px(20)
      .py(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .gap(14)
          .items_center()
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(`Worktrees${r ? ` · ${r.name}` : ""}${this.on ? ` (${this.on})` : ""}`))
          .children(summary.map(([v, n]) =>
            div()
              .id(`count-${v}`)
              .text_size(12)
              .text_color(color[v])
              .cursor_pointer()
              .hover((s) => s.opacity(0.75))
              // A click filters to that kind; clicking it again clears the filter.
              .on_click((_e, cx) => { if (this.busy) return; this.input.set_value(this.input.value() === v ? "" : v); this.top = 0; this.keepSelection(); cx.notify(); })
              .child(`${n} ${v}`),
          )),
      )
      .when(Boolean(this.notice), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Earlier, in the background: ${this.notice}`)))
      .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("Reading the repo…")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`)))
      .when(Boolean(r), (el) =>
        el
          .child(Input.new(this.input).h(34).px(12).items_center().rounded(8).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              .gap(6)
              .child(this.list(t))
              .child(div().h(16).truncate().text_size(11.5).text_color(t.dim).child(selected ? tilde(selected.path, this.userHome) : "")),
          ),
      )
      .when(Boolean(this.message), (el) => el.child(div().text_size(12).text_color(this.confirm || this.confirmPrune ? t.accent : t.muted).child(this.message)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(
        // The status takes what's left and truncates; the hints keep their size.
        h_flex()
          .gap(14)
          .items_center()
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(8)
              .items_center()
              .when(Boolean(status), (el) => el.child(div().flex_none().text_size(12).text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(status))),
          )
          .when(!this.busy, (el) =>
            el
              .child(this.hint(t, "↵", "open"))
              .child(this.hint(t, "⌘⌫", "remove"))
              .child(this.hint(t, "⌘⇧⌫", "remove all"))
              .child(this.hint(t, "⌘R", "refresh")),
          ),
      );
  }
}
