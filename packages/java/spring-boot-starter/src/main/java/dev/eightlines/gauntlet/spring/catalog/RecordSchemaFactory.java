package dev.eightlines.gauntlet.spring.catalog;

import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.schema.TcSchemaCore;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Negative;
import jakarta.validation.constraints.NegativeOrZero;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedParameterizedType;
import java.lang.reflect.AnnotatedType;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Generates closed JSON Schemas for the portable record input subset. */
public final class RecordSchemaFactory {
  private static final String BMP_SCALAR_PATTERN =
      "^[^" + scalar(0x10000) + "-" + scalar(0x10ffff) + "]$";
  private static final Set<Class<? extends Annotation>> SUPPORTED_CONSTRAINTS =
      Set.of(
          NotNull.class,
          NotEmpty.class,
          Size.class,
          Pattern.class,
          Min.class,
          Max.class,
          DecimalMin.class,
          DecimalMax.class,
          Positive.class,
          PositiveOrZero.class,
          Negative.class,
          NegativeOrZero.class);

  public JsonObject schemaFor(Class<?> type) {
    if (type == null || !type.isRecord()) {
      throw new IllegalArgumentException("operation input must be a Java record");
    }
    assertSupportedConstraints(type.getAnnotations());
    var properties = new LinkedHashMap<String, Object>();
    var required = new ArrayList<String>();
    for (RecordComponent component : type.getRecordComponents()) {
      assertSupportedConstraints(component);
      boolean mandatory = isRequired(component);
      var property = schemaForType(component.getGenericType(), !mandatory);
      applyConstraints(component, property);
      properties.put(component.getName(), property);
      if (mandatory) required.add(component.getName());
    }

    var document = new LinkedHashMap<String, Object>();
    document.put("$schema", "https://json-schema.org/draft/2020-12/schema");
    document.put("type", "object");
    if (!required.isEmpty()) document.put("required", List.copyOf(required));
    document.put("properties", properties);
    document.put("additionalProperties", false);
    JsonObject schema = JsonOwnership.object(document);
    TcSchemaCore.assertValid(schema, true);
    return schema;
  }

  private static LinkedHashMap<String, Object> schemaForType(Type type, boolean nullable) {
    var schema = new LinkedHashMap<String, Object>();
    if (type instanceof Class<?> raw) {
      if (raw == String.class || raw == Character.class || raw == char.class) {
        putType(schema, "string", nullable);
        if (raw == Character.class || raw == char.class) {
          schema.put("minLength", 1);
          schema.put("maxLength", 1);
          schema.put("pattern", BMP_SCALAR_PATTERN);
        }
      } else if (raw == UUID.class) {
        putType(schema, "string", nullable);
        schema.put("format", "uuid");
      } else if (raw == boolean.class || raw == Boolean.class) {
        putType(schema, "boolean", nullable);
      } else if (raw == byte.class
          || raw == Byte.class
          || raw == short.class
          || raw == Short.class
          || raw == int.class
          || raw == Integer.class
          || raw == long.class
          || raw == Long.class) {
        putType(schema, "integer", nullable);
        applyIntegralBounds(raw, schema);
      } else if (raw == double.class || raw == Double.class || raw == BigDecimal.class) {
        putType(schema, "number", nullable);
      } else if (raw.isEnum()) {
        putType(schema, "string", nullable);
        schema.put(
            "enum",
            Arrays.stream(raw.getEnumConstants()).map(value -> ((Enum<?>) value).name()).toList());
      } else {
        throw new IllegalArgumentException("unsupported record component type");
      }
      return schema;
    }
    if (type instanceof ParameterizedType parameterized
        && parameterized.getRawType() == List.class
        && parameterized.getActualTypeArguments().length == 1
        && parameterized.getActualTypeArguments()[0] instanceof Class<?>) {
      putType(schema, "array", nullable);
      schema.put("items", schemaForType(parameterized.getActualTypeArguments()[0], false));
      return schema;
    }
    throw new IllegalArgumentException("unsupported record component type");
  }

  private static void putType(Map<String, Object> schema, String type, boolean nullable) {
    schema.put("type", nullable ? List.of(type, "null") : type);
  }

  private static boolean isRequired(RecordComponent component) {
    return component.getType().isPrimitive()
        || annotation(component, NotNull.class) != null
        || annotation(component, NotEmpty.class) != null;
  }

  private static void applyConstraints(
      RecordComponent component, LinkedHashMap<String, Object> schema) {
    assertConstraintDomains(component);
    Size size = annotation(component, Size.class);
    if (size != null) {
      boolean array = "array".equals(primaryType(schema));
      putStrongerMinimum(schema, array ? "minItems" : "minLength", size.min());
      if (size.max() < Integer.MAX_VALUE) {
        putStrongerMaximum(schema, array ? "maxItems" : "maxLength", size.max());
      }
    }
    if (annotation(component, NotEmpty.class) != null) {
      putStrongerMinimum(schema, "array".equals(primaryType(schema)) ? "minItems" : "minLength", 1);
    }
    Pattern pattern = annotation(component, Pattern.class);
    if (pattern != null && pattern.flags().length != 0) {
      throw new IllegalArgumentException("pattern flags are not portable");
    }
    if (pattern != null) schema.put("pattern", pattern.regexp());
    applyNumericConstraints(component, schema);
    assertRangeIsSatisfiable(schema);
  }

