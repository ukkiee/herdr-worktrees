// New worktree dialog: pick a base branch, name the new branch, get a space on
// the checkout. The app version of the git-upstream TUI plugin's popup.
// Opened by `mod.open:worktree-new` (keys.json) for the focused space's repo.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, readTextFile, notify, nextCommand } from "herdr";
import * as G from "./git.js";

// Same folder as the shipped worktree mod and herdr's TUI.
const ROOT = (userHome) => `${userHome}/.herdr/worktrees`;
// Per-project setup steps the TUI ran on worktree.created (e.g. copying .env files).
const SETUP_PLUGIN = "tdi.worktree-setup";
// The list draws only the rows in view, like the app's command palette:
// a big repo can have thousands of remote branches.
const ROW = 30;
const SHOWN = 9;
// Remote refs fetched lately, so reopening the dialog doesn't fetch them again.
// Lives as long as this build of the mod.
const FRESH_MS = 2 * 60 * 1000;
const fetchedAt = new Map();

const tilde = (path, userHome) => (userHome && path.startsWith(userHome) ? `~${path.slice(userHome.length)}` : path);
const ago = (s) => {
  if (!s) return "";
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
// git's own complaint, not its progress lines.
const gitError = (log) => {
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => /^(fatal|error):/.test(l)).pop() ?? lines.pop() ?? "git worktree add failed.";
};
// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

