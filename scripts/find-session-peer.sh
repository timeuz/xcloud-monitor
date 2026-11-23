#!/usr/bin/env bash
# Finds the game server of a running xCloud session (any client, browser included) by watching UDP traffic for a few seconds.
#
# Why a script: the stream uses UDP sockets that are not "connected", so no unprivileged tool (and not the app)
# can see the remote address. A short packet capture can, and that needs root. Nothing is stored or sent
# anywhere: it only prints the busiest public UDP peers.
#
# Usage (while a game is streaming):   sudo scripts/find-session-peer.sh [seconds]
#        for testing the parser:        scripts/find-session-peer.sh --stdin < tcpdump.txt
# Linux, and macOS on a best-effort basis (needs tcpdump). Windows: use Wireshark and look for the UDP flow with
# the most bytes to a public address.
set -euo pipefail

SECONDS_TO_CAPTURE="${1:-6}"

summarise() {
  # Reads `tcpdump -nn -q` lines:  "... IP a.b.c.d.1234 > e.f.g.h.5678: UDP, length 96"
  # Sums bytes per public remote endpoint and prints the top ones.
  awk '
    function is_private(ip) {
      return ip ~ /^(10\.|127\.|192\.168\.|169\.254\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.|0\.)/ ||
             ip ~ /^172\.(1[6-9]|2[0-9]|3[01])\./ || ip ~ /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./
    }
    function host_of(tok,   n, parts) { n = split(tok, parts, "."); if (n < 5) return ""; return parts[1] "." parts[2] "." parts[3] "." parts[4] }
    / IP6? / && /UDP, length/ {
      src = ""; dst = ""; len = 0
      for (i = 1; i <= NF; i++) { if ($i == ">") { src = $(i-1); dst = $(i+1); sub(/:$/, "", dst) } if ($i == "length") len = $(i+1) + 0 }
      if (src == "" || dst == "") next
      s = host_of(src); d = host_of(dst)
      if (s != "" && !is_private(s)) { bytes[src] += len; pkts[src]++ }
      if (d != "" && !is_private(d)) { bytes[dst] += len; pkts[dst]++ }
    }
    END { for (k in bytes) printf "%d %d %s\n", bytes[k], pkts[k], k }
  ' | sort -rn | head -5
}

if [ "${1:-}" = "--stdin" ]; then
  result="$(summarise)"
else
  command -v tcpdump >/dev/null || { echo "tcpdump não encontrado." >&2; exit 1; }
  if [ "$(id -u)" -ne 0 ]; then echo "Precisa de root para capturar pacotes: rode com sudo." >&2; exit 1; fi
  echo "Capturando UDP por ${SECONDS_TO_CAPTURE}s (o jogo precisa estar em andamento)..." >&2
  result="$(timeout "$SECONDS_TO_CAPTURE" tcpdump -nn -q -l -i any udp 2>/dev/null | summarise || true)"
fi

if [ -z "$result" ]; then
  echo "Nenhum tráfego UDP para endereço público foi visto." >&2
  exit 2
fi

echo "bytes pacotes destino(ip.porta)"
echo "$result"
top="$(echo "$result" | head -1 | awk '{print $3}')"
echo
echo "Servidor provável da sessão: ${top%.*}   (porta ${top##*.})"
echo "Cole esse endereço na aba Histórico > Servidor da sessão."
