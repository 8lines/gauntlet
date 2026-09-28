package dev.eightlines.gauntlet.example;

import dev.eightlines.gauntlet.spring.annotation.GauntletFeature;
import org.springframework.stereotype.Component;

@Component
@GauntletFeature(id = "agency-applications", label = "Agency applications", order = 10)
public final class AgencyApplicationsFeature {}
