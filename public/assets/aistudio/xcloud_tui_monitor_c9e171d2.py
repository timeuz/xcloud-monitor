#!/usr/bin/env python3
"""
Xbox Cloud Gaming (xCloud) Brazil — Sci-Fi / Cyberpunk TUI Telemetry & Diagnostic Monitor.

Implements the complete technical specification from ./XCLOUD.md:
- 60 FPS decoupled reactive TUI HUD powered by Textual and Rich
- Asynchronous low-level network probing (ICMP via aioping, TCP/HTTP Bufferbloat burst via
  asyncio.open_connection, and on-demand TTL traceroute via Scapy)
- Real-time statistical processing:
  * Instantaneous RTT & Simple Moving Average (SMA) over sliding window N
  * EWMA Jitter according to RFC 3550 Section 6.4.1 (smoothing factor 1/16)
  * Packet Loss percentage over transmission window
  * Concurrent synthetic Bufferbloat delta (loaded RTT vs idle RTT)
- Multilabel heuristic diagnostic engine weighted by severity (1 to 4):
  * Severity 1: BGP_HAIRPINNING (120 ms <= RTT <= 150 ms — route leak to US PoPs CIX-ATL / Ashburn)
  * Severity 2: HIGH_PACKET_LOSS (Packet Loss > 0.10%)
  * Severity 3: BUFFERBLOAT_SATURATION (Bufferbloat Delta > 50.0 ms)
  * Severity 4: WIFI_24GHZ_INSTABILITY (2.4 GHz Wi-Fi with Jitter > 15.0 ms)
- Linux Capabilities privilege validation without root/sudo:
  sudo setcap cap_net_raw+ep $(which python3)
"""

from __future__ import annotations

import argparse
import asyncio
from collections import deque
from dataclasses import dataclass, field
import functools
import math
import os
import platform
import shutil
import socket
import struct
import sys
import time
from typing import Any, Callable, Deque, Dict, Iterable, List, Optional, Tuple

from rich import box
from rich.align import Align
from rich.columns import Columns
from rich.console import Console, Group, RenderableType
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.rule import Rule
from rich.style import Style
from rich.table import Table
from rich.text import Text

# ---------------------------------------------------------------------------
# Optional Low-Level Networking Libraries with Built-in Async/Raw Fallbacks
# ---------------------------------------------------------------------------
def compute_icmp_checksum(data: bytes) -> int:
    """Computes RFC 1071 16-bit one's complement checksum for ICMP headers."""
    s = 0
    count_to = (len(data) // 2) * 2
    count = 0
    while count < count_to:
        this_val = data[count + 1] * 256 + data[count]
        s = s + this_val
        s = s & 0xFFFFFFFF
        count += 2
    if count_to < len(data):
        s = s + data[len(data) - 1]
        s = s & 0xFFFFFFFF
    s = (s >> 16) + (s & 0xFFFF)
    s = s + (s >> 16)
    answer = ~s & 0xFFFF
    return (answer >> 8) | ((answer << 8) & 0xFF00)


try:
    import aioping  # type: ignore
except ImportError:
    import errno

    class _AiopingFallbackModule:
        """Fallback async ICMP / TCP ping module compatible with aioping.ping(host, timeout)."""

        _checksum = staticmethod(compute_icmp_checksum)
        _seq_counter: int = 0
        _dns_cache: Dict[Tuple[str, int], Tuple[float, int, str]] = {}

        @classmethod
        async def ping(cls, dest_addr: str, timeout: float = 1.5, family: Optional[int] = None) -> float:
            """
            Sends an asynchronous ICMP/ICMPv6 Echo Request via SOCK_RAW (when CAP_NET_RAW is enabled)
            or Linux unprivileged SOCK_DGRAM/IPPROTO_ICMP(V6); falls back to bounded TCP SYN probes
            if ICMP sockets are blocked or filtered (e.g. Azure load balancers). Returns RTT in seconds.
            """
            loop = asyncio.get_running_loop()
            overall_deadline = time.perf_counter() + timeout
            addr_family = family or socket.AF_UNSPEC

            # Fast-path for literal IPv4 / IPv6 addresses to avoid thread-pool contention during parallel bursts
            resolved_family: Optional[int] = None
            target_ip: Optional[str] = None
            is_hostname = True
            for cand_family in (socket.AF_INET, socket.AF_INET6):
                if family is not None and family != cand_family:
                    continue
                try:
                    socket.inet_pton(cand_family, dest_addr)
                    resolved_family = cand_family
                    target_ip = dest_addr
                    is_hostname = False
                    break
                except OSError:
                    continue

            if resolved_family is None or target_ip is None:
                now = time.perf_counter()
                cached = cls._dns_cache.get((dest_addr, addr_family))
                if cached and cached[0] > now:
                    resolved_family, target_ip = cached[1], cached[2]
                else:
                    target_names = (
                        ("s8brazilsouth.blob.core.windows.net", dest_addr)
                        if dest_addr == "brazilsouth.blob.core.windows.net"
                        else (dest_addr,)
                    )
                    for name_to_resolve in target_names:
                        try:
                            req_family = socket.AF_INET6 if (":" in name_to_resolve and family is None) else addr_family
                            rem_time = max(0.15, overall_deadline - time.perf_counter())
                            addr_info = await asyncio.wait_for(
                                loop.run_in_executor(
                                    None,
                                    lambda n=name_to_resolve, fam=req_family: socket.getaddrinfo(n, None, fam, socket.SOCK_STREAM),
                                ),
                                timeout=rem_time,
                            )
                            if not addr_info:
                                continue
                            candidate_ip = str(addr_info[0][4][0])
                            # If brazilsouth resolved to US East 20.209.1.1 wildcard fallback, prefer regional s8brazilsouth
                            if name_to_resolve == "brazilsouth.blob.core.windows.net" and candidate_ip.startswith("20.209."):
                                continue
                            resolved_family = addr_info[0][0]
                            target_ip = candidate_ip
                            cls._dns_cache[(dest_addr, addr_family)] = (now + 60.0, resolved_family, target_ip)
                            break
                        except (OSError, asyncio.TimeoutError):
                            continue
                    if resolved_family is None or target_ip is None:
                        raise TimeoutError(f"DNS resolution failed for {dest_addr}")

            # 1. Attempt raw ICMP socket (CAP_NET_RAW or root) or Linux unprivileged DGRAM ICMP/ICMPv6 socket
            is_ipv6 = resolved_family == socket.AF_INET6
            icmp_proto = (
                getattr(socket, "IPPROTO_ICMPV6", 58)
                if is_ipv6
                else getattr(socket, "IPPROTO_ICMP", 1)
            )
            echo_req_type = 128 if is_ipv6 else 8
            echo_rep_type = 129 if is_ipv6 else 0

            sock: Optional[socket.socket] = None
            is_raw_icmp = False
            for sock_type, raw_flag in ((socket.SOCK_RAW, True), (socket.SOCK_DGRAM, False)):
                try:
                    sock = socket.socket(resolved_family, sock_type, icmp_proto)
                    sock.setblocking(False)
                    is_raw_icmp = raw_flag
                    break
                except (PermissionError, OSError):
                    sock = None

            # Skip ICMP directly for known Azure Blob HTTPS hostnames to save timeout budget
            skip_icmp = dest_addr.endswith(".blob.core.windows.net")
            rem_after_dns = max(0.01, overall_deadline - time.perf_counter())
            icmp_deadline = (
                time.perf_counter() + min(0.20, rem_after_dns * 0.40)
                if is_hostname
                else time.perf_counter() + (rem_after_dns * 0.75)
            )

            cls._seq_counter = (cls._seq_counter + 1) & 0x7FFFFFFF
            seq_no = (cls._seq_counter % 65534) + 1
            packet_id = ((os.getpid() & 0xFFFF) ^ ((cls._seq_counter * 2654435761) & 0xFFFF)) & 0xFFFF
            expected_v4_src = socket.inet_pton(socket.AF_INET, target_ip) if not is_ipv6 else b""

            if sock is not None and not skip_icmp:
                try:
                    header = struct.pack("!BBHHH", echo_req_type, 0, 0, packet_id, seq_no)
                    payload = struct.pack("!dI", time.perf_counter(), cls._seq_counter) + b"XCLOUD-HUD"
                    chksum = compute_icmp_checksum(header + payload) if not is_ipv6 else 0
                    packet = (
                        struct.pack("!BBHHH", echo_req_type, 0, chksum, packet_id, seq_no)
                        + payload
                    )

                    t0 = time.perf_counter()
                    dest_sockaddr = (target_ip, 0, 0, 0) if is_ipv6 else (target_ip, 0)
                    await loop.sock_sendto(sock, packet, dest_sockaddr)

                    while True:
                        remaining = min(overall_deadline, icmp_deadline) - time.perf_counter()
                        if remaining <= 0:
                            break
                        raw_in = await asyncio.wait_for(loop.sock_recv(sock, 1024), timeout=remaining)
                        t1 = time.perf_counter()
                        if is_raw_icmp and not is_ipv6:
                            if len(raw_in) >= 28:
                                ihl = (raw_in[0] & 0x0F) * 4
                                src_ip_bytes = raw_in[12:16]
                                if len(raw_in) >= ihl + 8 and src_ip_bytes == expected_v4_src:
                                    icmp_header = raw_in[ihl : ihl + 8]
                                    r_type, _r_code, _r_chk, r_id, r_seq = struct.unpack("!BBHHH", icmp_header)
                                    if r_type == echo_rep_type and r_id == packet_id and r_seq == seq_no:
                                        return max(0.0001, t1 - t0)
                        else:
                            if len(raw_in) >= 8:
                                r_type, _r_code, _r_chk, _r_id, r_seq = struct.unpack("!BBHHH", raw_in[:8])
                                if r_type == echo_rep_type and r_seq == seq_no:
                                    return max(0.0001, t1 - t0)
                except OSError as exc:
                    if getattr(exc, "errno", None) in (
                        errno.ENETUNREACH,
                        errno.EHOSTUNREACH,
                        errno.EADDRNOTAVAIL,
                    ):
                        raise TimeoutError(f"Network unreachable for {dest_addr}") from exc
                except asyncio.TimeoutError:
                    pass
                finally:
                    sock.close()

            # 2. Unprivileged / ICMP-filtered fallback: bounded non-blocking TCP handshake timing (443 / 80 / 53)
            ports = (443, 80, 53)
            for idx, port in enumerate(ports):
                remaining = overall_deadline - time.perf_counter()
                if remaining <= 0.01:
                    break
                # Allocate primary budget (75%) to port 443 so HTTPS endpoints (Azure Blob) do not starve
                per_port_timeout = remaining * 0.75 if idx == 0 else remaining / max(1, len(ports) - idx)
                t0 = time.perf_counter()
                try:
                    conn_coro = asyncio.open_connection(target_ip, port)
                    _reader, writer = await asyncio.wait_for(conn_coro, timeout=per_port_timeout)
                    elapsed = max(0.0001, time.perf_counter() - t0)
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except Exception:
                        pass
                    return elapsed
                except (asyncio.TimeoutError, OSError):
                    continue

            raise TimeoutError(f"Probe to {dest_addr} timed out after {timeout}s")

    aioping = _AiopingFallbackModule()


try:
    from scapy.all import ICMP as ScapyICMP, IP as ScapyIP, sr1 as scapy_sr1  # type: ignore

    HAS_NATIVE_SCAPY = True
except ImportError:
    HAS_NATIVE_SCAPY = False

    class ScapyIP:  # type: ignore
        """Lightweight Scapy IP packet representation for TTL traceroute probing."""

        def __init__(self, dst: str = "8.8.8.8", ttl: int = 64):
            self.dst = dst
            self.ttl = ttl
            self.src = "0.0.0.0"
            self.layers: List[Any] = [self]

        def __truediv__(self, other: Any) -> "ScapyIP":
            self.layers.append(other)
            return self

    class ScapyICMP:  # type: ignore
        """Lightweight Scapy ICMP layer representation."""

        def __init__(self, type: int = 8, code: int = 0):
            self.type = type
            self.code = code

    def scapy_sr1(packet: ScapyIP, timeout: float = 0.5, verbose: int = 0, **_kwargs: Any) -> Optional[Any]:
        """
        Sends an IP/ICMP probe with custom TTL when raw or DGRAM ICMP sockets are available,
        returning a response object with `.src` and `.type`, or None on timeout/unprivileged.
        Supports Linux unprivileged `IP_RECVERR` + `MSG_ERRQUEUE` on `SOCK_DGRAM` sockets
        so intermediate `ICMP_TIME_EXCEEDED` (type 11) hops are captured without root/CAP_NET_RAW.
        """
        _ = verbose

        class _Reply:
            def __init__(self, src: str, rtype: int):
                self.src = src
                self.type = rtype

        try:
            import select

            target_ip = socket.gethostbyname(packet.dst)
            icmp_proto = getattr(socket, "IPPROTO_ICMP", 1)
            ip_recverr_opt = getattr(socket, "IP_RECVERR", 11)
            msg_errqueue_flag = getattr(socket, "MSG_ERRQUEUE", 0x2000)

            for sock_type, is_raw in ((socket.SOCK_RAW, True), (socket.SOCK_DGRAM, False)):
                try:
                    with socket.socket(socket.AF_INET, sock_type, icmp_proto) as sock:
                        sock.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, int(packet.ttl))
                        if not is_raw:
                            try:
                                sock.setsockopt(socket.SOL_IP, ip_recverr_opt, 1)
                            except OSError:
                                pass
                        sock.settimeout(timeout)
                        pkt_id = os.getpid() & 0xFFFF
                        header = struct.pack("!BBHHH", 8, 0, 0, pkt_id, int(packet.ttl))
                        payload = b"XCLOUD-TTL-TRACE"
                        chksum = compute_icmp_checksum(header + payload)
                        raw_pkt = struct.pack("!BBHHH", 8, 0, chksum, pkt_id, int(packet.ttl)) + payload
                        sock.sendto(raw_pkt, (target_ip, 0))

                        if not is_raw and hasattr(sock, "recvmsg"):
                            try:
                                select.select([sock], [], [sock], timeout)
                            except Exception:
                                pass
                            try:
                                data, addr = sock.recvfrom(1024)
                                icmp_type = data[0] if data else 0
                                return _Reply(addr[0], icmp_type)
                            except OSError:
                                data, ancdata, _flags, _addr = sock.recvmsg(1024, 1024, msg_errqueue_flag)
                                for _clevel, _ctype, cdata in ancdata:
                                    if len(cdata) >= 24:
                                        icmp_type = int(cdata[5])
                                        hop_ip = socket.inet_ntoa(cdata[20:24])
                                        return _Reply(hop_ip, icmp_type)
                                continue

                        data, addr = sock.recvfrom(1024)
                        if is_raw:
                            ihl = (data[0] & 0x0F) * 4 if data else 20
                            icmp_type = data[ihl] if len(data) > ihl else 0
                        else:
                            icmp_type = data[0] if data else 0
                        return _Reply(addr[0], icmp_type)
                except (PermissionError, OSError):
                    continue
        except Exception:
            pass
        return None


# ---------------------------------------------------------------------------
# Optional Textual Framework Import with Rich 60-FPS Reactive Fallback
# ---------------------------------------------------------------------------
try:
    from textual import work as textual_work  # type: ignore
    from textual.app import App as TextualApp, ComposeResult  # type: ignore
    from textual.binding import Binding  # type: ignore
    from textual.reactive import reactive  # type: ignore
    from textual.widgets import Footer, Header, Static  # type: ignore

    HAS_NATIVE_TEXTUAL = True
