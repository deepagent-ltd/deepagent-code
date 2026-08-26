#!/usr/bin/env python3
"""Auto-update hashes.json by building with fakeHash and extracting the correct hash.

Usage:
  nix run .#update-hashes                     # update current platform
  nix run .#update-hashes -- --check          # CI: verify hashes are current
  nix/scripts/update-hashes.py --root /path   # run directly with explicit root
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path


def get_current_platform():
    machine = os.uname().machine
    system = os.uname().sysname.lower()
    arch_map = {"x86_64": "x86_64", "aarch64": "aarch64"}
    os_map = {"linux": "linux", "darwin": "darwin"}
    arch = arch_map.get(machine, machine)
    os_name = os_map.get(system, system)
    return f"{arch}-{os_name}"


def extract_hash(stderr: str) -> str | None:
    m = re.search(r"got:\s+(sha256-[A-Za-z0-9+/=]+)", stderr)
    return m.group(1) if m else None


def parse_args():
    root = None
    check = False
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--root" and i + 1 < len(args):
            root = Path(args[i + 1])
            i += 2
        elif args[i] == "--check":
            check = True
            i += 1
        else:
            print(f"Unknown argument: {args[i]}", file=sys.stderr)
            sys.exit(1)
    return root, check


def ensure_repo_root(root: Path, hashes_path: Path):
    if not hashes_path.exists():
        print(f"ERROR: {hashes_path} not found", file=sys.stderr)
        print(f"Is {root} the deepagent-code repo root?", file=sys.stderr)
        print("Use --root PATH to specify the repo root", file=sys.stderr)
        sys.exit(1)


def build_and_extract(root: Path):
    result = subprocess.run(
        ["nix", "build", ".#node_modules_updater", "--no-link", "--print-build-logs"],
        capture_output=True, text=True, cwd=root,
    )
    combined = (result.stdout or "") + (result.stderr or "")
    return extract_hash(combined)


def main():
    arg_root, check = parse_args()
    root = arg_root or Path(os.getcwd())
    hashes_path = root / "nix" / "hashes.json"
    ensure_repo_root(root, hashes_path)

    platform = get_current_platform()

    if check:
        data = json.loads(hashes_path.read_text())
        stored = data["nodeModules"].get(platform)
        if not stored:
            print(f"ERROR: no hash stored for platform {platform}", file=sys.stderr)
            sys.exit(1)
        actual = build_and_extract(root)
        if not actual:
            print("ERROR: could not extract hash from build", file=sys.stderr)
            sys.exit(2)
        if stored != actual:
            print(f"HASH MISMATCH: stored={stored[:30]}... actual={actual[:30]}...", file=sys.stderr)
            print("Run: nix run .#update-hashes", file=sys.stderr)
            sys.exit(1)
        print(f"OK: hash matches for {platform}")
        return

    print(f"Platform: {platform}")
    print("Building node_modules_updater to compute correct hash ...")
    sys.stdout.flush()

    correct = build_and_extract(root)
    if not correct:
        print("ERROR: could not extract hash from build output", file=sys.stderr)
        sys.exit(1)

    print(f"Correct hash: {correct}")

    data = json.loads(hashes_path.read_text())
    old = data["nodeModules"].get(platform, "(missing)")
    data["nodeModules"][platform] = correct
    hashes_path.write_text(json.dumps(data, indent=2) + "\n")

    print(f"Updated {platform}: {old} → {correct}")
    print()
    print("Done. You can now run: nix build .#deepagent-code")


if __name__ == "__main__":
    main()
