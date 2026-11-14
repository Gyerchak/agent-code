#!/usr/bin/env python3
"""Agent Code remote desktop: streams this PC's screen and sound to the phone app and plays back the phone's input.

Python with PyGObject because the xdg-desktop-portal handshake needs D-Bus file-descriptor passing and the capture
and encoding are GStreamer; neither is reachable from plain Node without installing a library.

Started on demand by Agent Code's phone server (src/context/remote.js) and stopped when the last phone leaves.

  stdin   one JSON command per line: {"cmd": "...", "id": n?, ...} (see Desktop.on_command)
  stdout  frames [type u8][length u32 BE][payload]
            1 video  [flags u8: 1 = keyframe][pts u64 BE µs][H.264 Annex B access unit, SPS/PPS before each IDR]
            2 audio  [pts u64 BE µs][Opus packet, 48 kHz stereo, 20 ms]
            3 json   UTF-8 JSON event: hello, screens, view, status, reply, error
  stderr  log lines

Screen and input go through one xdg-desktop-portal RemoteDesktop session (with ScreenCast): approved once on the PC,
remembered with a restore token (persist_mode 2) in the state folder. Sound is the default output's monitor.
Test mode (ACODE_DESKTOP_TEST=1 or --test): test pattern + test tone, two fake 1920x1080 screens; input, window,
desktop, app, file and screen-layout actions are only logged, never done.
"""
import base64
import json
import os
import signal
import struct
import subprocess
import sys
import threading
import time

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import Gio, GLib, Gst, GstVideo  # noqa: E402

TEST = os.environ.get("ACODE_DESKTOP_TEST") == "1" or "--test" in sys.argv
STATE = os.path.expanduser("~/.local/state/agent-code")
for i, arg in enumerate(sys.argv):
    if arg == "--state" and i + 1 < len(sys.argv):
        STATE = sys.argv[i + 1]
TOKEN_FILE = os.path.join(STATE, "desktop-portal-token")
ONE_SCREEN_FILE = os.path.join(STATE, "desktop-one-screen.json")
HOME = os.path.expanduser("~")

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
RD = "org.freedesktop.portal.RemoteDesktop"
SC = "org.freedesktop.portal.ScreenCast"

BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112, "back": 0x113, "forward": 0x114}
TERMINALS = {"konsole", "alacritty", "kitty", "foot", "wezterm", "org.wezfurlong.wezterm", "xterm", "yakuake", "ghostty", "com.mitchellh.ghostty", "terminator", "gnome-terminal", "org.gnome.ptyxis", "tilix", "st"}
KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V = 29, 42, 47


def log(*parts):
    print("[desktop]", *parts, file=sys.stderr, flush=True)


_out_lock = threading.Lock()
_out_broken = False


def emit(kind, payload):
    global _out_broken
    if _out_broken:
        return
    try:
        with _out_lock:
            sys.stdout.buffer.write(struct.pack(">BI", kind, len(payload)) + payload)
            sys.stdout.buffer.flush()
    except (BrokenPipeError, ValueError, OSError):
        # Agent Code went away: stop on the main loop (that also puts the screens back).
        _out_broken = True
        if DESKTOP:
            GLib.idle_add(lambda: (DESKTOP.stop(), False)[1])


def event(data):
    emit(3, json.dumps(data).encode())


def run(args, timeout=5):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except Exception as error:
        log("run failed", args[0], error)
        return ""


# ---------------------------------------------------------------------------
# The portal session: screens (one PipeWire stream per monitor) and input
# ---------------------------------------------------------------------------


