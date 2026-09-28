package dev.eightlines.gauntlet.spring;

import dev.eightlines.gauntlet.core.run.InMemoryExecutionCoordinator;
import dev.eightlines.gauntlet.core.run.InMemoryRunStore;
import dev.eightlines.gauntlet.core.schema.NetworkntSchemaValidator;
import dev.eightlines.gauntlet.core.schema.SchemaValidator;
import dev.eightlines.gauntlet.core.spi.CapabilityProvider;
import dev.eightlines.gauntlet.core.spi.ExecutionCoordinator;
import dev.eightlines.gauntlet.core.spi.FileReferenceValidator;
import dev.eightlines.gauntlet.core.spi.RunStore;
import dev.eightlines.gauntlet.spring.capability.CancelRunEndpoint;
import dev.eightlines.gauntlet.spring.capability.RunEventsEndpoint;
import dev.eightlines.gauntlet.spring.capability.SessionLaunchEndpoint;
import dev.eightlines.gauntlet.spring.capability.SpringCapabilityRegistry;
import dev.eightlines.gauntlet.spring.capability.UploadEndpoint;
import dev.eightlines.gauntlet.spring.catalog.IdempotencySecret;
import dev.eightlines.gauntlet.spring.catalog.RecordSchemaFactory;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import dev.eightlines.gauntlet.spring.http.AdapterEnabledGate;
import dev.eightlines.gauntlet.spring.http.AdapterV1Controller;
import dev.eightlines.gauntlet.spring.http.CapabilityController;
import dev.eightlines.gauntlet.spring.http.CapabilityRunValidator;
import dev.eightlines.gauntlet.spring.http.CatalogCapabilityRunValidator;
import dev.eightlines.gauntlet.spring.http.ProblemResponseFactory;
import dev.eightlines.gauntlet.spring.http.ProtocolExceptionHandler;
import dev.eightlines.gauntlet.spring.http.RawAdapterPrefixFilter;
import dev.eightlines.gauntlet.spring.http.RequestEnvelopeValidator;
import jakarta.validation.Validator;
import java.time.Clock;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import tools.jackson.databind.ObjectMapper;

@AutoConfiguration
@EnableConfigurationProperties(GauntletProperties.class)
@Import({AdapterV1Controller.class, CapabilityController.class, ProtocolExceptionHandler.class})
public class GauntletAutoConfiguration {
  @Bean
  @ConditionalOnMissingBean
  public SchemaValidator gauntletSchemaValidator() {
    return new NetworkntSchemaValidator();
  }

  @Bean
  @ConditionalOnMissingBean
  public RunStore gauntletRunStore() {
    return new InMemoryRunStore();
  }

  @Bean
  @ConditionalOnMissingBean
  public ExecutionCoordinator gauntletExecutionCoordinator() {
    return new InMemoryExecutionCoordinator();
  }

  @Bean
  @ConditionalOnMissingBean(CancelRunEndpoint.class)
  public CancelRunEndpoint gauntletCoreCancellation(ObjectProvider<SpringAdapterCatalog> catalogs) {
    return runId -> catalogs.getObject().cancelRun(runId);
  }

  @Bean
  @ConditionalOnMissingBean
  public RecordSchemaFactory gauntletRecordSchemaFactory() {
    return new RecordSchemaFactory();
  }

  @Bean
  @ConditionalOnMissingBean
  public SpringCapabilityRegistry gauntletCapabilityRegistry(
      ObjectProvider<CancelRunEndpoint> cancellation,
      ObjectProvider<RunEventsEndpoint> events,
      ObjectProvider<UploadEndpoint> uploads,
      ObjectProvider<SessionLaunchEndpoint> sessions,
      ObjectProvider<CapabilityProvider> generic) {
    return new SpringCapabilityRegistry(
        cancellation.orderedStream().toList(),
        events.orderedStream().toList(),
        uploads.orderedStream().toList(),
        sessions.orderedStream().toList(),
        generic.orderedStream().toList());
  }

  @Bean
  @ConditionalOnMissingBean
  public SpringAdapterCatalog gauntletAdapterCatalog(
      GauntletProperties properties,
      SpringCapabilityRegistry capabilities,
      ListableBeanFactory beanFactory,
      RecordSchemaFactory recordSchemas,
      ObjectMapper objectMapper,
      Validator beanValidator,
      SchemaValidator schemaValidator,
      RunStore runStore,
      ExecutionCoordinator executionCoordinator,
      ObjectProvider<FileReferenceValidator> fileReferenceValidators,
      IdempotencySecret idempotencySecret,
      Clock clock) {
    return new SpringAdapterCatalog(
        properties,
        capabilities,
        beanFactory,
        recordSchemas,
        objectMapper,
        beanValidator,
        schemaValidator,
        runStore,
        executionCoordinator,
        fileReferenceValidators.getIfUnique(),
        idempotencySecret,
        clock);
  }

  @Bean
  @ConditionalOnMissingBean
  public IdempotencySecret gauntletIdempotencySecret(
      GauntletProperties properties, Environment environment) {
    String configured = environment.getProperty("gauntlet.idempotency-secret");
    if (configured != null && !configured.isBlank()) {
      return IdempotencySecret.configured(configured);
    }
    if (properties.enabled()) {
      throw new IllegalArgumentException("enabled adapter requires gauntlet.idempotency-secret");
    }
    return IdempotencySecret.disabledEphemeral();
  }

  @Bean
  @ConditionalOnMissingBean
  public AdapterEnabledGate gauntletEnabledGate(GauntletProperties properties) {
    return new AdapterEnabledGate(properties);
  }

  @Bean
  @ConditionalOnMissingBean
  public Clock gauntletClock() {
    return Clock.systemUTC();
  }

  @Bean
  @ConditionalOnMissingBean
  public RequestEnvelopeValidator gauntletRequestEnvelopeValidator() {
    return new RequestEnvelopeValidator();
  }

  @Bean
  @ConditionalOnMissingBean
  public ProblemResponseFactory gauntletProblemResponseFactory() {
    return new ProblemResponseFactory();
  }

  @Bean
  public CapabilityRunValidator gauntletCapabilityRunValidator(
      SpringAdapterCatalog catalog, ProblemResponseFactory problems) {
    return new CatalogCapabilityRunValidator(catalog, problems);
  }

  @Bean
  public FilterRegistrationBean<RawAdapterPrefixFilter> gauntletRawPrefixFilter(
      AdapterEnabledGate enabled,
      SpringCapabilityRegistry capabilities,
      ProblemResponseFactory problems) {
    FilterRegistrationBean<RawAdapterPrefixFilter> registration =
        new FilterRegistrationBean<>(new RawAdapterPrefixFilter(enabled, capabilities, problems));
    registration.addUrlPatterns("/*");
    registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
    registration.setName("gauntletRawPrefixFilter");
    return registration;
  }
}
