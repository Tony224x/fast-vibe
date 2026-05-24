"""One-off redactor for README screenshots.

Blurs regions that leak local paths (~\\KaliraGitRepo\\kalira-immo, full Windows
path) and Claude /remote-control session URLs (https://claude.ai/code/session_XXX)
in the screenshots under docs/img/.

Regions are derived from the captured layout at 1600x1000 viewport.
"""
from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "img"


def blur_box(img: Image.Image, box: tuple[int, int, int, int], radius: int = 14) -> None:
    """Blur a rectangular region in-place."""
    region = img.crop(box).filter(ImageFilter.GaussianBlur(radius=radius))
    img.paste(region, box)


def redact_quad(path: Path) -> None:
    """Redact the 4-worker grid screenshots (01 and 02)."""
    img = Image.open(path).convert("RGB")
    # Per-pane blur boxes covering BOTH the cwd line and the session URL line.
    # Coordinates measured against the 1600x1000 captured viewport.
    boxes = [
        # Worker 1 (top-left): cwd at y~85-105, session URL at y~155-200
        (80, 88, 510, 105),     # cwd path
        (15, 178, 470, 200),    # session URL
        # Worker 2 (top-right)
        (880, 88, 1310, 105),
        (815, 178, 1265, 200),
        # Worker 3 (bottom-left)
        (80, 585, 510, 600),
        (15, 675, 510, 705),
        # Worker 4 (bottom-right)
        (880, 585, 1310, 600),
        (815, 675, 1265, 705),
    ]
    for box in boxes:
        blur_box(img, box, radius=12)
    img.save(path, optimize=True)
    print(f"  redacted: {path.name}")


def redact_launchbar(path: Path) -> None:
    """Redact the cwd in the launchbar screenshot.

    Two leaky zones:
      - #cwd-input (the path field): x ~200..791
      - Right-side cwd caption: x ~940..1318
    Stop button sits at x ~794..856 — keep clear of it.
    """
    img = Image.open(path).convert("RGB")
    w, h = img.size
    blur_box(img, (200, 6, 790, h - 6), radius=10)
    blur_box(img, (940, 6, min(1318, w), h - 6), radius=10)
    img.save(path, optimize=True)
    print(f"  redacted: {path.name}")


def main() -> None:
    targets_quad = ["01-hero-workers.png", "02-sidebar-and-launch.png"]
    targets_bar = ["06-launchbar.png"]
    for name in targets_quad:
        p = IMG / name
        if p.exists():
            redact_quad(p)
    for name in targets_bar:
        p = IMG / name
        if p.exists():
            redact_launchbar(p)


if __name__ == "__main__":
    main()
