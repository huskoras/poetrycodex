"""Copy the published site into the Cloudflare R2 bucket that site-worker/ serves.

Run after every publish (after the rebuild commit), from the repository root:

    python tools/sync_r2.py            # upload what changed, delete what was removed
    python tools/sync_r2.py --dry-run  # show what would happen, change nothing
    python tools/sync_r2.py --mark-synced  # record HEAD as already uploaded (after a verified full sync)
    python tools/sync_r2.py --full     # ignore the upload manifest: checksum every file and list the bucket

It uses rclone with a remote named "r2" (an S3 remote for Cloudflare R2). The keys are the
owner's R2 API token, which he saves once in his own terminal, so they never pass through
anyone else:

    setx R2_ACCESS_KEY_ID "<Access Key ID>"
    setx R2_SECRET_ACCESS_KEY "<Secret Access Key>"

The script reads them from the environment (or, on Windows, from the user's saved
environment in the registry, so a terminal opened before setx also works) and hands them to
rclone as RCLONE_CONFIG_R2_* variables; it never prints them. An "r2" remote made with
`rclone config` works too, if the variables are absent.

What is published is exactly what GitHub Pages published: the committed files of the site
(git ls-files), not the tools, the Worker code or the notes, and never an uncommitted file.
Unchanged files are skipped by checksum, so a normal publish uploads only what the
rebuild changed.
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKET = "r2:poetrycodex-site"
ACCOUNT_ID = "1f203135a377d2295a7c788481062f11"   # the Cloudflare account (not a secret)
MANIFEST = os.environ.get("R2_MANIFEST", os.path.join(os.path.dirname(ROOT), "work", "r2-manifest.json"))


def saved_env(name):
    v = os.environ.get(name)
    if v or os.name != "nt":
        return v
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def rclone_env():
    env = dict(os.environ)
    key, secret = saved_env("R2_ACCESS_KEY_ID"), saved_env("R2_SECRET_ACCESS_KEY")
    if key and secret:
        env.update({"RCLONE_CONFIG_R2_TYPE": "s3", "RCLONE_CONFIG_R2_PROVIDER": "Cloudflare",
                    "RCLONE_CONFIG_R2_ACCESS_KEY_ID": key, "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY": secret,
                    "RCLONE_CONFIG_R2_ENDPOINT": f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com",
                    "RCLONE_CONFIG_R2_ACL": "private", "RCLONE_CONFIG_R2_NO_CHECK_BUCKET": "true"})
    return env
TOP_FILES = {"index.html", "404.html", "llms.txt", "app.js", "styles.css", "robots.txt", "site.webmanifest", "sw.js"}
TOP_EXT = (".png", ".webp", ".ico", ".jpg", ".svg")
DIRS = ("data/", "fonts/", "poem/", "poet/", "work/", "guide/", "blog/", "poets/", "eras/", ".well-known/", "privacy/", "terms/")


def published(path):
    if "/" not in path:
        return path in TOP_FILES or path.endswith(TOP_EXT) or (path.startswith("sitemap") and path.endswith(".xml"))
    return path.startswith(DIRS)


def rclone_exe():
    import shutil
    found = shutil.which("rclone")
    if found:
        return found
    # winget puts its link here; a shell opened before the install has not got it on PATH
    link = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links", "rclone.exe")
    return link if os.path.exists(link) else "rclone"


def run(args, **kw):
    if args and args[0] == "rclone":
        args = [rclone_exe()] + args[1:]
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, cwd=ROOT, env=rclone_env(), **kw)


def snapshot(files, dest, want=None):
    """Write the committed (HEAD) copy of every published file under dest, so the bucket gets
    exactly what GitHub has, whatever is being edited in the working tree meanwhile.
    With `want` (a set of paths), only those, data/ and the top-level files are written: the
    rest are unchanged since the last upload, and writing 180,000 pages to disk only to skip
    them took hours once Windows Defender scanned each new file (23 Oct 2026)."""
    import tarfile
    p = subprocess.Popen(["git", "archive", "--format=tar", "HEAD", "--", *DIRS, *sorted({f for f in files if "/" not in f})],
                         cwd=ROOT, stdout=subprocess.PIPE)
    with tarfile.open(fileobj=p.stdout, mode="r|") as tar:
        if want is None:
            tar.extractall(dest, filter="data")
        else:
            for m in tar:
                if m.name in want or m.name.startswith("data/") or "/" not in m.name:
                    tar.extract(m, dest, filter="data")
    # tarfile stops at the end-of-archive mark, but git still writes the padding after it;
    # unread, it fills the pipe and git (and this script) wait for ever.
    p.stdout.read()
    if p.wait():
        sys.exit("git archive failed")


def main():
    dry = "--dry-run" in sys.argv
    files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True).stdout.decode("utf-8").split("\0")
    files = sorted(f for f in files if f and published(f))
    print(f"{len(files)} published files")
    import json
    # The git blob id of each committed file: a file whose blob is the one recorded at the last
    # upload is unchanged, so it is neither exported nor read again (its checksum is the
    # manifest's). BLOBS sits beside the manifest; without it everything is read once.
    tree = subprocess.run(["git", "ls-tree", "-r", "-z", "HEAD"], cwd=ROOT, capture_output=True).stdout.decode("utf-8")
    blobs = {}
    for ent in tree.split("\0"):
        if "\t" in ent:
            meta, path = ent.split("\t", 1)
            blobs[path] = meta.split()[2]
    blobs = {f: blobs[f] for f in files if f in blobs}
    blobs_file = MANIFEST + ".blobs.json"
    prev = prev_blobs = None
    if "--full" not in sys.argv and "--mark-synced" not in sys.argv and os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as fh:
            prev = json.load(fh)
        if os.path.exists(blobs_file):
            with open(blobs_file, encoding="utf-8") as fh:
                prev_blobs = json.load(fh)
    same = set()
    if prev is not None and prev_blobs is not None:
        same = {f for f, b in blobs.items() if prev_blobs.get(f) == b and f in prev and not f.startswith("data/")}
        print(f"{len(same)} committed files unchanged since the last upload (not exported)", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "site")
        print("Exporting the committed site ...", flush=True)
        snapshot(files, src, want=set(files) - same if same else None)
        # The shards (tools/build_shards.py) are made from that same copy: they are derived
        # files, not in git, and are uploaded with the rest.
        r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "build_shards.py"), "--root", src], cwd=ROOT)
        if r.returncode:
            sys.exit("build_shards failed")
        # The list pages and the search index (tools/build_lists.py, data/l/ and data/s/) are
        # derived the same way, from the committed data/index.json of that copy.
        r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "build_lists.py"), "--root", src], cwd=ROOT)
        if r.returncode:
            sys.exit("build_lists failed")
        for sub in ("c", "ws", "l", "s"):
            base = os.path.join(src, "data", sub)
            for dirpath, _, names in os.walk(base):
                for n in names:
                    files.append(os.path.relpath(os.path.join(dirpath, n), src).replace(os.sep, "/"))
        files.sort()
        print(f"{len(files)} files with the shards", flush=True)
        common = ["--transfers", "32", "--checkers", "64", *(["--bwlimit", os.environ["R2_BWLIMIT"]] if os.environ.get("R2_BWLIMIT") else []), "--fast-list", "--stats", "30s", "--stats-one-line"]
        if dry:
            common.append("--dry-run")
        # Cost control (22 Oct 2026): R2 bills every write/list (Class A) and every read/HEAD
        # (Class B). A manifest of what was uploaded last time (path -> sha1, kept outside the
        # repo) lets a normal publish upload only the changed files with --no-check-dest (no
        # per-file HEAD) and delete only what disappeared, without listing the bucket.
        # --full, or a missing manifest, falls back to the old checksum sync + listing once.
        import hashlib
        def sha(path):
            h = hashlib.sha1()
            with open(path, "rb") as fh:
                for block in iter(lambda: fh.read(1 << 20), b""):
                    h.update(block)
            return h.hexdigest()
        now = {f: (prev[f] if f in same else sha(os.path.join(src, f))) for f in files}
        def write_manifest():
            for path, d in ((MANIFEST, now), (blobs_file, blobs)):
                with open(path + ".tmp", "w", encoding="utf-8") as fh:
                    json.dump(d, fh)
                os.replace(path + ".tmp", path)
        if "--mark-synced" in sys.argv:
            # The bucket is known to match HEAD (a full sync just finished): record it without
            # touching R2 at all.
            write_manifest()
            print(f"Manifest written for {len(now)} files; nothing uploaded.")
            return
        # A list's _.json and the search manifest name the pages and the index version they
        # need, so they go up with the pages, after the files they name.
        later = lambda f: f.endswith(".html") or f == "sw.js" or (f.startswith("data/l/") and f.endswith("/_.json")) or f == "data/s/manifest.json"
        if prev is None:
            print("No manifest (or --full): full checksum sync and bucket listing.", flush=True)
            send, extra = files, ["--checksum", "--no-traverse"]
        else:
            send = [f for f in files if prev.get(f) != now[f]]
            extra = ["--no-traverse", "--no-check-dest"]
            print(f"{len(send)} changed or new files to upload (manifest of {len(prev)})", flush=True)
        # Two passes: everything a page loads (app.js?v=N, styles.css, data, images) first, the
        # pages themselves and sw.js after, so no reader is sent a new page while the files it
        # names are still the old ones (a browser would keep that old copy under the new ?v=N).
        for n, part in enumerate(([f for f in send if not later(f)], [f for f in send if later(f)])):
            if not part:
                continue
            lst = os.path.join(tmp, f"files-{n}.txt")
            with open(lst, "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(part) + "\n")
            r = run(["rclone", "copy", "--files-from", lst, *extra, *common, src, BUCKET])
            if r.returncode:
                sys.exit(r.returncode)
        # Delete what the site no longer has (a renamed or removed page).
        keep = set(files)
        if prev is None:
            have = run(["rclone", "lsf", "-R", "--files-only", "--fast-list", BUCKET], capture_output=True, text=True)
            if have.returncode:
                sys.exit(have.returncode)
            gone = [k for k in have.stdout.splitlines() if k and k not in keep]
        else:
            gone = [k for k in prev if k not in keep]
        print(f"{len(gone)} files to delete from the bucket")
        if gone:
            dl = os.path.join(tmp, "gone.txt")
            with open(dl, "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(gone) + "\n")
            r = run(["rclone", "delete", "--files-from", dl, *common, BUCKET])
            if r.returncode:
                sys.exit(r.returncode)
        if not dry:
            write_manifest()
    print("R2 is in step with the repository." if not dry else "Dry run finished; nothing was changed.")


if __name__ == "__main__":
    main()
