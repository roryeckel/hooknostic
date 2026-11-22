# Durable project writes on Linux, and a lock that cannot be half-created

0.14.1 is a fix release. 0.14.0 flushed a file's contents before reporting the
write, but a rename becomes durable only once its directory's entries are: a
power loss could still lose a completed sync, or bring back a journal a
recovery had just removed. `sync` and `recover` now flush the directories their
renames and removals touch, in an explicit order, before they remove the
transaction journal. Lock creation is atomic as well: the PID is written and
flushed to a staging file, then published with a hard link, so on a filesystem
with hard links a half-created lock is unobservable.
[ADR-0015](decisions/0015-project-integration.md) records the amended
durability rule.

## What is included

- **A completed write survives a crash (Linux).** After the journal is in
  place, `sync` flushes `.hooknostic` and then the project root, replaces or
  removes every destination, flushes each touched destination directory once —
  including every newly created ancestor of a nested output — removes the
  journal, and flushes `.hooknostic` once more as the commit point.
- **Recovery flushes before it forgets.** Before removing the journal,
  `recover` flushes every existing ancestor, through the project root, of every
  validated journal entry, including entries already at their preimage, plus
  every directory it created while restoring. A retried recovery after a failed
  flush therefore cannot discard the journal while the rollback is not durable.
- **The flush cannot be redirected by a symlink.** Linux uses a
  descriptor-relative walk through `/proc/self/fd` with
  `O_NOFOLLOW | O_DIRECTORY`. A component swapped for a symlink fails with
  `ELOOP`/`ENOTDIR` instead of being followed, and a pre-unlink failure keeps
  the journal unless rollback completes. There is no absolute-path fallback.
- **A failed rollback is reported as such.** A pre-commit flush failure aborts
  the sync and attempts rollback. If rollback also fails, the error names both
  failures and the remaining journal, and tells you to run `hooknostic recover`
  with the same configuration instead of replacing the original error.
- **A lock is created in one publication step.** The lock's PID is written and
  flushed to `.hooknostic/staging/lock-<uuid>`, then linked into place;
  `rename` is not used because it would replace a peer's live lock. Filesystems
  without hard links fall back to the previous exclusive create.
- **The empty-lock message is now accurate.** An empty `sync.lock` or
  `recovery.lock` is still refused and still has to be deleted by hand, but the
  message no longer claims a current hooknostic can leave one: only an older
  hooknostic, another tool, or a filesystem without hard links can.

Apart from the new flush and rollback errors and that message, no CLI surface
or generated-artifact shape changes; the rest of the release is test and CI
hardening.

## Upgrading from 0.14.0

- **Upgrade the SDK and the CLI together.** Keep `@hooknostic/sdk`,
  `@hooknostic/agent-plugin` and the `hooknostic` CLI on the same release; the
  CLI warns HN110 when it and the project's SDK differ. To upgrade:

  ```sh
  npm install --save-dev @hooknostic/sdk@0.14.1 hooknostic@0.14.1
  ```

  With pnpm, run `pnpm add -D @hooknostic/sdk@0.14.1 hooknostic@0.14.1`,
  adding `--allow-build=esbuild` if the project has not
  [allowed esbuild's install script](getting-started.md#1-install-the-authoring-and-cli-packages)
  yet.

- **Rebuild or re-sync.** Generated artifacts carry the release version, so
  their bytes change with the upgrade even though their shape does not. A
  project already synced with 0.14.0 keeps working; the new durability applies
  to writes made after the upgrade.

- **An empty lock from an older release behaves as before.** Confirm no `sync`
  or `recover` is running, delete the file, and rerun `recover`.

## Limits

- **Directory flushing is Linux-only.** Windows, macOS, FreeBSD and Linux hosts
  without working `/proc/self/fd` traversal skip it, as do filesystems that
  cannot flush a directory (`EINVAL`, `EISDIR`, `ENOTSUP`, `EOPNOTSUPP`,
  `ENOSYS`). Rename durability there remains the filesystem's guarantee. On
  Windows, Node can open a directory but `fs.fsync` on it fails, and although
  Win32 has `MOVEFILE_WRITE_THROUGH`, Node does not expose it through
  `fs.rename`.
- **The guarantee starts below the opened project root.** The root is opened by
  absolute path; its ancestors must stay stable. Path-based recovery metadata
  checks, renames and removals are outside the descriptor walk. Network and
  FUSE filesystems may honour descriptor flushes differently.
- **`recover` cannot see another environment's process.** A process in WSL, a
  container or another host that shares the checkout cannot be seen, and its
  lock looks abandoned. Run `sync` and `recover` from one environment at a
  time.
- **Filesystems without hard links keep the weaker lock creation.** The
  exclusive create cannot overwrite a live lock, but a process killed between
  creating and writing it can leave an empty one, which `recover` still
  refuses.

Start with the [README](../README.md); the [release runbook](releases.md)
describes preparation, draft creation, and publication.