  private static void applyIntegralBounds(Class<?> raw, LinkedHashMap<String, Object> schema) {
    if (raw == byte.class || raw == Byte.class) {
      schema.put("minimum", (long) Byte.MIN_VALUE);
      schema.put("maximum", (long) Byte.MAX_VALUE);
    } else if (raw == short.class || raw == Short.class) {
      schema.put("minimum", (long) Short.MIN_VALUE);
      schema.put("maximum", (long) Short.MAX_VALUE);
    } else if (raw == int.class || raw == Integer.class) {
      schema.put("minimum", (long) Integer.MIN_VALUE);
      schema.put("maximum", (long) Integer.MAX_VALUE);
    } else {
      schema.put("minimum", -9_007_199_254_740_991L);
      schema.put("maximum", 9_007_199_254_740_991L);
    }
  }

  private static void applyNumericConstraints(
      RecordComponent component, LinkedHashMap<String, Object> schema) {
    Min min = annotation(component, Min.class);
    Max max = annotation(component, Max.class);
    DecimalMin decimalMin = annotation(component, DecimalMin.class);
    DecimalMax decimalMax = annotation(component, DecimalMax.class);
    if (min != null) narrowLower(schema, BigDecimal.valueOf(min.value()), true);
    if (max != null) narrowUpper(schema, BigDecimal.valueOf(max.value()), true);
    if (decimalMin != null)
      narrowLower(schema, new BigDecimal(decimalMin.value()), decimalMin.inclusive());
    if (decimalMax != null)
      narrowUpper(schema, new BigDecimal(decimalMax.value()), decimalMax.inclusive());
    if (annotation(component, Positive.class) != null) narrowLower(schema, BigDecimal.ZERO, false);
    if (annotation(component, PositiveOrZero.class) != null)
      narrowLower(schema, BigDecimal.ZERO, true);
    if (annotation(component, Negative.class) != null) narrowUpper(schema, BigDecimal.ZERO, false);
    if (annotation(component, NegativeOrZero.class) != null)
      narrowUpper(schema, BigDecimal.ZERO, true);
  }

  private static void narrowLower(
      LinkedHashMap<String, Object> schema, BigDecimal candidate, boolean inclusive) {
    Bound current = lowerBound(schema);
    if (current == null
        || candidate.compareTo(current.value()) > 0
        || candidate.compareTo(current.value()) == 0 && !inclusive && current.inclusive()) {
      schema.remove("minimum");
      schema.remove("exclusiveMinimum");
      schema.put(inclusive ? "minimum" : "exclusiveMinimum", candidate);
    }
  }

  private static void narrowUpper(
      LinkedHashMap<String, Object> schema, BigDecimal candidate, boolean inclusive) {
    Bound current = upperBound(schema);
    if (current == null
        || candidate.compareTo(current.value()) < 0
        || candidate.compareTo(current.value()) == 0 && !inclusive && current.inclusive()) {
      schema.remove("maximum");
      schema.remove("exclusiveMaximum");
      schema.put(inclusive ? "maximum" : "exclusiveMaximum", candidate);
    }
  }

  private static Bound lowerBound(Map<String, Object> schema) {
    if (schema.get("minimum") instanceof Number number) return new Bound(decimal(number), true);
    if (schema.get("exclusiveMinimum") instanceof Number number)
      return new Bound(decimal(number), false);
    return null;
  }

  private static Bound upperBound(Map<String, Object> schema) {
    if (schema.get("maximum") instanceof Number number) return new Bound(decimal(number), true);
    if (schema.get("exclusiveMaximum") instanceof Number number)
      return new Bound(decimal(number), false);
    return null;
  }

  private static BigDecimal decimal(Number number) {
    return number instanceof BigDecimal value ? value : new BigDecimal(number.toString());
  }

  private static void assertRangeIsSatisfiable(Map<String, Object> schema) {
    Bound lower = lowerBound(schema);
    Bound upper = upperBound(schema);
    if (lower == null || upper == null) return;
    int comparison = lower.value().compareTo(upper.value());
    if (comparison > 0 || comparison == 0 && (!lower.inclusive() || !upper.inclusive())) {
      throw new IllegalArgumentException("numeric constraints are unsatisfiable");
    }
  }

  private static void putStrongerMinimum(
      Map<String, Object> schema, String keyword, int candidate) {
    Object current = schema.get(keyword);
    if (!(current instanceof Number number) || candidate > number.intValue()) {
      schema.put(keyword, candidate);
    }
    assertLengthIsSatisfiable(schema, keyword);
  }

