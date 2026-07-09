"""
生成「透明背景 + 实心白钥匙剪影」通知小图标，并 Base64 嵌入 KeygoBleScanService.java。
透明背景是关键：通知小图标会被系统单色化，只有形状（不透明像素）会显示，
背景必须透明，否则整张图被当成色块 → 看不见。
"""
import base64
import io
from PIL import Image, ImageDraw

SIZE = 96
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

WHITE = (255, 255, 255, 255)
TRANS = (255, 255, 255, 0)

# 钥匙头（圆环）：外圆白，内圆透明挖空
cx, cy, r = 30, 48, 22
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=TRANS)

# 钥匙杆（向右的矩形）
d.rectangle([50, 41, 86, 55], fill=WHITE)

# 钥匙齿（末端三个小矩形）
for i, (x0, x1, y0, y1) in enumerate([
    (78, 84, 55, 64),
    (70, 76, 55, 62),
    (62, 68, 55, 60),
]):
    d.rectangle([x0, y0, x1, y1], fill=WHITE)

# 轻微放大描边感：再描一遍外轮廓（白）已被填充覆盖，无需额外处理
buf = io.BytesIO()
img.save(buf, format='PNG')
png = buf.getvalue()

# 统计不透明像素占比，确认有透明背景
rgba = img.convert('RGBA')
opaque = sum(1 for p in rgba.getdata() if p[3] > 10)
print('OPAQUE_RATIO', round(opaque / len(rgba.getdata()), 4), 'PNG_BYTES', len(png))

# 嵌入 Java
java_path = 'source/src/main/java/com/keygo/foreground/KeygoBleScanService.java'
src = open(java_path, 'r', encoding='utf-8').read()
b64 = base64.b64encode(png).decode('ascii')
import re
new_src = re.sub(r'KEY_ICON_B64 = ".*?"', 'KEY_ICON_B64 = "%s"' % b64, src, count=1)
open(java_path, 'w', encoding='utf-8').write(new_src)
print('EMBEDDED OK, B64_LEN', len(b64))
