package com.keygo.foreground;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
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
        // ★ v3.27: 每次 startScan 都确保屏幕事件总线监听已挂载（不再依赖 screenOnForwardReady），
        //   配合 onDestroy 不清空屏幕监听，保证前台服务重建后亮屏事件仍能送达 JS。
        BleScanEventBus.getInstance().setScreenEventListener(new BleScanEventBus.OnScreenEventListener() {
            @Override
            public void onScreenEvent(String type) {
                Log.i(TAG, "亮屏事件(经总线) → 推送 JS");
                pushScreenEvent(type);
            }
        });

        String targetName = (options != null) ? options.optString("targetName", "") : "";
        Context ctx = getAppContext();
        if (ctx == null) {
            Log.e(TAG, "getAppContext 失败，无法启动服务");
            // ★ v3.27: 静默失败诊断 —— 前台服务根本没起来，但 JS 仍认为已启动，
            //   会导致「无任何原生日志 + DEV 屏幕事件一直 --」。显式报错让 JS/DEV 可见。
            pushEvent("error", null, null, 0, "getAppContext失败，前台服务未启动（屏幕/扫描监听均不生效）");
            return;
        }
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
     * ★ 方案A（2026-07-12）+ Phase2 passkey（2026-07-15）：发起 BLE 配对（bond）。
     *
     * JS 在 BIND 之前调用（先配对再 BIND，使绑定码在加密链路上传输）：
     *   createBond({ mac: deviceId, forceRebond: true/false }, (res) => {...})
     *
     * 回调返回 { ok: true/false, message: "..." }。
     * 固件已启用 passkey/MITM（mitm=1, DISPLAY_ONLY），配对时系统弹「输入配对码」窗，
     * 用户输绑定码（默认 123456）完成 MITM 认证；bond 成功后 LTK 存手机 KeyStore 与
     * 固件 SNV，后续 OS 重连自动加密（LINK_ENCRYPTED）→ 走近自动解锁，无需 App 进程。
     *
     * ★ 关键修复（2026-07-15）：若手机侧已配对（如设备恢复出厂清了 SNV 但手机 bond 还在），
     *   直接 device.createBond() 返回 false 且不弹窗 → passkey 永不出现。故：
     *   - forceRebond=true 且已配对 → 先 removeBond（反射）等 BOND_NONE 再重新配对，强制弹窗；
     *   - 已配对且 forceRebond=false → 直接成功返回（耳机体验已具备，无需重绑）；
     *   - 未配对 → 直接发起配对。
     */
    @UniJSMethod(uiThread = false)
    public void createBond(JSONObject options, UniJSCallback callback) {
        String mac = (options != null) ? options.optString("mac", "") : "";
        boolean forceRebond = (options != null) && options.optBoolean("forceRebond", false);
        Log.i(TAG, "createBond mac=" + mac + " forceRebond=" + forceRebond);

        if (mac.isEmpty()) {
            invokeCallback(callback, false, "MAC 为空");
            return;
        }

        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            invokeCallback(callback, false, "蓝牙未开启");
            return;
        }

        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(mac);
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "getRemoteDevice 失败, mac=" + mac, e);
            invokeCallback(callback, false, "MAC 格式无效");
            return;
        }

        Context ctx = getAppContext();
        if (ctx == null) {
            invokeCallback(callback, false, "获取 Context 失败");
            return;
        }

        // ★ 已配对处理：见方法注释。未配对或强制重绑失败兜底均走 startCreateBond。
        int bs = device.getBondState();
        if (bs == BluetoothDevice.BOND_BONDED) {
            if (!forceRebond) {
                invokeCallback(callback, true, "已配对");
                return;
            }
            Log.i(TAG, "createBond: 已配对且 forceRebond -> 先 removeBond 再配对");
            removeBondThenCreate(device, mac, ctx, callback);
            return;
        }

        // 未配对：直接发起配对（passkey/MITM 下系统弹输入码窗）
        startCreateBond(device, mac, ctx, callback);
    }

    /** 发起配对并监听 BOND 结果（一次性广播接收器）。 */
    private void startCreateBond(BluetoothDevice device, String mac, Context ctx, UniJSCallback callback) {
        BondStateReceiver receiver = new BondStateReceiver(mac, device, callback);
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        ctx.registerReceiver(receiver, filter);

        boolean started = device.createBond();
        Log.i(TAG, "createBond started=" + started + " mac=" + mac);
        if (!started) {
            try { ctx.unregisterReceiver(receiver); } catch (Exception ignore) {}
            invokeCallback(callback, false, "createBond 调用失败");
        }
        // 成功：等待 BondStateReceiver 回传最终结果（BOND_BONDED 或 BOND_NONE）
    }

    /** 先 removeBond（反射，隐藏 API），等 BOND_NONE 后再 startCreateBond 触发新配对弹窗。 */
    private void removeBondThenCreate(BluetoothDevice device, String mac, Context ctx, UniJSCallback callback) {
        BroadcastReceiver remReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (!BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) return;
                BluetoothDevice dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (dev == null || !mac.equals(dev.getAddress())) return;
                int state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE);
                if (state == BluetoothDevice.BOND_NONE) {
                    try { context.unregisterReceiver(this); } catch (Exception ignore) {}
                    Log.i(TAG, "removeBond 完成，发起新配对 mac=" + mac);
                    startCreateBond(device, mac, ctx, callback);
                }
            }
        };
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        ctx.registerReceiver(remReceiver, filter);
        try {
            java.lang.reflect.Method m = device.getClass().getMethod("removeBond");
            m.invoke(device);
            Log.i(TAG, "removeBond 调用成功 mac=" + mac);
        } catch (Exception e) {
            try { ctx.unregisterReceiver(remReceiver); } catch (Exception ignore) {}
            Log.e(TAG, "removeBond 失败，退而直接配对 mac=" + mac, e);
            startCreateBond(device, mac, ctx, callback);
        }
    }

    /** 统一回调封装 */
    private void invokeCallback(UniJSCallback callback, boolean ok, String message) {
        if (callback == null) return;
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("message", message);
        } catch (Exception e) { /* ignore */ }
        callback.invoke(o);
    }

    /**
     * ★ 方案A：Bond 状态广播接收器（一次性）。
     *
     * 监听 BluetoothDevice.ACTION_BOND_STATE_CHANGED，
     * 等待目标设备的最终 bond 状态（BOND_BONDED=12 或 BOND_NONE=10），
     * 收到后回传 callback 并自动注销。
     */
    private static class BondStateReceiver extends BroadcastReceiver {
        private final String mac;
        private final BluetoothDevice device;
        private final UniJSCallback callback;

        BondStateReceiver(String mac, BluetoothDevice device, UniJSCallback callback) {
            this.mac = mac;
            this.device = device;
            this.callback = callback;
        }

        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (!BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) return;

            BluetoothDevice dev = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            if (dev == null || !mac.equals(dev.getAddress())) return;

            int state = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE);
            Log.i(TAG, "BondStateReceiver mac=" + mac + " state=" + state
                + " (" + (state == BluetoothDevice.BOND_BONDED ? "BONDED" :
                          state == BluetoothDevice.BOND_BONDING ? "BONDING" :
                          state == BluetoothDevice.BOND_NONE ? "NONE" : "?") + ")");

            if (state == BluetoothDevice.BOND_BONDED) {
                context.unregisterReceiver(this);
                invokeCallbackStatic(callback, true, "配对成功");
            } else if (state == BluetoothDevice.BOND_NONE) {
                context.unregisterReceiver(this);
                invokeCallbackStatic(callback, false, "配对失败");
            }
            // BOND_BONDING(11): 中间状态，忽略，等最终 BOND_BONDED 或 BOND_NONE
        }

        private static void invokeCallbackStatic(UniJSCallback callback, boolean ok, String message) {
            if (callback == null) return;
            JSONObject o = new JSONObject();
            try {
                o.put("ok", ok);
                o.put("message", message);
            } catch (Exception e) { /* ignore */ }
            callback.invoke(o);
        }
    }

    /**
     * ★ v3.25: 注册原生亮屏/解锁广播接收器（舒适模式后台重连触发器）
     *
     * 在 ApplicationContext 上注册标准 BroadcastReceiver，监听：
     *   - Intent.ACTION_SCREEN_ON    屏幕亮起
     *   - Intent.ACTION_USER_PRESENT 用户已解锁（有锁屏密码时更精准）
     * 收到后通过 keepAlive 回调向 JS 推送 { event: 'screen', type: 'screen_on'|'screen_off'|'user_present' }。
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
        BleScanEventBus.getInstance().setScreenEventListener(new BleScanEventBus.OnScreenEventListener() {
            @Override
            public void onScreenEvent(String type) {
                Log.i(TAG, "亮屏事件(经总线) → 推送 JS");
                pushScreenEvent(type);
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

    /** 推送屏幕事件给 JS（keepAlive 保证可多次调用）。type: screen_on / screen_off / user_present */
    private void pushScreenEvent(String type) {
        if (screenOnCallback == null) {
            Log.w(TAG, "pushScreenEvent: screenOnCallback 为 null（JS 未调用 startScreenOnReceiver），丢弃 type=" + type);
            return;
        }
        JSONObject o = new JSONObject();
        try {
            o.put("event", "screen");
            o.put("type", type == null ? "unknown" : type);
        } catch (Exception e) { /* ignore */ }
        try {
            screenOnCallback.invokeAndKeepAlive(o);
        } catch (Exception e) {
            Log.w(TAG, "pushScreenEvent 失败（JS 回调可能已失效）", e);
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
