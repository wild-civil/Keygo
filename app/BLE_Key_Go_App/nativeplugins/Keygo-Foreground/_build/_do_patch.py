import io
p = r"D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\source\src\main\java\com\keygo\foreground\KeygoBleScanService.java"
t = io.open(p, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
old = (
    '        int id = getResources().getIdentifier("keygo_notification_icon", "drawable", getPackageName());\n'
    '        return id != 0 ? id : getApplicationInfo().icon;'
)
new = (
    '        String[] candidatePkgs = new String[]{ getPackageName(), "com.keygo.foreground" };\n'
    '        int id = 0;\n'
    '        String matchedPkg = "";\n'
    '        for (String pkg : candidatePkgs) {\n'
    '            id = getResources().getIdentifier("keygo_notification_icon", "drawable", pkg);\n'
    '            if (id != 0) { matchedPkg = pkg; break; }\n'
    '        }\n'
    '        Log.i(TAG, "[KeyGo] icon resId=" + id + " pkg=" + (matchedPkg.isEmpty() ? "none" : matchedPkg));\n'
    '        if (id == 0) id = getApplicationInfo().icon;\n'
    '        return id;'
)
if old in t:
    io.open(p, "wb").write(t.replace(old, new, 1).encode("utf-8"))
    out = "PATCH_OK"
else:
    out = "PATCH_OLD_NOT_FOUND"
io.open(r"D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\pyrun.txt", "w", encoding="utf-8").write(out)
print(out)
