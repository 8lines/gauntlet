package dev.eightlines.gauntlet.spring.annotation;

import dev.eightlines.gauntlet.core.model.Idempotency;
import dev.eightlines.gauntlet.core.model.OperationImpact;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface GauntletOperation {
  String id();

  String featureId();

  String label();

  Class<?> input();

  String description() default "";

  String[] tags() default {};

  int order() default 0;

  OperationImpact impact() default OperationImpact.READ;

  boolean confirmationRequired() default false;

  boolean dryRunSupported() default false;

  Idempotency idempotency() default Idempotency.NONE;

  boolean cancellationSupported() default false;

  int timeoutSeconds() default -1;

  String concurrency() default "";

  String[] requiredProfiles() default {"tc-schema-core@1"};

  String[] requiredCapabilities() default {};

  String inputSchemaResource() default "";

  String definitionResource() default "";

  boolean globalPlacement() default false;

  SubjectPlacement[] subjectPlacements() default {};
}
