package io.dcloud.feature.uniapp.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 仅用于本地编译 KeyGo 插件时的「编译期桩」，不会被打进 aar。
 * 运行时由 App 内的真实 uni-app SDK 提供。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface UniJSMethod {
    boolean uiThread() default true;
}
