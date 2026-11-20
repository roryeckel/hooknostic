#!/usr/bin/env python3
"""Summarize non-loopback egress from an `strace -f -ttt` log.

Usage: parse_strace.py <strace.log> [vitest.json] > summary.json

Attribution: every traced pid is mapped to its thread group (clone with
CLONE_THREAD), and each thread group to the image of its last successful
execve (inherited from the parent across fork when it never execs). DNS
queries and answers are decoded from the traced UDP payloads on sockets that
were connected to port 53, so hostname -> address mappings are the ones the
process itself received.
"""
import json
import re
import sys
from collections import defaultdict

LINE = re.compile(r"^(\d+)\s+(\d+\.\d+)\s+(.*)$")
CALL = re.compile(r"^(\w+)\((.*)$")
RET = re.compile(r"\)\s+=\s+(-?\d+|\?)(?:\s+(\w+))?.*$")
INET4 = re.compile(r'sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)')
INET6 = re.compile(r'sa_family=AF_INET6, sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"')
STRS = re.compile(r'"((?:[^"\\]|\\.)*)"')


def unescape(s):
    out = bytearray()
    i = 0
    simple = {"n": 10, "t": 9, "r": 13, "v": 11, "f": 12, "a": 7, "b": 8, "\\": 92, '"': 34, "'": 39}
    while i < len(s):
        c = s[i]
        if c != "\\":
            out += c.encode("latin-1", "replace")
            i += 1
            continue
        n = s[i + 1]
        if n in simple:
            out.append(simple[n])
            i += 2
        elif n == "x":
            out.append(int(s[i + 2 : i + 4], 16))
            i += 4
        elif n in "01234567":
            j = i + 1
            while j < len(s) and j < i + 4 and s[j] in "01234567":
                j += 1
            out.append(int(s[i + 1 : j], 8) & 0xFF)
            i = j
        else:
            out += n.encode()
            i += 2
    return bytes(out)


def read_name(buf, off, depth=0):
    labels = []
    while off < len(buf):
        ln = buf[off]
        if ln == 0:
            return ".".join(labels), off + 1
        if ln & 0xC0 == 0xC0:
            if off + 1 >= len(buf) or depth > 10:
                return ".".join(labels), off + 2
            ptr = ((ln & 0x3F) << 8) | buf[off + 1]
            rest, _ = read_name(buf, ptr, depth + 1)
            labels.append(rest)
            return ".".join(x for x in labels if x), off + 2
        labels.append(buf[off + 1 : off + 1 + ln].decode("ascii", "replace"))
        off += 1 + ln
    return ".".join(labels), off


QTYPE = {1: "A", 28: "AAAA", 5: "CNAME", 65: "HTTPS", 33: "SRV", 16: "TXT", 12: "PTR"}


def parse_dns(buf):
    if len(buf) < 12:
        return None
    qid, flags, qd, an = buf[0] << 8 | buf[1], buf[2] << 8 | buf[3], buf[4] << 8 | buf[5], buf[6] << 8 | buf[7]
    off = 12
    qs = []
    for _ in range(qd):
        name, off = read_name(buf, off)
        if off + 4 > len(buf):
            return None
        qt = buf[off] << 8 | buf[off + 1]
        off += 4
        qs.append((name, QTYPE.get(qt, str(qt))))
    answers = []
    for _ in range(an):
        if off >= len(buf):
            break
        name, off = read_name(buf, off)
        if off + 10 > len(buf):
            break
        t = buf[off] << 8 | buf[off + 1]
        rdlen = buf[off + 8] << 8 | buf[off + 9]
        off += 10
        rd = buf[off : off + rdlen]
        if t == 1 and rdlen == 4:
            answers.append((name, "A", ".".join(str(b) for b in rd)))
        elif t == 28 and rdlen == 16:
            import ipaddress

            answers.append((name, "AAAA", str(ipaddress.IPv6Address(bytes(rd)))))
        elif t == 5:
            cname, _ = read_name(buf, off)
            answers.append((name, "CNAME", cname))
        off += rdlen
    return {"id": qid, "response": bool(flags & 0x8000), "rcode": flags & 0xF, "questions": qs, "answers": answers}


