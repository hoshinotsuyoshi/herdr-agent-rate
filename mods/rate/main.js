import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, readTextFile, theme } from "herdr";

// The 5-hour and weekly rate-limit windows of Claude and Codex, through agent-rate (bin/agent-rate).
// Claude: `agent-rate statusline`, the Claude Code status line command, writes the status
// line's rate_limits to ~/.cache/claude/rate-limits.json, and this reads that file.
// Codex: `agent-rate codex` prints the last rate_limits in Codex's newest session logs.
// Both are the account's values and change whenever any session gets a reply.
// No shell: the same code runs on macOS, Linux and Windows.
//
// Each window has two bars. The top one is the time gone in the window (the pace, the
// tortoise), the bottom one is the usage (the hare). When usage gets ahead, it turns red.
const pad = (n) => String(n).padStart(2, "0");
const clamp = (x) => Math.max(0, Math.min(100, x));

const WINDOWS = [
  { key: "five_hour", label: "5h", seconds: 5 * 3600, when: (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}` },
  { key: "seven_day", label: "week", seconds: 7 * 86400, when: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
];

// Each returns the JSON text, or null. A missing file or agent-rate shows "—" for that source
const readClaude = () => readTextFile(`${home()}/.cache/claude/rate-limits.json`);
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
];

export default class Rate extends View {
  init(_props, cx) {
    this.rate = {};
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
    const bar = (id, name, pct, color, text, right) =>
      h_flex().id(id).h(13).gap(6).items_center()
        .child(div().w(28).flex_none().text_color(t.dim).child(name))
        .child(div().flex_1().h(5).rounded(3).bg(t.hover)
          .child(div().h_full().rounded(3).bg(color).w(`${pct ?? 0}%`)))
        .child(div().w(30).flex_none().text_color(pct === null ? t.dim : color === t.blocked ? t.blocked : t.foreground).child(text))
        .child(div().w(34).flex_none().text_color(t.dim).child(right));
    const group = (src, w) => {
      const v = this.rate[src.key]?.[w.key];
      // A window past resets_at counts from 0% again, so don't show the old value
      const live = v && v.resets_at > now;
      const time = live ? clamp(100 - ((v.resets_at - now) / w.seconds) * 100) : null;
      const used = live ? clamp(v.used_percentage) : null;
      const over = live && used > time;
      return h_flex().id(`${src.key}-${w.key}`).gap(8).items_start()
        .child(div().w(30).flex_none().text_color(t.dim).child(w.label))
        .child(v_flex().flex_1().min_w(0)
          .child(bar(`${src.key}-${w.key}-time`, "time", time, t.muted, live ? `${Math.round(time)}%` : "—", live ? w.when(new Date(v.resets_at * 1000)) : ""))
          .child(bar(`${src.key}-${w.key}-used`, "used", used, over ? t.blocked : t.accent, live ? `${Math.round(used)}%` : "—", "")));
    };
    return v_flex().size_full().px(14).py(6).gap(5).justify_center().text_size(11).bg(t.chrome).border_t(1).border_color(t.border)
      .children(SOURCES.map((src) => v_flex().id(src.key).gap(3)
        .child(h_flex().gap(5).items_center()
          .child(image(src.icon).size(12).flex_none())
          .child(div().text_color(t.dim).child(src.label)))
        .children(WINDOWS.map((w) => group(src, w)))));
  }
}
