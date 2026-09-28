package dev.eightlines.gauntlet.consumer;

import dev.eightlines.gauntlet.core.model.UploadResponse;
import dev.eightlines.gauntlet.spring.capability.UploadEndpoint;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.multipart.MultipartFile;

/** Compile-time fixture proving that the starter exports every type in its documented API. */
public final class StarterOnlyConsumer {
  private final UploadEndpoint uploads;

  public StarterOnlyConsumer(UploadEndpoint uploads) {
    this.uploads = uploads;
  }

  public UploadResponse upload(MultipartFile file) throws Exception {
    return uploads.create(file);
  }

  public record Input(@NotNull String value) {}
}
