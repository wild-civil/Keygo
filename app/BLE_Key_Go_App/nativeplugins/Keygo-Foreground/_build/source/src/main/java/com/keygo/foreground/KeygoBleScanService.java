package com.keygo.foreground;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * ★ KeyGo 原生前台服务（后台 BLE 扫描核心）
 *
 * 为什么必须在原生层做：
 *   - uni-app 的 JS 运行在 WebView/V8 引擎，锁屏进入 Doze 后 JS 上下文会被系统冻结甚至回收，
 *     纯 JS 的 AlarmManager 心跳 / 亮屏广播 / plus.geolocation 全部随进程失效。
 *   - Android 8+ 的「蓝牙扫描待机限制」规定：后台 app 调用 BluetoothLeScanner.startScan()
 *     必须有正在运行的、foregroundServiceType=connectedDevice 的前台服务，否则扫描结果被静默限流。
 *   本服务在原生层常驻，不受 JS 冻结影响，是后台自动重连能真正成立的唯一路径。
 *
 * 保活策略（对抗 Doze 与厂商回收）：
 *   1. startForeground + 常驻通知 + type=connectedDevice → 系统不认为是高耗电后台，降低被杀概率。
 *   2. 原生 AlarmManager 心跳（60s，setExactAndAllowWhileIdle）→ Doze 深睡下仍能唤醒并重启扫描。
 *   3. onDestroy 时安排 15s 后自重启（通过 PendingIntent 启动前台服务，Android 12+ 属豁免场景）。
 *   4. START_STICKY → 被 LMK 杀后系统尝试重建。
 *
 * 扫描到目标设备后，通过 BleScanEventBus 把 (mac, name, rssi) 推给 KeygoForegroundModule，
 * 再由 JS 调用已有的 tryAutoConnect() 完成连接（复用成熟逻辑）。
 */
public class KeygoBleScanService extends Service {
    private static final String TAG = "KeygoBleScanSvc";
    private static final String CHANNEL_ID = "keygo_bg_ble_v1";
    private static final int NOTIF_ID = 2002;
    private static final String ACTION_TICK = "com.keygo.BG_TICK";
    private static final long TICK_INTERVAL = 60000; // 60s 原生心跳

    // ★ v3.26: 钥匙通知图标，Base64 内嵌 PNG（编译进 class，运行时零依赖，
    //   不依赖 assets / getIdentifier / 插件资源，100% 可靠，彻底修复左侧 H 图标问题）。
    private static final String KEY_ICON_B64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAABfklEQVR4nO3cy5KDMAxEUbVr/v+XNcUiu3mQ2Nht+Z4tKZAlC4ghiQAAAAAAAAAAAAAAAAAAoBLNOlBm5n+fkTQtHhdanfTTiyGnpJ9YjOae/Cf360C7JUjFuqHtNjuzWDe0HZORhYrQdk1CFilC23nwaRLH1AK4DTrN4ll6G4qHC+A629I0rqEFcB9kmsf3m68Fx/zpi1TGoWYWQDe2ZRxGE9r7k6WDjALuLJs8fRf06bqN4hDchroXoOP00zuLFQegA4oWYNTsVRRHByxGARajAItRgKIFGPVNNqM4OsC9AB2vgfTO3owD0AHFC/DpLM44hCY+cbpzrOw6wBuny7/Gc+2nd7vjA5lXwDwRW/xI8pjTy9BrgPtLsTKPb8hF2HWQMo3L9RRkQSZFa7sG7hrPu7Tzi1BamPxRt6Ft15mnzWf+S/cgVnSCiiR/yFLE7GSoUPIvQwfzZDeoWOIfWYx7KkkqmvwLv5RfjP+KAAAAAAAAAAAAAAAAAABEKd/FFo1NJ/LsxwAAAABJRU5ErkJggg==";

    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private String targetName;
    private boolean scanning = false;

