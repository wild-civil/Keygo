package com.keygo.foreground;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * KeyGo 前台服务
 *
 * 职责：
 *   1. 保持进程不被 Android Doze 冻结
 *   2. 持有 PARTIAL_WAKE_LOCK 防止 CPU 休眠
 *   3. 显示常驻通知 "KeyGo 后台运行中"
 *
 * 设计原则：
 *   - 不处理 BLE 逻辑，仅保持进程存活
 *   - BLE 扫描/重连由 JS 层 ble.js 的 setTimeout 循环负责
 *   - START_STICKY：进程被杀后系统自动重建 Service（但 JS 上下文会丢失）
 */
public class ForegroundService extends Service {

    private static final String CHANNEL_ID = "keygo_foreground_channel";
    private static final String CHANNEL_NAME = "KeyGo 后台服务";
    private static final int NOTIFICATION_ID = 1001;
    private static final String TAG = "KeyGo-Foreground";

    private PowerManager.WakeLock wakeLock;

    // ==================== 生命周期 ====================

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            // ★ v3.17.1: 先检查通知权限（Android 13+）
            if (Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    android.util.Log.w(TAG,
                        "POST_NOTIFICATIONS 权限未授予，startForeground 通知可能不显示");
                    // 不阻断：即使没权限，startForeground 也会成功，只是通知不显示
                }
            }

            Notification notification = buildNotification();
            startForeground(NOTIFICATION_ID, notification);
            android.util.Log.i(TAG, "ForegroundService started (foreground), WakeLock="
                + (wakeLock != null && wakeLock.isHeld()));
        } catch (Exception e) {
            android.util.Log.e(TAG, "onStartCommand failed: " + e.getMessage(), e);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    // ==================== 通知渠道 ====================

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW  // 不响铃不振动，仅显示在通知栏
            );
            channel.setDescription("保持蓝牙连接活跃，靠近车辆自动解锁");
            channel.setShowBadge(false);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    // ==================== 通知构建 ====================

    private Notification buildNotification() {
        // 点击通知 → 打开 App
        Intent notificationIntent = getPackageManager()
            .getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        builder
            .setContentTitle("KeyGo 车钥匙")
            .setContentText("后台运行中，靠近车辆自动解锁")
            .setSmallIcon(android.R.drawable.ic_lock_lock)  // Android 系统锁图标
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW);

        return builder.build();
    }

    // ==================== WakeLock ====================

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "KeyGo::BleKeepAlive"
                );
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
                android.util.Log.i(TAG, "WakeLock acquired: PARTIAL_WAKE_LOCK");
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "WakeLock acquire failed: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
                android.util.Log.i(TAG, "WakeLock released");
            } catch (RuntimeException ignored) {
                // WakeLock 可能已被系统回收
            }
        }
    }

    // ==================== 静态辅助方法 ====================

    /**
     * 启动前台服务
     */
    public static void start(Context context) {
        Intent intent = new Intent(context, ForegroundService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            android.util.Log.i(TAG, "Service start intent sent");
        } catch (Exception e) {
            android.util.Log.e(TAG, "start failed: " + e.getMessage(), e);
            throw new RuntimeException("ForegroundService start failed", e);
        }
    }

    /**
     * 停止前台服务
     */
    public static void stop(Context context) {
        Intent intent = new Intent(context, ForegroundService.class);
        try {
            context.stopService(intent);
            android.util.Log.i(TAG, "Service stop intent sent");
        } catch (Exception e) {
            android.util.Log.e(TAG, "stop failed: " + e.getMessage());
        }
    }

    /**
     * ★ v3.17.1: 检查前台服务是否正在运行
     */
    public static boolean isServiceRunning(Context context) {
        try {
            android.app.ActivityManager manager = (android.app.ActivityManager)
                context.getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) return false;
            for (android.app.ActivityManager.RunningServiceInfo service :
                 manager.getRunningServices(Integer.MAX_VALUE)) {
                if (ForegroundService.class.getName().equals(
                        service.service.getClassName())) {
                    return true;
                }
            }
        } catch (Exception e) {
            android.util.Log.w(TAG, "isRunning check failed: " + e.getMessage());
        }
        return false;
    }
}
