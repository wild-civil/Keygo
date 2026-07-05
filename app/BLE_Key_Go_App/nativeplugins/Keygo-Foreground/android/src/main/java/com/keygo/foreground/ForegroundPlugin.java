package com.keygo.foreground;

import com.alibaba.fastjson.JSONObject;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

import android.content.pm.PackageManager;
import android.os.Build;

/**
 * KeyGo 前台服务 JS 桥接模块
 *
 * JS 调用：
 *   const plugin = uni.requireNativePlugin('Keygo-Foreground')
 *   plugin.start({}, (res) => { console.log(res) })
 *   plugin.stop({}, (res) => { console.log(res) })
 *   plugin.checkNotificationPermission({}, callback)
 */
public class ForegroundPlugin extends UniModule {

    private static final String TAG = "Keygo-Foreground";

    // ==================== 启动/停止 ====================

    /**
     * 启动前台服务
     * @param options  暂未使用，保留扩展
     * @param callback 回调 { success: true } 或 { success: false, error: "..." }
     */
    @UniJSMethod(uiThread = false)
    public void start(JSONObject options, UniJSCallback callback) {
        try {
            android.content.Context ctx = mUniSDKInstance.getContext();
            if (ctx == null) {
                android.util.Log.e(TAG, "start failed: context is null");
                invokeCallback(callback, false, "context is null (WebView 未就绪?)");
                return;
            }
            ForegroundService.start(ctx);
            android.util.Log.i(TAG, "ForegroundService started successfully");
            invokeCallback(callback, true, null);
        } catch (Exception e) {
            android.util.Log.e(TAG, "start failed: " + e.getMessage(), e);
            invokeCallback(callback, false,
                (e.getMessage() != null) ? e.getMessage() : "Unknown error");
        }
    }

    /**
     * 停止前台服务
     * @param options  暂未使用，保留扩展
     * @param callback 回调 { success: true } 或 { success: false, error: "..." }
     */
    @UniJSMethod(uiThread = false)
    public void stop(JSONObject options, UniJSCallback callback) {
        try {
            android.content.Context ctx = mUniSDKInstance.getContext();
            if (ctx == null) {
                invokeCallback(callback, false, "context is null");
                return;
            }
            ForegroundService.stop(ctx);
            android.util.Log.i(TAG, "ForegroundService stopped successfully");
            invokeCallback(callback, true, null);
        } catch (Exception e) {
            android.util.Log.e(TAG, "stop failed: " + e.getMessage());
            invokeCallback(callback, false,
                (e.getMessage() != null) ? e.getMessage() : "Unknown error");
        }
    }

    // ==================== 状态查询 ====================

    /**
     * 查询前台服务是否正在运行
     * @param options  暂未使用
     * @param callback 回调 { running: true/false }
     */
    @UniJSMethod(uiThread = false)
    public void isRunning(JSONObject options, UniJSCallback callback) {
        try {
            android.content.Context ctx = mUniSDKInstance.getContext();
            boolean running = ctx != null && ForegroundService.isServiceRunning(ctx);
            JSONObject result = new JSONObject();
            result.put("running", running);
            if (callback != null) {
                callback.invoke(result);
            }
        } catch (Exception e) {
            android.util.Log.w(TAG, "isRunning failed: " + e.getMessage());
            JSONObject result = new JSONObject();
            result.put("running", false);
            result.put("error", (e.getMessage() != null) ? e.getMessage() : "Unknown error");
            if (callback != null) {
                callback.invoke(result);
            }
        }
    }

    /**
     * ★ v3.17.1: 检查通知权限状态（Android 13+）
     * @param options  暂未使用
     * @param callback 回调 {
     *   granted: true/false,
     *   needRequest: true/false,       // 是否需要请求权限
     *   sdkVersion: 33                  // 当前 Android SDK 版本
     * }
     */
    @UniJSMethod(uiThread = false)
    public void checkNotificationPermission(JSONObject options, UniJSCallback callback) {
        JSONObject result = new JSONObject();
        try {
            android.content.Context ctx = mUniSDKInstance.getContext();
            if (ctx == null) {
                result.put("granted", false);
                result.put("needRequest", false);
                result.put("error", "context is null");
                if (callback != null) callback.invoke(result);
                return;
            }

            int sdkInt = Build.VERSION.SDK_INT;
            result.put("sdkVersion", sdkInt);

            if (sdkInt < 33) {
                // Android 12 及以下不需要通知权限
                result.put("granted", true);
                result.put("needRequest", false);
            } else {
                int permStatus = ctx.checkSelfPermission(
                    android.Manifest.permission.POST_NOTIFICATIONS);
                boolean granted = (permStatus == PackageManager.PERMISSION_GRANTED);
                result.put("granted", granted);
                result.put("needRequest", !granted);
            }
        } catch (Exception e) {
            android.util.Log.e(TAG, "checkNotificationPermission failed: " + e.getMessage());
            result.put("granted", false);
            result.put("needRequest", true);
            result.put("error", (e.getMessage() != null) ? e.getMessage() : "Unknown error");
        }

        if (callback != null) {
            callback.invoke(result);
        }
    }

    // ==================== 工具方法 ====================

    private void invokeCallback(UniJSCallback callback, boolean success, String error) {
        if (callback == null) return;
        JSONObject result = new JSONObject();
        result.put("success", success);
        if (error != null) {
            result.put("error", error);
        }
        callback.invoke(result);
    }
}
