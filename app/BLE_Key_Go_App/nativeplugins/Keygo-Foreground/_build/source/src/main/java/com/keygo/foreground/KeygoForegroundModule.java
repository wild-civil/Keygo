package com.keygo.foreground;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.util.Log;

import org.json.JSONObject;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

/**
 * ★ KeyGo 原生插件 Module（JS 与原生前台服务的桥接层）
 *
 * JS 侧通过 uni.requireNativePlugin('Keygo-Foreground') 获取本模块，调用：
 *   - startScan({ targetName }, callback) ：启动原生前台服务 + 后台 BLE 扫描。
 *       callback 用 invokeAndKeepAlive 持续回调，事件格式 { event, ... }：
 *         { event: 'started' }                          服务已启动
 *         { event: 'devicefound', mac, name, rssi }     扫到设备（所有设备）
 *         { event: 'error', message }                   启动失败
 *   - stopScan(callback) ：停止前台服务
 *   - isRunning(callback) ：查询是否已启动
 *   - startScreenOnReceiver(callback) ：注册原生亮屏/解锁监听
 *       callback 用 invokeAndKeepAlive 持续回调：
 *         { event: 'screenon' }                         屏幕亮起 / 用户已解锁
 *   - stopScreenOnReceiver(callback) ：注销原生亮屏监听
 *
 * 扫到的设备经 BleScanEventBus 推送到此处注册的 listener，再由 callback 转交 JS。
 * JS 端在 devicefound 回调里比对已知设备 MAC，命中即触发 tryAutoConnect() 重连。
 * 亮屏事件由原生 BroadcastReceiver 直接推送，不依赖 WebView，修复后台冻结失效问题。
 */
public class KeygoForegroundModule extends UniModule {
    private static final String TAG = "KeygoFgModule";
    private UniJSCallback scanCallback;

    /**
     * ★ v3.25: 原生亮屏监听（舒适模式后台重连的核心触发器）
     *
     * 为什么必须在原生层做，而不能用 JS 的 plus.android.implements：
     *   - plus.android.implements 创建的是 WebView 桥接代理对象，其 onReceive 回调要经过
     *     JS 引擎 → WebView 桥 才能执行。App 退到后台后 WebView 被系统冻结（尤其国产 ROM），
     *     桥断开 → 回调静默丢失 → 用户开关屏毫无反应。
     *   - 本 Module 用标准 android.content.BroadcastReceiver 注册在 ApplicationContext 上，
     *     onReceive 是纯原生 Java 代码，不依赖 WebView，锁屏/Doze 下仍可靠触发。
     *     用户亮屏/解锁 → 系统唤醒 App → WebView 解冻 → keepAlive 回调送达 JS → 触发扫描。
     */
    private UniJSCallback screenOnCallback;
    private boolean screenOnForwardReady = false;

    /**
     * 通过反射兼容不同 uni-app SDK 版本的上下文字段：
     *   - 旧版（继承自 Weex WXModule）：mWXSDKInstance
     *   - 新版（uni-app）：mUniSDKInstance
     * 直接硬编码字段名在另一版本 SDK 上会抛 NoSuchFieldError，故用反射兜底。
     */
    private Context getAppContext() {
        try {
            Class<?> c = getClass();
            while (c != null && c != Object.class) {
                for (String name : new String[] { "mUniSDKInstance", "mWXSDKInstance" }) {
                    try {
                        java.lang.reflect.Field f = c.getDeclaredField(name);
                        f.setAccessible(true);
                        Object inst = f.get(this);
                        if (inst != null) {
                            return (Context) inst.getClass().getMethod("getContext").invoke(inst);
                        }
                    } catch (Exception ignore) { /* 尝试下一个字段 */ }
                }
                c = c.getSuperclass();
            }
        } catch (Exception e) {
            Log.w(TAG, "getAppContext 反射失败", e);
        }
        return null;
    }

    @UniJSMethod(uiThread = false)
    public void startScan(JSONObject options, UniJSCallback callback) {
        Log.i(TAG, "startScan");
        this.scanCallback = callback;
        BleScanEventBus.getInstance().setListener(new BleScanEventBus.OnDeviceFoundListener() {
            @Override
            public void onDeviceFound(String mac, String name, int rssi) {
                pushEvent("devicefound", mac, name, rssi, null);
            }
        });
        // ★ v3.26: 服务（重）启动时，若曾请求亮屏转发，重新挂上屏幕亮事件监听
        if (screenOnForwardReady) {
            BleScanEventBus.getInstance().setScreenOnListener(new BleScanEventBus.OnScreenOnListener() {
                @Override
                public void onScreenOn() {
                    Log.i(TAG, "亮屏事件(经总线) → 推送 JS");
                    pushScreenOn();
                }
            });
        }

        String targetName = (options != null) ? options.optString("targetName", "") : "";
        Context ctx = getAppContext();
        if (ctx == null) { Log.e(TAG, "getAppContext 失败，无法启动服务"); return; }
        try {
            Intent intent = new Intent(ctx, KeygoBleScanService.class);
            intent.putExtra("targetName", targetName == null ? "" : targetName);
            ctx.startForegroundService(intent);
            pushEvent("started", null, null, 0, null);
        } catch (Exception e) {
            Log.e(TAG, "startScan fail", e);
            pushEvent("error", null, null, 0, e.getMessage());
        }
    }

