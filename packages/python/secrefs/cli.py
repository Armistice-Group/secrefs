from __future__ import annotations

import argparse
import asyncio
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import List

from . import SecRefs, SecRefsResolutionError


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE per line, '#' comments, no interpolation."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="secrefs-py",
        description="BYOV secret reference engine - expand sec:// references in memory at runtime",
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    run_parser = subparsers.add_parser(
        "run", help="Resolve sec:// references and spawn a child process"
    )
    run_parser.add_argument("--env-file", default=".env", help="path to a .env file to load first")
    run_parser.add_argument(
        "--no-env-file", action="store_true", help="skip loading a .env file"
    )
    run_parser.add_argument(
        "command", nargs=argparse.REMAINDER, help="command to run, e.g. -- python app.py"
    )

    check_parser = subparsers.add_parser(
        "check", help="Validate sec:// references and provider reachability"
    )
    check_parser.add_argument("--env-file", default=".env", help="path to a .env file to load first")
    check_parser.add_argument(
        "--no-env-file", action="store_true", help="skip loading a .env file"
    )

    return parser


async def _run(args: argparse.Namespace) -> int:
    command: List[str] = [c for c in args.command if c != "--"]
    if not command:
        print(
            "secrefs-py run: no command given. Usage: secrefs-py run -- <command> [args...]",
            file=sys.stderr,
        )
        return 1

    if not args.no_env_file:
        _load_dotenv(Path(args.env_file))

    instance = SecRefs()
    try:
        changed = await instance.init()
        if changed:
            print(
                f"secrefs-py: resolved {len(changed)} secret reference(s): {', '.join(changed)}",
                file=sys.stderr,
            )
    except SecRefsResolutionError as exc:
        print("secrefs-py: failed to resolve one or more secret references:", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1

    process = subprocess.Popen(command, env=os.environ.copy())

    forwarded_signals = [
        s for s in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", None)) if s is not None
    ]

    def _forward(sig: int, _frame: object) -> None:
        if process.poll() is None:
            process.send_signal(sig)

    original_handlers = {sig: signal.getsignal(sig) for sig in forwarded_signals}
    for sig in forwarded_signals:
        signal.signal(sig, _forward)

    try:
        return process.wait()
    finally:
        for sig, handler in original_handlers.items():
            signal.signal(sig, handler)


async def _check(args: argparse.Namespace) -> int:
    if not args.no_env_file:
        _load_dotenv(Path(args.env_file))

    instance = SecRefs()
    results = await instance.check()

    if not results:
        print("secrefs-py check: no sec:// references found in the environment.")
        return 0

    ok_count = 0
    for result in results:
        icon = "✓" if result.ok else "✗"
        print(f"{icon} {result.key} -> {result.ref}")
        if result.ok:
            ok_count += 1
        else:
            print(f"    {result.message}")

    print(f"\n{ok_count}/{len(results)} reference(s) resolved successfully.")
    return 0 if ok_count == len(results) else 1


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.subcommand == "run":
        exit_code = asyncio.run(_run(args))
    else:
        exit_code = asyncio.run(_check(args))

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
