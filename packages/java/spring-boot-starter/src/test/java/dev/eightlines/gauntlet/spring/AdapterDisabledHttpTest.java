package dev.eightlines.gauntlet.spring;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.eightlines.gauntlet.spring.fixture.FixtureApplication;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(
    classes = FixtureApplication.class,
    properties = {"gauntlet.enabled=false"})
@AutoConfigureMockMvc
class AdapterDisabledHttpTest {
  @Autowired MockMvc mvc;

  @Test
  void disabledGateWinsBeforeCatalogRoutingMethodAndBodyParsing() throws Exception {
    mvc.perform(get("/_gauntlet/v1/manifest"))
        .andExpect(status().isServiceUnavailable())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:adapter-disabled"));
    mvc.perform(post("/_gauntlet/v1/health"))
        .andExpect(status().isServiceUnavailable())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:adapter-disabled"));
    mvc.perform(
            post("/_gauntlet/v1/operations/applications.finalize/runs")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{not-json"))
        .andExpect(status().isServiceUnavailable())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:adapter-disabled"));
    mvc.perform(post("/_gauntlet/v1/uploads"))
        .andExpect(status().isServiceUnavailable())
        .andExpect(jsonPath("$.type").value("urn:gauntlet:problem:adapter-disabled"));
  }
}