  private static void putStrongerMaximum(
      Map<String, Object> schema, String keyword, int candidate) {
    Object current = schema.get(keyword);
    if (!(current instanceof Number number) || candidate < number.intValue()) {
      schema.put(keyword, candidate);
    }
    assertLengthIsSatisfiable(schema, keyword);
  }

  private static void assertLengthIsSatisfiable(Map<String, Object> schema, String keyword) {
    String prefix = keyword.endsWith("Items") ? "Items" : "Length";
    Object minimum = schema.get("min" + prefix);
    Object maximum = schema.get("max" + prefix);
    if (minimum instanceof Number min
        && maximum instanceof Number max
        && min.longValue() > max.longValue()) {
      throw new IllegalArgumentException("size constraints are unsatisfiable");
    }
  }

  private record Bound(BigDecimal value, boolean inclusive) {}

  private static void assertConstraintDomains(RecordComponent component) {
    Class<?> raw = component.getType();
    boolean string = raw == String.class;
    boolean array = raw == List.class;
    boolean numeric =
        raw == byte.class
            || raw == Byte.class
            || raw == short.class
            || raw == Short.class
            || raw == int.class
            || raw == Integer.class
            || raw == long.class
            || raw == Long.class
            || raw == double.class
            || raw == Double.class
            || raw == BigDecimal.class;
    if (annotation(component, Size.class) != null && !string && !array
        || annotation(component, NotEmpty.class) != null && !string && !array
        || annotation(component, Pattern.class) != null && !string
        || hasNumericConstraint(component) && !numeric) {
      throw new IllegalArgumentException("constraint is not portable for record component type");
    }
  }

  private static boolean hasNumericConstraint(RecordComponent component) {
    return annotation(component, Min.class) != null
        || annotation(component, Max.class) != null
        || annotation(component, DecimalMin.class) != null
        || annotation(component, DecimalMax.class) != null
        || annotation(component, Positive.class) != null
        || annotation(component, PositiveOrZero.class) != null
        || annotation(component, Negative.class) != null
        || annotation(component, NegativeOrZero.class) != null;
  }

  private static void assertSupportedConstraints(RecordComponent component) {
    assertSupportedConstraints(component.getAnnotations());
    assertSupportedConstraints(component.getAccessor().getAnnotations());
    assertSupportedConstraints(component.getAnnotatedType().getAnnotations());
    assertNoContainerElementConstraints(component.getAnnotatedType());
    try {
      var field = component.getDeclaringRecord().getDeclaredField(component.getName());
      assertSupportedConstraints(field.getAnnotations());
      assertSupportedConstraints(field.getAnnotatedType().getAnnotations());
      assertNoContainerElementConstraints(field.getAnnotatedType());
    } catch (NoSuchFieldException exception) {
      throw new IllegalArgumentException(
          "record component backing field is unavailable", exception);
    }
  }

  private static void assertNoContainerElementConstraints(AnnotatedType type) {
    if (!(type instanceof AnnotatedParameterizedType parameterized)) return;
    for (AnnotatedType argument : parameterized.getAnnotatedActualTypeArguments()) {
      for (Annotation annotation : argument.getAnnotations()) {
        if (isConstraint(annotation.annotationType())) {
          throw new IllegalArgumentException("container element constraints are not portable");
        }
      }
      assertNoContainerElementConstraints(argument);
    }
  }

  private static void assertSupportedConstraints(Annotation[] annotations) {
    for (Annotation annotation : annotations) {
      Class<? extends Annotation> type = annotation.annotationType();
      if (isConstraint(type) && !SUPPORTED_CONSTRAINTS.contains(type)
          || isConstraintContainer(type)) {
        throw new IllegalArgumentException("unsupported Jakarta constraint");
      }
    }
  }

  private static boolean isConstraint(Class<? extends Annotation> type) {
    return type.isAnnotationPresent(jakarta.validation.Constraint.class);
  }

  private static boolean isConstraintContainer(Class<? extends Annotation> type) {
    try {
      Class<?> valueType = type.getDeclaredMethod("value").getReturnType();
      return valueType.isArray()
          && valueType.componentType().isAnnotation()
          && valueType.componentType().isAnnotationPresent(jakarta.validation.Constraint.class);
    } catch (NoSuchMethodException exception) {
      return false;
    }
  }

  private static String scalar(int codePoint) {
    return Character.toString(codePoint);
  }

  private static String primaryType(Map<String, Object> schema) {
    Object value = schema.get("type");
    if (value instanceof String string) return string;
    return (String) ((List<?>) value).getFirst();
  }

  private static <A extends Annotation> A annotation(
      RecordComponent component, Class<A> annotationType) {
    A direct = component.getAnnotation(annotationType);
    if (direct != null) return direct;
    A accessor = component.getAccessor().getAnnotation(annotationType);
    if (accessor != null) return accessor;
    return component.getAnnotatedType().getAnnotation(annotationType);
  }
}
