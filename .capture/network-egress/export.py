#!/usr/bin/env python3
"""Write one compact, redacted JSON summary per run into <out-dir>.
Usage: export.py <out-dir> <run-dir>...   (run-dir may lack strace.log for
no-network runs). Redaction: the capturing account's home becomes /home/user."""
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
PARSER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parse_strace.py")


def redact(value):
    if isinstance(value, str):
        return value.replace(HOME, "/home/user")
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


def meta(run):
    out = {}
    extra = []
    for line in open(os.path.join(run, "meta.txt")):
        line = line.rstrip("\n")
        if line.startswith("  extra: "):
            extra.append(line[len("  extra: "):])
            continue
        if line.startswith("kernel="):
            out["kernel"] = re.match(r"kernel=(.*?) node=", line).group(1)
        for k, v in re.findall(r"(\w+)=(\S+)", line):
            out.setdefault(k, v)
        m = re.match(r"^(\S+)\s+(\S+)\s*(.*)$", line)
        if m and re.match(r"^(lo|eth\d|br-|docker)", m.group(1)):
            # Loopback keeps its addresses (they show the namespace's isolation);
            # other interfaces keep name and state only (no host addresses).
            entry = f"{m.group(1)} {m.group(2)}" + (f" {m.group(3).strip()}" if m.group(1) == "lo" else "")
            out.setdefault("interfaces", []).append(entry)
    out["extra_env"] = extra
    return out


def tests(run):
    j = json.load(open(os.path.join(run, "vitest.json")))
    counts = {}
    failed = []
    for f in j["testResults"]:
        for a in f["assertionResults"]:
            counts[a["status"]] = counts.get(a["status"], 0) + 1
            if a["status"] == "failed":
                msg = re.sub(r"\s+", " ", " ".join(a["failureMessages"]))[:400]
                failed.append({"test": a["fullName"], "duration_ms": round(a["duration"]), "error": msg})
    return counts, failed


def probes(out_dir, dirs):
    """One table for standalone probe directories (strace.log + out.txt)."""
    rows = []
    for d in dirs:
        d = d.rstrip("/")
        s = json.loads(subprocess.run([sys.executable, "-I", PARSER, os.path.join(d, "strace.log")],
                                      capture_output=True, text=True, check=True).stdout)
        text = open(os.path.join(d, "out.txt"), errors="replace").read()
        exit_line = re.findall(r"exit=\d+", text)[-1]
        plain = re.sub(r"\x1b\[[0-9;?<>=$]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", text)
        update_notice = re.search(r"/update to install v[0-9.]+", plain)
        rows.append({
            "probe": os.path.basename(os.path.dirname(d)) + "/" + os.path.basename(d),
            "exit": exit_line,
            **({"screen_update_notice": update_notice.group(0) if update_notice else None}
               if "opencode-tui" in d else {}),
            "dns_queries": sorted({q["name"] for q in s["dns_queries"]}),
            "connects": sorted({f'{",".join(x["tls_sni"] or x["hostnames"]) or x["ip"]}:{x["port"]}'
                                for x in s["destinations"] if x["port"] not in (0, 53, 65535)}),
            "resolver_attempts": sum(x["count"] for x in s["destinations"] if x["port"] == 53),
        })
    with open(os.path.join(out_dir, "probes.json"), "w") as f:
        json.dump(redact(rows), f, indent=1)
        f.write("\n")
    for r in rows:
        print(r["probe"], r["exit"], r["dns_queries"], r["connects"])


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    if sys.argv[2] == "--probes":
        return probes(out_dir, sys.argv[3:])
    for run in sys.argv[2:]:
        run = run.rstrip("/")
        name = os.path.basename(run)
        m = meta(run)
        counts, failed = tests(run)
        doc = {"run": name, "meta": m, "tests": counts, "failed": failed}
        trace = os.path.join(run, "strace.log")
        if os.path.exists(trace):
            s = json.loads(subprocess.run([sys.executable, "-I", PARSER, trace], capture_output=True, text=True,
                                          check=True).stdout)
            doc["harness_processes"] = s["harness_processes"]
            doc["harness_processes_with_egress"] = s["harness_processes_with_egress"]
            doc["destinations"] = [
                {k: d[k] for k in ("ip", "port", "kind", "hostnames", "tls_sni", "exe", "chain", "results", "count",
                                   "processes", "first_offset_s")}
                | {"argv_examples": sorted(d["argv_all"])[:6]}
                for d in s["destinations"]
            ]
            doc["dns_queries"] = s["dns_queries"]
            doc["trace_bytes"] = os.path.getsize(trace)
        with open(os.path.join(out_dir, name + ".json"), "w") as f:
            json.dump(redact(doc), f, indent=1)
            f.write("\n")
        print(name, counts, len(doc.get("destinations", [])))


if __name__ == "__main__":
    main()
