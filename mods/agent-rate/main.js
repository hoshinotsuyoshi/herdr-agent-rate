import { View, div, image } from "gpui-kit";
import { Popover, h_flex, v_flex } from "gpui-base";
import { exec, home, readTextFile, theme } from "herdr";

// The 5-hour and weekly rate-limit windows of Claude, Codex and Antigravity, through agent-rate (bin/agent-rate).
// Claude: `agent-rate statusline`, the Claude Code status line command, writes the status
// line's rate_limits to ~/.cache/claude/rate-limits.json, and this reads that file.
// Codex: `agent-rate codex` prints the last rate_limits in Codex's newest session logs.
// Antigravity: `agent-rate statusline`, configured in Antigravity CLI's settings.json,
// writes the converted rate limits to ~/.cache/antigravity/rate-limits.json, and this reads that file.
// All are the account's values and change whenever any session gets a reply.
// No shell: the same code runs on macOS, Linux and Windows.
//
// Each window has two bars. The top one is the time gone in the window (the pace, the
// tortoise), the bottom one is the usage (the hare). When usage gets ahead, it turns red.
const pad = (n) => String(n).padStart(2, "0");
const clamp = (x) => Math.max(0, Math.min(100, x));
// The month in English, so no one reads the date in the wrong order (11/12 is December 11 in much of the world)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WINDOWS = [
  { key: "five_hour", label: "5h", seconds: 5 * 3600, when: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}` },
  { key: "seven_day", label: "week", seconds: 7 * 86400, when: (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`, whenUsed: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}` },
];

// Each returns the JSON text, or null. A missing file or agent-rate shows "—" for that source
const readClaude = () => readTextFile(`${home()}/.cache/claude/rate-limits.json`);
const readAgy = () => readTextFile(`${home()}/.cache/antigravity/rate-limits.json`);
// agent-rate on PATH, else in ~/.local/bin: a login shell's PATH may not have it, though an
// interactive one does
const AGENT_RATE = ["agent-rate", `${home()}/.local/bin/agent-rate`];
const readCodex = async () => {
  for (const cmd of AGENT_RATE) {
    try {
      const r = await exec(cmd, ["codex"], { timeout: 10000 });
      return r.code === 0 ? r.stdout : null;
    } catch {
      // not there (exec rejects when it can't start): try the next one
    }
  }
  return null;
};

const SOURCES = [
  // Icons that ship with Herdr in ~/.config/herdr-app/icons (in color, so drawn with image)
  { key: "claude", label: "Claude", icon: "icons/claude.svg", read: readClaude },
  { key: "codex", label: "Codex", icon: "icons/codex.svg", read: readCodex },
  { key: "agy", label: "Antigravity", icon: "icons/antigravity.svg", read: readAgy },
];

export default class Rate extends View {
  init(_props, cx) {
    this.rate = {};
    this.open = false;
    // The time bars move too, so redraw even when the files don't change
    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      for (const src of SOURCES) {
        try {
          const text = await src.read();
          this.rate[src.key] = text?.trim() ? JSON.parse(text) : null;
        } catch {
          this.rate[src.key] = null;
        }
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const now = Date.now() / 1000;

    const windowState = (src, w) => {
      const v = this.rate[src.key]?.[w.key];
      // A window past resets_at counts from 0% again, so don't show the old value
      const live = Boolean(v && v.resets_at > now);
      const time = live ? clamp(100 - ((v.resets_at - now) / w.seconds) * 100) : null;
      const used = live ? clamp(v.used_percentage) : null;
      const over = live && used > time;
      const reset = live ? new Date(v.resets_at * 1000) : null;
      return { w, live, time, used, over, reset };
    };

    const snapshots = SOURCES.map((src) => {
      const windows = WINDOWS.map((w) => windowState(src, w));
      return { src, windows, live: windows.some((s) => s.live) };
    });
    const active = snapshots.filter((s) => s.live);

    const formatPct = (s) => (s.live ? `${Math.round(s.used)}` : "—");
    const pctColor = (s) => (!s.live ? t.dim : s.over ? t.blocked : t.foreground);

    const compactTextLen = (snap, weekOnly) => {
      const [five, week] = snap.windows;
      if (weekOnly) {
        const target = week.live ? week : five;
        return formatPct(target).length + 1;
      }
      if (week.live) return formatPct(five).length + 1 + formatPct(week).length + 1;
      return formatPct(five).length + 3;
    };

    // Estimate width at 11px (~7px/char + 12px icon + 3px gap) inside a ~224px trigger area;
    // if 3 active sources wouldn't fit with both windows, fall back to week-only.
    const estimatedWidth = (weekOnly) =>
      active.reduce((sum, s) => sum + 15 + compactTextLen(s, weekOnly) * 7, 0) +
      Math.max(0, active.length - 1) * 8;
    const weekOnly = active.length >= 3 && estimatedWidth(false) > 216;

    const compactItem = (snap) => {
      const [five, week] = snap.windows;
      const parts = [];
      if (weekOnly) {
        const target = week.live ? week : five;
        parts.push(
          div().text_color(pctColor(target)).child(formatPct(target)),
          div().text_color(t.dim).child("%"),
        );
      } else if (week.live) {
        parts.push(
          div().text_color(pctColor(five)).child(formatPct(five)),
          div().text_color(t.dim).child("/"),
          div().text_color(pctColor(week)).child(formatPct(week)),
          div().text_color(t.dim).child("%"),
        );
      } else {
        parts.push(
          div().text_color(pctColor(five)).child(formatPct(five)),
          div().text_color(t.dim).child("%/—"),
        );
      }
      return h_flex().id(`compact-${snap.src.key}`).gap(3).items_center().flex_none()
        .child(image(snap.src.icon).size(12).flex_none())
        .child(h_flex().items_center().whitespace_nowrap().children(parts));
    };

    const trigger = h_flex()
      .id("agent-rate-trigger")
      .w_full()
      .h(31)
      .px(14)
      .gap(6)
      .items_center()
      .justify_between()
      .cursor_pointer()
      .bg(this.open ? t.hover : t.chrome)
      .hover((el) => el.bg(t.hover))
      .child(
        h_flex().flex_1().min_w(0).gap(8).items_center().overflow_hidden()
          .children(
            active.length > 0
              ? active.map(compactItem)
              : [div().text_color(t.dim).whitespace_nowrap().child("Rate —")],
          ),
      )
      .child(
        div().flex_none().text_color(this.open ? t.foreground : t.dim)
          .child(this.open ? "▾" : "▴"),
      );

    const bar = (id, name, pct, color, text, right) =>
      h_flex().id(id).h(13).gap(6).items_center()
        .child(div().w(28).flex_none().text_color(t.dim).child(name))
        .child(div().flex_1().h(5).rounded(3).bg(t.hover)
          .child(div().h_full().rounded(3).bg(color).w(`${pct ?? 0}%`)))
        .child(div().w(30).flex_none().text_color(pct === null ? t.dim : color === t.blocked ? t.blocked : t.foreground).child(text))
        .child(div().w(40).flex_none().text_color(t.dim).child(right));

    const group = (src, s) =>
      h_flex().id(`${src.key}-${s.w.key}`).gap(8).items_start()
        .child(div().w(30).flex_none().text_color(t.dim).child(s.w.label))
        .child(v_flex().flex_1().min_w(0)
          .child(bar(`${src.key}-${s.w.key}-time`, "time", s.time, t.muted, s.live ? `${Math.round(s.time)}%` : "—", s.reset ? s.w.when(s.reset) : ""))
          .child(bar(`${src.key}-${s.w.key}-used`, "used", s.used, s.over ? t.blocked : t.accent, s.live ? `${Math.round(s.used)}%` : "—", s.reset && s.w.whenUsed ? s.w.whenUsed(s.reset) : "")));

    const detail = v_flex()
      .id("agent-rate-detail")
      .w(252)
      .mb(4)
      .px(12)
      .py(10)
      .gap(8)
      .text_size(11)
      .bg(t.chrome)
      .border_1()
      .border_color(t.border)
      .rounded(6)
      .shadow_lg()
      .children(
        snapshots.map(({ src, windows }) =>
          v_flex().id(src.key).gap(3)
            .child(h_flex().gap(5).items_center()
              .child(image(src.icon).size(12).flex_none())
              .child(div().text_color(t.dim).child(src.label)))
            .children(windows.map((s) => group(src, s))),
        ),
      );

    return v_flex()
      .size_full()
      .justify_center()
      .text_size(11)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(
        Popover.new("agent-rate-popover")
          .anchor("bottom_left")
          .open(this.open)
          .overlay_closable(true)
          .on_open_change((open, cx) => {
            this.open = open;
            cx.notify();
          })
          .trigger(trigger)
          .content(detail),
      );
  }
}
