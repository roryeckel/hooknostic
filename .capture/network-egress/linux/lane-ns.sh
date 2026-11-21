#!/usr/bin/env bash
# Inside the lane's new network, mount and PID namespaces, as root (prototype;
# lane-run.sh starts it through unshare --net --mount --pid --fork --mount-proc).
#   lane-ns.sh <uid> <gid> <node> <scratch> <workspace> <runner temp> <runner dir> [grant]
# Then, before dropping to the lane user:
# - loopback up;
# - every mount read-only, except the scratch tree, /proc, /sys and /dev. The
#   copy is private to this namespace, so the host keeps its own mounts;
# - fresh tmpfs over /tmp, /var/tmp and /dev/shm, so nothing the lane leaves
#   there reaches a later step;
# - RUNNER_TEMP (the file-command files, the checkout's credentials) and the
#   runner's own directory (.credentials) hidden under empty tmpfs;
# - the workspace as an overlay whose upper layer is in the scratch tree, so
#   any write the lane's permissions allow lands there, never in the real
#   workspace. With "grant" (trial only), the lane may create entries in the
#   overlay's node_modules; the ACL is copied up, and only the upper changes.
# When the lane's first process exits, the PID namespace ends and the kernel
# kills every other lane process.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
uid="$1" gid="$2" node="$3" scratch="$4" ws="$5" rt="$6" runner_dir="$7" grant="${8:-}" mutant="${9:-}"
ip link set lo up
mount --make-rprivate /
mount --bind "$scratch" "$scratch"
ro_failed=()
# "no-ro" (trial mutant only) skips the read-only remount, to show that
# lane-after's check catches what the lane could then plant.
if [ "$mutant" = no-ro ]; then
  echo "lane-ns: MUTANT: mounts left writable"
else
  while IFS= read -r m; do
    case "$m" in /proc | /proc/* | /sys | /sys/* | /dev | /dev/* | "$scratch") continue ;; esac
    mount -o remount,bind,ro "$m" 2> /dev/null || ro_failed+=("$m")
  done < <(findmnt -rn -o TARGET | sort -u)
fi
for d in /tmp /var/tmp /dev/shm; do mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$d"; done
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$rt"
if [ -n "$runner_dir" ] && [ -d "$runner_dir" ]; then mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs "$runner_dir"; fi
mkdir -p "$scratch/ws-upper" "$scratch/ws-work"
mount -t overlay overlay -o "lowerdir=$ws,upperdir=$scratch/ws-upper,workdir=$scratch/ws-work" "$ws"
if [ "$grant" = grant ]; then setfacl -m "u:$uid:rwx" "$ws/node_modules"; fi
echo "lane-ns: $(findmnt -rn -o TARGET | grep -c .) mounts; read-only remount failed for: ${ro_failed[*]:-none}; / is $(findmnt -rn -o OPTIONS / | cut -d, -f1)"
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --no-new-privs -- env -i "$node" "$scratch/bin/lane-probe.mjs" "$scratch"
