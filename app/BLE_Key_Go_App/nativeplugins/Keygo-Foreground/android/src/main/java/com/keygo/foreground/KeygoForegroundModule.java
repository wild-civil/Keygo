package com.keygo.foreground;

import android.content.Context;
import android.content.Intent;
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
 *
 * 扫到的设备经 BleScanEventBus 推送到此处注册的 listener，再由 callback 转交 JS。
 * JS 端在 devicefound 回调里比对已知设备 MAC，命中即触发 tryAutoConnect() 重连。
 */
public class KeygoForegroundModule extends UniModule {
    private static final String TAG = "KeygoFgModule";
    private UniJSCallback scanCallback;

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

        String targetName = (options != null) ? options.optString("targetName", "") : "";
        try {
            Context ctx = mWXSDKInstance.getContext().getApplicationContext();
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
        try {
            Context ctx = mWXSDKInstance.getContext().getApplicationContext();
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
