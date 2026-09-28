package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.eightlines.gauntlet.core.json.JsonOwnership;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.spring.catalog.RecordSchemaFactory;
import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.lang.annotation.Retention;
import java.lang.annotation.Target;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class RecordSchemaFactoryTest {
  private final RecordSchemaFactory factory = new RecordSchemaFactory();

  @Test
  void recordSchemaUsesRequiredNullableAndPortableConstraintShapes() {
    var schema = factory.schemaFor(FinalizeInput.class);
    var java = castMap(JsonOwnership.toJava(schema));
    var properties = castMap(java.get("properties"));
    var applicationId = castMap(properties.get("applicationId"));
    var reason = castMap(properties.get("reason"));
    var labels = castMap(properties.get("labels"));

    assertThat(java.get("type")).isEqualTo("object");
    assertThat(java.get("additionalProperties")).isEqualTo(false);
    assertThat(castList(java.get("required"))).containsExactly("applicationId", "confirmationCode");
    assertThat(applicationId).containsEntry("type", "string").containsEntry("format", "uuid");
    assertThat(castList(reason.get("type"))).containsExactly("string", "null");
    assertThat(castMap(labels.get("items"))).containsEntry("type", "string");
  }

  @Test
  void unsupportedRecordsAndNonPortablePatternsFailClosed() {
    assertThatThrownBy(() -> factory.schemaFor(UnsupportedInput.class))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageNotContaining("java.time");
    assertThatThrownBy(() -> factory.schemaFor(NonPortablePatternInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(NestedListInput.class))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void generatedSchemaCarriesCharacterAndIntegralConstraints() {
    var schema = factory.schemaFor(PortableBoundariesInput.class);
    var java = castMap(JsonOwnership.toJava(schema));
    var properties = castMap(java.get("properties"));

    assertThat(castMap(properties.get("primitiveCharacter")))
        .containsEntry("type", "string")
        .containsEntry("minLength", 1L)
        .containsEntry("maxLength", 1L)
        .containsKey("pattern");
    assertThat(castMap(properties.get("boxedCharacter")))
        .containsEntry("type", List.of("string", "null"))
        .containsEntry("minLength", 1L)
        .containsEntry("maxLength", 1L);
    assertBounds(properties, "tiny", -128L, 127L);
    assertBounds(properties, "small", -32_768L, 32_767L);
    assertBounds(properties, "regular", -2_147_483_648L, 2_147_483_647L);
    assertBounds(properties, "large", -9_007_199_254_740_991L, 9_007_199_254_740_991L);

    var validator = new NetworkntSchemaValidator();
    assertThat(
            validator.validate(
                schema,
                JsonOwnership.object(
                    Map.of(
                        "primitiveCharacter",
                        "😀",
                        "tiny",
                        0,
                        "small",
                        0,
                        "regular",
                        0,
                        "large",
                        0))))
        .isNotEmpty();
  }

  @Test
  void notBlankFailsClosedBecauseThePortablePatternProfileCannotExpressItsDomain() {
    assertThatThrownBy(() -> factory.schemaFor(NotBlankInput.class))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void floatAndConstraintsOnIncompatibleDomainsFailClosed() {
    assertThatThrownBy(() -> factory.schemaFor(FloatInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(SizeOnNumberInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(PatternOnNumberInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(MinOnStringInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(NotBlankOnNumberInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(NotEmptyOnNumberInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(UnsupportedConstraintInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(ContainerConstraintInput.class))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void patternFlagsAndPrecisionLosingDecimalBoundsFailClosed() {
    assertThatThrownBy(() -> factory.schemaFor(FlaggedPatternInput.class))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> factory.schemaFor(PrecisionLosingDecimalInput.class))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void fieldOnlyJakartaConstraintOnTheGeneratedRecordFieldFailsClosed() throws Exception {
    assertThat(FieldOnlyConstraintInput.class.getRecordComponents()[0].getAnnotations()).isEmpty();
    assertThat(
            FieldOnlyConstraintInput.class
                .getDeclaredField("value")
                .getAnnotation(FieldOnlyConstraint.class))
        .isNotNull();

    assertThatThrownBy(() -> factory.schemaFor(FieldOnlyConstraintInput.class))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("unsupported Jakarta constraint");
  }

  @Test
  void exactlyRepresentableDecimalBoundsRemainExact() {
    var schema = factory.schemaFor(ExactDecimalInput.class);
    var properties = castMap(castMap(JsonOwnership.toJava(schema)).get("properties"));
    var amount = castMap(properties.get("amount"));

    assertThat(amount.get("minimum")).isEqualTo(0.125d);
    assertThat(amount.get("exclusiveMaximum")).isEqualTo(1.5d);
  }

  private static void assertBounds(
      java.util.Map<String, Object> properties, String name, long minimum, long maximum) {
    assertThat(castMap(properties.get(name)))
        .containsEntry("minimum", minimum)
        .containsEntry("maximum", maximum);
  }

  @SuppressWarnings("unchecked")
  private static java.util.Map<String, Object> castMap(Object value) {
    return (java.util.Map<String, Object>) value;
  }

  @SuppressWarnings("unchecked")
  private static List<Object> castList(Object value) {
    return (List<Object>) value;
  }

  private record FinalizeInput(
      @NotNull UUID applicationId,
      @NotNull @Pattern(regexp = "^[0-9]{6}$") String confirmationCode,
      String reason,
      List<String> labels) {}

  private record UnsupportedInput(java.time.Instant value) {}

  private record NonPortablePatternInput(@Pattern(regexp = "(?=x)x") String value) {}

  private record NestedListInput(List<List<String>> values) {}

  private record PortableBoundariesInput(
      char primitiveCharacter,
      Character boxedCharacter,
      byte tiny,
      short small,
      int regular,
      long large) {}

  private record NotBlankInput(@NotBlank String value) {}

  private record FlaggedPatternInput(
      @Pattern(regexp = "^[a-z]+$", flags = Pattern.Flag.CASE_INSENSITIVE) String value) {}

  private record PrecisionLosingDecimalInput(
      @DecimalMin("0.10000000000000001") BigDecimal amount) {}

  private record ExactDecimalInput(
      @DecimalMin("0.125") @DecimalMax(value = "1.5", inclusive = false) BigDecimal amount) {}

  private record FloatInput(float value) {}

  private record SizeOnNumberInput(@Size(min = 1) Integer value) {}

  private record PatternOnNumberInput(@Pattern(regexp = "1") Integer value) {}

  private record MinOnStringInput(@Min(1) String value) {}

  private record NotBlankOnNumberInput(@NotBlank Integer value) {}

  private record NotEmptyOnNumberInput(@NotEmpty Integer value) {}

  private record UnsupportedConstraintInput(@Email String value) {}

  private record ContainerConstraintInput(List<@NotBlank String> values) {}

  @Constraint(validatedBy = {})
  @Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
  @Target(java.lang.annotation.ElementType.FIELD)
  private @interface FieldOnlyConstraint {
    String message() default "field-only";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};
  }

  private record FieldOnlyConstraintInput(@FieldOnlyConstraint String value) {}
}
