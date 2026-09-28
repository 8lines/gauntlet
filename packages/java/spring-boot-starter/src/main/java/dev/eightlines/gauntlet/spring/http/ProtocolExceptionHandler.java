package dev.eightlines.gauntlet.spring.http;

import dev.eightlines.gauntlet.spring.catalog.SpringAdapterException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MultipartException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;

@RestControllerAdvice(assignableTypes = {AdapterV1Controller.class, CapabilityController.class})
public final class ProtocolExceptionHandler {
  private final ProblemResponseFactory problems;

  public ProtocolExceptionHandler(ProblemResponseFactory problems) {
    this.problems = problems;
  }

  @ExceptionHandler(RequestProblemException.class)
  public ResponseEntity<byte[]> requestProblem(RequestProblemException exception) {
    return problems.response(exception.problem());
  }

  @ExceptionHandler(SpringAdapterException.class)
  public ResponseEntity<byte[]> catalogProblem(SpringAdapterException exception) {
    return problems.response(exception.problem());
  }

  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  public ResponseEntity<byte[]> unsupportedMedia() {
    return problems.response(
        ProblemResponseFactory.problem("unsupported-media-type", "Unsupported media type", 415));
  }

  @ExceptionHandler({
    MissingServletRequestPartException.class,
    MissingServletRequestParameterException.class,
    MultipartException.class
  })
  public ResponseEntity<byte[]> invalidMultipart() {
    return problems.response(ProblemResponseFactory.validation(java.util.List.of()));
  }

  @ExceptionHandler(Throwable.class)
  public ResponseEntity<byte[]> unexpected() {
    return problems.internal();
  }
}
