import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, exec, home, focused, keys, nextCommand, readTextFile, notify, checking } from "herdr";

const PS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];

export default class ReadAloud extends View {
  init(_props, cx) {
    this.enabled = false;
    this.busy = false;
    this.script = `${home()}\\bin\\read-aloud.ps1`;
    this.stateFile = `${home()}\\.pi\\agent\\extensions\\.read-aloud-state.json`;
    this.lastDir = `${home()}\\.pi\\agent\\read-aloud\\last`;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(3000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle") this.toggle(cx);
        else if (command === "play") this.play(cx);
        else if (command === "stop") this.stop(cx);
      }
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      let enabled = false;
      try {
        const text = await readTextFile(this.stateFile);
        enabled = text ? JSON.parse(text).enabled === true : false;
      } catch (e) {
        enabled = false;
      }
      if (enabled !== this.enabled) {
        this.enabled = enabled;
        cx.notify();
      }
    });
  }

  reader(args) {
    return exec("powershell.exe", [...PS, this.script, ...args], { timeout: 20000 });
  }

  fail(what, e) {
    notify({ title: "Read aloud", body: `${what}: ${e && e.message ? e.message : e}`, level: "error" });
  }

  toggle(cx) {
    if (checking() || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await this.reader(["-Toggle"]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
        this.enabled = r.stdout.trim() === "on";
      } catch (e) {
        this.fail("Toggle failed", e);
      }
      this.busy = false;
      cx.notify();
    });
  }

  play(cx) {
    if (checking()) return;
    const terminal = focused()?.terminal;
    if (!terminal) {
      notify({ title: "Read aloud", body: "Focus a pi tab first.", level: "warning" });
      return;
    }
    const file = `${this.lastDir}\\${terminal.replace(/[^\w.-]/g, "_")}.txt`;
    cx.spawn(async () => {
      try {
        const text = await readTextFile(file);
        if (!text || !text.trim()) {
          notify({ title: "Read aloud", body: "No saved response for this tab yet.", level: "warning" });
          return;
        }
        const r = await this.reader(["-File", file, "-Now"]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      } catch (e) {
        this.fail("Play last failed", e);
      }
    });
  }

  stop(cx) {
    if (checking()) return;
    cx.spawn(async () => {
      try {
        const r = await this.reader(["-Stop"]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      } catch (e) {
        this.fail("Stop failed", e);
      }
    });
  }

  keyFor(action) {
    const b = keys().find((k) => k.action === action);
    return b ? b.keys.toUpperCase() : "";
  }

  button(t, id, label, action, color, onClick) {
    const key = this.keyFor(action);
    return h_flex().id(id).gap(5).items_center().px(6).h(20).rounded(4)
      .text_color(color)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label)
      .when(Boolean(key), (el) => el.child(div().text_size(10).text_color(t.dim).child(key)));
  }

  render() {
    const t = theme();
    const on = this.enabled;
    const dot = div().size(7).rounded(4).border(1).border_color(on ? t.done : t.dim).bg(on ? t.done : t.chrome);
    return h_flex().id("root").size_full().px(8).gap(4).items_center().justify_end()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .child(this.button(t, "toggle", h_flex().gap(6).items_center().child(dot).child(on ? "Read aloud: On" : "Read aloud: Off"),
        "read-aloud.toggle", on ? t.foreground : t.muted, (cx) => this.toggle(cx)))
      .child(this.button(t, "play", "Play last", "read-aloud.play", t.muted, (cx) => this.play(cx)))
      .child(this.button(t, "stop", "Stop", "read-aloud.stop", t.muted, (cx) => this.stop(cx)));
  }
}
