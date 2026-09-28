package dev.eightlines.gauntlet.spring;

import static org.assertj.core.api.Assertions.assertThat;

import dev.eightlines.gauntlet.core.spi.CapabilityProvider;
import dev.eightlines.gauntlet.spring.capability.CancelRunEndpoint;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import java.util.List;
import org.junit.jupiter.api.Test;

class SpringCapabilityRegistryTest {
  @Test
  void duplicateCoreProvidersAreDiagnosedAndNotAdvertised() {
    CancelRunEndpoint first = runId -> null;
    CancelRunEndpoint second = runId -> null;

    var registry =
        new SpringCapabilityRegistry(
            List.of(first, second), List.of(), List.of(), List.of(), List.of());

    assertThat(registry.ids()).doesNotContain(SpringCapabilityRegistry.CANCELLATION);
    assertThat(registry.cancellation()).isEmpty();
    assertThat(registry.diagnostics())
        .extracting(diagnostic -> diagnostic.code())
        .containsExactly("duplicate-capability-provider");
  }

  @Test
  void genericProvidersCannotClaimCoreIdsAndFutureIdsRequireExactlyOneProvider() {
    CapabilityProvider core = () -> SpringCapabilityRegistry.UPLOADS;
    CapabilityProvider firstFuture = () -> "tc-future@1";
    CapabilityProvider secondFuture = () -> "tc-future@1";

    var accepted =
        new SpringCapabilityRegistry(
            List.of(), List.of(), List.of(), List.of(), List.of(firstFuture));
    var rejected =
        new SpringCapabilityRegistry(
            List.of(), List.of(), List.of(), List.of(), List.of(core, firstFuture, secondFuture));

    assertThat(accepted.ids()).containsExactly("tc-future@1");
    assertThat(rejected.ids()).isEmpty();
    assertThat(rejected.diagnostics())
        .extracting(diagnostic -> diagnostic.code())
        .containsExactlyInAnyOrder(
            "core-capability-provider-mismatch", "duplicate-capability-provider");
  }
}