export default class NewWorktree extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const f = focused();
    this.space = spaces().find((s) => s.id === (p.space ?? f?.space)) ?? spaces().find((s) => s.active) ?? null;
    this.on = this.space?.machine ?? null;
    this.git = G.makeGit(exec, this.on);
    this.repo = undefined; // undefined: looking, null: not in git
    this.data = null;
    this.shown = [];
    this.baseRef = null;
    this.auto = "";
    this.busy = false;
    this.status = "";
    this.error = "";
    this.fetches = new Map(); // ref -> in-flight fetch, so open and Enter share one
    this.staleOk = null; // { ref, sha }: the cached commit the person agreed to start from
    this.job = null; // how to finish the running creation if the dialog goes
    this.notice = ""; // what went wrong with creations finished in the background

    this.name = InputState.new({ placeholder: "new branch name" });
    this.name.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.name.on("submit", (_e, cx) => this.go(cx));
    this.name.on("focus", (_e, cx) => { this.focus = "name"; cx.notify(); });
    this.filter = InputState.new({ placeholder: "filter bases" });
    this.filter.on("change", (_e, cx) => { if (!this.busy) { this.refilter(); this.prefetchSoon(cx); } cx.notify(); });
    this.filter.on("submit", (_e, cx) => this.go(cx));
    this.filter.on("focus", (_e, cx) => { this.focus = "filter"; cx.notify(); });
    this.focus = "name";
    this.name.focus();
    // The dialog takes the keyboard a moment after it opens.
    cx.timer.after(600, () => { if (this.focus === "name") this.name.focus(); });

    this.top = 0; // first row in view
    this.wheel = 0; // scroll px not yet a whole row
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => this.load(cx, p.folder ?? f?.cwd));
    // `herdr-app do worktree-new.create` presses Enter, `.up`/`.down` move the base (for scripts and tests).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "create") this.go(cx);
        else if ((c === "up" || c === "down") && !this.busy) { this.move(c === "down" ? 1 : -1); this.prefetchSoon(cx); cx.notify(); }
      }
    });
  }

  // The host calls this when the overlay goes, however it goes (Esc, a click beside
  // it, a reload). A checkout still running is handed to a detached finisher, which
  // runs setup and opens the space when it's done. Must return within 250 ms.
  async close(_cx) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    try {
      await G.handOff(exec, job);
      notify({ title: `Still creating ${job.name}`, body: "Its space opens when it's ready.", level: "info" });
    } catch (error) {
      notify({ title: `Lost track of ${job.name}`, body: `It may still be created at ${job.space.folder}: ${error?.message ?? error}`, level: "warning" });
    }
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  async load(cx, folder) {
    const errors = `${home()}/${G.ERRORS}`;
    const missed = ((await readTextFile(errors).catch(() => null)) ?? "").trim();
    if (missed) {
      this.notice = missed.split("\n").slice(-3).join("\n");
      await exec("rm", ["-f", errors]).catch(() => {});
      cx.notify();
    }
    try {
      if (this.on) {
        const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on });
        if (r.code !== 0 || !r.stdout.trim()) throw new Error(`Could not find the home folder on ${this.on}.`);
        this.userHome = r.stdout.trim();
      } else this.userHome = home();
      this.folder = folder || (this.space && place(this.space)) || this.userHome;
      const repo = await G.repoOf(this.git, this.folder);
      if (!repo) { this.repo = null; cx.notify(); return; }
      this.data = await G.loadRepo(this.git, repo);
      this.repo = repo;
      this.baseRef = this.data.candidates[0]?.ref ?? null;
      this.refilter();
      cx.notify();
      // Bring the current branch's upstream up to date so its ↓N is true. Only the
      // counts change, so nothing the person picked or typed is touched. Quietly:
      // a failure here shows again, louder, when Enter fetches.
      const current = this.data.candidates.find((c) => c.kind === "current");
      const up = this.data.candidates.find((c) => c.kind === "upstream" && c.remote);
      if (current && up && !(await this.fetchOnce(up))) {
        const ab = await G.aheadBehind(this.git, repo.top, current.ref, up.ref);
        if (ab) [current.ahead, current.behind] = ab;
        cx.notify();
      }
    } catch (error) {
      if (this.repo === undefined) this.repo = null;
      this.error = String(error?.message ?? error);
      cx.notify();
    }
  }

  // Resolves to "" or why the fetch failed. Callers at the same time share one fetch;
  // a success counts for FRESH_MS, a failure is retried by the next call.
  fetchOnce(c) {
    const key = `${this.on ?? ""}|${this.repo.main}|${c.ref}`;
    if (Date.now() - (fetchedAt.get(key) ?? 0) < FRESH_MS) return Promise.resolve("");
    let p = this.fetches.get(c.ref);
    if (!p) {
      p = G.fetchRef(exec, this.on, this.repo.top, c).then((failed) => {
        this.fetches.delete(c.ref);
        if (!failed) fetchedAt.set(key, Date.now());
        return failed;
      });
      this.fetches.set(c.ref, p);
    }
    return p;
  }

  base() {
    return this.data?.candidates.find((c) => c.ref === this.baseRef) ?? null;
  }

  // The name follows the base until someone types their own.
  autofill() {
    if (!this.data || (this.name.value() !== this.auto && this.name.value() !== "")) return;
    const base = this.base();
    this.auto = base ? G.autoName(base.name, this.data.taken) : "";
    if (this.name.value() === this.auto) return;
    this.name.set_value(this.auto);
    this.name.set_selected_range({ start: 0, end: this.auto.length });
  }

  refilter() {
    const words = this.filter.value().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.data?.candidates ?? [];
    this.shown = words.length ? all.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))) : all;
    if (!this.shown.some((c) => c.ref === this.baseRef)) this.select(this.shown[0]?.ref ?? null);
    this.top = 0;
    this.reveal(this.shown.findIndex((c) => c.ref === this.baseRef));
    this.autofill();
  }

  select(ref) {
    if (ref !== this.baseRef) this.staleOk = null;
    this.baseRef = ref;
    this.error = "";
    this.autofill();
  }

  // Starts fetching a remote base once the selection rests on it, so Enter seldom waits
  // for the network. 400 ms: holding ↓ through the list shouldn't fetch every row.
  prefetchSoon(cx) {
    const c = this.base();
    if (!c?.remote) return;
    cx.timer.after(400, () => { if (this.baseRef === c.ref && !this.busy) this.fetchOnce(c); });
  }

  move(step) {
    const n = this.shown.length;
    if (!n) return;
    const at = this.shown.findIndex((c) => c.ref === this.baseRef);
    const next = at < 0 ? 0 : Math.max(0, Math.min(n - 1, at + step));
    this.select(this.shown[next].ref);
    this.reveal(next);
  }

  reveal(i) {
    if (i < 0) return;
    if (i < this.top) this.top = i;
    if (i >= this.top + SHOWN) this.top = i - SHOWN + 1;
  }

  wheelBy(e, cx) {
    // Wheels report lines, touchpads pixels.
    this.wheel -= Math.abs(e.delta.y) < 4 ? e.delta.y * ROW : e.delta.y;
    const steps = Math.trunc(this.wheel / ROW);
    if (!steps) return;
    this.wheel -= steps * ROW;
    this.top = Math.max(0, Math.min(this.top + steps, this.shown.length - SHOWN));
    cx.notify();
  }

  key(e, cx) {
    // Esc while creating hides the dialog; close() lets the checkout finish on its own.
    if (e.key === "escape") { this.dismiss(); return cx.stop_propagation(); }
    if (this.busy) return;
    if (e.key === "up" || e.key === "down") { this.move(e.key === "down" ? 1 : -1); this.prefetchSoon(cx); cx.stop_propagation(); return cx.notify(); }
    if (e.key === "pageup" || e.key === "pagedown") { this.move(e.key === "pagedown" ? 8 : -8); this.prefetchSoon(cx); cx.stop_propagation(); return cx.notify(); }
    if (e.key === "tab") {
      if (this.focus === "name") { this.focus = "filter"; this.filter.focus(); } else { this.focus = "name"; this.name.focus(); }
      cx.stop_propagation();
      return cx.notify();
    }
  }

  // Opens the space already showing a checkout, else a new one there.
  openPath(path) {
    const inside = (p) => p === path || p.startsWith(`${path}/`);
    const s = spaces().find((s) => (s.machine ?? null) === this.on && inside(place(s) ?? ""));
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: path, machine: this.on });
  }

  go(cx) {
    if (this.busy || !this.repo || !this.data) return;
    const p = G.plan(this.name.value(), this.base(), this.data);
    if (p.error) { this.error = p.error; return cx.notify(); }
    if (p.mode === "open") { this.dismiss(); return this.openPath(p.path); }
    this.busy = true; // before spawn: Enter can arrive twice (input submit and a command)
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (await this.create(cx, p)) return this.dismiss();
      } catch (error) {
        // Waited too long: close() hands the still-running job to the finisher.
        if (error instanceof G.StillRunning) return this.dismiss();
        this.job = null;
        this.error = String(error?.message ?? error);
      }
      this.busy = false;
      this.status = "";
      cx.notify();
    });
  }

  async create(cx, p) {
    const say = (text) => { this.status = text; cx.notify(); };
    const wait = { sleep: (ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve())), read: (path) => readTextFile(path, { on: this.on }) };
    const warnings = [];

    const valid = await this.git(this.repo.top, ["check-ref-format", "--branch", p.name]);
    if (!valid.ok) throw new Error(`"${p.name}" isn't a valid branch name.`);

    let start = null;
    let pinned = null;
    if (p.mode === "new") {
      // The base's remote-tracking ref (for the current branch: its upstream's) is
      // fetched first, so the worktree starts from what the remote has now. A remote
      // base that can't be fetched stops here, as in the TUI, until a second Enter.
      const tracked = p.base.remote ? p.base : this.data.candidates.find((c) => c.ref === p.base.upstream && c.remote);
      if (tracked) {
        say(`Fetching ${tracked.label}…`);
        const failed = await this.fetchOnce(tracked);
        const why = failed.split("\n")[0];
        if (failed && p.base.kind === "current") warnings.push(`Couldn't fetch ${tracked.label}: ${why}`);
        else if (failed && this.staleOk?.ref !== p.base.ref) {
          const sha = await this.git(this.repo.top, ["rev-parse", "--verify", `${p.base.ref}^{commit}`]);
          if (!sha.ok) throw new Error(`Couldn't fetch ${tracked.label}: ${why}`);
          this.staleOk = { ref: p.base.ref, sha: sha.out };
          throw new Error(`Couldn't fetch ${tracked.label}: ${why}. ↵ again starts it from the last fetched ${sha.out.slice(0, 10)}.`);
        } else if (failed) {
          pinned = this.staleOk.sha; // what the message showed, even if the ref moved since
          warnings.push(`Started from the last fetched ${tracked.label} (${pinned.slice(0, 10)}); the fetch failed: ${why}`);
        }
      }
      const sp = await G.startPoint(this.git, this.repo, p.base);
      start = pinned ?? sp.ref;
      if (sp.note) warnings.push(`Started from the upstream: ${sp.note}.`);
    }

    const registered = await G.worktreePaths(this.git, this.repo.main);
    const path = await G.freePath(exec, this.on, ROOT(this.userHome), this.repo.name, p.name, registered);
    const setup = this.on ? null : await this.setupCommand(path);
    // Left unnamed so the space follows its folder and nests under the repo's.
    const space = { folder: path, ...(this.on ? { machine: this.on } : {}) };

    say(`Checking out into ${tilde(path, this.userHome)}…`);
    const op = { name: p.name, space, setup, on: this.on };
    const added = await this.runJob({ ...op, phase: "checkout" }, this.repo.main, G.addArgs(p, path, start), wait);
    if (added.code !== 0) throw new Error(gitError(added.log));

    if (setup) {
      say("Running worktree setup…");
      try {
        const r = await this.runJob({ ...op, phase: "setup" }, setup.cwd, setup.argv, { ...wait, timeoutMs: 5 * 60 * 1000 });
        if (r.code !== 0) warnings.push(`Worktree setup failed (exit ${r.code}): ${r.log.split("\n").slice(-3).join(" ")}`);
      } catch (error) {
        if (error instanceof G.StillRunning) throw error;
        this.job = { ...op, phase: "setup", dir: "" }; // setup is over, only the space is left
        warnings.push(`Worktree setup didn't start: ${error?.message ?? error}`);
      }
    }

    this.job = null;
    run("space.new", space);
    if (warnings.length) notify({ title: `Worktree ${p.name} is ready`, body: warnings.join("\n"), level: "warning", timeout: 12000 });
    return true;
  }

  // Starts a detached job and waits for it. this.job always says how to finish the
  // creation without this dialog: while the job runs it names the job's folder; once the
  // job succeeded, dir "" says this phase is done (a checkout still needs setup and the
  // space, a setup only the space). A failed checkout leaves nothing to finish.
  async runJob(job, cwd, argv, wait) {
    const dir = await G.jobDir(exec, this.on);
    this.job = { ...job, dir };
    await G.startJob(exec, this.on, dir, cwd, argv);
    const r = await G.waitJob(exec, this.on, dir, wait);
    this.job = r.code === 0 || job.phase === "setup" ? { ...job, dir: "" } : null;
    await G.removeJob(exec, this.on, dir);
    return r;
  }

  // The TUI's worktree-setup plugin, called the way herdr calls it on worktree.created:
  // { cwd, argv }, or null when it isn't installed or has no config. This machine only.
  async setupCommand(path) {
    const herdrHome = `${this.userHome}/.config/herdr`;
    let plugin;
    try { plugin = JSON.parse((await readTextFile(`${herdrHome}/plugins.json`)) ?? "[]").find((x) => x.plugin_id === SETUP_PLUGIN && x.enabled); }
    catch { return null; }
    const command = plugin?.events?.find((e) => e.on === "worktree.created")?.command;
    const configDir = `${herdrHome}/plugins/config/${SETUP_PLUGIN}`;
    if (!command?.length || !((await readTextFile(`${configDir}/config.toml`)) ?? "").trim()) return null;
    const env = [`HERDR_PLUGIN_CONFIG_DIR=${configDir}`, `HERDR_PLUGIN_EVENT_JSON=${JSON.stringify({ data: { worktree: { path } } })}`];
    return { cwd: plugin.plugin_root, argv: ["env", ...env, ...command] };
  }

  detail(c) {
    const bits = [c.kind];
    if (c.kind === "current" && c.behind) bits.push(`↓${c.behind}`);
    if (c.kind === "current" && c.ahead) bits.push(`↑${c.ahead}`);
    if (c.kind === "local" || c.kind === "remote") bits.push(ago(c.at));
    if (c.kind !== "current" && !c.remote && this.data.local.get(c.name)) bits.push("checked out");
    return bits.filter(Boolean).join(" · ");
  }

  row(c, i, t) {
    const on = c.ref === this.baseRef;
    return h_flex()
      .id(`wtn-${i}`)
      .h(ROW)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { if (!this.busy) { this.select(c.ref); this.prefetchSoon(cx); cx.notify(); } })
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.label))
      .child(div().flex_none().text_size(11).text_color(c.kind === "current" && c.behind ? t.blocked : c.kind === "default" || c.kind === "upstream" ? t.accent : t.dim).child(this.detail(c)));
  }

  list(t) {
    const n = this.shown.length;
    const height = SHOWN * ROW;
    const thumb = n > SHOWN ? Math.max(16, (height * SHOWN) / n) : 0;
    return div()
      .id("wtn-bases")
      .relative()
      .flex_none()
      .h(height)
      .overflow_hidden()
      .on_scroll_wheel((e, cx) => this.wheelBy(e, cx))
      .child(v_flex().children(this.shown.slice(this.top, this.top + SHOWN).map((c, k) => this.row(c, this.top + k, t))))
      .when(n === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No branch matches.")))
      .when(thumb > 0, (el) =>
        el.child(div().absolute().right(0).w(3).rounded(2).bg(t.border).h(thumb).top(((height - thumb) * this.top) / Math.max(1, n - SHOWN))),
      );
  }

  preview(t) {
    if (!this.repo || !this.data) return div();
    const p = G.plan(this.name.value(), this.base(), this.data);
    if (p.error) return div().text_color(t.dim).child(p.error);
    if (p.mode === "open") return div().text_color(t.muted).child(`${p.name} is already checked out at ${tilde(p.path, this.userHome)}. ↵ goes there.`);
    const what = p.mode === "existing" ? `Checks out the existing branch ${p.name} (the base isn't used).` : `New branch ${p.name} from ${p.base.label}.`;
    return v_flex()
      .gap(2)
      .child(div().text_color(t.muted).child(what))
      .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${tilde(ROOT(this.userHome), this.userHome)}/${this.repo.name}/${G.slug(p.name)}`));
  }

  render() {
    const t = theme();
    const r = this.repo;
    const field = (state, focus) =>
      Input.new(state).h(32).px(10).items_center().rounded(6).border(1).border_color(this.focus === focus ? t.accent : t.input).bg(t.background).text_color(t.foreground);
    const label = (text) => div().pt(4).text_size(11).text_color(t.dim).child(text);
    const count = this.data ? (this.shown.length === this.data.candidates.length ? `${this.shown.length}` : `${this.shown.length}/${this.data.candidates.length}`) : "";

    return v_flex()
      .id("worktree-new")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(6)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().font_semibold().text_color(t.foreground).child(`New worktree${r ? ` · ${r.name}` : ""}${this.on ? ` (${this.on})` : ""}`))
          .child(div().text_size(11).text_color(t.dim).child("esc")),
      )
      .when(Boolean(this.notice), (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Earlier, in the background: ${this.notice}`)))
      .when(r === undefined, (el) => el.child(div().text_color(t.muted).child("Reading the repo…")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.data), (el) =>
        el.child(
          // While creating, the controls stay visible but don't change what's being made.
          v_flex()
            .flex_1()
            .min_h(0)
            .gap(6)
            .when(this.busy, (el) => el.opacity(0.55))
            .child(h_flex().child(label("Base")).child(div().flex_1()).child(label(count)))
            .child(field(this.filter, "filter"))
            .child(this.list(t))
            .child(label("Name"))
            .child(field(this.name, "name"))
            .child(this.preview(t)),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(
        h_flex()
          .pt(4)
          .gap(6)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .when(this.busy, (el) => el.child(div().text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child(div().min_w(0).truncate().text_color(t.muted).child(this.status || "Working…")))
          .child(div().flex_1())
          .child(this.busy ? "esc keeps it going in the background" : "↑↓ base · tab filter/name · ↵ create"),
      );
  }
}