def sni(buf):
    """server_name from a TLS ClientHello record, if the traced prefix holds it."""
    try:
        if len(buf) < 44 or buf[0] != 0x16 or buf[5] != 0x01:
            return None
        off = 9 + 2 + 32  # record(5) + handshake hdr(4) + version + random
        off += 1 + buf[off]  # session id
        off += 2 + (buf[off] << 8 | buf[off + 1])  # cipher suites
        off += 1 + buf[off]  # compression
        end = off + 2 + (buf[off] << 8 | buf[off + 1])
        off += 2
        while off + 4 <= min(end, len(buf)):
            typ, ln = buf[off] << 8 | buf[off + 1], buf[off + 2] << 8 | buf[off + 3]
            if typ == 0:
                n = buf[off + 7] << 8 | buf[off + 8]
                return buf[off + 9 : off + 9 + n].decode("ascii", "replace")
            off += 4 + ln
    except IndexError:
        return None
    return None


def is_loopback(ip):
    return ip.startswith("127.") or ip == "::1" or ip.startswith("::ffff:127.")


def main():
    path = sys.argv[1]
    tgid = {}  # pid -> thread group id
    parent = {}  # tgid -> parent tgid
    image = {}  # tgid -> (exe, argv)
    pending = {}  # pid -> (syscall, args-so-far, ts)
    started = {}  # tgid -> timestamp of its last successful execve
    dnsfd = set()  # (tgid, fd)
    tlsfd = {}  # (tgid, fd) -> (ip, port) of a non-loopback stream
    snis = defaultdict(set)  # (ip, port) -> TLS SNI names seen in ClientHellos
    events = []
    dns = []
    first_ts = None

    def tg(pid):
        return tgid.get(pid, pid)

    def img(t):
        seen = set()
        while t not in image and t in parent and t not in seen:
            seen.add(t)
            t = parent[t]
        return image.get(t, ("?", []))

    def chain(t):
        out = []
        seen = set()
        while t is not None and t not in seen and len(out) < 8:
            seen.add(t)
            exe, argv = img(t)
            out.append(exe.rsplit("/", 1)[-1])
            t = parent.get(t)
        return out

    def handle(pid, ts, name, rest):
        nonlocal first_ts
        first_ts = first_ts or ts
        t = tg(pid)
        rm = RET.search(rest)
        ret = rm.group(1) if rm else "?"
        err = rm.group(2) if rm else None
        if name == "execve":
            if ret == "0":
                strs = STRS.findall(rest)
                exe = strs[0] if strs else "?"
                argv = [unescape(x).decode("utf-8", "replace") for x in strs[1:12]]
                image[t] = (exe, argv)
                started[t] = ts
            return
        if name in ("clone", "clone3", "fork", "vfork"):
            if ret.isdigit() and int(ret) > 0:
                child = int(ret)
                if "CLONE_THREAD" in rest:
                    tgid[child] = t
                else:
                    parent[child] = t
            return
        fdm = re.match(r"(\d+),", rest)
        fd = int(fdm.group(1)) if fdm else -1
        if name == "connect":
            m4, m6 = INET4.search(rest), INET6.search(rest)
            if not (m4 or m6):
                return
            port, ip = (m4 or m6).groups()
            port = int(port)
            if port == 53:
                dnsfd.add((t, fd))
            else:
                dnsfd.discard((t, fd))
            if is_loopback(ip) or port in (0, 53):
                tlsfd.pop((t, fd), None)
            else:
                tlsfd[(t, fd)] = (ip, port)
            if is_loopback(ip):
                return
            exe, argv = img(t)
            events.append(
                {"ts": ts, "pid": pid, "tgid": t, "ip": ip, "port": port, "ret": ret, "err": err,
                 "exe": exe, "argv": argv, "chain": chain(t)}
            )
            return
        if name in ("sendto", "sendmmsg", "sendmsg", "recvfrom", "recvmsg"):
            if name.startswith("send") and (t, fd) in tlsfd:
                for s in STRS.findall(rest)[:1]:
                    host = sni(unescape(s))
                    if host:
                        snis[tlsfd[(t, fd)]].add(host)
            to53 = "htons(53)" in rest
            if (t, fd) not in dnsfd and not to53:
                return
            for s in STRS.findall(rest):
                msg = parse_dns(unescape(s))
                if msg and msg["questions"]:
                    exe, argv = img(t)
                    dns.append({"ts": ts, "tgid": t, "exe": exe, "chain": chain(t),
                                "since_exec": round(ts - started.get(t, ts), 3), **msg})

    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            m = LINE.match(raw.rstrip("\n"))
            if not m:
                continue
            pid, ts, body = int(m.group(1)), float(m.group(2)), m.group(3)
            if body.endswith("<unfinished ...>"):
                cm = CALL.match(body)
                if cm:
                    pending[pid] = (cm.group(1), cm.group(2)[: -len("<unfinished ...>")], ts)
                continue
            rm = re.match(r"<\.\.\. (\w+) resumed>(.*)$", body)
            if rm:
                name = rm.group(1)
                prev = pending.pop(pid, (name, "", ts))
                handle(pid, prev[2], name, prev[1] + rm.group(2))
                continue
            cm = CALL.match(body)
            if cm:
                handle(pid, ts, cm.group(1), cm.group(2))

    # hostname for each address, from the answers the processes received
    names = defaultdict(set)
    for d in dns:
        if not d["response"]:
            continue
        q = d["questions"][0][0]
        for owner, typ, val in d["answers"]:
            if typ in ("A", "AAAA"):
                names[val].add(q)
    queries = defaultdict(lambda: {"types": set(), "procs": set(), "answers": set(), "rcodes": set(), "first_ts": None,
                                   "since_exec": [], "tgids": set()})
    for d in dns:
        q = d["questions"][0]
        e = queries[q[0]]
        if not d["response"]:
            e["since_exec"].append(d["since_exec"])
            e["tgids"].add(d["tgid"])
            e.setdefault("argv", set()).add(" ".join(a[:100] for a in img(d["tgid"])[1][:5]))
        e["types"].add(q[1])
        e["procs"].add(d["exe"].rsplit("/", 1)[-1])
        e["first_ts"] = e["first_ts"] or d["ts"]
        if d["response"]:
            e["rcodes"].add(d["rcode"])
            for owner, typ, val in d["answers"]:
                e["answers"].add(f"{typ} {val}")
    dests = {}
    for e in events:
        if e["port"] == 53:
            kind = "dns-resolver"
        elif e["port"] == 0:
            kind = "udp-route-probe (glibc getaddrinfo source-address selection; sends no packet)"
        elif e["port"] == 65535 and "EINPROGRESS" not in str(e["ret"]):
            kind = "udp-route-probe (musl getaddrinfo source-address selection, port 65535; sends no packet)"
        else:
            kind = "tcp-or-udp"
        key = (e["ip"], e["port"], e["exe"])
        d = dests.setdefault(
            key,
            {"ip": e["ip"], "port": e["port"], "kind": kind, "hostnames": sorted(names.get(e["ip"], [])),
             "exe": e["exe"], "chain": e["chain"], "argv_example": [a[:160] for a in e["argv"]],
             "count": 0, "results": set(), "first_offset_s": round(e["ts"] - first_ts, 3),
             "processes": set(), "argv_all": set()},
        )
        d["count"] += 1
        d["processes"].add(e["tgid"])
        d["argv_all"].add(" ".join(a[:100] for a in e["argv"][:4]))
        d["results"].add(e["ret"] if e["err"] is None else e["err"])
    for d in dests.values():
        d["tls_sni"] = sorted(snis.get((d["ip"], d["port"]), []))
    harness_procs = {t for t, (exe, _) in image.items() if "/harness/" in exe}
    out = {
        "trace": path,
        "harness_processes": len(harness_procs),
        "harness_processes_with_egress": len(
            {e["tgid"] for e in events if e["tgid"] in harness_procs and e["port"] not in (0, 53, 65535)}
        ),
        "destinations": [
            {**d, "results": sorted(d["results"]), "processes": len(d["processes"]),
             "argv_all": sorted(d["argv_all"])} for d in sorted(dests.values(), key=lambda x: x["first_offset_s"])
        ],
        "dns_queries": [
            {"name": k, "types": sorted(v["types"]), "procs": sorted(v["procs"]), "answers": sorted(v["answers"]),
             "rcodes": sorted(v["rcodes"]), "first_offset_s": round(v["first_ts"] - first_ts, 3),
             "querying_processes": len(v["tgids"]),
             "argv_examples": sorted(v.get("argv", []))[:6],
             "seconds_after_exec": [min(v["since_exec"]), max(v["since_exec"])] if v["since_exec"] else None}
            for k, v in sorted(queries.items(), key=lambda kv: kv[1]["first_ts"])
        ],
    }
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