    private AlarmManager alarmMgr;
    private PendingIntent tickPi;
    private BroadcastReceiver tickReceiver;
    private BroadcastReceiver screenOnReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "onCreate");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "onStartCommand");
        if (intent != null && intent.hasExtra("targetName")) {
            targetName = intent.getStringExtra("targetName");
        }
        startForeground();
        setupTickAlarm();
        setupScreenOnReceiver();
        startScan();
        return START_STICKY;
    }

    // ==================== 前台通知 ====================
    private void startForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "KeyGo 后台连接", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("保持与车钥匙的蓝牙连接");
            nm.createNotificationChannel(ch);
        }
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = null;
        if (launch != null) {
            int flag = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flag |= PendingIntent.FLAG_IMMUTABLE;
            pi = PendingIntent.getActivity(this, 0, launch, flag);
        }
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) b = new Notification.Builder(this, CHANNEL_ID);
        else b = new Notification.Builder(this);
        // --------------- 通知图标说明（重要）---------------
        // 1. setSmallIcon(int) → 通知【左侧】的小图标（状态栏也会用它）。
        //    当前直接使用 App 桌面图标（drawable/icon.png = KeyGo logo），见 getNotificationSmallIcon()。
        //    ★ 注意：Android 5.0+ 会强制把 SmallIcon 渲染成单色（按通知背景取黑/白/灰），
        //      所以左侧看到的是单色化的 App 图标剪影，这是系统行为，无法显示彩色。
        // 2. setLargeIcon(Bitmap) → 通知【右侧】的大图标；不调用它，右侧就不会出现多余图标。
        //    之前误加了 setLargeIcon，导致右侧出现一个白色方块 APP 图标。
        // --------------------------------------------------
        android.graphics.drawable.Icon _ic = getNotificationSmallIcon();
        b.setSmallIcon(_ic != null ? _ic : android.graphics.drawable.Icon.createWithResource(this, getApplicationInfo().icon))
         .setContentTitle("KeyGo 车钥匙")
         .setContentText("后台连接中，靠近车辆自动解锁")
         .setContentIntent(pi)
         .setOngoing(true);
        // Android 14+ 必须在 startForeground 之前已在 manifest 声明 foregroundServiceType
        startForeground(NOTIF_ID, b.build());
    }

    /**
     * 通知左侧小图标资源：查找插件自带的 keygo_notification_icon
     * （内容 = static/icons/ 的钥匙线稿，已用 aapt2 验证会被 DCloud 打包进 APK，
     *  并在 1.0.7 自定义基座运行时成功生效，不会回退到基座默认图标）。
     * 找不到资源时回退到 getApplicationInfo().icon，保证不崩。
     */
    /**
     * Notification small icon: prefer loading key line-art from plugin assets
     * (bypasses getIdentifier, which returns 0 at runtime under DCloud build).
     * Fallback to getIdentifier, then to app icon (HBuilder H) to avoid crash.
     */
    private android.graphics.drawable.Icon getNotificationSmallIcon() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.M) return null;
        // ★ 用户要求：状态栏左侧小图标直接使用 App 桌面图标（drawable/icon.png，即 KeyGo logo）。
        //   Android 5.0+ 会强制把小图标单色化（按通知背景取黑/白/灰），全彩 logo 会被渲染成单色剪影，
        //   这是系统行为。如后续出现显示异常（如看不清形状），可改回钥匙线稿或单独做白色剪影资源。
        int appIcon = getApplicationInfo().icon;
        if (appIcon != 0) {
            Log.i(TAG, "[KeyGo] icon from app launcher icon (res=" + appIcon + ")");
            return android.graphics.drawable.Icon.createWithResource(this, appIcon);
        }
        Log.w(TAG, "[KeyGo] app icon not found, fallback to HBuilder icon");
        return null;
    }

    // ==================== 原生心跳（抗 Doze） ====================
    private void setupTickAlarm() {
        alarmMgr = (AlarmManager) getSystemService(ALARM_SERVICE);
        if (alarmMgr == null) return;

        Intent i = new Intent(ACTION_TICK);
        int flag = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flag |= PendingIntent.FLAG_IMMUTABLE;
        tickPi = PendingIntent.getBroadcast(this, 9001, i, flag);

        tickReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_TICK.equals(intent.getAction())) {
                    Log.i(TAG, "心跳 tick");
                    ensureScanRunning();
                }
            }
        };
        registerReceiver(tickReceiver, new IntentFilter(ACTION_TICK));

        scheduleNextTick(TICK_INTERVAL);
    }

    private void scheduleNextTick(long delayMs) {
        if (alarmMgr == null || tickPi == null) return;
        long next = SystemClock.elapsedRealtime() + delayMs;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmMgr.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, next, tickPi);
        } else {
            alarmMgr.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, next, tickPi);
        }
    }

    // ==================== 亮屏/解锁监听（舒适模式核心触发器） ====================
    private long _lastScreenOnTs = 0;
    private void setupScreenOnReceiver() {
        if (screenOnReceiver != null) return;
        screenOnReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                String a = intent.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(a) || Intent.ACTION_USER_PRESENT.equals(a)) {
                    long now = System.currentTimeMillis();
                    if (now - _lastScreenOnTs < 3000) return; // 去重：同一次亮屏 SCREEN_ON+USER_PRESENT 只触发一次
                    _lastScreenOnTs = now;
                    Log.i(TAG, "亮屏/解锁，立即触发积极扫描");
                    onScreenOn();
                }
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_USER_PRESENT);
        registerReceiver(screenOnReceiver, f);
        Log.i(TAG, "screenOnReceiver 已注册 (前台服务内)");
    }

    /** 亮屏时强制重启一次积极扫描：前台服务常驻、不受 Doze 限制，必能收到亮屏广播。
     *  解决原先亮屏监听挂在 Activity 上下文上、锁屏后台收不到广播导致开关屏无反应的问题。 */
    private void onScreenOn() {
        Log.i(TAG, "SCREEN_ON/USER_PRESENT → emitScreenOn + rescan");
        // ★ v3.26: 通过事件总线通知 JS 走「心跳同款」高可靠重连路径（tryAutoConnect / 高功率扫描），
        //   不再仅依赖原生 LOW_POWER 扫描（后台常扫不到设备）。前台服务常驻，必能收到亮屏广播。
        BleScanEventBus.getInstance().emitScreenOn();
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
        if (adapter == null || !adapter.isEnabled()) return;
        stopScan();
        startScan();
    }

    /** 心跳触发：确认蓝牙已开、扫描仍在跑，否则自救 */
    private void ensureScanRunning() {
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
        if (adapter == null || !adapter.isEnabled()) {
            if (adapter != null
                    && getPackageManager().checkPermission(android.Manifest.permission.BLUETOOTH_CONNECT, getPackageName()) == PackageManager.PERMISSION_GRANTED) {
                try { adapter.enable(); } catch (Exception e) { Log.w(TAG, "enable bt fail", e); }
            }
            scheduleNextTick(10000); // 蓝牙未开，10s 后再看
            return;
        }
        if (!scanning) startScan();
        scheduleNextTick(TICK_INTERVAL);
    }

    // ==================== BLE 扫描 ====================
    private void startScan() {
        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
        if (adapter == null || !adapter.isEnabled()) {
            scheduleNextTick(10000);
            return;
        }
        if (getPackageManager().checkPermission(android.Manifest.permission.BLUETOOTH_SCAN, getPackageName()) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "无 BLUETOOTH_SCAN 权限，无法后台扫描");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { scheduleNextTick(10000); return; }

        scanCallback = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                BluetoothDevice d = result.getDevice();
                if (d == null) return;
                String mac = d.getAddress();
                String name = d.getName();
                int rssi = result.getRssi();
                if (mac == null) return;
                Log.i(TAG, "发现 " + (name == null ? "?" : name) + " " + mac + " rssi=" + rssi);
                BleScanEventBus.getInstance().emit(mac, name, rssi);
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                for (ScanResult r : results) onScanResult(0, r);
            }

            @Override
            public void onScanFailed(int errorCode) {
                Log.w(TAG, "扫描失败 code=" + errorCode);
                scanning = false;
                scheduleNextTick(10000);
            }
        };

        List<ScanFilter> filters = new ArrayList<>();
        if (targetName != null && !targetName.isEmpty()) {
            filters.add(new ScanFilter.Builder().setDeviceName(targetName).build());
        }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
                .build();
        try {
            scanner.startScan(filters, settings, scanCallback);
            scanning = true;
            Log.i(TAG, "扫描启动 target=" + (targetName == null ? "(全部)" : targetName));
        } catch (Exception e) {
            Log.e(TAG, "startScan 异常", e);
            scanning = false;
            scheduleNextTick(10000);
        }
    }

    private void stopScan() {
        if (scanner != null && scanCallback != null) {
            try { scanner.stopScan(scanCallback); } catch (Exception e) { /* ignore */ }
        }
        scanning = false;
    }

    // ==================== 销毁 / 抗被杀 ====================
    @Override
    public void onDestroy() {
        Log.i(TAG, "onDestroy");
        stopScan();
        if (tickReceiver != null) {
            try { unregisterReceiver(tickReceiver); } catch (Exception e) { /* ignore */ }
        }
        if (screenOnReceiver != null) {
            try { unregisterReceiver(screenOnReceiver); } catch (Exception e) { /* ignore */ }
        }
        if (alarmMgr != null && tickPi != null) {
            try { alarmMgr.cancel(tickPi); } catch (Exception e) { /* ignore */ }
        }
        BleScanEventBus.getInstance().clearListener();
        BleScanEventBus.getInstance().clearScreenOn();

        // ★ 抗被杀：安排 15s 后自重启。Android 12+ 通过 PendingIntent 启动前台服务属豁免场景。
        try {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (am != null) {
                Intent i = new Intent(this, KeygoBleScanService.class);
                if (targetName != null) i.putExtra("targetName", targetName);
                int flag = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flag |= PendingIntent.FLAG_IMMUTABLE;
                PendingIntent pi;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    pi = PendingIntent.getForegroundService(this, 9002, i, flag);
                } else {
                    pi = PendingIntent.getService(this, 9002, i, flag);
                }
                long next = SystemClock.elapsedRealtime() + 15000;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, next, pi);
                } else {
                    am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, next, pi);
                }
                Log.i(TAG, "已安排 15s 后复活");
            }
        } catch (Exception e) {
            Log.w(TAG, "安排复活失败", e);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
