package dev.eightlines.gauntlet.spring.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target({})
public @interface SubjectPlacement {
  String subjectType();

  PlacementBinding[] bindings() default {};
}
