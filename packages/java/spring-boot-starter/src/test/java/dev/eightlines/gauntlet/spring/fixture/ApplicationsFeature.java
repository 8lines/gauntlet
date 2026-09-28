package dev.eightlines.gauntlet.spring.fixture;

import dev.eightlines.gauntlet.spring.annotation.GauntletFeature;
import org.springframework.stereotype.Component;

@Component
@GauntletFeature(id = "applications", label = "Applications")
public final class ApplicationsFeature {}
