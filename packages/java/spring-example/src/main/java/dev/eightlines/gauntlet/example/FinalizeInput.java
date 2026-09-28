package dev.eightlines.gauntlet.example;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;

public record FinalizeInput(
    @NotNull UUID applicationId, @NotNull @Pattern(regexp = "^[0-9]{6}$") String confirmationCode) {}
