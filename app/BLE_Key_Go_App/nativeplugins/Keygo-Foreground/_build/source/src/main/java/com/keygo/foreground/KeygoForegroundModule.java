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
            callback.invokeAndKeepAlive(o);
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
     * 用户输【系统配对码】(由固件 g_sysPasscode 回传，默认 123456，与绑定码独立)完成 MITM 认证；
     * bond 成功后 LTK 存手机 KeyStore 与固件 SNV，后续 OS 重连自动加密（LINK_ENCRYPTED）→ 走近自动解锁，无需 App 进程。
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

        if (mac.isEmpty()) { invokeOnce(callback, false, "MAC 为空"); return; }

        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            invokeOnce(callback, false, "蓝牙未开启"); return;
        }

        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(mac);
        } catch (IllegalArgumentException e) {
            Log.e(TAG, "getRemoteDevice 失败, mac=" + mac, e);
            invokeOnce(callback, false, "MAC 格式无效"); return;
        }

        Context ctx = getAppContext();
        if (ctx == null) {
            invokeOnce(callback, false, "获取 Context 失败"); return;
        }

        int bs = device.getBondState();
        Log.i(TAG, "createBond bondState=" + bs);
        if (bs == BluetoothDevice.BOND_BONDED && !forceRebond) {
            invokeOnce(callback, true, "已配对"); return;
        }

        // ★ 关键修复(2026-07-15 晚): 弃用异步 invokeAndKeepAlive —— Weex 在方法 return 时
        //   会用 null 自动收尾回调，异步广播里的 invokeAndKeepAlive 全部被丢弃 -> JS 只收到 null。
        //   改用【同步阻塞】模式：后台线程用 CountDownLatch 等 OS 配对广播（最多 30s 给用户输配对码），
        //   方法 return 前用【单次】 callback.invoke() 返回真实结果（uiThread=false 阻塞工作线程，不 ANR）。
        android.util.Pair<Boolean, String> result;
        if (bs == BluetoothDevice.BOND_BONDED && forceRebond) {
            result = removeBondAndWait(device, mac, ctx, 30);
        } else {
            result = createBondAndWait(device, mac, ctx, 30);
        }
        invokeOnce(callback, result.first, result.second);
    }

    /** 同步等待配对结果（最多 timeoutSec 秒）。必须在后台线程调用（uiThread=false）。 */
    private android.util.Pair<Boolean, String> createBondAndWait(BluetoothDevice device, String mac, Context ctx, int timeoutSec) {
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final boolean[] ok = { false };
        final String[] reason = { "超时未完成配对" };
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (!BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(i.getAction())) return;
                BluetoothDevice dev = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (dev == null || !mac.equals(dev.getAddress())) return;
                int st = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE);
                if (st == BluetoothDevice.BOND_BONDED) {
                    ok[0] = true; reason[0] = "配对成功"; latch.countDown();
                } else if (st == BluetoothDevice.BOND_NONE) {
                    ok[0] = false; reason[0] = "配对失败(用户取消或超时)"; latch.countDown();
                }
            }
        };
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        ctx.registerReceiver(receiver, filter);

        boolean started = doCreateBond(device);
        if (!started) {
            Log.w(TAG, "createBond 首次返回 false，800ms 后重试 mac=" + mac);
            try { Thread.sleep(800); } catch (InterruptedException ignore) {}
            started = doCreateBond(device);
        }
        if (!started) {
            try { ctx.unregisterReceiver(receiver); } catch (Exception ignore) {}
            return new android.util.Pair<>(false, "系统拒绝发起配对(createBond 返回 false)");
        }
        try { latch.await(timeoutSec, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignore) {}
        try { ctx.unregisterReceiver(receiver); } catch (Exception ignore) {}
        return new android.util.Pair<>(ok[0], reason[0]);
    }

    /** 已配对且强制重绑：先 removeBond 等 NONE，再重新配对弹 passkey。 */
    private android.util.Pair<Boolean, String> removeBondAndWait(BluetoothDevice device, String mac, Context ctx, int timeoutSec) {
        final java.util.concurrent.CountDownLatch removed = new java.util.concurrent.CountDownLatch(1);
        BroadcastReceiver rem = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                if (!BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(i.getAction())) return;
                BluetoothDevice dev = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (dev == null || !mac.equals(dev.getAddress())) return;
                int st = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE);
                if (st == BluetoothDevice.BOND_NONE) {
                    try { c.unregisterReceiver(this); } catch (Exception ignore) {}
                    removed.countDown();
                }
            }
        };
        ctx.registerReceiver(rem, new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED));
        try {
            java.lang.reflect.Method m = device.getClass().getMethod("removeBond");
            m.invoke(device);
            Log.i(TAG, "removeBond 调用成功 mac=" + mac);
        } catch (Exception e) {
            try { ctx.unregisterReceiver(rem); } catch (Exception ignore) {}
            Log.e(TAG, "removeBond 失败，退而直接配对 mac=" + mac, e);
            return createBondAndWait(device, mac, ctx, timeoutSec);
        }
        try { removed.await(10, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignore) {}
        return createBondAndWait(device, mac, ctx, timeoutSec);
    }

    /** 单次最终回调（不再依赖 keepAlive）。 */
    private void invokeOnce(UniJSCallback callback, boolean ok, String message) {
        if (callback == null) return;
        JSONObject o = new JSONObject();
        try { o.put("ok", ok); o.put("message", message); } catch (Exception e) { /* ignore */ }
        Log.i(TAG, "createBond 最终 -> ok=" + ok + " msg=" + message);
        callback.invoke(o);
    }

    /** 发起配对：先无参 createBond()（JS 已断开 GATT 时最稳），失败再反射 TRANSPORT_LE（API31+，针对双模传输歧义）。 */
    private boolean doCreateBond(BluetoothDevice device) {
        boolean r = device.createBond();
        Log.i(TAG, "doCreateBond: createBond() -> " + r);
        if (r) return true;
        try {
            java.lang.reflect.Method m = device.getClass().getMethod("createBond", int.class);
            Object ret = m.invoke(device, 2 /* BluetoothDevice.TRANSPORT_LE */);
            if (ret instanceof Boolean) {
                Log.i(TAG, "doCreateBond: createBond(TRANSPORT_LE) -> " + ret);
                return (Boolean) ret;
            }
        } catch (Exception e) {
            Log.w(TAG, "doCreateBond: TRANSPORT_LE 不可用，保持失败", e);
        }
        return false;
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
