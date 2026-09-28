package dev.eightlines.gauntlet.spring.fixture;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record FinalizeInput(@NotNull UUID applicationId, String reason) {}
