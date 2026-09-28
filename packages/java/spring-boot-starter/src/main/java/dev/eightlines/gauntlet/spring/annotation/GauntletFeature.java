package dev.eightlines.gauntlet.spring.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GauntletFeature {
  String id();

  String label();

  String parentId() default "";

  int order() default 0;
}