except ImportError:
    HAS_NATIVE_TEXTUAL = False

    class Binding:  # type: ignore
        """Fallback key binding descriptor mirroring textual.binding.Binding."""

        def __init__(self, key: str, action: str, description: str = "", show: bool = True):
            self.key = key
            self.action = action
            self.description = description
            self.show = show

    class _ReactiveDescriptor:
        """Reactive attribute descriptor mirroring textual.reactive.reactive."""

        def __init__(self, default: Any):
            self.default = default
            self.attr_name = ""

        def __set_name__(self, owner: Any, name: str) -> None:
            self.attr_name = f"_reactive_{name}"
            self.public_name = name

        def __get__(self, instance: Any, owner: Any = None) -> Any:
            if instance is None:
                return self
            return getattr(instance, self.attr_name, self.default)

        def __set__(self, instance: Any, value: Any) -> None:
            old_value = getattr(instance, self.attr_name, self.default)
            setattr(instance, self.attr_name, value)
            watcher = getattr(instance, f"watch_{self.public_name}", None)
            if callable(watcher) and old_value != value:
                watcher(value)

    def reactive(default: Any, **_kwargs: Any) -> Any:  # type: ignore
        return _ReactiveDescriptor(default)

    def textual_work(func: Optional[Callable[..., Any]] = None, **_kwargs: Any) -> Any:
        """Decorator mirroring @textual.work for scheduling async background workers."""

        def _decorator(fn: Callable[..., Any]) -> Callable[..., asyncio.Task[Any]]:
            @functools.wraps(fn)
            def _wrapper(self_obj: Any, *args: Any, **kw: Any) -> asyncio.Task[Any]:
                coro = fn(self_obj, *args, **kw)
                task = asyncio.create_task(coro)
                if hasattr(self_obj, "_background_tasks"):
                    self_obj._background_tasks.append(task)
                return task

            return _wrapper

        if func is not None and callable(func):
            return _decorator(func)
        return _decorator

    class Static:  # type: ignore
        """Fallback Widget mirroring textual.widgets.Static."""

        def __init__(self, renderable: RenderableType = "", *, id: Optional[str] = None, classes: Optional[str] = None):
            self._renderable: RenderableType = renderable
            self.id = id
            self.classes = classes

        def update(self, renderable: RenderableType) -> None:
            self._renderable = renderable

        def render(self) -> RenderableType:
            return self._renderable

    class Header(Static):  # type: ignore
        pass

    class Footer(Static):  # type: ignore
        pass

    ComposeResult = Iterable[Any]  # type: ignore

    class TextualApp:  # type: ignore
        """
        High-frequency 60 FPS Rich Live fallback engine implementing TextualApp lifecycle
        and interactive keybindings when the `textual` package is not installed.
        """

        CSS: str = ""
        TITLE: str = "xCloud TUI Monitor"
        SUB_TITLE: str = "Azure brazilsouth (AS8075)"
        BINDINGS: List[Binding] = []

        def __init__(self) -> None:
            self._background_tasks: List[asyncio.Task[Any]] = []
            self._intervals: List[asyncio.Task[Any]] = []
            self._running: bool = False
            self._widgets: Dict[str, Static] = {}
            self.console = Console()

        def compose(self) -> ComposeResult:
            return []

        def query_one(self, selector: str, _expect_type: Any = None) -> Static:
            key = selector.lstrip("#")
            if key in self._widgets:
                return self._widgets[key]
            widget = Static(id=key)
            self._widgets[key] = widget
            return widget

        def set_interval(self, interval: float, callback: Callable[[], Any]) -> asyncio.Task[Any]:
            async def _runner() -> None:
                while self._running:
                    res = callback()
                    if asyncio.iscoroutine(res):
                        await res
                    await asyncio.sleep(interval)

            task = asyncio.create_task(_runner())
            self._intervals.append(task)
            return task

        def exit(self, result: Any = None) -> None:
            _ = result
            self._running = False

        async def action_quit(self) -> None:
            self.exit()

        def handle_key(self, key: str) -> Optional[asyncio.Task[Any]]:
            """Dispatches a pressed key to the bound `action_<name>` method."""
            normalized = key.lower()
            for binding in getattr(self, "BINDINGS", []):
                if binding.key.lower() == normalized:
                    action_fn = getattr(self, f"action_{binding.action}", None)
                    if callable(action_fn):
                        res = action_fn()
                        if asyncio.iscoroutine(res):
                            task = asyncio.create_task(res)
                            self._background_tasks.append(task)
                            return task
                    break
            return None

        async def run_async(
            self,
            headless: bool = False,
            run_seconds: Optional[float] = None,
            **_kwargs: Any,
        ) -> None:
            self._running = True
            for widget in self.compose():
                if getattr(widget, "id", None):
                    self._widgets[widget.id] = widget
            on_mount = getattr(self, "on_mount", None)
            if callable(on_mount):
                res = on_mount()
                if asyncio.iscoroutine(res):
                    await res

            start_t = time.perf_counter()
            if headless:
                while self._running:
                    await asyncio.sleep(1.0 / 60.0)
                    if run_seconds is not None and (time.perf_counter() - start_t) >= run_seconds:
                        self.exit()
            else:
                fd: Optional[int] = None
                old_term_settings: Any = None
                try:
                    import select
                    import termios
                    import tty

                    if sys.stdin is not None and sys.stdin.isatty():
                        fd = sys.stdin.fileno()
                        old_term_settings = termios.tcgetattr(fd)
                        tty.setcbreak(fd)
                except Exception:
                    fd = None
                    old_term_settings = None

                try:
                    with Live(
                        self._render_full_screen(),
                        console=self.console,
                        refresh_per_second=60,
                        screen=True,
                        transient=False,
                    ) as live:
                        while self._running:
                            if fd is not None:
                                try:
                                    import select

                                    rlist, _, _ = select.select([fd], [], [], 0.0)
                                    if rlist:
                                        ch = os.read(fd, 1).decode("utf-8", errors="ignore")
                                        if ch:
                                            self.handle_key(ch)
                                except Exception:
                                    pass
                            live.update(self._render_full_screen())
                            await asyncio.sleep(1.0 / 60.0)
                            if run_seconds is not None and (time.perf_counter() - start_t) >= run_seconds:
                                self.exit()
                finally:
                    if fd is not None and old_term_settings is not None:
                        try:
                            import termios

                            termios.tcsetattr(fd, termios.TCSADRAIN, old_term_settings)
                        except Exception:
                            pass

            for task in self._intervals + self._background_tasks:
                task.cancel()
            await asyncio.gather(*(self._intervals + self._background_tasks), return_exceptions=True)

        def _render_full_screen(self) -> RenderableType:
            render_fn = getattr(self, "build_dashboard_renderable", None)
            if callable(render_fn):
                return render_fn()
            return Group(*(w.render() for w in self._widgets.values()))

        def run(self) -> None:
            try:
                asyncio.run(self.run_async())
            except KeyboardInterrupt:
                pass


# ---------------------------------------------------------------------------
# Color Palette & Hollywood Cyberpunk HUD Constants (Section 1 of Spec)
# ---------------------------------------------------------------------------
NEON_GREEN = "#00ff66"
ELECTRIC_CYAN = "#00f0ff"
WARNING_AMBER = "#ffaa00"
CRITICAL_RED = "#ff003c"
DIM_CYAN = "#2b6f7e"
DARK_BG = "#060d12"

TARGET_FPS = 60
FRAME_INTERVAL_SEC = 1.0 / TARGET_FPS  # ~16.67 ms for 60 FPS reactive UI loop

# Strict Threshold Matrix Constants (Section 3 of XCLOUD.md)
RTT_GOOD_MAX_MS = 20.0
RTT_EXTENDED_NATIONAL_MS = 40.0
RTT_WARNING_MAX_MS = 50.0
RTT_CRITICAL_MIN_MS = 60.0
BGP_HAIRPIN_MIN_MS = 120.0
BGP_HAIRPIN_MAX_MS = 150.0

JITTER_GOOD_MAX_MS = 2.0
JITTER_WARNING_MAX_MS = 10.0
JITTER_CRITICAL_MIN_MS = 15.0

LOSS_GOOD_MAX_PCT = 0.00
LOSS_WARNING_MAX_PCT = 0.05
LOSS_CRITICAL_MIN_PCT = 0.10

BUFFERBLOAT_GOOD_MAX_MS = 5.0
BUFFERBLOAT_WARNING_MAX_MS = 25.0
BUFFERBLOAT_CRITICAL_MIN_MS = 50.0

REQUIRED_SETCAP_CMD = "sudo setcap cap_net_raw+ep $(which python3)"
READLINK_SETCAP_CMD = "sudo setcap cap_net_raw+ep $(readlink -f $(which python3))"

# Default primary target: Microsoft AS8075 Direct Edge at IX.br São Paulo (no CLI arg required)
DEFAULT_PRIMARY_HOST = "187.16.218.144"

# Fallback / candidate hosts for dynamic primary selection in Brazil (Microsoft AS8075 & Azure brazilsouth)
PRIMARY_TARGET_CANDIDATES: List[str] = [
    "187.16.218.144",                   # IX.br SP IPv4 #1 (AS8075)
    "187.16.218.139",                   # IX.br SP IPv4 #2 (AS8075)
    "s8brazilsouth.blob.core.windows.net", # AzureSpeed Telemetry SP (HTTP/TCP 80-443)
    "brazilsouth.blob.core.windows.net",   # Azure Datacenter brazilsouth (HTTPS/TCP 443)
    "45.68.80.73",                       # IX.br Rio de Janeiro PIX
    "200.192.108.42",                    # IX.br Campinas PIX
    "64.191.233.147",                    # Equinix São Paulo SP1-SP4
    "8.8.8.8",                           # Anycast DNS fallback (Google Anycast Brasil - TCP 53/ICMP)
]

