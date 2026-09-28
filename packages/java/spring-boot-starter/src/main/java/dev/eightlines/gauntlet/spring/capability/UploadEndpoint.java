package dev.eightlines.gauntlet.spring.capability;

import dev.eightlines.gauntlet.core.model.UploadResponse;
import org.springframework.web.multipart.MultipartFile;

@FunctionalInterface
public interface UploadEndpoint {
  UploadResponse create(MultipartFile file) throws Exception;
}
