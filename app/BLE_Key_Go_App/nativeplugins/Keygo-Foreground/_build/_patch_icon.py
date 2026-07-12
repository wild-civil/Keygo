import io
p = r"D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\source\src\main\java\com\keygo\foreground\KeygoBleScanService.java"
t = io.open(p, "rb").read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
old = (
    '    private int getNotificationIconRes() {\n'
    '        int id = getResources().getIdentifier("keygo_notification_icon", "drawable", getPackageName());\n'
    '        return id != 0 ? id : getApplicationInfo().icon;\n'
    '    }'
)
new = (
    '    private int getNotificationIconRes() {\n'
    '        String[] candidatePkgs = new String[]{ getPackageName(), "com.keygo.foreground" };\n'
    '        int id = 0;\n'
    '        String matchedPkg = "";\n'
    '        for (String pkg : candidatePkgs) {\n'
    '            id = getResources().getIdentifier("keygo_notification_icon", "drawable", pkg);\n'
    '            if (id != 0) { matchedPkg = pkg; break; }\n'
    '        }\n'
    '        Log.i(TAG, "[KeyGo] notify icon resId=" + id\n'
    '                + " matchedPkg=" + (matchedPkg.isEmpty() ? "none(fallback Hbuilder)" : matchedPkg)\n'
    '                + " appPkg=" + getPackageName());\n'
    '        if (id == 0) id = getApplicationInfo().icon;\n'
    '        return id;\n'
    '    }'
)
if old in t:
    io.open(p, "wb").write(t.replace(old, new, 1).encode("utf-8"))
    res = "PATCH_OK"
else:
    res = "PATCH_OLD_NOT_FOUND"
io.open(r"D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\patch_out.txt", "w", encoding="utf-8").write(res)
print(res)
