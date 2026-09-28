package dev.eightlines.gauntlet.spring.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GauntletDataSource {
  String id();

  String label();

  String description() default "";

  boolean search() default true;

  int defaultLimit() default 20;

  int maxLimit() default 100;

  String dependencySchemaResource() default "";

  String contextSchemaResource() default "";

  String definitionResource() default "";
}
