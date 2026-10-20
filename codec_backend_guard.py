"""Codec availability guard.

Reports what this host can actually encode with:

``available``   the shared library is present, so the native low-latency path
                is usable (LAME, libfdk-aac);
``fallback``    only the command line encoder exists — usable, but piped and
                higher latency (opus-tools, flac, or lame without the library);
``unavailable`` neither;
``unchecked``   probe_all() has not run yet.

`codec_backend` is probed once at import, and again by the API's
`/api/status/codecs` route so a package installed while the bridge is running
is picked up without a restart.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import glob
import shutil
import subprocess
from dataclasses import dataclass


class CodecStatus:
    UNCHECKED = "unchecked"
    AVAILABLE = "available"
    FALLBACK = "fallback"
    UNAVAILABLE = "unavailable"


# Library file names per codec, in the order the loader would try them.
LIBRARY_NAMES = {
    "lame": ("mp3lame", "libmp3lame.so.0", "libmp3lame.so"),
    "fdkaac": ("fdk-aac", "fdk_aac", "libfdk-aac.so.2", "libfdk-aac.so"),
}

CLI_NAMES = {
    "lame": ("lame",),
    "fdkaac": ("fdkaac",),
    "opus": ("opusenc",),
    "flac": ("flac",),
}

DISPLAY = {
    "lame": "MP3 (LAME)",
    "fdkaac": "AAC (FDK)",
    "opus": "Opus",
    "flac": "FLAC",
}


def _library_path(*names: str) -> str | None:
    """Resolve a shared library the same way the dynamic loader would."""
    for name in names:
        found = ctypes.util.find_library(name)
        if found:
            try:
                ctypes.CDLL(found)
                return found
            except OSError:
                pass
        for pattern in (
            f"/usr/lib/*/{name}",
            f"/usr/lib/{name}",
            f"/usr/lib64/{name}",
            f"/usr/local/lib/{name}",
            f"/lib/{name}",
        ):
            matches = glob.glob(pattern)
            if matches:
                return matches[0]
    return None


def _cli_path(*names: str) -> str | None:
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


def _version(argv: list[str]) -> str | None:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return None
    text = (out.stdout or out.stderr).strip().splitlines()
    return text[0].strip() if text else None


@dataclass
class CodecInfo:
    name: str
    status: str
    library: str | None
    cli: str | None
    version: str | None

    @property
    def mode(self) -> str:
        if self.status == CodecStatus.AVAILABLE:
            return "native"
        if self.status == CodecStatus.FALLBACK:
            return "cli"
        return "none"

    def as_dict(self) -> dict[str, object]:
        return {
            "name": DISPLAY[self.name],
            "status": self.status,
            "mode": self.mode,
            # `path` is the name the original UI contract used (native/cli/none).
            "path": self.mode,
            "library": self.library,
            "cli": self.cli,
            "version": self.version,
            "note": note_for(self),
        }


def note_for(info: CodecInfo) -> str:
    if info.status == CodecStatus.AVAILABLE:
        return f"{info.name}: using {info.library} — low-latency native path"
    if info.status == CodecStatus.FALLBACK:
        return f"{info.name}: using {info.cli} — CLI pipe, higher latency"
    package = {"lame": "lame libmp3lame0", "fdkaac": "libfdk-aac2", "opus": "opus-tools", "flac": "flac"}[info.name]
    return f"{info.name}: not installed — run: sudo apt install {package}"


class CodecBackend:
    def __init__(self) -> None:
        self.infos: dict[str, CodecInfo] = {
            name: CodecInfo(name, CodecStatus.UNCHECKED, None, None, None)
            for name in DISPLAY
        }

    # ── compatibility properties ────────────────────────────────────────
    @property
    def lame_status(self) -> str:
        return self.infos["lame"].status

    @property
    def fdkaac_status(self) -> str:
        return self.infos["fdkaac"].status

    @property
    def opus_status(self) -> str:
        return self.infos["opus"].status

    @property
    def flac_status(self) -> str:
        return self.infos["flac"].status

    def probe_all(self) -> dict[str, CodecInfo]:
        """Check every codec; safe to call again after installing a package."""
        for name, lib_names in LIBRARY_NAMES.items():
            library = _library_path(*lib_names)
            cli = _cli_path(*CLI_NAMES[name])
            if library:
                status = CodecStatus.AVAILABLE
            elif cli:
                status = CodecStatus.FALLBACK
            else:
                status = CodecStatus.UNAVAILABLE
            version = _version([cli, "--version"]) if cli else None
            self.infos[name] = CodecInfo(name, status, library, cli, version)
        for name in ("opus", "flac"):
            cli = _cli_path(*CLI_NAMES[name])
            status = CodecStatus.FALLBACK if cli else CodecStatus.UNAVAILABLE
            version = _version([cli, "--version"]) if cli else None
            self.infos[name] = CodecInfo(name, status, None, cli, version)
        return self.infos

    def get_status_report(self) -> dict[str, str]:
        return {DISPLAY[name]: info.status for name, info in self.infos.items()}

    def get_encoder_info(self, codec: str) -> tuple[str, str]:
        info = self.infos.get(codec)
        if info is None:
            return "none", f"{codec}: unknown codec"
        return info.mode, note_for(info)

    def details(self) -> dict[str, dict[str, object]]:
        return {DISPLAY[name]: info.as_dict() for name, info in self.infos.items()}

    def native_available(self, codec: str) -> bool:
        info = self.infos.get(codec)
        return bool(info and info.status == CodecStatus.AVAILABLE)


codec_backend = CodecBackend()
codec_backend.probe_all()


if __name__ == "__main__":
    print("Codec Status Report:")
    for name, info in codec_backend.infos.items():
        print(f"  {DISPLAY[name]:12} {info.status:11} {info.mode:7} {info.library or info.cli or '—'}")
    print()
    for name, info in codec_backend.infos.items():
        print(f"  {note_for(info)}")