class Portal:
    def __init__(self, bus):
        self.bus = bus
        self.sender = bus.get_unique_name()[1:].replace(".", "_")
        self.session = None
        self.fd = None
        self.streams = []
        self.counter = 0
        self.closed_sub = None

    def _token(self):
        self.counter += 1
        return f"acode{os.getpid()}_{self.counter}"

    def _request(self, iface, method, build, done, fail, fds=False):
        token = self._token()
        path = f"{PORTAL_PATH}/request/{self.sender}/{token}"
        sub = [None]

        def on_response(_conn, _sender, _path, _iface, _signal, params):
            self.bus.signal_unsubscribe(sub[0])
            code, results = params.unpack()
            if code == 0:
                done(results)
            else:
                fail("cancelled on the PC" if code == 1 else f"refused ({code})")

        sub[0] = self.bus.signal_subscribe(None, "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, on_response)

        def called(bus, result):
            try:
                bus.call_finish(result)
            except Exception as error:
                self.bus.signal_unsubscribe(sub[0])
                fail(str(error))

        self.bus.call(PORTAL, PORTAL_PATH, iface, method, build(token), None, Gio.DBusCallFlags.NONE, -1, None, called)

    def start(self, on_ready, on_fail, on_approval):
        restore = ""
        try:
            restore = open(TOKEN_FILE).read().strip()
        except OSError:
            pass
        session_token = self._token()

        def created(results):
            self.session = results["session_handle"]
            self.closed_sub = self.bus.signal_subscribe(None, "org.freedesktop.portal.Session", "Closed", self.session, None, Gio.DBusSignalFlags.NONE, lambda *a: self._closed())
            options = {"types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)}
            if restore:
                options["restore_token"] = GLib.Variant("s", restore)
            self._request(RD, "SelectDevices", lambda t: GLib.Variant("(oa{sv})", (self.session, {**options, "handle_token": GLib.Variant("s", t)})), devices, on_fail)

        def devices(_results):
            options = {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", True), "cursor_mode": GLib.Variant("u", 2)}
            self._request(SC, "SelectSources", lambda t: GLib.Variant("(oa{sv})", (self.session, {**options, "handle_token": GLib.Variant("s", t)})), sources, on_fail)

        def sources(_results):
            if not restore:
                on_approval()
            self._request(RD, "Start", lambda t: GLib.Variant("(osa{sv})", (self.session, "", {"handle_token": GLib.Variant("s", t)})), started, on_fail)

        def started(results):
            token = results.get("restore_token")
            if token:
                os.makedirs(STATE, exist_ok=True)
                with open(TOKEN_FILE, "w") as handle:
                    handle.write(token)
            self.streams = []
            for node, props in results.get("streams", []):
                x, y = props.get("position", (0, 0))
                w, h = props.get("size", (1920, 1080))
                self.streams.append({"node": node, "x": x, "y": y, "w": w, "h": h})
            if not self.streams:
                return on_fail("no screens were shared")
            try:
                reply, fds = self.bus.call_with_unix_fd_list_sync(PORTAL, PORTAL_PATH, SC, "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType("(h)"), Gio.DBusCallFlags.NONE, -1, None, None)
                self.fd = fds.get(reply.unpack()[0])
            except Exception as error:
                return on_fail(f"no PipeWire remote: {error}")
            on_ready(self.streams)

        self._request(RD, "CreateSession", lambda t: GLib.Variant("(a{sv})", ({"handle_token": GLib.Variant("s", t), "session_handle_token": GLib.Variant("s", session_token)},)), created, on_fail)

    def _closed(self):
        log("portal session closed")
        self.session = None
        GLib.idle_add(lambda: (DESKTOP.portal_closed(), False)[1])

    def close(self):
        if self.closed_sub is not None:
            self.bus.signal_unsubscribe(self.closed_sub)
            self.closed_sub = None
        if self.session:
            try:
                self.bus.call_sync(PORTAL, self.session, "org.freedesktop.portal.Session", "Close", None, None, Gio.DBusCallFlags.NONE, 2000, None)
            except Exception as error:
                log("session close", error)
        self.session = None
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None

    def notify(self, method, signature, *args):
        if not self.session:
            return
        self.bus.call(PORTAL, PORTAL_PATH, RD, method, GLib.Variant(signature, (self.session, {}, *args)), None, Gio.DBusCallFlags.NONE, -1, None, None)


# ---------------------------------------------------------------------------
# Everything else: pipelines, input, windows, desktops, apps, files, one-screen mode, phone microphone
# ---------------------------------------------------------------------------


class Desktop:
    def __init__(self):
        Gst.init(None)
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.portal = None if TEST else Portal(self.bus)
        self.streams = []
        self.view = 0  # a screen index, or "all"
        self.maxw, self.maxh = 2400, 1080
        self.bitrate = 8000
        self.fps = 30
        self.video = None
        self.video_variant = 0
        self.video_frames = 0
        self.layout = []
        self.audio = None
        self.audio_on = True
        self.mic = None
        self.mic_format = None
        self.icons = {}
        self.loop = GLib.MainLoop()
        self.stopping = False

    # -- start / stop --------------------------------------------------------

    def start(self):
        restore_outputs()
        event({"type": "hello", "test": TEST, "desktops": self.desktops(), "oneScreen": False})
        if TEST:
            GLib.timeout_add(50, lambda: (self.ready([{"node": 1, "x": 0, "y": 0, "w": 1920, "h": 1080}, {"node": 2, "x": 1920, "y": 0, "w": 1920, "h": 1080}]), False)[1])
        else:
            self.connect_portal()
        if self.audio_on:
            self.start_audio()

    def connect_portal(self):
        event({"type": "status", "state": "starting", "text": "Starting screen sharing…"})
        self.portal.start(self.ready, self.portal_failed, lambda: event({"type": "status", "state": "approval", "text": "Approve remote control on the PC (asked only the first time)"}))

    def portal_failed(self, why):
        log("portal failed:", why)
        event({"type": "status", "state": "error", "text": f"Screen sharing failed: {why}"})

    def portal_closed(self):
        if self.stopping:
            return
        self.stop_video()
        event({"type": "status", "state": "error", "text": "Screen sharing was stopped on the PC"})

    def ready(self, streams):
        self.streams = sorted(streams, key=lambda s: (s["x"], s["y"]))
        names = output_names()
        screens = [{"index": i, "name": names.get((s["x"], s["y"]), f"Screen {i + 1}"), "x": s["x"], "y": s["y"], "w": s["w"], "h": s["h"]} for i, s in enumerate(self.streams)]
        event({"type": "screens", "screens": screens})
        if self.view != "all" and (not isinstance(self.view, int) or self.view >= len(self.streams)):
            self.view = 0
        self.start_video()

    def stop(self):
        if self.stopping:
            return
        self.stopping = True
        self.stop_video()
        self.stop_audio()
        self.stop_mic()
        restore_outputs()
        if self.portal:
            self.portal.close()
        self.loop.quit()

    # -- video ---------------------------------------------------------------

    def source(self, index, stream):
        if TEST:
            pattern = ["ball", "smpte", "snow"][index % 3]
            return f"videotestsrc is-live=true pattern={pattern} ! video/x-raw,width={stream['w']},height={stream['h']},framerate={self.fps}/1 ! timeoverlay font-desc=\"Sans 48\""
        return f"pipewiresrc fd={self.portal.fd} path={stream['node']} always-copy=true keepalive-time=500 do-timestamp=true ! videorate drop-only=true max-rate={self.fps}"

    def output_size(self, w, h):
        scale = min(1.0, self.maxw / w, self.maxh / h)
        return max(320, int(w * scale) // 2 * 2), max(180, int(h * scale) // 2 * 2)

    def encoder(self, variant, ow, oh, cuda_ok):
        gop = self.fps * 4
        nv = f"nvh264enc name=enc preset=p4 tune=ultra-low-latency rc-mode=cbr bitrate={self.bitrate} gop-size={gop} bframes=0 zerolatency=true rc-lookahead=0 repeat-sequence-header=true"
        x264 = f"x264enc name=enc tune=zerolatency speed-preset=veryfast bitrate={self.bitrate} key-int-max={gop} bframes=0 threads=4 vbv-buf-capacity=300"
        variants = []
        if cuda_ok:
            variants.append(f"cudaupload ! cudaconvertscale ! video/x-raw(memory:CUDAMemory),format=NV12,width={ow},height={oh} ! {nv}")
        variants.append(f"videoconvertscale n-threads=4 ! video/x-raw,format=NV12,width={ow},height={oh} ! {nv}")
        variants.append(f"videoconvertscale n-threads=4 ! video/x-raw,format=I420,width={ow},height={oh} ! {x264}")
        return variants[variant] if variant < len(variants) else None

    def start_video(self):
        self.stop_video()
        if not self.streams:
            return
        if self.view == "all" and len(self.streams) > 1:
            minx = min(s["x"] for s in self.streams)
            miny = min(s["y"] for s in self.streams)
            tw = max(s["x"] + s["w"] for s in self.streams) - minx
            th = max(s["y"] + s["h"] for s in self.streams) - miny
            ow, oh = self.output_size(tw, th)
            k = ow / tw
            pads, branches = [], []
            self.layout = []
            for i, s in enumerate(self.streams):
                px, py = int((s["x"] - minx) * k), int((s["y"] - miny) * k)
                sw, sh = max(2, int(s["w"] * k) // 2 * 2), max(2, int(s["h"] * k) // 2 * 2)
                pads.append(f"sink_{i}::xpos={px} sink_{i}::ypos={py}")
                branches.append(f"{self.source(i, s)} ! videoconvertscale ! video/x-raw,format=BGRx,width={sw},height={sh} ! mix.sink_{i}")
                self.layout.append({"stream": i, "u": (s["x"] - minx) / tw, "v": (s["y"] - miny) / th, "uw": s["w"] / tw, "vh": s["h"] / th})
            head = f"compositor name=mix background=black ignore-inactive-pads=true {' '.join(pads)} ! video/x-raw,width={ow},height={oh},framerate={self.fps}/1"
            chain = self.encoder(self.video_variant, ow, oh, cuda_ok=False)
            text = f"{head} ! {chain} ! " + self.tail() + " " + " ".join(branches) if chain else None
        else:
            index = self.view if isinstance(self.view, int) else 0
            s = self.streams[index]
            ow, oh = self.output_size(s["w"], s["h"])
            self.layout = [{"stream": index, "u": 0, "v": 0, "uw": 1, "vh": 1}]
            chain = self.encoder(self.video_variant, ow, oh, cuda_ok=True)
            text = f"{self.source(index, s)} ! {chain} ! {self.tail()}" if chain else None
        if not text:
            event({"type": "status", "state": "error", "text": "No H.264 encoder works on this PC"})
            return
        log("video:", text)
        try:
            pipeline = Gst.parse_launch(text)
        except GLib.Error as error:
            log("video pipeline", error)
            return self.next_variant()
        self.video = pipeline
        self.video_frames = 0
        sink = pipeline.get_by_name("vsink")
        sink.connect("new-sample", self.on_video)
        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self.on_video_error)
        pipeline.set_state(Gst.State.PLAYING)
        event({"type": "view", "view": self.view, "width": ow, "height": oh, "layout": self.layout})

    @staticmethod
    def tail():
        return "h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink name=vsink emit-signals=true sync=false max-buffers=8 drop=false"

    def next_variant(self):
        self.stop_video()
        self.video_variant += 1
        if self.video_variant > 2:
            event({"type": "status", "state": "error", "text": "The screen could not be encoded (see Agent Code's log)"})
            return
        GLib.timeout_add(200, lambda: (self.start_video(), False)[1])

    def on_video_error(self, _bus, message):
        error, debug = message.parse_error()
        log("video error:", error.message, debug)
        if self.video_frames == 0:
            GLib.idle_add(lambda: (self.next_variant(), False)[1])
        else:
            event({"type": "status", "state": "error", "text": f"Screen stream stopped: {error.message}"})
            GLib.timeout_add(1000, lambda: (self.start_video(), False)[1])

    def on_video(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.EOS
        buffer = sample.get_buffer()
        ok, info = buffer.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        data = bytes(info.data)
        buffer.unmap(info)
        key = not buffer.has_flags(Gst.BufferFlags.DELTA_UNIT)
        pts = buffer.pts // 1000 if buffer.pts != Gst.CLOCK_TIME_NONE else int(time.monotonic() * 1e6)
        self.video_frames += 1
        if self.video_frames == 1:
            event({"type": "status", "state": "live", "text": ""})
        emit(1, struct.pack(">BQ", 1 if key else 0, pts) + data)
        return Gst.FlowReturn.OK

    def keyframe(self):
        if not self.video:
            return
        enc = self.video.get_by_name("enc")
        if enc:
            enc.get_static_pad("sink").send_event(GstVideo.video_event_new_downstream_force_key_unit(Gst.CLOCK_TIME_NONE, Gst.CLOCK_TIME_NONE, Gst.CLOCK_TIME_NONE, True, 0))

    def stop_video(self):
        if self.video:
            self.video.set_state(Gst.State.NULL)
            self.video.get_bus().remove_signal_watch()
            self.video = None

    # -- sound ---------------------------------------------------------------

    def start_audio(self):
        self.stop_audio()
        if TEST:
            src = "audiotestsrc is-live=true wave=sine freq=440 volume=0.05"
        else:
            sink = run(["pactl", "get-default-sink"]).strip()
            src = f"pulsesrc device={sink}.monitor buffer-time=40000 latency-time=10000 provide-clock=false" if sink else "pulsesrc"
        text = f"{src} ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! opusenc bitrate=128000 frame-size=20 ! appsink name=asink emit-signals=true sync=false max-buffers=50 drop=true"
        try:
            self.audio = Gst.parse_launch(text)
        except GLib.Error as error:
            log("audio pipeline", error)
            return
        self.audio.get_by_name("asink").connect("new-sample", self.on_audio)
        bus = self.audio.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", lambda _b, m: log("audio error:", m.parse_error()[0].message))
        self.audio.set_state(Gst.State.PLAYING)

    def on_audio(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.EOS
        buffer = sample.get_buffer()
        ok, info = buffer.map(Gst.MapFlags.READ)
        if ok:
            pts = buffer.pts // 1000 if buffer.pts != Gst.CLOCK_TIME_NONE else 0
            emit(2, struct.pack(">Q", pts) + bytes(info.data))
            buffer.unmap(info)
        return Gst.FlowReturn.OK

    def stop_audio(self):
        if self.audio:
            self.audio.set_state(Gst.State.NULL)
            self.audio.get_bus().remove_signal_watch()
            self.audio = None

    # -- the phone's microphone as a PC microphone ("Phone microphone") ------

    def start_mic(self, fmt):
        self.stop_mic()
        caps = "audio/x-opus,rate=48000,channels=1,channel-mapping-family=0" if fmt == "opus" else "audio/x-raw,format=S16LE,rate=48000,channels=1,layout=interleaved"
        decode = "opusdec plc=true ! " if fmt == "opus" else ""
        # A PipeWire source node that exists only while this runs: nothing to unload, gone if this process dies.
        sink = "fakesink sync=false" if TEST else 'pipewiresink mode=provide client-name="Agent Code" stream-properties="props,media.class=(string)Audio/Source/Virtual,node.name=(string)acode_phone_mic,node.description=(string)\\"Phone microphone\\""'
        text = f"appsrc name=micsrc is-live=true format=time do-timestamp=true caps={caps} ! {decode}audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=1 ! queue max-size-time=200000000 leaky=downstream ! {sink}"
        try:
            self.mic = Gst.parse_launch(text)
        except GLib.Error as error:
            log("mic pipeline", error)
            event({"type": "status", "state": "warning", "text": "The phone microphone could not be added on the PC"})
            return
        self.mic_format = fmt
        self.mic.set_state(Gst.State.PLAYING)
        log("phone microphone on", fmt)

    def mic_data(self, data):
        if not self.mic:
            return
        src = self.mic.get_by_name("micsrc")
        src.emit("push-buffer", Gst.Buffer.new_wrapped(base64.b64decode(data)))

    def stop_mic(self):
        if self.mic:
            self.mic.set_state(Gst.State.NULL)
            self.mic = None
            log("phone microphone off")

    # -- input ---------------------------------------------------------------

    def target(self, u, v):
        """A point of the shown picture (0..1) as (stream node, x, y) in that screen's pixels."""
        for part in self.layout:
            if part["u"] <= u <= part["u"] + part["uw"] and part["v"] <= v <= part["v"] + part["vh"]:
                s = self.streams[part["stream"]]
                return s["node"], (u - part["u"]) / part["uw"] * s["w"], (v - part["v"]) / part["vh"] * s["h"]
        part = self.layout[0] if self.layout else None
        if not part:
            return None
        s = self.streams[part["stream"]]
        return s["node"], min(max(u, 0), 1) * s["w"], min(max(v, 0), 1) * s["h"]

    def notify(self, method, signature, *args):
        if TEST:
            log("input", method, *[round(a, 1) if isinstance(a, float) else a for a in args])
            return
        self.portal.notify(method, signature, *args)

    def key(self, code, down):
        self.notify("NotifyKeyboardKeycode", "(oa{sv}iu)", int(code), 1 if down else 0)

    def type_text(self, text):
        """ASCII goes in as key symbols; anything else (ą, ś, emoji…) through the clipboard and a paste."""
        if all(32 <= ord(c) < 127 or c in "\n\t" for c in text):
            for c in text:
                sym = 0xFF0D if c == "\n" else 0xFF09 if c == "\t" else ord(c)
                self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", sym, 1)
                self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", sym, 0)
            return
        threading.Thread(target=self.paste, args=(text,), daemon=True).start()

    def paste(self, text):
        if TEST:
            log("paste", repr(text))
            return
        kept = None
        types = run(["wl-paste", "-l"]).split()
        if types:
            try:
                kept = (types[0], subprocess.run(["wl-paste", "-n", "-t", types[0]], capture_output=True, timeout=3).stdout)
            except Exception:
                kept = None
        subprocess.run(["wl-copy", text], timeout=3)
        time.sleep(0.08)
        terminal = active_window_class() in TERMINALS
        keys = [KEY_LEFTCTRL] + ([KEY_LEFTSHIFT] if terminal else []) + [KEY_V]
        for code in keys:
            self.key(code, True)
        for code in reversed(keys):
            self.key(code, False)
        time.sleep(0.4)
        if kept:
            subprocess.run(["wl-copy", "-t", kept[0]], input=kept[1], timeout=3)

    # -- KWin: virtual desktops, windows -------------------------------------

    def desktops(self):
        try:
            get = lambda name: self.bus.call_sync("org.kde.KWin", "/VirtualDesktopManager", "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.kde.KWin.VirtualDesktopManager", name)), None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
            current = get("current")
            rows = get("rows")
            return {"rows": rows, "list": [{"id": d[1], "name": d[2], "current": d[1] == current} for d in get("desktops")]}
        except Exception as error:
            log("desktops", error)
            return {"rows": 1, "list": []}

    def set_desktop(self, ident):
        if TEST:
            log("switch desktop", ident)
            return
        self.bus.call_sync("org.kde.KWin", "/VirtualDesktopManager", "org.freedesktop.DBus.Properties", "Set", GLib.Variant("(ssv)", ("org.kde.KWin.VirtualDesktopManager", "current", GLib.Variant("s", ident))), None, Gio.DBusCallFlags.NONE, 2000, None)

    def windows(self):
        out = []
        active = run(["kdotool", "getactivewindow"]).strip()
        for ident in run(["kdotool", "search", "--class", "."]).split():
            try:
                info = self.bus.call_sync("org.kde.KWin", "/KWin", "org.kde.KWin", "getWindowInfo", GLib.Variant("(s)", (ident,)), None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
            except Exception:
                continue
            if info.get("type", 0) != 0 or info.get("skipTaskbar") or not info.get("caption"):
                continue
            cx, cy = info.get("x", 0) + info.get("width", 0) / 2, info.get("y", 0) + info.get("height", 0) / 2
            screen = next((i for i, s in enumerate(self.streams) if s["x"] <= cx < s["x"] + s["w"] and s["y"] <= cy < s["y"] + s["h"]), None)
            out.append({"id": ident, "title": info["caption"], "app": info.get("resourceClass", ""), "minimized": bool(info.get("minimized")), "active": ident == active, "screen": screen, "desktops": list(info.get("desktops", []))})
        return out

    # -- apps, files ---------------------------------------------------------

    def apps(self):
        out = []
        for app in Gio.AppInfo.get_all():
            if not app.should_show():
                continue
            icon = icon_file(app.get_icon())
            if icon:
                self.icons[app.get_id()] = icon
            out.append({"id": app.get_id(), "name": app.get_display_name(), "about": app.get_description() or "", "icon": icon})
        out.sort(key=lambda a: a["name"].lower())
        return out

    def launch(self, ident):
        if TEST:
            log("launch", ident)
            return
        app = Gio.DesktopAppInfo.new(ident)
        if not app:
            raise ValueError("no such app")
        app.launch([], None)

    @staticmethod
    def safe_path(p):
        real = os.path.realpath(os.path.expanduser(p or "~"))
        if real != HOME and not real.startswith(HOME + os.sep):
            raise ValueError("only files in your home folder")
        return real

    def files(self, p, hidden=False):
        folder = self.safe_path(p)
        entries = []
        with os.scandir(folder) as it:
            for entry in it:
                if entry.name.startswith(".") and not hidden:
                    continue
                try:
                    is_dir = entry.is_dir()
                    stat = entry.stat()
                except OSError:
                    continue
                entries.append({"name": entry.name, "dir": is_dir, "size": 0 if is_dir else stat.st_size, "time": int(stat.st_mtime)})
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        return {"path": folder, "parent": os.path.dirname(folder) if folder != HOME else None, "home": HOME, "entries": entries[:800]}

    def open_path(self, p):
        real = self.safe_path(p)
        if TEST:
            log("open", real)
            return
        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(real).get_uri(), None)

    # -- "everything on one screen" ------------------------------------------

    def one_screen(self, on):
        if on:
            outputs = kscreen_outputs()
            enabled = [o for o in outputs if o.get("enabled")]
            if len(enabled) < 2:
                return {"oneScreen": False}
            shown = self.streams[self.view] if isinstance(self.view, int) and self.view < len(self.streams) else None
            keep = next((o for o in enabled if shown and (o["pos"]["x"], o["pos"]["y"]) == (shown["x"], shown["y"])), None) or min(enabled, key=lambda o: o.get("priority", 99))
            os.makedirs(STATE, exist_ok=True)
            with open(ONE_SCREEN_FILE, "w") as handle:
                json.dump({"outputs": [{"name": o["name"], "enabled": o["enabled"], "pos": o["pos"], "mode": o.get("currentModeId"), "priority": o.get("priority")} for o in outputs]}, handle)
            args = [f"output.{o['name']}.disable" for o in enabled if o is not keep]
            kscreen(args)
            index = next((i for i, s in enumerate(self.streams) if (s["x"], s["y"]) == (keep["pos"]["x"], keep["pos"]["y"])), 0)
            if not TEST:
                # The other screens' streams end with their outputs; show the one that stays.
                self.streams = [self.streams[index]] if index < len(self.streams) else self.streams[:1]
                index = 0
            self.view = index
            self.start_video()
            return {"oneScreen": True, "view": self.view}
        restore_outputs()
        if not TEST and self.portal:
            # Screens that come back need new streams: a new portal session (no dialog with the saved token).
            self.stop_video()
            self.portal.close()
            GLib.timeout_add(1500, lambda: (self.connect_portal(), False)[1])
        return {"oneScreen": False}

    # -- commands from Agent Code (one JSON line each) ----------------------

    def on_command(self, msg):
        cmd = msg.get("cmd")
        if cmd == "move":
            hit = self.target(float(msg["x"]), float(msg["y"]))
            if hit:
                self.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", int(hit[0]), float(hit[1]), float(hit[2]))
        elif cmd == "rel":
            self.notify("NotifyPointerMotion", "(oa{sv}dd)", float(msg["dx"]), float(msg["dy"]))
        elif cmd == "button":
            self.notify("NotifyPointerButton", "(oa{sv}iu)", BUTTONS.get(msg.get("button", "left"), 0x110), 1 if msg.get("down") else 0)
        elif cmd == "click":
            code = BUTTONS.get(msg.get("button", "left"), 0x110)
            for _ in range(int(msg.get("count", 1))):
                self.notify("NotifyPointerButton", "(oa{sv}iu)", code, 1)
                self.notify("NotifyPointerButton", "(oa{sv}iu)", code, 0)
        elif cmd == "scroll":
            if msg.get("dy"):
                self.notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", 0, int(msg["dy"]))
            if msg.get("dx"):
                self.notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)", 1, int(msg["dx"]))
        elif cmd == "key":
            self.key(msg["code"], bool(msg.get("down")))
        elif cmd == "combo":
            codes = [int(c) for c in msg.get("codes", [])]
            for code in codes:
                self.key(code, True)
            for code in reversed(codes):
                self.key(code, False)
        elif cmd == "text":
            self.type_text(str(msg.get("text", "")))
        elif cmd == "view":
            self.view = "all" if msg.get("view") == "all" else int(msg.get("view", 0))
            self.video_variant = 0
            self.start_video()
        elif cmd == "quality":
            self.maxw = max(320, min(3840, int(msg.get("maxw", self.maxw))))
            self.maxh = max(180, min(2160, int(msg.get("maxh", self.maxh))))
            self.bitrate = max(500, min(30000, int(msg.get("bitrate", self.bitrate))))
            if self.streams:
                self.start_video()
        elif cmd == "keyframe":
            self.keyframe()
        elif cmd == "audio":
            self.audio_on = bool(msg.get("on"))
            self.start_audio() if self.audio_on else self.stop_audio()
        elif cmd == "mic":
            self.start_mic(msg.get("format", "opus")) if msg.get("on") else self.stop_mic()
        elif cmd == "micdata":
            self.mic_data(msg.get("data", ""))
        elif cmd == "desktops":
            return self.desktops()
        elif cmd == "desktop":
            self.set_desktop(str(msg["desktop"]))
            return self.desktops()
        elif cmd == "windows":
            return {"windows": self.windows()}
        elif cmd == "activate":
            if TEST:
                log("activate", msg.get("window"))
            else:
                run(["kdotool", "windowactivate", str(msg["window"])])
        elif cmd == "apps":
            return {"apps": self.apps()}
        elif cmd == "launch":
            self.launch(str(msg["app"]))
        elif cmd == "files":
            return self.files(msg.get("path"), bool(msg.get("hidden")))
        elif cmd == "open":
            self.open_path(str(msg["path"]))
        elif cmd == "oneScreen":
            return self.one_screen(bool(msg.get("on")))
        elif cmd == "stop":
            self.stop()
        else:
            raise ValueError(f"unknown command {cmd}")
        return None

    def read_stdin(self, channel, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            self.stop()
            return False
        line = channel.readline()
        if not line:
            self.stop()
            return False
        try:
            msg = json.loads(line)
        except ValueError:
            return True
        try:
            result = self.on_command(msg)
            if "id" in msg:
                event({"type": "reply", "id": msg["id"], "ok": True, **(result or {})})
        except Exception as error:
            log("command failed", msg.get("cmd"), error)
            if "id" in msg:
                event({"type": "reply", "id": msg["id"], "ok": False, "error": str(error)})
        return True


# ---------------------------------------------------------------------------
# Helpers that don't need the session
# ---------------------------------------------------------------------------


def kscreen_outputs():
    try:
        return [o for o in json.loads(run(["kscreen-doctor", "-j"]) or "{}").get("outputs", []) if o.get("connected")]
    except ValueError:
        return []


def output_names():
    return {(o["pos"]["x"], o["pos"]["y"]): o["name"] for o in kscreen_outputs() if o.get("enabled")}


def kscreen(args):
    if not args:
        return
    if TEST:
        log("kscreen-doctor", *args)
        return
    run(["kscreen-doctor", *args], timeout=15)


def restore_outputs():
    """Put the screens back as they were before "everything on one screen" (also after a crash: the file stays)."""
    try:
        saved = json.load(open(ONE_SCREEN_FILE))
    except (OSError, ValueError):
        return
    args = []
    for o in saved.get("outputs", []):
        if not o.get("enabled"):
            continue
        args += [f"output.{o['name']}.enable", f"output.{o['name']}.position.{o['pos']['x']},{o['pos']['y']}"]
        if o.get("mode"):
            args.append(f"output.{o['name']}.mode.{o['mode']}")
    for o in saved.get("outputs", []):
        if o.get("enabled") and o.get("priority"):
            args.append(f"output.{o['name']}.priority.{o['priority']}")
    log("restoring screens")
    kscreen(args)
    try:
        os.remove(ONE_SCREEN_FILE)
    except OSError:
        pass


def active_window_class():
    ident = run(["kdotool", "getactivewindow"]).strip()
    if not ident:
        return ""
    return run(["kdotool", "getwindowclassname", ident]).strip().lower()


ICON_DIRS = [
    os.path.join(HOME, ".local/share/icons/hicolor"),
    "/usr/share/icons/hicolor",
    "/var/lib/flatpak/exports/share/icons/hicolor",
    os.path.join(HOME, ".local/share/flatpak/exports/share/icons/hicolor"),
]
ICON_SIZES = ["64x64", "48x48", "128x128", "96x96", "256x256", "scalable", "32x32"]


def icon_file(icon):
    if icon is None:
        return None
    if isinstance(icon, Gio.FileIcon):
        path = icon.get_file().get_path()
        return path if path and path.endswith((".png", ".svg")) and os.path.exists(path) else None
    if not isinstance(icon, Gio.ThemedIcon):
        return None
    for name in icon.get_names():
        for base in ICON_DIRS:
            for size in ICON_SIZES:
                for ext in (".png", ".svg"):
                    path = os.path.join(base, size, "apps", name + ext)
                    if os.path.exists(path):
                        return path
        for path in (f"/usr/share/icons/breeze/apps/48/{name}.svg", f"/usr/share/pixmaps/{name}.png", f"/usr/share/pixmaps/{name}.svg"):
            if os.path.exists(path):
                return path
    return None


DESKTOP = None


def main():
    global DESKTOP
    if "--restore" in sys.argv:
        restore_outputs()
        return
    DESKTOP = Desktop()
    channel = GLib.IOChannel.unix_new(sys.stdin.fileno())
    GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, DESKTOP.read_stdin)
    try:
        gi.require_version("GLibUnix", "2.0")
        from gi.repository import GLibUnix

        signal_add = GLibUnix.signal_add
    except (ImportError, ValueError):
        signal_add = GLib.unix_signal_add
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal_add(GLib.PRIORITY_HIGH, sig, lambda: (DESKTOP.stop(), False)[1])
    DESKTOP.start()
    try:
        DESKTOP.loop.run()
    finally:
        DESKTOP.stop()


if __name__ == "__main__":
    main()
