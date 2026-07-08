package io.dcloud.feature.uniapp.bridge;

/**
 * 仅用于本地编译 KeyGo 插件时的「编译期桩」，不会被打进 aar。
 * 运行时由 App 内的真实 uni-app SDK 提供。
 */
public interface UniJSCallback {
    void invoke(Object data);
    void invokeAndKeepAlive(Object data);
    void success(Object data);
    void error(Object data);
    boolean isCallbackInvoked();
}
