package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.core.json.CanonicalJson;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.model.Problem;
import dev.eightlines.gauntlet.core.model.Run;
import dev.eightlines.gauntlet.spring.catalog.SpringAdapterCatalog;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/_gauntlet/v1")
public final class AdapterV1Controller {
  private final SpringAdapterCatalog catalog;
  private final RequestEnvelopeValidator requests;
  private final ProblemResponseFactory problems;
  private final CapabilityRunValidator runValidator;

  public AdapterV1Controller(
      SpringAdapterCatalog catalog,
      RequestEnvelopeValidator requests,
      ProblemResponseFactory problems,
      CapabilityRunValidator runValidator) {
    this.catalog = catalog;
    this.requests = requests;
    this.problems = problems;
    this.runValidator = runValidator;
  }

  @GetMapping("/health")
  public ResponseEntity<byte[]> health() {
    return json(catalog.health().toProtocolMap(), 200);
  }

  @GetMapping("/manifest")
  public ResponseEntity<byte[]> manifest(
      @RequestHeader(name = HttpHeaders.IF_NONE_MATCH, required = false) String ifNoneMatch) {
    var manifest = catalog.manifest();
    return revisionResponse(manifest.toProtocolMap(), manifest.manifestRevision(), ifNoneMatch);
  }

  @GetMapping("/operations/{operationId}")
  public ResponseEntity<byte[]> operation(
      @PathVariable(name = "operationId") String operationId,
      @RequestHeader(name = HttpHeaders.IF_NONE_MATCH, required = false) String ifNoneMatch) {
    var operation = catalog.operation(operationId);
    if (operation.isEmpty()) {
      return problems.response(
          ProblemResponseFactory.problem("operation-not-found", "Operation not found", 404));
    }
    var value = operation.orElseThrow();
    return revisionResponse(value.toProtocolMap(), value.revision(), ifNoneMatch);
  }

  @PostMapping("/operations/{operationId}/runs")
  public ResponseEntity<byte[]> createRun(
      @PathVariable(name = "operationId") String operationId,
      HttpServletRequest servletRequest,
      @RequestBody(required = false) byte[] body) {
    Optional<Problem> unavailable = catalog.operationProblem(operationId);
    if (unavailable.isPresent()) return problems.response(unavailable.orElseThrow());
    JsonObject envelope = requests.parse(servletRequest, body);
    var result = catalog.createRun(operationId, requests.createRun(envelope));
    if (!result.isSuccess()) return problems.response(result.problem());
    Run run =
        runValidator.validate(result.run(), null, operationId, CapabilityRunValidator.Origin.STORE);
    return json(run.toProtocolMap(), run.state().terminal() ? 201 : 202);
  }

  @GetMapping("/runs/{runId}")
  public ResponseEntity<byte[]> run(@PathVariable(name = "runId") String runId) {
    Optional<Run> run = catalog.run(runId);
    return run.<ResponseEntity<byte[]>>map(
            value ->
                json(
                    runValidator
                        .validate(value, runId, null, CapabilityRunValidator.Origin.STORE)
                        .toProtocolMap(),
                    200))
        .orElseGet(
            () ->
                problems.response(
                    ProblemResponseFactory.problem("run-not-found", "Run not found", 404)));
  }

  @PostMapping("/data-sources/{dataSourceId}/query")
  public ResponseEntity<byte[]> query(
      @PathVariable(name = "dataSourceId") String dataSourceId,
      HttpServletRequest servletRequest,
      @RequestBody(required = false) byte[] body)
      throws Exception {
    if (catalog.dataSourceDefinition(dataSourceId).isEmpty()) {
      return problems.response(
          ProblemResponseFactory.problem("data-source-not-found", "Data source not found", 404));
    }
    JsonObject envelope = requests.parse(servletRequest, body);
    return json(
        catalog.queryDataSource(dataSourceId, requests.dataSourceQuery(envelope)).toProtocolMap(),
        200);
  }

  @PostMapping("/data-sources/{dataSourceId}/resolve")
  public ResponseEntity<byte[]> resolve(
      @PathVariable(name = "dataSourceId") String dataSourceId,
      HttpServletRequest servletRequest,
      @RequestBody(required = false) byte[] body)
      throws Exception {
    if (catalog.dataSourceDefinition(dataSourceId).isEmpty()) {
      return problems.response(
          ProblemResponseFactory.problem("data-source-not-found", "Data source not found", 404));
    }
    JsonObject envelope = requests.parse(servletRequest, body);
    return json(
        catalog
            .resolveDataSource(dataSourceId, requests.dataSourceResolve(envelope))
            .toProtocolMap(),
        200);
  }

  private static ResponseEntity<byte[]> revisionResponse(
      JsonObject value, String revision, String ifNoneMatch) {
    String etag = '"' + revision + '"';
    if (etag.equals(ifNoneMatch)) {
      return ResponseEntity.status(304).header(HttpHeaders.ETAG, etag).build();
    }
    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_JSON)
        .header(HttpHeaders.ETAG, etag)
        .body(CanonicalJson.encode(value));
  }

  private static ResponseEntity<byte[]> json(JsonObject value, int status) {
    return ResponseEntity.status(status)
        .contentType(MediaType.APPLICATION_JSON)
        .body(CanonicalJson.encode(value));
  }
}
