package io.dcloud.feature.uniapp.common;

/**
 * 仅用于本地编译 KeyGo 插件时的「编译期桩」，不会被打进 aar。
 * 运行时由 App 内的真实 uni-app SDK 提供（其真实实现继承 Weex WXModule）。
 * 注意：本插件通过反射获取 ApplicationContext，不依赖 mWXSDKInstance / mUniSDKInstance
 * 字段名，因此此桩类无需声明任何字段。
 */
public class UniModule {
}
