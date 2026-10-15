"""Copy the published site into the Cloudflare R2 bucket that site-worker/ serves.

Run after every publish (after the rebuild commit), from the repository root:

    python tools/sync_r2.py            # upload what changed, delete what was removed
    python tools/sync_r2.py --dry-run  # show what would happen, change nothing

It uses rclone with a remote named "r2" (an S3 remote for Cloudflare R2). The owner sets
that remote up once, in his own terminal, so the keys never pass through anyone else:

    rclone config create r2 s3 provider=Cloudflare access_key_id=<ID> secret_access_key=<SECRET> endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com acl=private no_check_bucket=true

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
TOP_FILES = {"index.html", "404.html", "app.js", "styles.css", "robots.txt", "site.webmanifest"}
TOP_EXT = (".png", ".webp", ".ico", ".jpg", ".svg")
DIRS = ("data/", "poem/", "poet/", "work/", "poets/")


def published(path):
    if "/" not in path:
        return path in TOP_FILES or path.endswith(TOP_EXT) or (path.startswith("sitemap") and path.endswith(".xml"))
    return path.startswith(DIRS)


def run(args, **kw):
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, cwd=ROOT, **kw)


def main():
    dry = "--dry-run" in sys.argv
    files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True).stdout.decode("utf-8").split("\0")
    files = sorted(f for f in files if f and published(f))
    dirty = subprocess.run(["git", "status", "--porcelain", "--", *DIRS, *TOP_FILES], cwd=ROOT,
                           capture_output=True, text=True).stdout.splitlines()
    dirty = [d for d in dirty if not d.startswith("??")]
    if dirty:
        print(f"Warning: {len(dirty)} published files have uncommitted changes; the bucket gets the "
              "working-tree copy. Commit first for an exact match with GitHub.", file=sys.stderr)
    print(f"{len(files)} published files")
    with tempfile.TemporaryDirectory() as tmp:
        lst = os.path.join(tmp, "files.txt")
        with open(lst, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(files) + "\n")
        common = ["--transfers", "32", "--checkers", "64", "--fast-list", "--stats", "30s", "--stats-one-line"]
        if dry:
            common.append("--dry-run")
        r = run(["rclone", "copy", "--files-from", lst, "--checksum", "--no-traverse", *common, ".", BUCKET])
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
