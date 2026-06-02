from PIL import Image, ImageDraw
import os

os.makedirs("icons", exist_ok=True)

def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = size // 8
    d.rounded_rectangle([m, m, size - m, size - m], radius=size // 5, fill="#e8490f")
    lw = max(1, size // 16)
    cx, cy = size // 2, size // 2
    # Fork
    fx = cx - size // 5
    top, bot = cy - size // 4, cy + size // 4
    d.line([(fx, top), (fx, bot)], fill="white", width=lw)
    d.line([(fx - lw*2, top), (fx - lw*2, cy)], fill="white", width=lw)
    d.line([(fx + lw*2, top), (fx + lw*2, cy)], fill="white", width=lw)
    d.line([(fx - lw*2, cy), (fx + lw*2, cy)], fill="white", width=lw)
    # Knife
    kx = cx + size // 5
    d.line([(kx, top), (kx, bot)], fill="white", width=lw)
    d.polygon([(kx, top), (kx + lw*3, cy), (kx, cy)], fill="white")
    img.save(f"icons/icon{size}.png")
    print(f"created icons/icon{size}.png")

for s in [16, 48, 128]:
    make_icon(s)
