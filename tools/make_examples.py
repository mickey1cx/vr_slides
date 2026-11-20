"""Создать тестовые картинки для всех поддерживаемых форматов (не обязательно).

Нужны Pillow и segno? segno — нет: только Pillow.
    pip install Pillow
    python tools/make_examples.py
"""

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "example"
EYE_W, EYE_H = 960, 540

try:
    FONT = ImageFont.load_default(size=28)
    SMALL = ImageFont.load_default(size=20)
except TypeError:  # старые версии Pillow
    FONT = SMALL = ImageFont.load_default()


def eye_image(label: str, caption: str, shift: int, accent: tuple[int, int, int]) -> Image.Image:
    """Один глаз в полном разрешении; shift создает видимую диспаратность."""
    img = Image.new("RGB", (EYE_W, EYE_H), (38, 52, 82))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 370, EYE_W - 1, EYE_H - 1), fill=(28, 34, 48))
    d.rectangle((0, 366, EYE_W - 1, 370), fill=(90, 104, 130))
    # Одинаковая «текстура» в глазах: без нее корреляция половин неустойчива.
    rng = random.Random(7)
    for _ in range(140):
        x = rng.randrange(EYE_W)
        y = rng.randrange(40, 350)
        s = rng.randrange(40, 95)
        color = (150, 165, 195) if rng.random() < 0.5 else (22, 30, 48)
        d.rectangle((x, y, x + s, y + s // 2), fill=color)
    for y in range(60, 360, 45):
        d.line((0, y, EYE_W, y), fill=(120, 135, 165), width=4)
    cx = EYE_W // 2 + shift
    d.ellipse((cx - 95, 175, cx + 95, 365), fill=accent)
    d.rectangle((cx - 65, 330, cx + 65, 470), fill=(210, 218, 232))
    d.rectangle((cx - 130, 200, cx - 95, 350), fill=(150, 160, 180))
    d.text((24, 20), label, fill=(255, 255, 255), font=FONT)
    d.text((24, EYE_H - 44), caption, fill=(190, 200, 220), font=SMALL)
    return img


def paste(dst: Image.Image, eye: Image.Image, box: tuple[int, int, int, int]) -> None:
    """Вставить глаз в прямоугольник, сжав его до нужного размера."""
    w, h = box[2] - box[0], box[3] - box[1]
    dst.paste(eye.resize((w, h), Image.Resampling.LANCZOS), (box[0], box[1]))


def save(img: Image.Image, name: str) -> None:
    path = OUT / name
    img.save(path, "JPEG", quality=90)
    print(path.relative_to(OUT.parent))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    left = eye_image("LEFT EYE", "scene object shifted right", 24, (236, 124, 72))
    right = eye_image("RIGHT EYE", "scene object shifted left", -24, (236, 124, 72))

    # 2D: обычная картинка без стереопары.
    save(left.resize((1200, 675), Image.Resampling.LANCZOS), "01_mono_2d.jpg")

    # Full-SBS: каждый глаз 960x540 без потери разрешения.
    img = Image.new("RGB", (1920, 540))
    paste(img, left, (0, 0, 960, 540))
    paste(img, right, (960, 0, 1920, 540))
    save(img, "02_sbs_full.jpg")

    # Half-SBS: каждый глаз сжат по ширине вдвое.
    img = Image.new("RGB", (960, 540))
    paste(img, left, (0, 0, 480, 540))
    paste(img, right, (480, 0, 960, 540))
    save(img, "03_sbs_half.jpg")

    # Full-OU: каждый глаз 960x540, сложены вертикально.
    img = Image.new("RGB", (960, 1080))
    paste(img, left, (0, 0, 960, 540))
    paste(img, right, (0, 540, 960, 1080))
    save(img, "04_ou_full.jpg")

    # HOU: каждый глаз сжат по высоте вдвое.
    img = Image.new("RGB", (960, 540))
    paste(img, left, (0, 0, 960, 270))
    paste(img, right, (0, 270, 960, 540))
    save(img, "05_hou.jpg")

    # Перестановка глаз: в первой половине левый глаз находится справа.
    img = Image.new("RGB", (1920, 540))
    paste(img, right, (0, 0, 960, 540))
    paste(img, left, (960, 0, 1920, 540))
    save(img, "06_sbs_rl.jpg")

    # Перестановка половин: сверху правый глаз.
    img = Image.new("RGB", (960, 1080))
    paste(img, right, (0, 0, 960, 540))
    paste(img, left, (0, 540, 960, 1080))
    save(img, "07_ou_bt.jpg")

    # Half-SBS с большой диспаратностью и без подсказки в имени: чистая проверка
    # детектора по сходству половин (сдвиг ~24 пикселя на уменьшенном изображении).
    near = eye_image("L", "large disparity", 120, (236, 124, 72))
    far = eye_image("R", "large disparity", -120, (236, 124, 72))
    img = Image.new("RGB", (960, 540))
    paste(img, near, (0, 0, 480, 540))
    paste(img, far, (480, 0, 960, 540))
    save(img, "08_big_disparity.jpg")

    # Вертикальная стереопара 1536x1280: два портретных кадра по 768x1280.
    # Aspect 1.2 раньше ошибочно давал признак OU; теперь это Half-SBS.
    near = eye_image("L", "portrait pair", 30, (236, 124, 72))
    far = eye_image("R", "portrait pair", -30, (236, 124, 72))
    img = Image.new("RGB", (1536, 1280))
    paste(img, near, (0, 0, 768, 1280))
    paste(img, far, (768, 0, 1536, 1280))
    save(img, "09_pair_1536.jpg")

    # Контроль: обычное фото тех же размеров не должно становиться стереопарой.
    save(eye_image("2D", "single photo", 0, (236, 124, 72)).resize(
        (1536, 1280), Image.Resampling.LANCZOS
    ), "10_plain_1536.jpg")


if __name__ == "__main__":
    main()
