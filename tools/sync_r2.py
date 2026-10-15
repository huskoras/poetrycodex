"""Copy the published site into the Cloudflare R2 bucket that site-worker/ serves.

Run after every publish (after the rebuild commit), from the repository root:

    python tools/sync_r2.py            # upload what changed, delete what was removed
    python tools/sync_r2.py --dry-run  # show what would happen, change nothing

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
TOP_FILES = {"index.html", "404.html", "app.js", "styles.css", "robots.txt", "site.webmanifest", "sw.js"}
TOP_EXT = (".png", ".webp", ".ico", ".jpg", ".svg")
DIRS = ("data/", "poem/", "poet/", "work/", "poets/", "privacy/")


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


def snapshot(files, dest):
    """Write the committed (HEAD) copy of every published file under dest, so the bucket gets
    exactly what GitHub has, whatever is being edited in the working tree meanwhile."""
    import tarfile
    p = subprocess.Popen(["git", "archive", "--format=tar", "HEAD", "--", *DIRS, *sorted({f for f in files if "/" not in f})],
                         cwd=ROOT, stdout=subprocess.PIPE)
    with tarfile.open(fileobj=p.stdout, mode="r|") as tar:
        tar.extractall(dest, filter="data")
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
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "site")
        print("Exporting the committed site ...", flush=True)
        snapshot(files, src)
        # The shards (tools/build_shards.py) are made from that same copy: they are derived
        # files, not in git, and are uploaded with the rest.
        r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "build_shards.py"), "--root", src], cwd=ROOT)
        if r.returncode:
            sys.exit("build_shards failed")
        for sub in ("c", "ws"):
            base = os.path.join(src, "data", sub)
            for dirpath, _, names in os.walk(base):
                for n in names:
                    files.append(os.path.relpath(os.path.join(dirpath, n), src).replace(os.sep, "/"))
        files.sort()
        print(f"{len(files)} files with the shards", flush=True)
        lst = os.path.join(tmp, "files.txt")
        with open(lst, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(files) + "\n")
        common = ["--transfers", "32", "--checkers", "64", "--fast-list", "--stats", "30s", "--stats-one-line"]
        if dry:
            common.append("--dry-run")
        r = run(["rclone", "copy", "--files-from", lst, "--checksum", "--no-traverse", *common, src, BUCKET])
        if r.returncode:
            sys.exit(r.returncode)
        # Delete what the site no longer has (a renamed or removed page).
        have = run(["rclone", "lsf", "-R", "--files-only", "--fast-list", BUCKET], capture_output=True, text=True)
        if have.returncode:
            sys.exit(have.returncode)
        keep = set(files)
        gone = [k for k in have.stdout.splitlines() if k and k not in keep]
        print(f"{len(gone)} files to delete from the bucket")
        if gone:
            dl = os.path.join(tmp, "gone.txt")
            with open(dl, "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(gone) + "\n")
            r = run(["rclone", "delete", "--files-from", dl, *common, BUCKET])
            if r.returncode:
                sys.exit(r.returncode)
    print("R2 is in step with the repository." if not dry else "Dry run finished; nothing was changed.")


if __name__ == "__main__":
    main()
