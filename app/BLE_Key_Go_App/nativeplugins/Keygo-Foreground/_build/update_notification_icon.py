#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KeyGo 通知图标嵌入工具
把任意 PNG 转成 Base64，替换进 KeygoBleScanService.java 的 KEY_ICON_B64。

用法：
  python update_notification_icon.py <png路径>

建议：
  - 输入图最好是白/浅色图标、透明背景，适合 Android 通知小图标（系统会单色化）。
  - 若想要彩色/原图效果，部分国产 ROM 也会直接显示；但系统状态栏仍可能单色化。
  - 输出会被居中裁剪/缩放为 96x96，保持透明度。
"""
import base64, re, sys, os
from PIL import Image

JAVA_PATH = r'd:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\source\src\main\java\com\keygo\foreground\KeygoBleScanService.java'
TARGET_SIZE = 96

def main():
    if len(sys.argv) < 2:
        print('Usage: python update_notification_icon.py <png_path> [crop_bottom_px] [crop_right_px]')
        sys.exit(1)
    src = sys.argv[1]
    if not os.path.exists(src):
        print(f'File not found: {src}')
        sys.exit(1)

    crop_bottom = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    crop_right = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    img = Image.open(src).convert('RGBA')
    w, h = img.size

    # 按参数裁剪水印/边距
    if crop_bottom or crop_right:
        img = img.crop((0, 0, w - crop_right, h - crop_bottom))
        w, h = img.size

    # 居中裁剪为正方形（若需要）
    if w != h:
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        img = img.crop((left, top, left + side, top + side))

    # 缩放到目标尺寸
    img = img.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)

    # 保存临时 PNG（调试用，可保留）
    out_dir = os.path.dirname(JAVA_PATH)
    out_png = os.path.join(out_dir, 'keygo_notification_icon_embedded.png')
    img.save(out_png, 'PNG')
    print(f'Processed icon saved to: {out_png}')

    # 转 Base64
    buf = io_bytes()
    img.save(buf, format='PNG')
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    print(f'Base64 length: {len(b64)}')

    # 替换 Java 文件中的 KEY_ICON_B64
    with open(JAVA_PATH, 'r', encoding='utf-8') as f:
        java = f.read()
    new_java = re.sub(
        r'(private static final String KEY_ICON_B64 = ")(.*)(";)',
        lambda m: m.group(1) + b64 + m.group(3),
        java
    )
    if new_java == java:
        print('ERROR: KEY_ICON_B64 pattern not found, nothing replaced')
        sys.exit(1)
    with open(JAVA_PATH, 'w', encoding='utf-8') as f:
        f.write(new_java)
    print(f'Updated: {JAVA_PATH}')

def io_bytes():
    import io
    return io.BytesIO()

if __name__ == '__main__':
    main()