    @UniJSMethod(uiThread = false)
    public void stopScan(UniJSCallback callback) {
        Log.i(TAG, "stopScan");
        Context ctx = getAppContext();
        if (ctx == null) { Log.e(TAG, "getAppContext 失败"); return; }
        try {
            Intent intent = new Intent(ctx, KeygoBleScanService.class);
            ctx.stopService(intent);
        } catch (Exception e) {
            Log.e(TAG, "stopScan fail", e);
        }
        BleScanEventBus.getInstance().clearListener();
        this.scanCallback = null;
        if (callback != null) callback.invoke(new JSONObject());
    }

    @UniJSMethod(uiThread = false)
    public void isRunning(UniJSCallback callback) {
        if (callback != null) {
            JSONObject o = new JSONObject();
            try { o.put("running", scanCallback != null); } catch (Exception e) { /* ignore */ }
            callback.invoke(o);
        }
    }

    /**
     * ★ v3.25: 注册原生亮屏/解锁广播接收器（舒适模式后台重连触发器）
     *
     * 在 ApplicationContext 上注册标准 BroadcastReceiver，监听：
     *   - Intent.ACTION_SCREEN_ON    屏幕亮起
     *   - Intent.ACTION_USER_PRESENT 用户已解锁（有锁屏密码时更精准）
     * 收到后通过 keepAlive 回调向 JS 推送 { event: 'screenon' }。
     * 接收器为原生实现，不受 WebView 冻结影响（修复 JS plus.android.implements 后台失效）。
     */
    @UniJSMethod(uiThread = false)
    public void startScreenOnReceiver(UniJSCallback callback) {
        Log.i(TAG, "startScreenOnReceiver");
        this.screenOnCallback = callback;
        if (screenOnForwardReady) {
            Log.i(TAG, "screenOnReceiver 转发已就绪，仅更新回调");
            return;
        }
        // ★ v3.26: 真正的亮屏广播接收器已移到前台服务 KeygoBleScanService（常驻、不受 Doze /
        //   Activity 销毁影响，100% 收到广播）。本方法只把“亮屏→JS”的转发挂到事件总线：
        //   前台服务收到 SCREEN_ON/USER_PRESENT → BleScanEventBus.emitScreenOn()
        //   → 此处 listener → pushScreenOn() → JS 触发 tryAutoConnect（与心跳同路径，高可靠）。
        //   不再在 Activity 上下文注册 BroadcastReceiver（后台 Activity 被回收 → 收不到广播）。
        screenOnForwardReady = true;
        BleScanEventBus.getInstance().setScreenOnListener(new BleScanEventBus.OnScreenOnListener() {
            @Override
            public void onScreenOn() {
                Log.i(TAG, "亮屏事件(经总线) → 推送 JS");
                pushScreenOn();
            }
        });
        Log.i(TAG, "screenOnReceiver 转发已就绪（实际接收器在前台服务内）");
    }

    /**
     * ★ v3.25: 注销原生亮屏广播接收器
     */
    @UniJSMethod(uiThread = false)
    public void stopScreenOnReceiver(UniJSCallback callback) {
        Log.i(TAG, "stopScreenOnReceiver");
        BleScanEventBus.getInstance().clearScreenOn();
        screenOnForwardReady = false;
        this.screenOnCallback = null;
        if (callback != null) callback.invoke(new JSONObject());
    }

    /** 推送亮屏事件给 JS（keepAlive 保证可多次调用） */
    private void pushScreenOn() {
        if (screenOnCallback == null) return;
        JSONObject o = new JSONObject();
        try { o.put("event", "screenon"); } catch (Exception e) { /* ignore */ }
        try {
            screenOnCallback.invokeAndKeepAlive(o);
        } catch (Exception e) {
            Log.w(TAG, "pushScreenOn 失败（JS 回调可能已失效）", e);
        }
    }

    /** 统一推送事件给 JS（keepAlive 保证可多次调用） */
    private void pushEvent(String event, String mac, String name, int rssi, String message) {
        if (scanCallback == null) return;
        JSONObject o = new JSONObject();
        try {
            o.put("event", event);
            if (mac != null) o.put("mac", mac);
            if (name != null) o.put("name", name);
            if (event.equals("devicefound")) o.put("rssi", rssi);
            if (message != null) o.put("message", message);
        } catch (Exception e) { /* ignore */ }
        scanCallback.invokeAndKeepAlive(o);
    }
}
