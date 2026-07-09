package com.keygo.foreground;

/**
 * 进程内单例事件总线：原生扫描服务 → UniModule → JS 回调 的桥梁。
 *
 * KeygoBleScanService（独立 Service 组件）扫到设备后调用 emit()，
 * KeygoForegroundModule 注册 listener，再通过 UniJSCallback 把结果推给 JS。
 * 二者同进程，静态单例即可共享。
 *
 * v3.26: 新增亮屏事件（OnScreenEventListener）。前台服务收到 SCREEN_ON/USER_PRESENT 后
 *   emitScreenOn()，经 UniModule 推给 JS 触发 tryAutoConnect（与心跳一致的高可靠路径）。
 */
public class BleScanEventBus {
    private static BleScanEventBus instance;
    private OnDeviceFoundListener listener;
    private OnScreenEventListener screenEventListener;

    public interface OnDeviceFoundListener {
        void onDeviceFound(String mac, String name, int rssi);
    }

    public interface OnScreenEventListener {
        void onScreenEvent(String type);
    }

    public static synchronized BleScanEventBus getInstance() {
        if (instance == null) instance = new BleScanEventBus();
        return instance;
    }

    public void setListener(OnDeviceFoundListener l) { this.listener = l; }
    public void clearListener() { this.listener = null; }

    public void setScreenEventListener(OnScreenEventListener l) { this.screenEventListener = l; }
    public void clearScreenOn() { this.screenEventListener = null; }

    public void emit(String mac, String name, int rssi) {
        if (listener != null) {
            try {
                listener.onDeviceFound(mac, name, rssi);
            } catch (Exception e) {
                android.util.Log.w("KeygoBleScanSvc", "emit fail", e);
            }
        }
    }

    public void emitScreenEvent(String type) {
        if (screenEventListener != null) {
            try {
                screenEventListener.onScreenEvent(type);
            } catch (Exception e) {
                android.util.Log.w("KeygoBleScanSvc", "emitScreenEvent fail", e);
            }
        }
    }

    /** @deprecated 兼容旧调用点 */
    public void emitScreenOn() { emitScreenEvent("screen_on"); }
}
