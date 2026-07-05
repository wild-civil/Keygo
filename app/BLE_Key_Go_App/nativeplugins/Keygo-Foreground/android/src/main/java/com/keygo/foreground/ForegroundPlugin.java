package com.keygo.foreground;

import com.alibaba.fastjson.JSONObject;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

/**
 * KeyGo 前台服务 JS 桥接模块
 *
 * JS 调用：
 *   const plugin = uni.requireNativePlugin('Keygo-Foreground')
 *   plugin.start({}, (res) => { console.log(res) })
 *   plugin.stop({}, (res) => { console.log(res) })
 */
public class ForegroundPlugin extends UniModule {

    private static final String TAG = "Keygo-Foreground";

    /**
     * 启动前台服务
     * @param options  暂未使用，保留扩展
     * @param callback 回调 { success: true } 或 { success: false, error: "..." }
     */
    @UniJSMethod(uiThread = false)
    public void start(JSONObject options, UniJSCallback callback) {
        try {
            android.content.Context ctx = mUniSDKInstance.getContext();
            ForegroundService.start(ctx);
            android.util.Log.i(TAG, "ForegroundService started");
            invokeCallback(callback, true, null);
        } catch (Exception e) {
            android.util.Log.e(TAG, "start failed: " + e.getMessage());
            invokeCallback(callback, false, e.getMessage());
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
            ForegroundService.stop(ctx);
            android.util.Log.i(TAG, "ForegroundService stopped");
            invokeCallback(callback, true, null);
        } catch (Exception e) {
            android.util.Log.e(TAG, "stop failed: " + e.getMessage());
            invokeCallback(callback, false, e.getMessage());
        }
    }

    /**
     * 查询前台服务是否正在运行
     * @param options  暂未使用
     * @param callback 回调 { running: true/false }
     */
    @UniJSMethod(uiThread = false)
    public void isRunning(JSONObject options, UniJSCallback callback) {
        boolean running = isServiceRunning();
        JSONObject result = new JSONObject();
        result.put("running", running);
        if (callback != null) {
            callback.invoke(result);
        }
    }

    /**
     * 检查 Service 是否正在运行
     */
    private boolean isServiceRunning() {
        try {
            android.app.ActivityManager manager = (android.app.ActivityManager)
                mUniSDKInstance.getContext().getSystemService(
                    android.content.Context.ACTIVITY_SERVICE
                );
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
