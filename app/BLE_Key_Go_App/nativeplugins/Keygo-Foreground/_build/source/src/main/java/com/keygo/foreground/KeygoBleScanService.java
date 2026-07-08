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

    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private String targetName;
    private boolean scanning = false;

    private AlarmManager alarmMgr;
    private PendingIntent tickPi;
    private BroadcastReceiver tickReceiver;

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
        //    这里不能直接用 getApplicationInfo().icon，因为 DCloud 自定义基座打包时，
        //    getApplicationInfo().icon 返回的可能是基座默认图标（绿色 H），而不是
        //    manifest.json 里配置的 static/icons/ 自定义图标。
        //    所以把 static/icons/ 下的图标复制到插件 res/drawable-*/keygo_app_icon.png，
        //    通过 getIdentifier("keygo_app_icon", ...) 直接查找，确保通知左侧和 App 桌面图标一致。
        //    找不到时回退到 getApplicationInfo().icon，保证不崩。
        // 2. setLargeIcon(Bitmap) → 通知【右侧】的大图标；去掉这行后右侧不会出现多余图标。
        //    之前把 setLargeIcon 也写上了，导致右侧出现一个白色方块 APP 图标。
        // --------------------------------------------------
        int appIconRes = getResources().getIdentifier("keygo_app_icon", "drawable", getPackageName());
        if (appIconRes == 0) appIconRes = getApplicationInfo().icon;
        b.setSmallIcon(appIconRes)
         .setContentTitle("KeyGo 车钥匙")
         .setContentText("后台连接中，靠近车辆自动解锁")
         .setContentIntent(pi)
         .setOngoing(true);
        // Android 14+ 必须在 startForeground 之前已在 manifest 声明 foregroundServiceType
        startForeground(NOTIF_ID, b.build());
    }

    /**
     * 状态栏小图标：优先用插件自带的白色通知图标（keygo_notification_icon），
     * 不依赖基座包图标（自定义基座默认是 HbuilderX 图标，会导致状态栏显示 HbuilderX）。
     * 找不到资源时回退到 getApplicationInfo().icon，保证不崩。
     */
    private int getNotificationIconRes() {
        int id = getResources().getIdentifier("keygo_notification_icon", "drawable", getPackageName());
        return id != 0 ? id : getApplicationInfo().icon;
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
        if (alarmMgr != null && tickPi != null) {
            try { alarmMgr.cancel(tickPi); } catch (Exception e) { /* ignore */ }
        }
        BleScanEventBus.getInstance().clearListener();

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
