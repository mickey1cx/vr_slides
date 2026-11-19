"""Создать небольшую тестовую SBS-картинку (не обязательно)."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "example" / "sample_sbs.jpg"
W, H = 1600, 800
img = Image.new("RGB", (W, H), (18, 22, 34))
draw = ImageDraw.Draw(img)

for eye in range(2):
    x0 = eye * (W // 2)
    # Фон "комнаты"
    draw.rectangle((x0, 0, x0 + W // 2 - 1, H // 2), fill=(35 + eye * 8, 45, 70))
    draw.rectangle((x0, H // 2, x0 + W // 2 - 1, H), fill=(24, 28, 40))
    # Объект со сдвигом — видна разница между глазами
    shift = 60 if eye == 0 else -60
    cx = x0 + W // 4 + shift
    draw.rectangle((cx - 120, H // 2 - 160, cx + 120, H // 2 + 160), fill=(230, 120, 60))
    draw.ellipse((cx - 50, H // 2 - 300, cx + 50, H // 2 - 200), fill=(90, 200, 230))
    draw.text((x0 + 20, 20), "LEFT" if eye == 0 else "RIGHT", fill=(255, 255, 255))

OUT.parent.mkdir(exist_ok=True)
img.save(OUT, "JPEG", quality=90)
print(OUT)