# Strategic Endpoints Catalog (4 Categories for Xbox Cloud Gaming Brazil Telemetry)
STRATEGIC_ENDPOINTS: List[Dict[str, Any]] = [
    # Categoria 1: Hosts de Borda Direta da Microsoft no Brasil (AS8075)
    {
        "id": "ix_sp_v4_1",
        "category": "borda_brasil",
        "group": "IX.br São Paulo (AS26162 / AS8075)",
        "label": "IX.br SP IPv4 #1",
        "host": "187.16.218.144",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "ix_sp_v4_2",
        "category": "borda_brasil",
        "group": "IX.br São Paulo (AS26162 / AS8075)",
        "label": "IX.br SP IPv4 #2",
        "host": "187.16.218.139",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "ix_sp_v6_1",
        "category": "borda_brasil",
        "group": "IX.br São Paulo (AS26162 / AS8075)",
        "label": "IX.br SP IPv6 #1",
        "host": "2001:12f8::218:144",
        "ip_version": "IPv6",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "ix_sp_v6_2",
        "category": "borda_brasil",
        "group": "IX.br São Paulo (AS26162 / AS8075)",
        "label": "IX.br SP IPv6 #2",
        "host": "2001:12f8::218:139",
        "ip_version": "IPv6",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "equinix_sp_v4_1",
        "category": "borda_brasil",
        "group": "Equinix São Paulo (Barueri SP1–SP4)",
        "label": "Equinix SP IPv4 #1",
        "host": "64.191.233.147",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "equinix_sp_v4_2",
        "category": "borda_brasil",
        "group": "Equinix São Paulo (Barueri SP1–SP4)",
        "label": "Equinix SP IPv4 #2",
        "host": "64.191.233.148",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "equinix_sp_v6_1",
        "category": "borda_brasil",
        "group": "Equinix São Paulo (Barueri SP1–SP4)",
        "label": "Equinix SP IPv6 #1",
        "host": "2001:504:0:7::8075:1",
        "ip_version": "IPv6",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "equinix_sp_v6_2",
        "category": "borda_brasil",
        "group": "Equinix São Paulo (Barueri SP1–SP4)",
        "label": "Equinix SP IPv6 #2",
        "host": "2001:504:0:7::8075:2",
        "ip_version": "IPv6",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "ix_rj",
        "category": "ix_nacional",
        "group": "Outros PIX do IX.br (Abrangência Nacional)",
        "label": "IX.br Rio de Janeiro",
        "host": "45.68.80.73",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "ix_campinas",
        "category": "ix_nacional",
        "group": "Outros PIX do IX.br (Abrangência Nacional)",
        "label": "IX.br Campinas",
        "host": "200.192.108.42",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "ix_fortaleza",
        "category": "ix_nacional",
        "group": "Outros PIX do IX.br (Abrangência Nacional)",
        "label": "IX.br Fortaleza",
        "host": "45.68.74.84",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    # Categoria 2: Endpoints do Datacenter Azure Brazil South (brazilsouth)
    {
        "id": "azure_brazilsouth_blob",
        "category": "azure_brazilsouth",
        "group": "Datacenter Azure Brazil South (brazilsouth)",
        "label": "Azure Storage brazilsouth",
        "host": "brazilsouth.blob.core.windows.net",
        "ip_version": "HTTPS/TCP",
        "probe_type": "http_tcp",
    },
    {
        "id": "azure_brazilsouth_telemetry",
        "category": "azure_brazilsouth",
        "group": "Datacenter Azure Brazil South (brazilsouth)",
        "label": "Telemetria HTTP AzureSpeed (SP)",
        "host": "s8brazilsouth.blob.core.windows.net",
        "ip_version": "HTTP/80-443",
        "probe_type": "http_telemetry",
    },
    # Categoria 3: Hosts de Referência Internacional (Para Detecção de BGP Hairpinning)
    {
        "id": "us_equinix_miami",
        "category": "referencia_internacional",
        "group": "Referência Internacional EUA (Hairpinning BGP)",
        "label": "Equinix Miami (EUA)",
        "host": "198.32.242.188",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "us_equinix_atlanta",
        "category": "referencia_internacional",
        "group": "Referência Internacional EUA (Hairpinning BGP)",
        "label": "Equinix Atlanta (EUA)",
        "host": "198.32.182.105",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
    {
        "id": "us_equinix_ashburn",
        "category": "referencia_internacional",
        "group": "Referência Internacional EUA (Hairpinning BGP)",
        "label": "Equinix Ashburn (EUA)",
        "host": "206.126.236.148",
        "ip_version": "IPv4",
        "probe_type": "icmp_tcp",
    },
]

# Known US PoP indicators for International Hairpinning validation (Section 4.1 + Miami/Atlanta/Ashburn)
US_HAIRPIN_POP_SIGNATURES = (
    "cix-atl",
    "atl",
    "atlanta",
    "ix-1668",
    "198.32.132.",
    "198.32.182.",
    "miami",
    "mia",
    "198.32.242.",
    "ashburn",
    "iad",
    "ix-2572",
    "206.126.236.",
    "digitalrealty",
    "us-east",
)

# Microsoft AS8075 / Azure xCloud IPv4 prefixes used to identify active WebRTC UDP media sessions
MICROSOFT_AS8075_IPV4_PREFIXES = (
    "13.",
    "20.",
    "40.",
    "51.",
    "52.",
    "64.191.",
    "104.44.",
    "104.214.",
    "187.16.218.",
    "191.232.",
    "191.233.",
    "191.234.",
    "191.235.",
    "191.236.",
    "191.237.",
    "191.238.",
    "191.239.",
)


# ---------------------------------------------------------------------------
# Data Structures (Section 5 of XCLOUD.md)
# ---------------------------------------------------------------------------
@dataclass
class ClientContextMetadata:
    """Metadados do ambiente do usuário baseados no r/xcloud telemetry inputs."""

    device_os: str = "Linux / Ubuntu 22.04 LTS"
    execution_medium: str = "Browser Google Chrome v122.0"
    browser_extensions: List[str] = field(
        default_factory=lambda: ["uBlock Origin", "xCloud Better extension"]
    )
    app_version: str = "N/A (Web Client)"
    client_region: str = "São Paulo, Brasil"
    azure_region: str = "brazilsouth (São Paulo - AS8075)"
    interconnection_mode: str = "IX.br SP (AS26162) / PNI 100G / MAPS"
    addressing_mode: str = "IPv6 Nativo / CGNAT IPv4"


@dataclass
class NetworkMetrics:
    """Estrutura contendo o estado quantitativo atualizado da rede."""

    rtt_ms: float = 0.0
    jitter_ms: float = 0.0
    packet_loss_pct: float = 0.0
    bufferbloat_delta_ms: float = 0.0
    is_wifi_2_4ghz: bool = False
    ttl_hop_count: int = 0
    samples_sent: int = 0
    samples_lost: int = 0
    rtt_avg_ms: float = 0.0
    decode_time_status: str = "< 5 ms"


# ---------------------------------------------------------------------------
# Linux Capability & System Deployment Validator (Section 6.1 of XCLOUD.md)
# ---------------------------------------------------------------------------
def validate_linux_capabilities(python_executable: Optional[str] = None) -> Dict[str, Any]:
    """
    Validates whether the Python interpreter has CAP_NET_RAW enabled on Linux
    and diagnoses the `Invalid file 'setcap' for capability operation` symlink/shell error
    when running `sudo setcap cap_net_raw+ep $(which python3)`.
    Also checks whether Linux unprivileged ICMP (`SOCK_DGRAM` via `net.ipv4.ping_group_range`)
    is available so ICMP works natively without needing `setcap` or root.
    """
    raw_candidate = python_executable or shutil.which("python3") or sys.executable or "/usr/bin/python3"
    is_symlink = os.path.islink(raw_candidate)
    exe_path = os.path.realpath(python_executable or sys.executable or raw_candidate)
    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    has_cap_net_raw = False
    cap_eff_hex = "0000000000000000"

    # 1. Inspect /proc/self/status CapEff bitmask (CAP_NET_RAW is bit 13 -> 0x2000)
    if sys.platform.startswith("linux") and os.path.exists("/proc/self/status"):
        try:
            with open("/proc/self/status", "r", encoding="utf-8") as status_file:
                for line in status_file:
                    if line.startswith("CapEff:") or line.startswith("CapPrm:"):
                        hex_val = line.split(":", 1)[1].strip()
                        if line.startswith("CapEff:"):
                            cap_eff_hex = hex_val
                        if int(hex_val, 16) & (1 << 13):
                            has_cap_net_raw = True
        except (OSError, ValueError):
            pass

    # 2. Check getcap output on the resolved Python binary if available
    getcap_bin = shutil.which("getcap")
    getcap_output = ""
    if getcap_bin and os.path.exists(exe_path):
        try:
            import subprocess

            proc = subprocess.run(
                [getcap_bin, exe_path],
                capture_output=True,
                text=True,
                timeout=1.5,
                check=False,
            )
            getcap_output = (proc.stdout or "").strip()
            if "cap_net_raw" in getcap_output:
                has_cap_net_raw = True
        except Exception:
            pass

    # 3. Check if Linux unprivileged ICMP DGRAM socket is enabled (net.ipv4.ping_group_range)
    has_unprivileged_icmp = False
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM, getattr(socket, "IPPROTO_ICMP", 1)) as test_sock:
            _ = test_sock
            has_unprivileged_icmp = True
    except (PermissionError, OSError):
        has_unprivileged_icmp = False

    if is_root:
        has_cap_net_raw = True

    resolved_cmd = f"sudo setcap cap_net_raw+ep {exe_path}"
    symlink_error_explanation = (
        f"NOTA: \"Invalid file 'setcap' for capability operation\" ocorre porque $(which python3) "
        f"({raw_candidate}) é um symlink para {exe_path}: o kernel retorna EINVAL em symlinks "
        f"(setcap exige arquivo ELF regular) e o binário setcap (libcap) imprime argv[0] ('setcap') "
        f"na mensagem de erro. Solução: {READLINK_SETCAP_CMD}  (ou diretamente: {resolved_cmd})"
    )

    if has_cap_net_raw:
        status_msg = "CAP_NET_RAW ATIVO (Sockets ICMP Raw operacionais sem root)"
    elif has_unprivileged_icmp:
        status_msg = (
            f"ICMP DGRAM ATIVO SEM ROOT (ping_group_range OK) — Para Raw Socket: {resolved_cmd}"
        )
    else:
        status_msg = (
            f"CAP_NET_RAW AUSENTE — Execute no binário real: {resolved_cmd}"
        )

    return {
        "has_cap_net_raw": has_cap_net_raw,
        "has_unprivileged_icmp": has_unprivileged_icmp,
        "is_root": is_root,
        "is_symlink": is_symlink,
        "raw_python_path": raw_candidate,
        "python_executable": exe_path,
        "cap_eff_hex": cap_eff_hex,
        "getcap_output": getcap_output,
        "recommended_command": REQUIRED_SETCAP_CMD,
        "readlink_command": READLINK_SETCAP_CMD,
        "resolved_command": resolved_cmd,
        "setcap_error_explanation": symlink_error_explanation,
        "status_message": status_msg,
    }


def detect_webrtc_udp_session() -> Optional[Dict[str, Any]]:
    """
    Inspeciona conexões UDP ativas (/proc/net/udp) em busca de sessões In-Stream
    WebRTC do Xbox Cloud Gaming (RTCPeerConnection / Better xCloud) conectadas à rede
    Microsoft AS8075 / Azure brazilsouth.
    """
    if not sys.platform.startswith("linux") or not os.path.exists("/proc/net/udp"):
        return None
    try:
        candidates: List[Dict[str, Any]] = []
        with open("/proc/net/udp", "r", encoding="utf-8") as udp_file:
            next(udp_file, None)  # skip header
            for line in udp_file:
                parts = line.strip().split()
                if len(parts) < 4:
                    continue
                rem_hex = parts[2]
                if ":" not in rem_hex:
                    continue
                ip_hex, port_hex = rem_hex.split(":", 1)
                rem_port = int(port_hex, 16)
                if rem_port in (0, 53, 67, 68, 123, 1900, 5353):
                    continue
                ip_int = int(ip_hex, 16)
                if ip_int == 0:
                    continue
                octets = [
                    str((ip_int >> 0) & 0xFF),
                    str((ip_int >> 8) & 0xFF),
                    str((ip_int >> 16) & 0xFF),
                    str((ip_int >> 24) & 0xFF),
                ]
                rem_ip = ".".join(octets)
                if rem_ip.startswith(("127.", "10.", "192.168.", "169.254.", "224.", "239.", "255.")):
                    continue
                is_msft = rem_ip.startswith(MICROSOFT_AS8075_IPV4_PREFIXES)
                candidates.append(
                    {
                        "peer_ip": rem_ip,
                        "peer_port": rem_port,
                        "is_as8075": is_msft,
                        "transport": "WebRTC UDP (RTCPeerConnection / H.264)",
                    }
                )
        for cand in candidates:
            if cand["is_as8075"]:
                return cand
        return candidates[0] if candidates else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Heuristic Multilabel Network Diagnostic Engine (Section 5 of XCLOUD.md)
# ---------------------------------------------------------------------------
class NetworkDiagnosticEngine:
    """Engine heurística com sistema multilabel, sondagem estratégica multi-host e ponderação por severidade."""

    def __init__(
        self,
        target_host: str = DEFAULT_PRIMARY_HOST,
        window_size: int = 20,
        custom_host: Optional[str] = None,
    ):
        if window_size < 1:
            raise ValueError("window_size must be >= 1")
        self.original_target_host = target_host or DEFAULT_PRIMARY_HOST
        self.target_host = target_host or DEFAULT_PRIMARY_HOST
        self.is_target_auto: bool = (
            target_host in (DEFAULT_PRIMARY_HOST, None)
        )
        self.consecutive_target_failures: int = 0
        self.target_switch_history: List[Tuple[float, str, str, str]] = []
        self.window_size = window_size
        self.metrics = NetworkMetrics()
        self.context = ClientContextMetadata()
        self.last_rtt: Optional[float] = None
        self.rtt_window: Deque[float] = deque(maxlen=window_size)
        self.rtt_history: Deque[float] = deque(maxlen=48)
        self.jitter_history: Deque[float] = deque(maxlen=48)
        self.loss_history: Deque[float] = deque(maxlen=48)
        self.bufferbloat_history: Deque[float] = deque(maxlen=48)
        self.last_traceroute_report: Dict[str, Any] = {
            "executed": False,
            "hops": [],
            "hairpin_confirmed": False,
            "detected_pop": None,
        }

        # Strategic Endpoints state (Categories 1, 2, 3)
        self.endpoint_results: Dict[str, Dict[str, Any]] = {}
        for ep in STRATEGIC_ENDPOINTS:
            self.endpoint_results[ep["id"]] = {
                **ep,
                "rtt_ms": None,
                "online": False,
                "status": "AGUARDANDO",
            }
        self.sp_edge_rtt_ms: Optional[float] = None
        self.azure_brazilsouth_rtt_ms: Optional[float] = None
        self.us_miami_rtt_ms: Optional[float] = None
        self.us_atlanta_rtt_ms: Optional[float] = None
        self.us_ashburn_rtt_ms: Optional[float] = None

        # Category 4: In-Stream WebRTC UDP (RTCPeerConnection / Better xCloud H.264)
        self.webrtc_session: Dict[str, Any] = {
            "active": False,
            "peer_ip": None,
            "peer_port": None,
            "rtt_ms": 0.0,
            "jitter_ms": 0.0,
            "packet_loss_pct": 0.0,
            "codec": "H.264 (RTCPeerConnection UDP)",
            "source": "Auto-Detect / Better xCloud API",
            "samples_sent": 0,
            "samples_lost": 0,
            "_last_rtt": None,
        }

        # Requirement 2: Optional User Custom Host / IP (e.g. 8.8.8.8)
        self.custom_host: Optional[str] = None
        self.custom_host_metrics: Dict[str, Any] = {
            "host": None,
            "rtt_ms": 0.0,
            "rtt_avg_ms": 0.0,
            "jitter_ms": 0.0,
            "packet_loss_pct": 0.0,
            "samples_sent": 0,
            "samples_lost": 0,
            "status": "INATIVO",
            "online": False,
            "_last_rtt": None,
            "_window": deque(maxlen=window_size),
        }
        if custom_host:
            self.set_custom_host(custom_host)

    def set_custom_host(self, host: Optional[str]) -> None:
        """Define ou limpa o IP/Host customizado inserido pelo usuário (ex: 8.8.8.8)."""
        cleaned = (host or "").strip()
        self.custom_host = cleaned if cleaned else None
        self.custom_host_metrics = {
            "host": self.custom_host,
            "rtt_ms": 0.0,
            "rtt_avg_ms": 0.0,
            "jitter_ms": 0.0,
            "packet_loss_pct": 0.0,
            "samples_sent": 0,
            "samples_lost": 0,
            "status": "AGUARDANDO" if self.custom_host else "INATIVO",
            "online": False,
            "_last_rtt": None,
            "_window": deque(maxlen=self.window_size),
        }

    def switch_target_host(self, new_host: str, reason: str = "failover") -> None:
        """Alterna dinamicamente o host alvo primário de telemetria."""
        if not new_host or new_host == self.target_host:
            return
        old_host = self.target_host
        self.target_host = new_host
        self.target_switch_history.append((time.time(), old_host, new_host, reason))

    def elect_best_primary_target(self) -> Optional[str]:
        """
        Seleciona dinamicamente o melhor endpoint primário da borda Microsoft Brasil (AS8075 / Azure brazilsouth)
        com base na telemetria fresca de sondagem estratégica.
        """
        # Se o host alvo atual está respondendo e online, mantém-no estável
        current_ep = next((ep for ep in self.endpoint_results.values() if ep.get("host") == self.target_host), None)
        if current_ep and current_ep.get("online") and current_ep.get("rtt_ms") is not None:
            self.consecutive_target_failures = 0
            return self.target_host

        # Ordem de preferência de categorias para seleção automática:
        for cat in ("borda_brasil", "azure_brazilsouth", "ix_nacional"):
            candidates = [
                ep for ep in self.endpoint_results.values()
                if ep.get("category") == cat and ep.get("online") and ep.get("rtt_ms") is not None
            ]
            if candidates:
                # Prioritizes regional scale unit s8brazilsouth (Campinas SP) over generic brazilsouth domain
                # when both are online to avoid GeoDNS fallback to 20.209.1.1 in US East
                candidates.sort(
                    key=lambda x: (
                        0 if x.get("host") == "s8brazilsouth.blob.core.windows.net" else 1,
                        float(x["rtt_ms"]),
                    )
                )
                chosen = candidates[0]["host"]
                self.switch_target_host(chosen, reason=f"auto_election_{cat}")
                return chosen
        return None

    def get_fallback_candidates(self) -> List[str]:
        """Retorna lista ordenada de hosts alternativos para failover rápido caso o alvo atual falhe."""
        online_hosts = [
            ep["host"] for ep in self.endpoint_results.values()
            if ep.get("online") and ep.get("host") != self.target_host and ep.get("host") in PRIMARY_TARGET_CANDIDATES
        ]
        online_hosts.sort(key=lambda h: (0 if h == "s8brazilsouth.blob.core.windows.net" else 1))
        remaining = [h for h in PRIMARY_TARGET_CANDIDATES if h != self.target_host and h not in online_hosts]
        return online_hosts + remaining

    def process_custom_host_sample(self, raw_rtt: Optional[float]) -> None:
        """Atualiza RTT, SMA, EWMA Jitter (RFC 3550) e Perda para o IP/Host customizado do usuário."""
        if not self.custom_host:
            return
        cm = self.custom_host_metrics
        cm["host"] = self.custom_host
        cm["samples_sent"] += 1
        if raw_rtt is None or raw_rtt < 0.0:
            cm["samples_lost"] += 1
            cm["online"] = False
            cm["packet_loss_pct"] = (cm["samples_lost"] / cm["samples_sent"]) * 100.0
            cm["status"] = "RUIM"
            return

        rtt_val = float(raw_rtt)
        cm["rtt_ms"] = rtt_val
        cm["online"] = True
        win: Deque[float] = cm["_window"]
        win.append(rtt_val)
        cm["rtt_avg_ms"] = sum(win) / len(win)
        cm["packet_loss_pct"] = (cm["samples_lost"] / cm["samples_sent"]) * 100.0
        last_rtt = cm["_last_rtt"]
        if last_rtt is not None:
            d_k = abs(rtt_val - last_rtt)
            cm["jitter_ms"] = cm["jitter_ms"] + (d_k - cm["jitter_ms"]) / 16.0
        cm["_last_rtt"] = rtt_val
        cm["status"] = self.classify_metric_quality("rtt", rtt_val)

    async def probe_custom_host(self, timeout: float = 0.8) -> Optional[float]:
        """Executa sondagem assíncrona contra o IP/Host customizado inserido pelo usuário."""
        probed_host = self.custom_host
        if not probed_host:
            return None
        try:
            delay = await aioping.ping(probed_host, timeout=timeout)
            if self.custom_host != probed_host:
                return None
            rtt_ms = delay * 1000.0
            self.process_custom_host_sample(rtt_ms)
            return rtt_ms
        except (TimeoutError, OSError):
            if self.custom_host == probed_host:
                self.process_custom_host_sample(None)
            return None

    def set_webrtc_session(self, peer_ip: Optional[str], peer_port: int = 0) -> None:
        """Configura o IP da sessão In-Stream WebRTC UDP (RTCPeerConnection / Better xCloud)."""
        cleaned = (peer_ip or "").strip()
        if not cleaned:
            self.webrtc_session["active"] = False
            self.webrtc_session["peer_ip"] = None
            self.webrtc_session["peer_port"] = None
            return
        self.webrtc_session["active"] = True
        self.webrtc_session["peer_ip"] = cleaned
        self.webrtc_session["peer_port"] = peer_port or 3478

    def ingest_webrtc_stats(
        self,
        rtt_ms: Optional[float],
        jitter_ms: Optional[float] = None,
        packet_loss_pct: Optional[float] = None,
        peer_ip: Optional[str] = None,
    ) -> None:
        """
        Atualiza métricas da sessão WebRTC UDP (RTCPeerConnection / H.264 stream),
        calculando Jitter EWMA (RFC 3550) e descarte de pacotes no fluxo de vídeo.
        """
        ws = self.webrtc_session
        if peer_ip:
            ws["peer_ip"] = peer_ip
        ws["active"] = True
        ws["samples_sent"] += 1
        if rtt_ms is None or rtt_ms < 0.0:
            ws["samples_lost"] += 1
            if packet_loss_pct is not None:
                ws["packet_loss_pct"] = float(packet_loss_pct)
            else:
                ws["packet_loss_pct"] = (ws["samples_lost"] / ws["samples_sent"]) * 100.0
            return

        ws["rtt_ms"] = float(rtt_ms)
        if jitter_ms is not None:
            ws["jitter_ms"] = float(jitter_ms)
        else:
            prev = ws.get("_last_rtt")
            if prev is not None:
                d_k = abs(ws["rtt_ms"] - prev)
                ws["jitter_ms"] = ws["jitter_ms"] + (d_k - ws["jitter_ms"]) / 16.0
            ws["_last_rtt"] = ws["rtt_ms"]

        if packet_loss_pct is not None:
            ws["packet_loss_pct"] = float(packet_loss_pct)
        else:
            ws["packet_loss_pct"] = (ws["samples_lost"] / ws["samples_sent"]) * 100.0

    async def probe_azure_http_telemetry(
        self,
        host: str = "brazilsouth.blob.core.windows.net",
        timeout: float = 0.85,
        *,
        send_http: bool = False,
    ) -> Optional[float]:
        """
        Mede a latência HTTP/HTTPS direta do Datacenter Azure Brazil South (brazilsouth)
        no estilo AzureSpeed, separando a resolução DNS da medição de RTT TCP/HTTP.
        Quando `host` é o domínio genérico `brazilsouth.blob.core.windows.net` (que pode
        resolver via GeoDNS para um CNAME de fallback nos EUA), prioriza a unidade de
        escala regional `s8brazilsouth.blob.core.windows.net` (Campinas/São Paulo cpq24).
        """
        loop = asyncio.get_running_loop()
        deadline = time.perf_counter() + timeout
        candidate_hosts = (
            ("s8brazilsouth.blob.core.windows.net", host)
            if host == "brazilsouth.blob.core.windows.net"
            else (host,)
        )

        target_ip = host
        http_host_header = host
        for cand in candidate_hosts:
            rem_dns = deadline - time.perf_counter()
            if rem_dns <= 0.05:
                break
            try:
                addr_info = await asyncio.wait_for(
                    loop.run_in_executor(
                        None,
                        lambda h=cand: socket.getaddrinfo(h, None, socket.AF_INET, socket.SOCK_STREAM),
                    ),
                    timeout=min(0.35, rem_dns * 0.5),
                )
                if addr_info:
                    resolved = str(addr_info[0][4][0])
                    # Avoid 20.209.1.1 US East wildcard fallback when probing brazilsouth
                    if cand == "brazilsouth.blob.core.windows.net" and resolved == "20.209.1.1":
                        target_ip = resolved
                        continue
                    target_ip = resolved
                    http_host_header = cand
                    break
            except (OSError, asyncio.TimeoutError):
                continue

        ports = (80, 443) if send_http else (443, 80)
        for port in ports:
            rem = deadline - time.perf_counter()
            if rem <= 0.02:
                break
            t0 = time.perf_counter()
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(target_ip, port),
                    timeout=rem,
                )
                tcp_ms = max(0.1, (time.perf_counter() - t0) * 1000.0)
                elapsed_ms = tcp_ms
                if send_http and port == 80:
                    rem_http = deadline - time.perf_counter()
                    if rem_http > 0.02:
                        t_http = time.perf_counter()
                        req = (
                            f"HEAD /?comp=list HTTP/1.1\r\nHost: {http_host_header}\r\n"
                            "Connection: close\r\n\r\n"
                        ).encode("ascii")
                        writer.write(req)
                        await writer.drain()
                        data = await asyncio.wait_for(reader.read(64), timeout=rem_http)
                        if data:
                            elapsed_ms = max(0.1, (time.perf_counter() - t_http) * 1000.0)
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
                return elapsed_ms
            except (asyncio.TimeoutError, OSError):
                continue
        return None

    async def probe_strategic_endpoints(self, timeout: float = 0.55) -> Dict[str, Dict[str, Any]]:
        """
        Sonda em paralelo os hosts e endpoints estratégicos das 4 categorias:
        1. Borda Direta Microsoft no Brasil (AS8075: IX.br SP IPv4/IPv6, Equinix SP1-SP4, PIX RJ/Campinas/Fortaleza)
        2. Datacenter Azure Brazil South (brazilsouth.blob.core.windows.net & Telemetria HTTP AzureSpeed)
        3. Referência Internacional nos EUA (Equinix Miami, Atlanta e Ashburn) p/ detecção de BGP Hairpinning
        4. Sessão In-Stream WebRTC UDP (RTCPeerConnection) se ativa.
        """
        async def _probe_single(ep: Dict[str, Any]) -> Tuple[str, Optional[float]]:
            ep_id = ep["id"]
            host = ep["host"]
            p_type = ep.get("probe_type", "icmp_tcp")
            try:
                if p_type in ("http_tcp", "http_telemetry"):
                    rtt = await self.probe_azure_http_telemetry(
                        host=host,
                        timeout=max(timeout, 0.75),
                        send_http=(p_type == "http_telemetry"),
                    )
                    if rtt is not None:
                        return ep_id, rtt
                delay = await aioping.ping(host, timeout=timeout)
                return ep_id, delay * 1000.0
            except (TimeoutError, OSError):
                return ep_id, None

        tasks = [_probe_single(ep) for ep in STRATEGIC_ENDPOINTS]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for item in results:
            if isinstance(item, Exception) or not isinstance(item, tuple):
                continue
            ep_id, rtt_ms = item
            if ep_id not in self.endpoint_results:
                continue
            entry = self.endpoint_results[ep_id]
            entry["rtt_ms"] = rtt_ms
            entry["online"] = rtt_ms is not None
            if rtt_ms is None:
                entry["status"] = "TIMEOUT"
            elif entry["category"] == "referencia_internacional":
                entry["status"] = "REF-EUA"
            else:
                entry["status"] = self.classify_metric_quality("rtt", rtt_ms)

        # Aggregate São Paulo Edge RTT (IX.br SP + Equinix SP)
        sp_candidates = [
            self.endpoint_results[k]["rtt_ms"]
            for k in (
                "ix_sp_v4_1",
                "ix_sp_v4_2",
                "ix_sp_v6_1",
                "ix_sp_v6_2",
                "equinix_sp_v4_1",
                "equinix_sp_v4_2",
                "equinix_sp_v6_1",
                "equinix_sp_v6_2",
            )
            if self.endpoint_results.get(k, {}).get("rtt_ms") is not None
        ]
        self.sp_edge_rtt_ms = min(sp_candidates) if sp_candidates else None

        # Aggregate Azure Brazil South RTT
        az_candidates = [
            self.endpoint_results[k]["rtt_ms"]
            for k in ("azure_brazilsouth_blob", "azure_brazilsouth_telemetry")
            if self.endpoint_results.get(k, {}).get("rtt_ms") is not None
        ]
        self.azure_brazilsouth_rtt_ms = min(az_candidates) if az_candidates else None

        # Update US Reference PoPs (Equinix Miami, Atlanta, Ashburn)
        self.us_miami_rtt_ms = self.endpoint_results.get("us_equinix_miami", {}).get("rtt_ms")
        self.us_atlanta_rtt_ms = self.endpoint_results.get("us_equinix_atlanta", {}).get("rtt_ms")
        self.us_ashburn_rtt_ms = self.endpoint_results.get("us_equinix_ashburn", {}).get("rtt_ms")

        # Category 4: Auto-detect or probe active WebRTC UDP session
        detected_udp = detect_webrtc_udp_session()
        if detected_udp and not self.webrtc_session.get("peer_ip"):
            self.set_webrtc_session(detected_udp["peer_ip"], detected_udp.get("peer_port", 3478))

        if self.webrtc_session.get("active") and self.webrtc_session.get("peer_ip"):
            peer_ip = str(self.webrtc_session["peer_ip"])
            try:
                w_delay = await aioping.ping(peer_ip, timeout=timeout)
                self.ingest_webrtc_stats(w_delay * 1000.0, peer_ip=peer_ip)
            except (TimeoutError, OSError):
                self.ingest_webrtc_stats(None, peer_ip=peer_ip)

        return self.endpoint_results

    def process_raw_sample(self, raw_rtt: float | None) -> None:
        """
        Atualiza RTT instantâneo, Média Móvel Simples (SMA), EWMA Jitter (RFC 3550)
        e Taxa Percentual de Perda de Pacotes baseado no recebimento de datagramas.
        """
        self.metrics.samples_sent += 1

        if raw_rtt is None or raw_rtt < 0.0:
            self.metrics.samples_lost += 1
            self.metrics.packet_loss_pct = (
                self.metrics.samples_lost / self.metrics.samples_sent
            ) * 100.0
            self.loss_history.append(self.metrics.packet_loss_pct)
            return

        # 1. Atualiza Latência Instantânea (RTT_k = t_recebimento - t_envio)
        self.metrics.rtt_ms = float(raw_rtt)
        self.rtt_window.append(self.metrics.rtt_ms)
        self.rtt_history.append(self.metrics.rtt_ms)
        if (
            self.sp_edge_rtt_ms is not None
            or self.target_host == DEFAULT_PRIMARY_HOST
            or self.target_host in PRIMARY_TARGET_CANDIDATES
        ):
            self.sp_edge_rtt_ms = self.metrics.rtt_ms
        if self.target_host in ("brazilsouth.blob.core.windows.net", "s8brazilsouth.blob.core.windows.net"):
            self.azure_brazilsouth_rtt_ms = self.metrics.rtt_ms

        # Média Móvel Simples (\overline{RTT} = \frac{1}{N} \sum_{i=1}^{N} RTT_i)
        self.metrics.rtt_avg_ms = sum(self.rtt_window) / len(self.rtt_window)

        # 2. Taxa Percentual de Perda de Pacotes
        self.metrics.packet_loss_pct = (
            self.metrics.samples_lost / self.metrics.samples_sent
        ) * 100.0
        self.loss_history.append(self.metrics.packet_loss_pct)

        # 3. Cálculo do Jitter via EWMA conforme RFC 3550 (Seção 6.4.1)
        # D_k = |RTT_k - RTT_{k-1}|
        # J_k = J_{k-1} + (D_k - J_{k-1}) / 16.0
        if self.last_rtt is not None:
            d_k = abs(self.metrics.rtt_ms - self.last_rtt)
            self.metrics.jitter_ms = (
                self.metrics.jitter_ms + (d_k - self.metrics.jitter_ms) / 16.0
            )
        self.last_rtt = self.metrics.rtt_ms
        self.jitter_history.append(self.metrics.jitter_ms)

    async def measure_bufferbloat_burst(self) -> float:
        """Executa uma rajada assíncrona leve para medir o Delta de Bufferbloat sob carga."""
        idle_rtt = self.metrics.rtt_ms if self.metrics.rtt_ms > 0.0 else self.metrics.rtt_avg_ms
        loaded_rtts: List[float] = []

        async def lightweight_stream_probe() -> None:
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection("www.microsoft.com", 80),
                    timeout=1.5,
                )
                writer.write(b"GET / HTTP/1.1\r\nHost: www.microsoft.com\r\nConnection: close\r\n\r\n")
                await writer.drain()
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

        # Dispara rajadas de conexões simultâneas controladas
        burst_tasks = [asyncio.create_task(lightweight_stream_probe()) for _ in range(5)]

        # Mede latência durante o estresse de E/S
        try:
            rtt_sample = await aioping.ping(self.target_host, timeout=1.0)
            loaded_rtts.append(rtt_sample * 1000.0)
        except (TimeoutError, OSError):
            pass

        await asyncio.gather(*burst_tasks, return_exceptions=True)

        if loaded_rtts:
            loaded_rtt_avg = sum(loaded_rtts) / len(loaded_rtts)
            delta = max(0.0, loaded_rtt_avg - idle_rtt)
            self.metrics.bufferbloat_delta_ms = delta
            self.bufferbloat_history.append(delta)
            return delta
        return 0.0

    async def trace_route_ttl_scapy(
        self,
        max_hops: int = 16,
        timeout: float = 0.25,
        simulated_hops: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Dispara silenciosamente um traceroute assíncrono via Scapy configurando
        incrementos sequenciais no campo TTL para detectar International Hairpinning
        (desvio BGP para Equinix Miami, Atlanta CIX-ATL ou Ashburn IX-2572).
        """
        hops: List[Dict[str, Any]] = []
        hairpin_confirmed = False
        detected_pop: Optional[str] = None

        if simulated_hops is not None:
            hops = list(simulated_hops)
        else:
            try:
                resolved_target_ip = await asyncio.to_thread(socket.gethostbyname, self.target_host)
            except OSError:
                resolved_target_ip = self.target_host

            for ttl in range(1, max_hops + 1):
                pkt = ScapyIP(dst=self.target_host, ttl=ttl) / ScapyICMP()
                sr1_call = functools.partial(scapy_sr1, pkt, timeout=timeout, verbose=0)
                reply = await asyncio.to_thread(sr1_call)
                if reply is None:
                    continue
                hop_ip = str(getattr(reply, "src", "0.0.0.0"))
                hop_host = getattr(reply, "host", None)
                if not hop_host or hop_host == hop_ip:
                    try:
                        ptr_info = await asyncio.wait_for(
                            asyncio.to_thread(socket.gethostbyaddr, hop_ip),
                            timeout=max(0.05, timeout),
                        )
                        hop_host = ptr_info[0]
                    except Exception:
                        hop_host = hop_ip
                hops.append({"ttl": ttl, "ip": hop_ip, "host": str(hop_host)})

                icmp_type = getattr(reply, "type", None)
                if (icmp_type is None or not isinstance(icmp_type, int)) and hasattr(reply, "getlayer"):
                    try:
                        icmp_layer = reply.getlayer(ScapyICMP)
                        if icmp_layer is not None:
                            icmp_type = getattr(icmp_layer, "type", -1)
                    except Exception:
                        icmp_type = -1

                if icmp_type == 0 or hop_ip in (self.target_host, resolved_target_ip):
                    break

        for hop in hops:
            descriptor = f"{hop.get('ip', '')} {hop.get('host', '')}".lower()
            for sig in US_HAIRPIN_POP_SIGNATURES:
                if sig in descriptor:
                    hairpin_confirmed = True
                    if "mia" in sig or "242." in sig:
                        detected_pop = "Miami (Equinix MI1 / 198.32.242.188)"
                    elif "atl" in sig or "1668" in sig or "198.32.132." in sig or "198.32.182." in sig:
                        detected_pop = "Atlanta (CIX-ATL / Equinix 198.32.182.105)"
                    else:
                        detected_pop = "Ashburn (Equinix / IX-2572 206.126.236.148)"
                    break
            if hairpin_confirmed:
                break

        if hops:
            self.metrics.ttl_hop_count = len(hops)

        self.last_traceroute_report = {
            "executed": True,
            "hops": hops,
            "hop_count": self.metrics.ttl_hop_count,
            "hairpin_confirmed": hairpin_confirmed,
            "detected_pop": detected_pop,
        }
        return self.last_traceroute_report

    def classify_metric_quality(self, metric_name: str, value: float) -> str:
        """
        Classifies an individual metric into 'BOA', 'ATENÇÃO', or 'RUIM'
        according to Section 3 (Matriz Rígida de Limiares de Desempenho).
        """
        if metric_name == "rtt":
            if value < RTT_GOOD_MAX_MS:
                return "BOA"
            if value <= RTT_CRITICAL_MIN_MS:
                return "ATENÇÃO"
            return "RUIM"
        if metric_name == "jitter":
            if value < JITTER_GOOD_MAX_MS:
                return "BOA"
            if value <= JITTER_CRITICAL_MIN_MS:
                return "ATENÇÃO"
            return "RUIM"
        if metric_name == "loss":
            if value <= LOSS_GOOD_MAX_PCT:
                return "BOA"
            if value <= LOSS_CRITICAL_MIN_PCT:
                return "ATENÇÃO"
            return "RUIM"
        if metric_name == "bufferbloat":
            if value < BUFFERBLOAT_GOOD_MAX_MS:
                return "BOA"
            if value <= BUFFERBLOAT_CRITICAL_MIN_MS:
                return "ATENÇÃO"
            return "RUIM"
        return "BOA"

    def evaluate_diagnostics(self) -> Dict[str, Any]:
        """Avalia falhas concorrentes gerando diagnósticos multilabel ordenados por severidade."""
        detected_anomalies: List[Dict[str, Any]] = []

        # 1. Checagem Crítica: International Hairpinning (BGP Subótimo)
        # Lógica 1A: Janela clássica de Hairpinning (120 ms <= RTT <= 150 ms)
        # Lógica 1B: Comparação paralela São Paulo vs. Equinix Miami / Atlanta / Ashburn:
        # Se o RTT para o host de São Paulo (> 120 ms) estiver próximo ou acima do RTT para Miami/EUA
        effective_sp_rtt = (
            self.metrics.rtt_ms
            if self.metrics.rtt_ms > 0.0
            else (self.sp_edge_rtt_ms or 0.0)
        )
        us_rtts = [
            r
            for r in (self.us_miami_rtt_ms, self.us_atlanta_rtt_ms, self.us_ashburn_rtt_ms)
            if r is not None and r > 0.0
        ]
        ref_us_rtt = self.us_miami_rtt_ms if (self.us_miami_rtt_ms and self.us_miami_rtt_ms > 0.0) else (min(us_rtts) if us_rtts else None)

        hairpin_by_threshold = BGP_HAIRPIN_MIN_MS <= self.metrics.rtt_ms <= BGP_HAIRPIN_MAX_MS
        hairpin_by_miami_comp = (
            ref_us_rtt is not None
            and effective_sp_rtt > BGP_HAIRPIN_MIN_MS
            and (abs(effective_sp_rtt - ref_us_rtt) <= 65.0 or effective_sp_rtt >= ref_us_rtt * 0.80)
        )

        if hairpin_by_threshold or hairpin_by_miami_comp:
            if hairpin_by_miami_comp and ref_us_rtt is not None:
                cause_text = (
                    f"RTT São Paulo ({effective_sp_rtt:.1f} ms) próximo ao RTT de Miami/EUA ({ref_us_rtt:.1f} ms) — "
                    "Tráfego para São Paulo desviado para PoPs nos EUA (Equinix Miami / Atlanta CIX-ATL / Ashburn)."
                )
            else:
                cause_text = "Tráfego para São Paulo desviado para PoPs nos EUA (Atlanta CIX-ATL / Ashburn / Miami)."

            detected_anomalies.append(
                {
                    "severity": 1,
                    "code": "BGP_HAIRPINNING",
                    "alert": "ALERTA CRÍTICO: Roteamento Internacional Subótimo (Hairpinning BGP)",
                    "cause": cause_text,
                }
            )

        # 2. Checagem Crítica: Perda de Pacotes Severa
        if self.metrics.packet_loss_pct > LOSS_CRITICAL_MIN_PCT:
            detected_anomalies.append(
                {
                    "severity": 2,
                    "code": "HIGH_PACKET_LOSS",
                    "alert": "Perda de Pacotes Elevada (>0.10%)",
                    "cause": "Descarte de pacotes no enlace de acesso ou gargalo no provedor.",
                }
            )

        # 3. Checagem Alta: Saturação por Bufferbloat
        if self.metrics.bufferbloat_delta_ms > BUFFERBLOAT_CRITICAL_MIN_MS:
            detected_anomalies.append(
                {
                    "severity": 3,
                    "code": "BUFFERBLOAT_SATURATION",
                    "alert": "Saturação de BufferBloat no Roteador",
                    "cause": "Enfileiramento excessivo de dados sob carga de upload/download.",
                }
            )

        # 4. Checagem Média: Instabilidade em Meio Sem Fio (Wi-Fi 2.4 GHz)
        if self.metrics.is_wifi_2_4ghz and self.metrics.jitter_ms > JITTER_CRITICAL_MIN_MS:
            detected_anomalies.append(
                {
                    "severity": 4,
                    "code": "WIFI_24GHZ_INSTABILITY",
                    "alert": "Instabilidade de Meio Físico Wi-Fi 2.4 GHz",
                    "cause": "Interferência eletromagnética ou sobreposição de canais sem fio.",
                }
            )

        # Determinação do Status Global baseado nas anomalias e na matriz de limiares de RTT
        if detected_anomalies:
            detected_anomalies.sort(key=lambda x: x["severity"])
            if detected_anomalies[0]["severity"] <= 2 or self.metrics.rtt_ms > RTT_CRITICAL_MIN_MS:
                global_status = "RUIM"
            else:
                global_status = "ATENÇÃO"
            main_root_cause = detected_anomalies[0]["cause"]
        else:
            if self.metrics.rtt_ms > RTT_CRITICAL_MIN_MS:
                global_status = "RUIM"
                main_root_cause = "Latência crítica acima do orçamento de 60 FPS (> 60 ms)"
            elif self.metrics.rtt_ms >= RTT_GOOD_MAX_MS:
                global_status = "ATENÇÃO"
                main_root_cause = "Latência moderada na faixa de atenção (20 ms a 50 ms)"
            else:
                global_status = "BOA"
                main_root_cause = "Conexão Estável com Parâmetros Ideais"

        # Nota sobre a métrica de Tempo de Decodificação (Seção 3 de XCLOUD.md):
        # "< 5 ms" em BOA; "N/D (Via Socket Network Probes)" em ATENÇÃO e RUIM.
        self.metrics.decode_time_status = (
            "< 5 ms" if global_status == "BOA" else "N/D (Via Socket Network Probes)"
        )

        return {
            "status": global_status,
            "anomalies": detected_anomalies,
            "primary_root_cause": main_root_cause,
            "metrics_snapshot": self.metrics,
            "context_snapshot": self.context,
            "traceroute_report": self.last_traceroute_report,
            "strategic_endpoints": self.endpoint_results,
            "sp_edge_rtt_ms": self.sp_edge_rtt_ms,
            "azure_brazilsouth_rtt_ms": self.azure_brazilsouth_rtt_ms,
            "us_miami_rtt_ms": self.us_miami_rtt_ms,
            "us_atlanta_rtt_ms": self.us_atlanta_rtt_ms,
            "us_ashburn_rtt_ms": self.us_ashburn_rtt_ms,
            "webrtc_session": self.webrtc_session,
            "custom_host_metrics": self.custom_host_metrics,
        }


# ---------------------------------------------------------------------------
# Background Asynchronous Measurement Worker (Section 5 of XCLOUD.md)
# ---------------------------------------------------------------------------
async def network_measurement_worker(
    engine: NetworkDiagnosticEngine,
    data_queue: asyncio.Queue[Dict[str, Any]],
    *,
    max_cycles: Optional[int] = None,
    cycle_interval: float = 1.0,
    enable_scapy_on_hairpin: bool = True,
    probe_strategic: bool = True,
) -> None:
    """Loop assíncrono de background que executa sondagens nos hosts estratégicos e atualiza a fila de UI."""
    loop_count = 0
    while max_cycles is None or loop_count < max_cycles:
        # Sondagem em paralelo dos endpoints estratégicos (Categorias 1, 2, 3 e 4)
        # Executa no ciclo inicial e periodicamente a cada 3 ciclos, ou imediatamente se o alvo atual estiver com falhas
        if probe_strategic and (
            loop_count == 0
            or loop_count % 3 == 0
            or engine.consecutive_target_failures > 0
        ):
            await engine.probe_strategic_endpoints(timeout=0.75)
            if getattr(engine, "is_target_auto", False):
                engine.elect_best_primary_target()

        try:
            # Medição contínua via ICMP/TCP aioping no host primário da borda Microsoft Brasil
            delay = await aioping.ping(engine.target_host, timeout=1.5)
            engine.consecutive_target_failures = 0
            engine.process_raw_sample(delay * 1000.0)
        except (TimeoutError, OSError):
            recovered = False
            # Se falhou e está em modo automático, tenta failover concorrente imediato entre candidatos alternativos AS8075/Azure
            if getattr(engine, "is_target_auto", False):
                candidates_to_try = [c for c in engine.get_fallback_candidates() if c != engine.target_host][:4]
                if candidates_to_try:
                    async def _test_cand(cand: str) -> Tuple[str, float]:
                        d = await aioping.ping(cand, timeout=1.0)
                        return cand, d

                    pending = [asyncio.create_task(_test_cand(c)) for c in candidates_to_try]
                    while pending:
                        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                        for fut in done:
                            try:
                                cand_host, cand_delay = fut.result()
                                engine.switch_target_host(cand_host, reason="probe_timeout_failover")
                                engine.consecutive_target_failures = 0
                                engine.process_raw_sample(cand_delay * 1000.0)
                                recovered = True
                                break
                            except Exception:
                                continue
                        if recovered:
                            for p in pending:
                                p.cancel()
                            break
            if not recovered:
                engine.consecutive_target_failures += 1
                engine.process_raw_sample(None)

        # Sondagem do IP/Host customizado inserido pelo usuário (ex: 8.8.8.8), se ativo
        if engine.custom_host:
            await engine.probe_custom_host(timeout=0.75)

        # A cada 10 ciclos, executa teste de Bufferbloat concorrente
        loop_count += 1
        if loop_count % 10 == 0:
            await engine.measure_bufferbloat_burst()

        # Se detectar RTT na faixa de International Hairpinning (120-150 ms) ou comparativo Miami > 120ms,
        # dispara traceroute assíncrono via Scapy (Seção 6.2 de XCLOUD.md)
        if enable_scapy_on_hairpin and (
            BGP_HAIRPIN_MIN_MS <= engine.metrics.rtt_ms <= BGP_HAIRPIN_MAX_MS
            or (
                engine.us_miami_rtt_ms is not None
                and engine.metrics.rtt_ms > BGP_HAIRPIN_MIN_MS
                and abs(engine.metrics.rtt_ms - engine.us_miami_rtt_ms) <= 65.0
            )
        ):
            await engine.trace_route_ttl_scapy(max_hops=12, timeout=0.15)

        # Avalia estado e injeta na fila assíncrona thread-safe
        diagnostic_payload = engine.evaluate_diagnostics()
        await data_queue.put(diagnostic_payload)

        if max_cycles is not None and loop_count >= max_cycles:
            break
        await asyncio.sleep(cycle_interval)


# ---------------------------------------------------------------------------
# ASCII / ANSI Bar Graph & Sci-Fi HUD Renderers (Section 1 of Spec)
# ---------------------------------------------------------------------------
SPARK_BLOCKS = "▁▂▃▄▅▆▇█"


def status_color(status: str) -> str:
    """Maps connection quality classification to the cyberpunk neon palette."""
    if status == "BOA":
        return NEON_GREEN
    if status == "ATENÇÃO":
        return WARNING_AMBER
    return CRITICAL_RED


def render_ascii_gauge_bar(
    value: float,
    max_scale: float,
    width: int = 12,
    quality: str = "BOA",
) -> Text:
    """Renders a high-contrast ANSI/ASCII progress bar with neon fill and grid ticks."""
    clamped = max(0.0, min(value, max_scale))
    ratio = clamped / max_scale if max_scale > 0 else 0.0
    filled = int(round(ratio * width))
    empty = max(0, width - filled)
    color = status_color(quality)

    bar_text = Text("[", style=f"bold {ELECTRIC_CYAN}")
    if filled > 0:
        bar_text.append("█" * filled, style=f"bold {color}")
    if empty > 0:
        bar_text.append("░" * empty, style=f"dim {DIM_CYAN}")
    bar_text.append("]", style=f"bold {ELECTRIC_CYAN}")
    return bar_text


def render_sparkline(
    values: Iterable[float],
    max_scale: float,
    width: int = 10,
    color: str = NEON_GREEN,
) -> Text:
    """Renders an ASCII/Unicode vertical bar sparkline of historical telemetry samples."""
    raw_seq = list(values)[-width:]
    missing = max(0, width - len(raw_seq))

    out = Text("", style=color)
    if missing > 0:
        out.append("·" * missing, style=f"dim {DIM_CYAN}")

    for val in raw_seq:
        norm = max(0.0, min(1.0, val / max_scale)) if max_scale > 0 else 0.0
        idx = int(round(norm * (len(SPARK_BLOCKS) - 1)))
        block_char = SPARK_BLOCKS[idx]
        out.append(block_char, style=f"bold {color}")
    return out


def render_header_hud(
    payload: Dict[str, Any],
    cap_info: Dict[str, Any],
    fps: float = 60.0,
    frame_seq: int = 0,
    ui_mode: str = "detailed",
) -> Panel:
    """Renders the top Cyberpunk Tactical HUD banner."""
    global_status = payload.get("status", "BOA")
    badge_color = status_color(global_status)
    pulse_glyph = "◈" if (frame_seq % 2 == 0) else "◇"

    cap_ok = cap_info.get("has_cap_net_raw", False)
    cap_badge = "CAP_NET_RAW: OK" if cap_ok else "CAP_NET_RAW: WARN"
    cap_style = NEON_GREEN if cap_ok else WARNING_AMBER

    line1 = Text()
    line1.append(f" {pulse_glyph} XCLOUD // CYBER-HUD TELEMETRY ", style=f"bold {DARK_BG} on {ELECTRIC_CYAN}")
    line1.append("  AS8075::brazilsouth  ", style=f"bold {ELECTRIC_CYAN}")
    line1.append("SP / IX.br", style="dim white")

    line2 = Text()
    line2.append("STATUS GLOBAL: ", style=f"bold {ELECTRIC_CYAN}")
    line2.append(f"[ {global_status} ]", style=f"bold {DARK_BG} on {badge_color}")
    line2.append(f"  [{cap_badge}]", style=f"bold {cap_style}")
    line2.append(f"  UI LOOP: {fps:04.1f} FPS", style=f"bold {NEON_GREEN}")
    if ui_mode == "simplified":
        line2.append("  [MODO CINEMA]", style=f"bold {NEON_GREEN}")

    return Panel(
        Group(line1, line2),
        box=box.HEAVY,
        border_style=f"bold {ELECTRIC_CYAN}",
        padding=(0, 1),
    )


def render_metrics_bars_panel(
    engine: NetworkDiagnosticEngine,
    payload: Dict[str, Any],
) -> Panel:
    """
    Renders real-time ASCII/ANSI bar charts and sparklines for RTT, Jitter,
    Packet Loss, Bufferbloat Delta, and Decode Time.
    """
    m: NetworkMetrics = payload.get("metrics_snapshot", engine.metrics)

    rtt_q = engine.classify_metric_quality("rtt", m.rtt_ms)
    jitter_q = engine.classify_metric_quality("jitter", m.jitter_ms)
    loss_q = engine.classify_metric_quality("loss", m.packet_loss_pct)
    bloat_q = engine.classify_metric_quality("bufferbloat", m.bufferbloat_delta_ms)

    table = Table(
        box=box.SIMPLE_HEAVY,
        expand=True,
        show_header=True,
        header_style=f"bold {ELECTRIC_CYAN}",
        border_style=DIM_CYAN,
        pad_edge=False,
    )
    table.add_column("MÉTRICA", style="bold white", ratio=2, no_wrap=True)
    table.add_column("VALOR ATUAL", justify="right", ratio=2, no_wrap=True)
    table.add_column("BARRA (ANSI)", justify="center", ratio=2, no_wrap=True)
    table.add_column("HISTÓRICO", justify="center", ratio=2, no_wrap=True)
    table.add_column("LIMIAR / STATUS", justify="center", ratio=2, no_wrap=True)

    # 1. RTT Row
    rtt_val_txt = Text(f"{m.rtt_ms:5.1f}ms ", style=f"bold {status_color(rtt_q)}")
    rtt_val_txt.append(f"(μ={m.rtt_avg_ms:.1f})", style=f"dim {ELECTRIC_CYAN}")
    table.add_row(
        "Latência (RTT)",
        rtt_val_txt,
        render_ascii_gauge_bar(m.rtt_ms, 160.0, width=10, quality=rtt_q),
        render_sparkline(engine.rtt_history, 160.0, width=10, color=status_color(rtt_q)),
        Text(f"<20ms [{rtt_q}]", style=f"bold {status_color(rtt_q)}"),
    )

    # 2. Jitter Row (EWMA RFC 3550)
    jitter_val_txt = Text(f"{m.jitter_ms:5.2f}ms ", style=f"bold {status_color(jitter_q)}")
    jitter_val_txt.append("(EWMA)", style=f"dim {ELECTRIC_CYAN}")
    table.add_row(
        "Jitter (RFC3550)",
        jitter_val_txt,
        render_ascii_gauge_bar(m.jitter_ms, 30.0, width=10, quality=jitter_q),
        render_sparkline(engine.jitter_history, 30.0, width=10, color=status_color(jitter_q)),
        Text(f"<2ms  [{jitter_q}]", style=f"bold {status_color(jitter_q)}"),
    )

    # 3. Packet Loss Row
    loss_val_txt = Text(f"{m.packet_loss_pct:5.2f}% ", style=f"bold {status_color(loss_q)}")
    loss_val_txt.append(f"({m.samples_lost}/{m.samples_sent})", style=f"dim {ELECTRIC_CYAN}")
    table.add_row(
        "Perda Pacotes",
        loss_val_txt,
        render_ascii_gauge_bar(m.packet_loss_pct, 1.0, width=10, quality=loss_q),
        render_sparkline(engine.loss_history, 1.0, width=10, color=status_color(loss_q)),
        Text(f"0.00% [{loss_q}]", style=f"bold {status_color(loss_q)}"),
    )

    # 4. Bufferbloat Delta Row
    bloat_val_txt = Text(f"+{m.bufferbloat_delta_ms:4.1f}ms ", style=f"bold {status_color(bloat_q)}")
    bloat_val_txt.append("(ΔLoad)", style=f"dim {ELECTRIC_CYAN}")
    table.add_row(
        "Delta Bufferbloat",
        bloat_val_txt,
        render_ascii_gauge_bar(m.bufferbloat_delta_ms, 80.0, width=10, quality=bloat_q),
        render_sparkline(engine.bufferbloat_history, 80.0, width=10, color=status_color(bloat_q)),
        Text(f"<50ms [{bloat_q}]", style=f"bold {status_color(bloat_q)}"),
    )

    # 5. Hardware Decode Time Row (Section 3 Note)
    global_status = payload.get("status", "BOA")
    decode_col = NEON_GREEN if global_status == "BOA" else WARNING_AMBER
    table.add_row(
        "Tempo Decodif.",
        Text(m.decode_time_status, style=f"bold {decode_col}"),
        Text("[SOCKET PROBE]", style=f"dim {ELECTRIC_CYAN}"),
        Text("RTCStats", style=f"dim {ELECTRIC_CYAN}"),
        Text("60 FPS Lock", style=f"bold {decode_col}"),
    )

    return Panel(
        table,
        title=f"[bold {NEON_GREEN}]◈ TELEMETRIA DE REDE EM TEMPO REAL & GRÁFICOS ANSI/ASCII ◈[/]",
        subtitle=f"[{ELECTRIC_CYAN}]Equações: SMA(RTT), EWMA J_k = J_{{k-1}} + (|RTT_k - RTT_{{k-1}}| - J_{{k-1}})/16, Δ Bufferbloat[/]",
        box=box.HEAVY,
        border_style=NEON_GREEN if global_status == "BOA" else status_color(global_status),
        padding=(0, 1),
    )


def render_strategic_endpoints_panel(
    engine: NetworkDiagnosticEngine,
    payload: Dict[str, Any],
    *,
    custom_input_active: bool = False,
    custom_input_buffer: str = "",
) -> Panel:
    """
    Renderiza o painel das 4 categorias de Hosts e Endpoints Estratégicos do Xbox Cloud Gaming
    no Brasil + Campo Interativo para IP/Host Customizado do Usuário (ex: 8.8.8.8).
    """
    ep_map: Dict[str, Dict[str, Any]] = payload.get("strategic_endpoints", engine.endpoint_results)
    ws: Dict[str, Any] = payload.get("webrtc_session", engine.webrtc_session)
    cm: Dict[str, Any] = payload.get("custom_host_metrics", engine.custom_host_metrics)

    def _fmt_rtt(ep_id: str) -> str:
        info = ep_map.get(ep_id, {})
        val = info.get("rtt_ms")
        return f"{val:5.1f}ms" if val is not None else "  --  "

    # 1. Interactive Custom Host / IP Input Field Banner (Requirement 2)
    input_line = Text()
    input_line.append(" ✎ CAMPO IP/HOST EXTRA ", style=f"bold {DARK_BG} on {ELECTRIC_CYAN}")
    if custom_input_active:
        input_line.append(
            " [DIGITANDO — Enter confirmar | Esc cancelar]: ",
            style=f"bold {WARNING_AMBER}",
        )
        input_line.append(f"[ {custom_input_buffer}█ ]", style=f"bold {NEON_GREEN} on {DARK_BG}")
    elif engine.custom_host:
        c_status = cm.get("status", "AGUARDANDO")
        c_col = status_color(c_status) if c_status in ("BOA", "ATENÇÃO", "RUIM") else ELECTRIC_CYAN
        c_rtt = f"{cm.get('rtt_ms', 0.0):.1f}ms" if cm.get("online") else "TIMEOUT/AGUARD."
        input_line.append(" [Tecla I editar | C limpar]: ", style=f"bold {ELECTRIC_CYAN}")
        input_line.append(f"[ {engine.custom_host} ] ", style=f"bold {NEON_GREEN}")
        input_line.append(
            f"RTT: {c_rtt} (μ={cm.get('rtt_avg_ms', 0.0):.1f}ms) | "
            f"Jitter: {cm.get('jitter_ms', 0.0):.2f}ms | "
            f"Loss: {cm.get('packet_loss_pct', 0.0):.1f}% [{c_status}]",
            style=f"bold {c_col}",
        )
    else:
        input_line.append(
            " [Tecla I p/ inserir IP/Host (ex: 8.8.8.8) | Tecla 8 testar 8.8.8.8]: ",
            style=f"bold {ELECTRIC_CYAN}",
        )
        input_line.append(
            "[ Nenhum — Executando nos hosts nativos xCloud Brasil ]",
            style=f"dim {NEON_GREEN}",
        )

    # 2. Strategic Endpoints Matrix Table (Categories 1, 2, 3, 4)
    table = Table(
        box=box.SIMPLE,
        expand=True,
        show_header=True,
        header_style=f"bold {ELECTRIC_CYAN}",
        pad_edge=False,
    )
    table.add_column("CATEGORIA ESTRATÉGICA", style=f"bold {ELECTRIC_CYAN}", ratio=2)
    table.add_column("ENDPOINTS / POPS MONITORADOS", style="white", ratio=3)
    table.add_column("TELEMETRIA (RTT / JITTER)", justify="right", style=f"bold {NEON_GREEN}", ratio=3)

    # Cat 1A: IX.br São Paulo (AS26162 / AS8075)
    table.add_row(
        "1. Borda MSFT IX.br SP",
        "v4: 187.16.218.144 / .139 | v6: 2001:12f8::218:144 / :139",
        f"v4:{_fmt_rtt('ix_sp_v4_1')}/{_fmt_rtt('ix_sp_v4_2')} | v6:{_fmt_rtt('ix_sp_v6_1')}/{_fmt_rtt('ix_sp_v6_2')}",
    )
    # Cat 1B: Equinix São Paulo (Barueri SP1-SP4)
    table.add_row(
        "1. Borda Equinix SP1-SP4",
        "v4: 64.191.233.147 / .148 | v6: 2001:504:0:7::8075:1 / :2",
        f"v4:{_fmt_rtt('equinix_sp_v4_1')}/{_fmt_rtt('equinix_sp_v4_2')} | v6:{_fmt_rtt('equinix_sp_v6_1')}/{_fmt_rtt('equinix_sp_v6_2')}",
    )
    # Cat 1C: Outros PIX do IX.br (RJ, Campinas, Fortaleza)
    table.add_row(
        "1. PIX IX.br Nacionais",
        "RJ: 45.68.80.73 | CMP: 200.192.108.42 | FOR: 45.68.74.84",
        f"RJ:{_fmt_rtt('ix_rj')} | CMP:{_fmt_rtt('ix_campinas')} | FOR:{_fmt_rtt('ix_fortaleza')}",
    )
    # Cat 2: Datacenter Azure Brazil South (brazilsouth)
    table.add_row(
        "2. Azure brazilsouth (SP)",
        "brazilsouth.blob.core.windows.net (Blob + HTTP AzureSpeed)",
        f"Blob: {_fmt_rtt('azure_brazilsouth_blob')} | HTTP: {_fmt_rtt('azure_brazilsouth_telemetry')}",
    )
    # Cat 3: Hosts de Referência Internacional (Detecção Hairpinning BGP)
    table.add_row(
        "3. Ref. EUA (Hairpin BGP)",
        "MIA: 198.32.242.188 | ATL: 198.32.182.105 | ASH: 206.126.236.148",
        f"MIA:{_fmt_rtt('us_equinix_miami')} | ATL:{_fmt_rtt('us_equinix_atlanta')} | ASH:{_fmt_rtt('us_equinix_ashburn')}",
    )
    # Cat 4: Conexões In-Stream WebRTC UDP (RTCPeerConnection / H.264)
    if ws.get("active") and ws.get("peer_ip"):
        w_peer = f"{ws['peer_ip']}:{ws.get('peer_port', 3478)} (RTCPeerConnection UDP H.264)"
        w_stats = (
            f"RTT: {ws.get('rtt_ms', 0.0):.1f}ms | "
            f"Jitter: {ws.get('jitter_ms', 0.0):.2f}ms | "
            f"Loss: {ws.get('packet_loss_pct', 0.0):.2f}%"
        )
    else:
        w_peer = "RTCPeerConnection UDP / Better xCloud (Fluxo H.264)"
        w_stats = "Auto-Scan UDP (Sem stream ativa)"
    table.add_row(
        "4. In-Stream WebRTC UDP",
        w_peer,
        w_stats,
    )

    return Panel(
        Group(input_line, table),
        title=f"[bold {ELECTRIC_CYAN}]◈ SONDAGEM ESTRATÉGICA MULTI-HOST (AS8075 / BRAZILSOUTH / EUA / WEBRTC) & HOST EXTRA ◈[/]",
        subtitle=f"[{DIM_CYAN}]Detecção Automática Hairpinning BGP: RTT São Paulo vs. Equinix Miami (> 120 ms)[/]",
        box=box.HEAVY,
        border_style=ELECTRIC_CYAN,
        padding=(0, 1),
    )


def render_client_context_panel(payload: Dict[str, Any], engine: NetworkDiagnosticEngine) -> Panel:
    """
    Renders the Tactical Telemetry Table containing ClientContextMetadata
    inspired by the r/xcloud community & Brazilian AS8075 Peering Infrastructure.
    """
    ctx: ClientContextMetadata = payload.get("context_snapshot", engine.context)
    m: NetworkMetrics = payload.get("metrics_snapshot", engine.metrics)

    table = Table(
        box=box.SIMPLE,
        expand=True,
        show_header=True,
        header_style=f"bold {ELECTRIC_CYAN}",
        pad_edge=False,
    )
    table.add_column("PARÂMETRO (r/xcloud)", style=f"bold {ELECTRIC_CYAN}", ratio=1)
    table.add_column("METADADO / ESTADO ATIVO", style=f"bold {NEON_GREEN}", ratio=2)
    table.add_column("INFRAESTRUTURA / TOPOLOGIA", style=f"bold {ELECTRIC_CYAN}", ratio=1)
    table.add_column("DETALHE DE REDE", style=f"bold {NEON_GREEN}", ratio=2)

    exts = ", ".join(ctx.browser_extensions) if ctx.browser_extensions else "Nenhuma"
    phy_medium = (
        f"[bold {WARNING_AMBER}]Wi-Fi 2.4 GHz (Interferência)[/]"
        if m.is_wifi_2_4ghz
        else f"[bold {NEON_GREEN}]Gigabit Ethernet / Wi-Fi 5-6GHz[/]"
    )
    target_desc = f"{engine.target_host} (Hops: {m.ttl_hop_count})"
    if getattr(engine, "is_target_auto", False) and engine.target_host != engine.original_target_host:
        target_desc += " [Failover AS8075]"
    if engine.custom_host:
        target_desc += f" | Extra: {engine.custom_host}"

    table.add_row("Sistema Operacional", ctx.device_os, "Servidor Azure xCloud", ctx.azure_region)
    table.add_row("Cliente / Navegador", ctx.execution_medium, "Peering / IX.br", ctx.interconnection_mode)
    table.add_row("Extensões Ativas", exts, "Topologia IP / NAT", ctx.addressing_mode)
    table.add_row("Versão da Aplicação", ctx.app_version, "Meio Físico (PHY/MAC)", phy_medium)
    table.add_row("Região do Cliente", ctx.client_region, "Target / Hops TTL", target_desc)

    return Panel(
        table,
        title=f"[bold {ELECTRIC_CYAN}]▣ CONTEXTO TÁTICO DO CLIENTE (r/xcloud) & INFRAESTRUTURA AS8075 ▣[/]",
        subtitle=f"[{DIM_CYAN}]Equinix SP1-SP4 | Ascenty | Elea | NIC.br Anycast[/]",
        box=box.HEAVY,
        border_style=ELECTRIC_CYAN,
        padding=(0, 1),
    )


def render_diagnostics_panel(payload: Dict[str, Any], cap_info: Dict[str, Any]) -> Panel:
    """
    Renders the Multilabel Heuristic Diagnostic Engine output, BGP Topology diagram,
    Scapy TTL traceroute verification, and Linux Capabilities deployment status.
    """
    global_status = payload.get("status", "BOA")
    anomalies: List[Dict[str, Any]] = payload.get("anomalies", [])
    root_cause = payload.get("primary_root_cause", "Conexão Estável com Parâmetros Ideais")
    trace_info: Dict[str, Any] = payload.get("traceroute_report", {})
    m: NetworkMetrics = payload.get("metrics_snapshot", NetworkMetrics())

    elements: List[RenderableType] = []

    # Primary Status & Root Cause Banner
    header_line = Text()
    header_line.append("CAUSA RAIZ PRIMÁRIA: ", style=f"bold {ELECTRIC_CYAN}")
    header_line.append(root_cause, style=f"bold {status_color(global_status)}")
    elements.append(header_line)

    # Anomaly Table
    anom_table = Table(
        box=box.SQUARE,
        expand=True,
        show_header=True,
        header_style=f"bold {ELECTRIC_CYAN}",
        border_style=DIM_CYAN,
    )
    anom_table.add_column("SEV", justify="center", width=5)
    anom_table.add_column("CÓDIGO HEURÍSTICO", width=24)
    anom_table.add_column("DIAGNÓSTICO / ALERTA EM NEON", ratio=2)
    anom_table.add_column("TRIAGEM DE ENGENHARIA", ratio=3)

    if not anomalies:
        anom_table.add_row(
            Text("0", style=f"bold {NEON_GREEN}"),
            Text("NOMINAL_LINK_OK", style=f"bold {NEON_GREEN}"),
            Text("Nenhuma anomalia ativa no enlace até Azure brazilsouth", style=NEON_GREEN),
            Text("Roteamento direto via PNI / IX.br SP (AS26162) / MAPS Cold-Potato.", style="dim white"),
        )
    else:
        for item in anomalies:
            sev = item["severity"]
            col = CRITICAL_RED if sev <= 2 else WARNING_AMBER
            anom_table.add_row(
                Text(f"S{sev}", style=f"bold {DARK_BG} on {col}"),
                Text(item["code"], style=f"bold {col}"),
                Text(item["alert"], style=f"bold {col}"),
                Text(item["cause"], style="white"),
            )

    elements.append(anom_table)

    # BGP Route & Scapy TTL Traceroute Visualization
    has_hairpin = any(a.get("code") == "BGP_HAIRPINNING" for a in anomalies)
    route_text = Text()
    if has_hairpin:
        route_text.append("ROTA SUBÓTIMA DETECTADA (Roteamento Internacional Subótimo / Hairpinning BGP):\n", style=f"bold {CRITICAL_RED}")
        route_text.append(
            f"[Cliente BR] ==(Cabo Submarino)==> [EUA: Equinix Miami / Atlanta CIX-ATL / Ashburn] ==(Retorno)==> [Azure brazilsouth SP] (RTT: {m.rtt_ms:.1f} ms)\n",
            style=f"bold {WARNING_AMBER}",
        )
        if trace_info.get("executed"):
            pop_label = trace_info.get("detected_pop") or "PoP Internacional (TTL Anomaly)"
            route_text.append(
                f"Scapy TTL Traceroute: {trace_info.get('hop_count', m.ttl_hop_count)} hops inspecionados | Desvio: {pop_label}",
                style=f"bold {ELECTRIC_CYAN}",
            )
    else:
        route_text.append("ROTA NACIONAL OTIMIZADA (Cold-Potato / IX.br SP / PNI):\n", style=f"bold {NEON_GREEN}")
        route_text.append(
            f"[Cliente Brasil] ----(PNI 100Gbps / IX.br SP AS26162 / MAPS)----> [Azure brazilsouth - SP (AS8075)] (RTT: {m.rtt_ms:.1f} ms)",
            style=f"bold {ELECTRIC_CYAN}",
        )

    elements.append(route_text)

    # Linux Capabilities & Privilege Verification Line (Section 4 of Task / Section 6.1 of XCLOUD.md)
    cap_line = Text()
    cap_line.append("PERMISSÃO LINUX RAW SOCKET: ", style=f"bold {ELECTRIC_CYAN}")
    cap_line.append(
        f"{REQUIRED_SETCAP_CMD} ",
        style=f"bold {NEON_GREEN if cap_info.get('has_cap_net_raw') else WARNING_AMBER}",
    )
    cap_line.append(
        f"({'VALIDADO' if cap_info.get('has_cap_net_raw') else 'REQUER CONFIGURAÇÃO P/ ICMP PURO'})\n",
        style="dim white",
    )
    resolved_cmd = cap_info.get("resolved_command", f"sudo setcap cap_net_raw+ep {cap_info.get('python_executable', '/usr/bin/python3')}")
    dgram_ok = cap_info.get("has_unprivileged_icmp", False)
    cap_line.append(
        f"FIX 'Invalid file setcap' (Symlink): {READLINK_SETCAP_CMD} -> {resolved_cmd} | ICMP DGRAM: {'ATIVO' if dgram_ok else 'INATIVO'}",
        style=f"bold {NEON_GREEN if (cap_info.get('has_cap_net_raw') or dgram_ok) else WARNING_AMBER}",
    )
    elements.append(cap_line)

    return Panel(
        Group(*elements),
        title=f"[bold { status_color(global_status) }]⚠ MOTOR DE DIAGNÓSTICO HEURÍSTICO MULTILABEL & TOPOLOGIA BGP ⚠[/]",
        subtitle=f"[{ELECTRIC_CYAN}]Teclas: [TAB/D] Modo Cinema | [Q] Sair | [I] Inserir IP/Host | [C] Limpar Host | [8] Testar 8.8.8.8 | [B] Bufferbloat | [T] Scapy Trace | [W] Wi-Fi | [1-4/0] Simular[/]",
        box=box.HEAVY,
        border_style=status_color(global_status),
        padding=(0, 1),
    )


FONT_3X3: Dict[str, List[str]] = {
    "0": ["█▀█", "█ █", "▀▀▀"],
    "1": [" ▄█", "  █", "▀▀▀"],
    "2": ["▀▀█", " ▄▀", "▀▀▀"],
    "3": ["▀▀█", " ▀▄", "▀▀▀"],
    "4": ["█ █", "█▀█", "  ▀"],
    "5": ["█▀▀", "▀▀▄", "▀▀▀"],
    "6": ["█▀▀", "█▀█", "▀▀▀"],
    "7": ["▀▀█", " ▄▀", "▀  "],
    "8": ["█▀█", "█▀█", "▀▀▀"],
    "9": ["█▀█", "▀▀█", "▀▀▀"],
    ".": ["   ", "   ", " ▄ "],
    "-": ["   ", "▀▀▀", "   "],
    "+": ["   ", " ▄ ", "   "],
    "m": ["     ", "█▄▀▄█", "█ ▀ █"],
    "s": ["     ", " █▀▀ ", " ▀▀▄ "],
    " ": [" ", " ", " "],
}


def render_big_digits(text_str: str) -> List[str]:
    """Renders alphanumeric characters into a 3-row high-contrast cyberpunk ASCII font."""
    lines = ["", "", ""]
    for ch in text_str:
        glyph = FONT_3X3.get(ch, ["   ", "   ", "   "])
        for r in range(3):
            lines[r] += glyph[r] + " "
    return lines


def render_3d_globe_ascii(frame_seq: int, radius: int = 4) -> List[Text]:
    """
    Renders a real-time rotating 3D ASCII earth globe with spherical raycast projection,
    diffuse lighting, dynamic continental landmasses, and latitude/longitude coordinate grid.
    Rotates smoothly at 60 FPS without layout wobble.
    """
    angle = frame_seq * 0.08
    lx, ly, lz = -0.4, -0.3, 0.87
    result: List[Text] = []
    for y in range(-radius, radius + 1):
        line = Text()
        ny = y / radius
        for x in range(-radius * 2, radius * 2 + 1):
            nx = x / (radius * 2.0)
            d2 = nx * nx + ny * ny
            if d2 > 1.0:
                line.append(" ")
                continue
            nz = math.sqrt(max(0.0, 1.0 - d2))
            phi = math.asin(max(-1.0, min(1.0, ny)))
            lam = math.atan2(nx, nz) + angle
            diff = max(0.1, nx * lx + ny * ly + nz * lz)
            land = (
                math.sin(2.5 * lam) * math.cos(3.0 * phi)
                + math.sin(4.0 * lam - phi) * 0.4
                + math.cos(lam + 2.0 * phi) * 0.3
            ) > 0.05
            grid = (abs(phi % (math.pi / 4)) < 0.15) or (abs(lam % (math.pi / 4)) < 0.18)

            if d2 > 0.90:
                line.append("░" if land else "·", style=ELECTRIC_CYAN)
            elif land:
                ch = "█" if diff > 0.6 else ("▓" if diff > 0.35 else "▒")
                line.append(ch, style=f"bold {NEON_GREEN}")
            elif grid:
                ch = "+" if diff > 0.4 else "·"
                line.append(ch, style=ELECTRIC_CYAN)
            else:
                ch = "~" if diff > 0.6 else ("·" if diff > 0.3 else " ")
                line.append(ch, style=DIM_CYAN)
        result.append(line)
    return result


def render_xbox_logo_ascii(frame_seq: int) -> List[Text]:
    """
    Renders the stylized Xbox emblem in ASCII art with cybernetic pulsing glow
    and green neon palette (#00ff66).
    """
    raw_lines = [
        "   .▄▄█▀▀█▄▄.   ",
        " ▄█▀  ▄██▄  ▀█▄ ",
        "█▀  ▄██  ██▄  ▀█",
        "█   ▀██  ██▀   █",
        "█▄  ▀██  ██▀  ▄█",
        " ▀█▄  ▀██▀  ▄█▀ ",
        "   ˙▀▀█▄▄█▀▀˙   ",
    ]
    pulse = (frame_seq // 20) % 2 == 0
    res: List[Text] = []
    for idx, raw in enumerate(raw_lines):
        t = Text()
        highlight = idx == ((frame_seq // 4) % len(raw_lines))
        style = "bold #88ffaa" if highlight else (f"bold {NEON_GREEN}" if pulse else NEON_GREEN)
        t.append(raw, style=style)
        res.append(t)
    return res


def render_simplified_hud_dashboard(
    engine: NetworkDiagnosticEngine,
    payload: Optional[Dict[str, Any]] = None,
    cap_info: Optional[Dict[str, Any]] = None,
    fps: float = 60.0,
    frame_seq: int = 0,
    *,
    custom_input_active: bool = False,
    custom_input_buffer: str = "",
) -> RenderableType:
    """
    Renders the simplified Cyberpunk / Sci-Fi Hollywood HUD dashboard.
    Focuses on aesthetic visual impact, clean essential metrics,
    3D rotating ASCII globe, styled Xbox logo, and cybernetic pulse effects.
    """
    if payload is None:
        payload = engine.evaluate_diagnostics()
    if cap_info is None:
        cap_info = validate_linux_capabilities()

    global_status = payload.get("status", "BOA")
    status_col = status_color(global_status)
    pulse_tick = (frame_seq // 12) % 2 == 0
    m: NetworkMetrics = payload.get("metrics_snapshot", engine.metrics)

    header = render_header_hud(payload, cap_info, fps=fps, frame_seq=frame_seq, ui_mode="simplified")

    # 3-column Grid
    grid = Table.grid(expand=True)
    grid.add_column("xbox", ratio=20, min_width=18)
    grid.add_column("mid", ratio=40, min_width=38)
    grid.add_column("globe", ratio=20, min_width=19)

    # 1. Left Column: Xbox Logo + Radar Waves + Pulsing Indicators (11 lines total)
    radar_frames = [
        "◖··◉··◗",
        "◖·(◉)·◗",
        "◖((◉))◗",
        "◖( ◉ )◗",
    ]
    radar_str = radar_frames[(frame_seq // 8) % len(radar_frames)]
    sync_glyph = "●" if (frame_seq // 15) % 2 == 0 else "○"

    left_elems: List[RenderableType] = []
    for line in render_xbox_logo_ascii(frame_seq):
        left_elems.append(Align.center(line))
    left_elems.append(Align.center(Text("XBOX CLOUD", style=f"bold {NEON_GREEN}")))
    left_elems.append(Align.center(Text(f"RADAR: {radar_str}", style=f"bold {ELECTRIC_CYAN}")))
    left_elems.append(Align.center(Text(f"{sync_glyph} SYNC LOCKED", style=f"bold {NEON_GREEN}")))
    left_elems.append(Align.center(Text("FEED: 1080p 60FPS", style=f"dim {ELECTRIC_CYAN}")))
    left_panel = Panel(
        Group(*left_elems),
        title=f"[bold {NEON_GREEN}]⚡ XBOX ⚡[/]",
        box=box.ROUNDED,
        border_style=NEON_GREEN,
        padding=(0, 0),
    )

    # 2. Center Column: Big Neon Ping RTT + Essential Telemetry + Global Status Pulse (11 lines total)
    mid_elems: List[RenderableType] = []
    mid_elems.append(Align.center(Text("── LATÊNCIA RTT (PING) ──", style=f"bold {ELECTRIC_CYAN}")))

    rtt_display = f"{m.rtt_ms:04.1f} ms" if m.rtt_ms > 0 else "00.0 ms"
    big_ping_lines = render_big_digits(rtt_display)
    ping_style = f"bold {status_col}" if pulse_tick else status_col
    for line in big_ping_lines:
        mid_elems.append(Align.center(Text(line, style=ping_style)))

    badge_style = f"bold {DARK_BG} on {status_col}" if pulse_tick else f"bold {status_col} on {DARK_BG}"
    status_line = Text()
    status_line.append("STATUS GLOBAL: ", style="bold white")
    status_line.append(f" [ {global_status} ] ", style=badge_style)
    mid_elems.append(Align.center(status_line))

    jitter_q = engine.classify_metric_quality("jitter", m.jitter_ms)
    loss_q = engine.classify_metric_quality("loss", m.packet_loss_pct)
    bloat_q = engine.classify_metric_quality("bufferbloat", m.bufferbloat_delta_ms)

    st_table = Table.grid(expand=True)
    st_table.add_column("k", style=f"bold {ELECTRIC_CYAN}", no_wrap=True)
    st_table.add_column("v", style="bold white", justify="right", no_wrap=True)
    st_table.add_row("Jitter (RFC 3550):", f"{m.jitter_ms:0.2f} ms  [{jitter_q}]")
    st_table.add_row("Perda de Pacotes:", f"{m.packet_loss_pct:0.1f}%  [{loss_q}]")
    st_table.add_row("Bufferbloat Delta:", f"{m.bufferbloat_delta_ms:+.1f} ms  [{bloat_q}]")
    st_table.add_row("Servidor Azure:", "brazilsouth [SP]")
    cm: Dict[str, Any] = payload.get("custom_host_metrics", engine.custom_host_metrics)
    has_custom = bool(engine.custom_host or cm.get("host"))
    if has_custom:
        c_host = engine.custom_host or cm.get("host")
        c_rtt = f"{cm.get('rtt_ms', 0.0):0.1f} ms" if cm.get("online") else "Aguardando..."
        st_table.add_row(f"Host Extra ({c_host}):", f"{c_rtt}")
    mid_elems.append(st_table)

    anomalies = payload.get("anomalies", [])
    if anomalies:
        primary_anomaly = anomalies[0]
        code = primary_anomaly.get("code", "ANOMALIA")
        alert_desc = primary_anomaly.get("alert") or primary_anomaly.get("cause") or ""
        for pfx in ("ALERTA CRÍTICO: ", "ALERTA: ", "Alerta: "):
            if alert_desc.startswith(pfx):
                alert_desc = alert_desc[len(pfx):]
        sev = primary_anomaly.get("severity", 4)
        col = CRITICAL_RED if sev <= 2 else WARNING_AMBER
        alert_text = Text(f"⚠ {code}: {alert_desc[:20]}", style=f"bold {col}")
        mid_elems.append(Align.center(alert_text))
        if not has_custom:
            mid_elems.append(Align.center(Text("Triagem: [TAB/D] Ver Rota Detalhada", style=f"dim {WARNING_AMBER}")))
    else:
        mid_elems.append(Align.center(Text("✔ LINK NOMINAL: Parâmetros Ideais", style=f"bold {NEON_GREEN}")))
        if not has_custom:
            mid_elems.append(Align.center(Text("AS8075 Microsoft Borda SP / IX.br", style=f"dim {ELECTRIC_CYAN}")))

    mid_panel = Panel(
        Group(*mid_elems),
        title=f"[bold {ELECTRIC_CYAN}]◈ TELEMETRIA ESSENCIAL ◈[/]",
        box=box.ROUNDED,
        border_style=status_col,
        padding=(0, 0),
    )

    # 3. Right Column: Rotating 3D ASCII Globe + Orbital Telemetry (11 lines total)
    right_elems: List[RenderableType] = []
    for line in render_3d_globe_ascii(frame_seq, radius=4):
        right_elems.append(Align.center(line))
    right_elems.append(Align.center(Text("AZURE BRAZILSOUTH", style=f"bold {ELECTRIC_CYAN}")))
    right_elems.append(Align.center(Text("SP [23.5°S 46.6°W]", style=DIM_CYAN)))
    right_panel = Panel(
        Group(*right_elems),
        title=f"[bold {ELECTRIC_CYAN}]🌐 GLOBO 3D 🌐[/]",
        box=box.ROUNDED,
        border_style=ELECTRIC_CYAN,
        padding=(0, 0),
    )

    grid.add_row(left_panel, mid_panel, right_panel)

    # 4. Bottom Panel: Audio / Signal Equalizer Pulse Bars, Scanlines, and Shortcuts
    eq_chars = [" ", " ", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
    eq_text = Text()
    eq_text.append("AUDIO/SIGNAL PULSE: [", style=ELECTRIC_CYAN)
    for i in range(16):
        val = int((math.sin(frame_seq * 0.2 + i * 0.45) * 0.5 + 0.5) * (len(eq_chars) - 1))
        col = NEON_GREEN if val < 5 else (ELECTRIC_CYAN if val < 7 else WARNING_AMBER)
        eq_text.append(eq_chars[val], style=f"bold {col}")
    eq_text.append("] ", style=ELECTRIC_CYAN)
    eq_text.append(f"SCAN 0x{frame_seq:04X} // 60 FPS PULSE", style=f"dim {ELECTRIC_CYAN}")

    bottom_elems: List[RenderableType] = [eq_text]
    if custom_input_active:
        input_text = Text()
        input_text.append("DIGITAR IP/HOST: ", style=f"bold {WARNING_AMBER}")
        input_text.append(f"[ {custom_input_buffer}█ ]", style=f"bold {NEON_GREEN} on {DARK_BG}")
        input_text.append(" (Enter confirma, Esc cancela)", style="dim white")
        bottom_elems.append(input_text)

    shortcut_line1 = Text(
        "Teclas: [TAB/D] Modo Detalhado (Telemetria Completa) | [Q] Sair",
        style=f"bold {ELECTRIC_CYAN}",
    )
    shortcut_line2 = Text(
        "Controles: [I] Host | [8] 8.8.8.8 | [B] Bufferbloat | [T] Scapy Trace",
        style=f"bold {ELECTRIC_CYAN}",
    )
    bottom_elems.append(shortcut_line1)
    bottom_elems.append(shortcut_line2)

    bottom_panel = Panel(
        Group(*bottom_elems),
        title=f"[bold {ELECTRIC_CYAN}]⚡ SINAL DE REDE & CONTROLES TÁTICOS ⚡[/]",
        box=box.HEAVY,
        border_style=status_col,
        padding=(0, 1),
    )

    return Group(header, grid, bottom_panel)


def render_full_hud_dashboard(
    engine: NetworkDiagnosticEngine,
    payload: Optional[Dict[str, Any]] = None,
    cap_info: Optional[Dict[str, Any]] = None,
    fps: float = 60.0,
    frame_seq: int = 0,
    *,
    custom_input_active: bool = False,
    custom_input_buffer: str = "",
) -> RenderableType:
    """Composes the entire Cyberpunk Hollywood TUI HUD dashboard as a Rich Layout/Group."""
    if payload is None:
        payload = engine.evaluate_diagnostics()
    if cap_info is None:
        cap_info = validate_linux_capabilities()

    header = render_header_hud(payload, cap_info, fps=fps, frame_seq=frame_seq, ui_mode="detailed")
    metrics_panel = render_metrics_bars_panel(engine, payload)
    strategic_panel = render_strategic_endpoints_panel(
        engine,
        payload,
        custom_input_active=custom_input_active,
        custom_input_buffer=custom_input_buffer,
    )
    context_panel = render_client_context_panel(payload, engine)
    diag_panel = render_diagnostics_panel(payload, cap_info)

    return Group(header, metrics_panel, strategic_panel, context_panel, diag_panel)


# ---------------------------------------------------------------------------
# Textual TUI Application (60 FPS Reactive Event Loop)
# ---------------------------------------------------------------------------
class XCloudHudWidget(Static):
    """Reactive HUD Widget rendered at 60 FPS inside Textual."""

    frame_counter: int = reactive(0)  # type: ignore
    global_status: str = reactive("BOA")  # type: ignore

    def __init__(
        self,
        engine: NetworkDiagnosticEngine,
        cap_info: Dict[str, Any],
        *,
        id: Optional[str] = "hud-root",
        ui_mode: str = "simplified",
    ) -> None:
        super().__init__(id=id)
        self.engine = engine
        self.cap_info = cap_info
        self.latest_payload: Dict[str, Any] = self.engine.evaluate_diagnostics()
        self.measured_fps: float = 60.0
        self.custom_input_active: bool = False
        self.custom_input_buffer: str = ""
        self.ui_mode: str = ui_mode

    def update_from_payload(
        self,
        payload: Dict[str, Any],
        fps: float,
        frame_seq: int,
        *,
        custom_input_active: bool = False,
        custom_input_buffer: str = "",
        ui_mode: Optional[str] = None,
    ) -> None:
        self.latest_payload = payload
        self.measured_fps = fps
        self.global_status = payload.get("status", "BOA")
        self.frame_counter = frame_seq
        self.custom_input_active = custom_input_active
        self.custom_input_buffer = custom_input_buffer
        if ui_mode is not None:
            self.ui_mode = ui_mode
        if self.ui_mode == "detailed":
            self.update(
                render_full_hud_dashboard(
                    self.engine,
                    self.latest_payload,
                    self.cap_info,
                    fps=self.measured_fps,
                    frame_seq=self.frame_counter,
                    custom_input_active=self.custom_input_active,
                    custom_input_buffer=self.custom_input_buffer,
                )
            )
        else:
            self.update(
                render_simplified_hud_dashboard(
                    self.engine,
                    self.latest_payload,
                    self.cap_info,
                    fps=self.measured_fps,
                    frame_seq=self.frame_counter,
                    custom_input_active=self.custom_input_active,
                    custom_input_buffer=self.custom_input_buffer,
                )
            )


class XCloudTuiApp(TextualApp):
    """
    Aplicação TUI Estilo Sci-Fi / Hollywood para Monitoramento do Xbox Cloud Gaming (xCloud)
    no Brasil (Azure brazilsouth - AS8075).
    Opera em loop reativo a 60 FPS desacoplado da Engine de Medição via asyncio.Queue.
    """

    TITLE = "XCLOUD // CYBER-HUD TELEMETRY MONITOR [BRAZILSOUTH - AS8075]"
    SUB_TITLE = "60 FPS Reactive TUI | RFC 3550 EWMA Jitter | Multilabel BGP & Bufferbloat Diagnostics"

    CSS = """
    Screen {
        background: #060d12;
        color: #00ff66;
    }
    #hud-root {
        width: 100%;
        height: 100%;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "Sair"),
        Binding("tab", "toggle_ui_mode", "Alternar UI (Cinema/Detalhada)"),
        Binding("d", "toggle_ui_mode", "Alternar UI (Cinema/Detalhada)"),
        Binding("i", "focus_custom_host", "Inserir IP/Host"),
        Binding("c", "clear_custom_host", "Limpar Host Extra"),
        Binding("8", "quick_google_dns", "Testar 8.8.8.8"),
        Binding("b", "trigger_bufferbloat", "Burst Bufferbloat"),
        Binding("t", "trigger_traceroute", "Scapy TTL Trace"),
        Binding("w", "toggle_wifi", "Toggle Wi-Fi 2.4GHz"),
        Binding("1", "sim_hairpin", "Simular Hairpinning"),
        Binding("2", "sim_loss", "Simular Packet Loss"),
        Binding("3", "sim_bloat", "Simular Bufferbloat"),
        Binding("4", "sim_wifi", "Simular Wi-Fi 2.4GHz"),
        Binding("0", "sim_nominal", "Resetar Nominal"),
    ]

    current_status = reactive("BOA")  # type: ignore

    def __init__(
        self,
        target_host: str = DEFAULT_PRIMARY_HOST,
        probe_interval: float = 1.0,
        demo_mode: bool = False,
        custom_host: Optional[str] = None,
        ui_mode: str = "simplified",
    ) -> None:
        super().__init__()
        self.ui_mode = ui_mode
        self.engine = NetworkDiagnosticEngine(
            target_host=target_host or DEFAULT_PRIMARY_HOST,
            custom_host=custom_host,
        )
        self.data_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        self.cap_info = validate_linux_capabilities()
        self.probe_interval = probe_interval
        self.demo_mode = demo_mode
        self.custom_input_active: bool = False
        self.custom_input_buffer: str = custom_host or ""
        self.latest_payload: Dict[str, Any] = self.engine.evaluate_diagnostics()
        self._frame_seq: int = 0
        self._last_frame_ts: float = time.perf_counter()
        self._fps_ema: float = 60.0
        self._pending_run_seconds: Optional[float] = None
        self.hud_widget = XCloudHudWidget(
            self.engine,
            self.cap_info,
            id="hud-root",
            ui_mode=self.ui_mode,
        )

    def compose(self) -> ComposeResult:
        yield self.hud_widget

    def on_mount(self) -> None:
        # Render initial frame immediately
        self._on_frame_tick()
        # Inicia o worker assíncrono de medição em background (@work)
        self.start_telemetry_worker()
        # Loop reativo de interface a 60 FPS (16.67 ms por quadro)
        self.set_interval(FRAME_INTERVAL_SEC, self._on_frame_tick)
        if HAS_NATIVE_TEXTUAL and self._pending_run_seconds is not None:
            set_timer = getattr(self, "set_timer", None)
            if callable(set_timer):
                set_timer(self._pending_run_seconds, self.exit)

    async def run_async(
        self,
        headless: bool = False,
        run_seconds: Optional[float] = None,
        **kwargs: Any,
    ) -> Any:
        self._pending_run_seconds = run_seconds
        if HAS_NATIVE_TEXTUAL:
            return await super().run_async(headless=headless, **kwargs)
        return await super().run_async(headless=headless, run_seconds=run_seconds, **kwargs)

    @textual_work(exclusive=True)
    async def start_telemetry_worker(self) -> None:
        """Executa o worker de medição de rede desacoplado via asyncio.Queue."""
        if self.demo_mode:
            await self._demo_simulation_worker()
        else:
            await network_measurement_worker(
                self.engine,
                self.data_queue,
                cycle_interval=self.probe_interval,
            )

    def _populate_demo_strategic_endpoints(self, step: int = 0) -> None:
        """Preenche os endpoints estratégicos com telemetria sintética realista de São Paulo/Brasil/EUA."""
        jitter_offset = (step % 4) * 0.3
        demo_rtts = {
            "ix_sp_v4_1": 11.8 + jitter_offset,
            "ix_sp_v4_2": 12.1 + jitter_offset,
            "ix_sp_v6_1": 11.6 + jitter_offset,
            "ix_sp_v6_2": 11.9 + jitter_offset,
            "equinix_sp_v4_1": 12.9 + jitter_offset,
            "equinix_sp_v4_2": 13.2 + jitter_offset,
            "equinix_sp_v6_1": 12.7 + jitter_offset,
            "equinix_sp_v6_2": 13.0 + jitter_offset,
            "ix_rj": 19.4 + jitter_offset,
            "ix_campinas": 14.8 + jitter_offset,
            "ix_fortaleza": 44.2 + jitter_offset,
            "azure_brazilsouth_blob": 13.8 + jitter_offset,
            "azure_brazilsouth_telemetry": 14.1 + jitter_offset,
            "us_equinix_miami": 118.5 + jitter_offset,
            "us_equinix_atlanta": 134.0 + jitter_offset,
            "us_equinix_ashburn": 142.6 + jitter_offset,
        }
        for ep_id, rtt_val in demo_rtts.items():
            if ep_id in self.engine.endpoint_results:
                ep = self.engine.endpoint_results[ep_id]
                ep["rtt_ms"] = rtt_val
                ep["online"] = True
                ep["status"] = (
                    "REF-EUA"
                    if ep["category"] == "referencia_internacional"
                    else self.engine.classify_metric_quality("rtt", rtt_val)
                )
        self.engine.sp_edge_rtt_ms = demo_rtts["ix_sp_v4_1"]
        self.engine.azure_brazilsouth_rtt_ms = demo_rtts["azure_brazilsouth_blob"]
        self.engine.us_miami_rtt_ms = demo_rtts["us_equinix_miami"]
        self.engine.us_atlanta_rtt_ms = demo_rtts["us_equinix_atlanta"]
        self.engine.us_ashburn_rtt_ms = demo_rtts["us_equinix_ashburn"]
        self.engine.set_webrtc_session("104.44.239.10", 3478)
        self.engine.ingest_webrtc_stats(12.6 + jitter_offset, jitter_ms=0.85, packet_loss_pct=0.0)
        if self.engine.custom_host:
            self.engine.process_custom_host_sample(15.2 + jitter_offset)

    async def _demo_simulation_worker(self) -> None:
        """Gera telemetria sintética realista caso executado com --demo."""
        step = 0
        while True:
            # Oscila suavemente em torno de 12 ms (rota ideal IX.br SP -> Azure brazilsouth)
            synthetic_rtt = 11.5 + (step % 5) * 0.6
            self.engine.process_raw_sample(synthetic_rtt)
            self._populate_demo_strategic_endpoints(step)
            payload = self.engine.evaluate_diagnostics()
            await self.data_queue.put(payload)
            step += 1
            await asyncio.sleep(self.probe_interval)

    def _on_frame_tick(self) -> None:
        """Consome atualizações da asyncio.Queue sem bloqueio e atualiza o HUD a 60 FPS."""
        now = time.perf_counter()
        dt = max(0.001, now - self._last_frame_ts)
        inst_fps = min(60.0, 1.0 / dt)
        self._fps_ema = self._fps_ema * 0.9 + inst_fps * 0.1
        self._last_frame_ts = now
        self._frame_seq += 1

        # Drena todos os snapshots disponíveis na fila assíncrona sem bloquear o loop de 60 FPS
        while not self.data_queue.empty():
            try:
                self.latest_payload = self.data_queue.get_nowait()
                self.current_status = self.latest_payload.get("status", "BOA")
            except asyncio.QueueEmpty:
                break

        self.hud_widget.update_from_payload(
            self.latest_payload,
            fps=self._fps_ema,
            frame_seq=self._frame_seq,
            custom_input_active=self.custom_input_active,
            custom_input_buffer=self.custom_input_buffer,
            ui_mode=self.ui_mode,
        )

    def build_dashboard_renderable(self) -> RenderableType:
        if self._frame_seq == 0:
            self._on_frame_tick()
        return self.hud_widget.render()

    def check_action(self, action: str, parameters: Tuple[Any, ...]) -> bool:
        """Bloqueia disparo de BINDINGS globais do Textual enquanto o campo de IP/Host estiver em edição."""
        _ = (action, parameters)
        return not self.custom_input_active

    async def action_quit(self) -> None:
        if self.custom_input_active:
            return
        self.exit()

    async def action_toggle_ui_mode(self) -> None:
        """Alterna entre Modo Cinema (visual simplificado) e Modo Detalhado (telemetria completa)."""
        if self.custom_input_active:
            return
        self.ui_mode = "detailed" if self.ui_mode == "simplified" else "simplified"
        self._on_frame_tick()

    def handle_key(self, key: str) -> Optional[asyncio.Task[Any]]:
        """
        Processa teclas no modo de digitação de IP/Host customizado (quando ativo)
        ou despacha para os atalhos táticos da TUI.
        """
        if self.custom_input_active:
            if key in ("\r", "\n", "enter"):
                self.custom_input_active = False
                target_str = self.custom_input_buffer.strip()
                task = asyncio.create_task(self.apply_custom_host(target_str))
                if hasattr(self, "_background_tasks"):
                    self._background_tasks.append(task)
                self._on_frame_tick()
                return task
            if key in ("\x1b", "escape"):
                self.custom_input_active = False
                self.custom_input_buffer = self.engine.custom_host or ""
                self._on_frame_tick()
                return None
            if key in ("\x7f", "\x08", "backspace"):
                self.custom_input_buffer = self.custom_input_buffer[:-1]
                self._on_frame_tick()
                return None
            if len(key) == 1 and (key.isalnum() or key in ".:-_"):
                self.custom_input_buffer += key
                self._on_frame_tick()
            return None

        normalized = key.lower()
        if normalized in ("tab", "\t"):
            normalized = "tab"
        for binding in getattr(self, "BINDINGS", []):
            if binding.key.lower() == normalized:
                action_fn = getattr(self, f"action_{binding.action}", None)
                if callable(action_fn):
                    res = action_fn()
                    if asyncio.iscoroutine(res):
                        task = asyncio.create_task(res)
                        if hasattr(self, "_background_tasks"):
                            self._background_tasks.append(task)
                        return task
                break
        return None

    async def on_key(self, event: Any) -> None:
        """Hook de teclado para o Textual nativo quando o campo de IP/Host está ativo."""
        key_name = getattr(event, "key", "")
        char_val = getattr(event, "character", None)
        if not self.custom_input_active:
            if key_name in ("tab", "d") or char_val in ("d", "D", "\t"):
                prevent_fn = getattr(event, "prevent_default", None)
                if callable(prevent_fn):
                    prevent_fn()
                stop_fn = getattr(event, "stop", None)
                if callable(stop_fn):
                    stop_fn()
                await self.action_toggle_ui_mode()
                return
            return
        prevent_fn = getattr(event, "prevent_default", None)
        if callable(prevent_fn):
            prevent_fn()
        stop_fn = getattr(event, "stop", None)
        if callable(stop_fn):
            stop_fn()
        if key_name in ("enter", "escape", "backspace"):
            self.handle_key(key_name)
        elif char_val and len(char_val) == 1:
            self.handle_key(char_val)

    async def apply_custom_host(self, host: Optional[str]) -> None:
        """Define o IP/Host customizado (ex: 8.8.8.8) e dispara uma sondagem imediata."""
        self.engine.set_custom_host(host)
        self.custom_input_buffer = self.engine.custom_host or ""
        # Atualiza imediatamente o snapshot do HUD para exibir AGUARDANDO antes da sondagem de rede
        self.latest_payload = self.engine.evaluate_diagnostics()
        self._on_frame_tick()
        if self.engine.custom_host:
            if self.demo_mode:
                self.engine.process_custom_host_sample(14.8)
            else:
                await self.engine.probe_custom_host(timeout=0.75)
        await self.data_queue.put(self.engine.evaluate_diagnostics())
        self._on_frame_tick()

    # Interactive Actions for Testing & Live Triage
    async def action_focus_custom_host(self) -> None:
        """Ativa o campo interativo para digitar um IP ou Host extra (ex: 8.8.8.8)."""
        self.custom_input_active = True
        self.custom_input_buffer = self.engine.custom_host or ""
        self._on_frame_tick()

    async def action_clear_custom_host(self) -> None:
        """Limpa o IP/Host customizado e retorna apenas aos hosts nativos do xCloud."""
        if self.custom_input_active:
            return
        self.custom_input_active = False
        self.custom_input_buffer = ""
        self.engine.set_custom_host(None)
        await self.data_queue.put(self.engine.evaluate_diagnostics())
        self._on_frame_tick()

    async def action_quick_google_dns(self) -> None:
        """Atalho rápido [8] para inserir e testar 8.8.8.8 no campo de host customizado."""
        if self.custom_input_active:
            return
        await self.apply_custom_host("8.8.8.8")

    async def action_trigger_bufferbloat(self) -> None:
        if self.custom_input_active:
            return
        await self.engine.measure_bufferbloat_burst()
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_trigger_traceroute(self) -> None:
        if self.custom_input_active:
            return
        await self.engine.trace_route_ttl_scapy(max_hops=12, timeout=0.15)
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_toggle_wifi(self) -> None:
        if self.custom_input_active:
            return
        self.engine.metrics.is_wifi_2_4ghz = not self.engine.metrics.is_wifi_2_4ghz
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_sim_hairpin(self) -> None:
        if self.custom_input_active:
            return
        self.engine.process_raw_sample(135.0)
        self.engine.sp_edge_rtt_ms = 135.0
        self.engine.us_miami_rtt_ms = 128.0
        await self.engine.trace_route_ttl_scapy(
            simulated_hops=[
                {"ttl": 1, "ip": "192.168.1.1", "host": "cpe-gateway.local"},
                {"ttl": 2, "ip": "187.16.216.1", "host": "ix-sp.br"},
                {"ttl": 3, "ip": "198.32.242.188", "host": "equinix-miami.as8075.net"},
                {"ttl": 4, "ip": "198.32.132.44", "host": "cix-atl.ix-1668.us.as8075.net"},
                {"ttl": 5, "ip": "104.44.239.10", "host": "brazilsouth.azure.microsoft.com"},
            ]
        )
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_sim_loss(self) -> None:
        if self.custom_input_active:
            return
        self.engine.process_raw_sample(None)
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_sim_bloat(self) -> None:
        if self.custom_input_active:
            return
        self.engine.metrics.bufferbloat_delta_ms = 68.5
        self.engine.bufferbloat_history.append(68.5)
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_sim_wifi(self) -> None:
        if self.custom_input_active:
            return
        self.engine.metrics.is_wifi_2_4ghz = True
        self.engine.metrics.jitter_ms = 22.4
        self.engine.jitter_history.append(22.4)
        await self.data_queue.put(self.engine.evaluate_diagnostics())

    async def action_sim_nominal(self) -> None:
        if self.custom_input_active:
            return
        self.engine.metrics = NetworkMetrics()
        self.engine.last_rtt = None
        self.engine.rtt_window.clear()
        self.engine.sp_edge_rtt_ms = 12.4
        self.engine.us_miami_rtt_ms = 118.5
        self.engine.last_traceroute_report = {
            "executed": False,
            "hops": [],
            "hairpin_confirmed": False,
            "detected_pop": None,
        }
        self.engine.process_raw_sample(12.4)
        await self.data_queue.put(self.engine.evaluate_diagnostics())


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------
def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Xbox Cloud Gaming (xCloud) Brasil — Monitor TUI Cyberpunk a 60 FPS "
            "(Executa automaticamente nos hosts estratégicos AS8075 / Azure brazilsouth / EUA)"
        )
    )
    parser.add_argument(
        "--target",
        default=DEFAULT_PRIMARY_HOST,
        help=(
            f"Host primário da borda Microsoft Brasil (padrão automático: {DEFAULT_PRIMARY_HOST} "
            "— IX.br São Paulo AS8075; nenhum parâmetro é obrigatório)"
        ),
    )
    parser.add_argument(
        "--custom-host",
        default=None,
        help="IP ou Host adicional opcional para testar fora dos principais do xCloud (ex: 8.8.8.8)",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=1.0,
        help="Intervalo em segundos entre ciclos de sondagem (padrão: 1.0s)",
    )
    parser.add_argument(
        "--check-caps",
        action="store_true",
        help="Valida permissões Linux CAP_NET_RAW (setcap) e exibe instruções de implantação",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Executa um ciclo de diagnóstico e renderiza o snapshot do HUD no terminal",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Executa em modo de demonstração com telemetria sintética para inspeção visual",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Tempo máximo de execução da TUI em segundos (útil para testes automatizados)",
    )
    parser.add_argument(
        "--detailed",
        action="store_true",
        help="Inicia diretamente na UI detalhada (modo estatísticas completas; padrão é UI simplificada/cinema)",
    )
    parser.add_argument(
        "--compact",
        "--simplified",
        action="store_true",
        help="Inicia na UI simplificada/cinema (comportamento padrão)",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    console = Console()
    ui_mode = "detailed" if args.detailed else "simplified"

    cap_info = validate_linux_capabilities()
    if args.check_caps:
        panel = Panel(
            Group(
                Text(f"Status: {cap_info['status_message']}", style=f"bold {NEON_GREEN if (cap_info['has_cap_net_raw'] or cap_info.get('has_unprivileged_icmp')) else WARNING_AMBER}"),
                Text(f"Interpretador Python (Real ELF): {cap_info['python_executable']}", style=ELECTRIC_CYAN),
                Text(f"Caminho Original (Symlink={cap_info.get('is_symlink')}): {cap_info.get('raw_python_path')}", style="white"),
                Text(f"CapEff Hex (/proc/self/status): {cap_info['cap_eff_hex']}", style="white"),
                Text(f"ICMP DGRAM Sem Root (ping_group_range): {'ATIVO (Não exige setcap)' if cap_info.get('has_unprivileged_icmp') else 'INATIVO'}", style=f"bold {NEON_GREEN if cap_info.get('has_unprivileged_icmp') else WARNING_AMBER}"),
                Text(f"Comando Padrão Spec: {cap_info['recommended_command']}", style=f"dim {ELECTRIC_CYAN}"),
                Text(f"Comando Corrigido (Resolve Symlink): {cap_info['readlink_command']}", style=f"bold {NEON_GREEN}"),
                Text(f"Comando Direto no Binário Real: {cap_info['resolved_command']}", style=f"bold {NEON_GREEN}"),
                Text(f"Diagnóstico setcap: {cap_info['setcap_error_explanation']}", style=WARNING_AMBER),
            ),
            title="[bold #00f0ff]VALIDAÇÃO DE PRIVILÉGIOS DE REDE LINUX (CAP_NET_RAW & SYMLINK FIX)[/]",
            box=box.HEAVY,
            border_style=ELECTRIC_CYAN,
        )
        console.print(panel)
        return 0

    if args.once:
        engine = NetworkDiagnosticEngine(
            target_host=args.target,
            custom_host=args.custom_host,
        )
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        if args.demo:
            engine.process_raw_sample(14.2)
            engine.process_raw_sample(15.0)
            app_demo = XCloudTuiApp(
                target_host=args.target,
                demo_mode=True,
                custom_host=args.custom_host,
                ui_mode=ui_mode,
            )
            app_demo.engine = engine
            app_demo._populate_demo_strategic_endpoints(0)
            payload = engine.evaluate_diagnostics()
        else:
            asyncio.run(
                network_measurement_worker(
                    engine,
                    queue,
                    max_cycles=1,
                    cycle_interval=0.05,
                )
            )
            payload = queue.get_nowait()
        if ui_mode == "detailed":
            console.print(render_full_hud_dashboard(engine, payload, cap_info, fps=60.0, frame_seq=1))
        else:
            console.print(render_simplified_hud_dashboard(engine, payload, cap_info, fps=60.0, frame_seq=1))
        return 0

    app = XCloudTuiApp(
        target_host=args.target,
        probe_interval=args.interval,
        demo_mode=args.demo,
        custom_host=args.custom_host,
        ui_mode=ui_mode,
    )
    if args.duration is not None:
        asyncio.run(app.run_async(run_seconds=args.duration))
    else:
        app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
