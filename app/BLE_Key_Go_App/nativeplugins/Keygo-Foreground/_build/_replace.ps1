$ErrorActionPreference = "Stop"
$p = "D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\source\src\main\java\com\keygo\foreground\KeygoBleScanService.java"
$c = [System.IO.File]::ReadAllText($p)
$old = @'
    private int getNotificationIconRes() {
        int id = getResources().getIdentifier("keygo_notification_icon", "drawable", getPackageName());
        return id != 0 ? id : getApplicationInfo().icon;
    }
'@
$new = @'
    private int getNotificationIconRes() {
        String[] candidatePkgs = new String[]{ getPackageName(), "com.keygo.foreground" };
        int id = 0;
        String matchedPkg = "";
        for (String pkg : candidatePkgs) {
            id = getResources().getIdentifier("keygo_notification_icon", "drawable", pkg);
            if (id != 0) { matchedPkg = pkg; break; }
        }
        Log.i(TAG, "[KeyGo] 通知图标 resId=" + id
                + " 命中包名=" + (matchedPkg.isEmpty() ? "无(将回退HBuilder)" : matchedPkg)
                + " appPkg=" + getPackageName());
        if (id == 0) id = getApplicationInfo().icon;
        return id;
    }
'@
if ($c.Contains($old)) {
    $c = $c.Replace($old, $new)
    [System.IO.File]::WriteAllText($p, $c)
    "REPLACE_OK" | Out-File -FilePath "D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\replace_out.txt" -Encoding utf8
} else {
    "REPLACE_OLD_NOT_FOUND" | Out-File -FilePath "D:\WorkSpace\Code\Ai\CodeBuddy\Keygo\app\BLE_Key_Go_App\nativeplugins\Keygo-Foreground\_build\replace_out.txt" -Encoding utf8
}
